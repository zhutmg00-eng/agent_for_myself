# CONTRACT_ROOM — 群聊房间（Group Room）行为契约

> **来源**：对 `D:\能力测试\agentharness\agentharness` 的只读逆向（2026-11-06），以 Python 实现为唯一事实来源。
> **用途**：`fusion` 的 Node.js 重实现必须与本文件一致；与 `docs/FUSION_SPEC.md` §5 冲突时，**以本文件描述的 Python 行为为准**，并在实现处标注差异。
> **引用形式**：`group.py:767` = `agentharness/agents/group.py` 第 767 行。
>
> 贯穿全文的两个字面量约定：所有事件 `sender` 为 `"group_room"`（例外见 §11 表），所有时间戳为 `datetime.now(timezone.utc).isoformat()`（形如 `2026-11-06T01:23:45.678901+00:00`）。

---

## 1. 数据模型

### 1.1 SQLite DDL（逐字，`store.py:324-377`）

```sql
CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    owner_id TEXT,
    parent_room_id TEXT,
    topic TEXT NOT NULL DEFAULT '',
    context_policy TEXT NOT NULL DEFAULT 'shared',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_parent ON rooms(parent_room_id);

CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    permissions_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (room_id, bot_id),
    FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS room_messages (
    room_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    speaker TEXT NOT NULL,
    content TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',
    ts TEXT NOT NULL,
    PRIMARY KEY (room_id, seq),
    FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pending_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_room_id TEXT NOT NULL,
    child_room_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    drained_at TEXT,
    FOREIGN KEY(parent_room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pending_notices_parent
    ON pending_notices(parent_room_id, drained_at);

CREATE TABLE IF NOT EXISTS room_files (
    room_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    path TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (room_id, file_id),
    FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);
```

迁移：老库启动时执行一次 `ALTER TABLE room_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';`，失败（列已存在）吞掉异常（`store.py:386-391`）。因此**历史行读回 `kind='message'`**。

注意实现细节（必须在 Node 端口复刻）：

- `room_messages.seq` 由应用层计算：`SELECT COALESCE(MAX(seq),0) FROM room_messages WHERE room_id=?` 后 `+1`，再 INSERT（`store.py:1147-1157`）。并发回合会撞 PK（同一房间同时跑两个回合时），Python 端没有加锁保护，仅靠 `round_idle`/`pending_rounds` 做串行化提示。
- `room_files.path` 存**绝对路径**（不是相对路径），见 §8。
- `rooms` 表没有 `updated_at` 列（内存对象有 `updated_at`，但不落库）。
- 外键声明的级联删除实际是否生效取决于 SQLite 的 `PRAGMA foreign_keys`；`delete_room` 的注释假定级联生效。

### 1.2 权限 JSON（存 `room_members.permissions_json`）

```json
{
  "can_speak": true,
  "context_access": "full",
  "can_create_subgroup": false,
  "allowed_tool_overrides": null
}
```

`MemberPermission.to_dict()/from_dict()`（`group.py:54-70`）：
- `can_speak` 缺省 `true`，`bool()` 强制。
- `context_access` 合法集 `("full","summary","none")`；构造时非法值静默回退为 `"full"`；`set_permission` 时非法值**保留旧值**（`group.py:330-332`）。
- `can_create_subgroup` 缺省 `false`。
- `allowed_tool_overrides`：`null` 或 `string[]`；空数组归一化为 `null`（`group.py:52,337`）。
- **`allowed_tool_overrides` 在 Python 版中只是描述性字段，引擎从不读取它做工具裁剪**（全仓仅 `to_dict/from_dict/set_permission/room_list_members` 出现）。真正的工具面裁剪靠 `worker.mount_tools` + `mandate.allowed_tools`（§6.3）。

### 1.3 内存房间对象字段（`CollaborativeGroupRoom.__init__`，`group.py:105-168`）

| 字段 | 类型 | 初值 / 说明 |
|---|---|---|
| `room_id` | `str` | |
| `members` | `list[str]` | 构造入参拷贝；顺序即默认发言顺序 |
| `event_bus` | `EventBus \| None` | |
| `grace_ms` | `int` | 默认 `ROOM_WORK_GRACE_MS = 5000` |
| `relay_limit` | `int` | `3 * len(members)`，构造时冻结（加成员不更新） |
| `relays` | `int` | `0`；每完成一个非 user 回合 +1 |
| `status` | `str` | 恒从 `"active"` 开始；取值 `active \| paused` |
| `speaking_slots` | `list[str]` | `list(members)` 拷贝；回合内被 @提及重排，回合结束后**不重置** |
| `message_log` | `list[dict]` | 见下 |
| `late_replies` | `list[dict]` | 长工具延迟回复缓冲，`drain_late_replies()` 取走 |
| `sessions` | `dict[str, WorkerAgent]` | `bot_id → worker` |
| `owner_id` | `str \| None` | 群主（老板） |
| `title` | `str` | 默认 `""` |
| `parent_room_id` | `str \| None` | 小群指向父群 |
| `topic` | `str` | 默认 `""` |
| `context_policy` | `str` | `shared \| summary \| isolated`；非法值回退 `"shared"` |
| `store` | `SQLiteStore \| None` | |
| `orchestrator_mode` | `str` | `dispatch \| legacy`；入参 `None` 时：`"dispatch" if owner_id == "boss" else "legacy"` |
| `member_permissions` | `dict[str, MemberPermission]` | 为 `members` 中每个人建默认权限 |
| `pending_assignments` | `dict[str, list[str]]` | `bot_id → [task, ...]`（仅内存，不落库） |
| `file_index` | `dict[str, RoomFileEntry]` | `file_id → entry` |
| `system_notices` | `list[str]` | 文本通知队列；每轮结束清空 |
| `updated_at` | `str` | 创建时刻；每次成功 `advance_turn` 更新 |
| `round_running` | `int` | 并发回合计数 |
| `pending_rounds` | `int` | 已调度但未 `begin_round()` 的回合数（关闭 spawn→start 竞争窗） |
| `round_idle` | `asyncio.Event` | 初始 `set()`；回合开始 `clear()`，全部结束 `set()` |
| `round_spawned_children` | `int` | 本回合 spawn 的子会话数 |
| `_round_pending_notice_ids` | `list[int]` | 本回合加载的 `pending_notices.id`，供 ack |
| `_orchestrator_announcements` | `list[str]` | dispatch 编排者本回合的播报缓冲 |
| `child_rooms` | `list[str]` | `note_child_spawned()` 去重追加 |

`message_log` 行（成功回合，`group.py:266-272`）：

```python
{
  "speaker": speaker,            # "user" | bot_id | f"subgroup:{id}"
  "content": content,
  "kind": effective_kind,        # user|assistant|tool|result|user_visible|notice|message
  "relays": self.relays,         # 仅此处有；持久化时丢弃
  "timestamp": "<iso8601 utc>",
}
```

`late_replies` 行：`{"speaker","content","kind","timestamp"}`（无 `relays`）。

`RoomFileEntry`（`group.py:73-99`）：`file_id`、`path`（绝对路径）、`description`（默认 `""`）、`tags`（`list`，默认 `[]`）、`updated_at`（构造时 `now()`，`move_file` 时刷新）。`to_dict()` 返回这 5 个键。

### 1.4 快照对象 `to_dict()`（`group.py:747-764`）

```
room_id, title, members[], owner_id, parent_room_id, topic, context_policy,
orchestrator_mode, status, relays, message_count, file_count, updated_at,
member_permissions{bot_id: {can_speak,context_access,can_create_subgroup,allowed_tool_overrides}}
```

这是 `GET /api/rooms/{id}`、`room.{id}.updated` 事件、`list_rooms()` 的 payload。

---

## 2. 房间生命周期

### 2.1 `create_room`（`runtime.py:371-436`）

签名：

```python
create_room(room_id, member_bot_ids, grace_ms=ROOM_WORK_GRACE_MS, *,
            owner_id=None, title="", parent_room_id=None, topic="",
            context_policy="shared", member_permissions=None,
            orchestrator_mode=None, persist=True) -> CollaborativeGroupRoom
```

顺序：

1. 校验成员：`missing = [b for b in member_bot_ids if b not in self.workers]` → `KeyError(f"Unknown worker(s) for room '{room_id}': {missing}")`。**成员必须已是注册 worker**。
2. 构造 `CollaborativeGroupRoom(...)`（默认值见 §1.3）。
   - **默认权限**：对每个成员 `MemberPermission.from_dict(None)` → `{can_speak: True, context_access: "full", can_create_subgroup: False, allowed_tool_overrides: None}`。**群主没有特殊默认权限**（与普通成员完全一致）。
   - **默认 owner**：`None`（除非显式传入）。
   - **默认 orchestrator_mode**：`owner_id == "boss"` → `"dispatch"`，否则 `"legacy"`。
3. `room.register_session(bot_id, self.workers[bot_id])` 逐个绑定。
4. `self.rooms[room_id] = room`；`self.router.register_room(room)`（Router 可把该房间当作派发目标，`router.py:233`）。
5. **恢复文件索引**：`for row in store.list_room_files(room_id): room.upsert_file(row["file_id"], row["path"], row["description"], row.get("tags") or [])`（内存 + 回写 DB）。
6. `persist=True` → `_persist_room(room)`：`store.upsert_room(room_id, title, owner_id, parent_room_id, topic, context_policy, status)` + `store.set_room_members(room_id, {bot: perm.to_dict()})`（先 DELETE 再全量 INSERT）。
7. 发布 `harness.room.created`，sender `"runtime"`，payload `{"room_id","members":[...],"owner_id","title"}`。

`upsert_room` 是**全字段覆盖**（`ON CONFLICT DO UPDATE SET title, owner_id, parent_room_id, topic, context_policy, status`），但 `created_at` 不更新（`store.py:1027-1047`）。

### 2.2 HTTP 面向的 `open_room`（`runtime.py:502-564`）

```python
open_room(member_ids, *, owner_id=None, title="", context_policy="shared",
          include_roles=False) -> {"room_id": str, "members": [...]}
```

- `include_roles=True`：若 `"boss"` 不在列表中，`_ensure_special_worker("boss", room_role=True)` 并 **insert 到下标 0**；若 `"librarian"` 不在，则 ensure 并 **append 到末尾**；最后 `dict.fromkeys` 去重保序。
- 对每个 `member`：若既不是已注册 worker 且 `get_archetype(member)` 命中，则 `_ensure_special_worker(member, room_role=(member in ("boss","librarian")))` 惰性物化（任意 archetype 都可入群）。
- 成员数 `< 2` → `ValueError(f"A room needs at least 2 members, got {len(members)}.")`。
- `room_id = uuid.uuid4().hex[:6]`（6 位十六进制），与现存 `self.rooms` 冲突则重抽。
- `effective_owner = owner_id.strip() if owner_id else ("boss" if include_roles else None)`；若给定 owner 不在 members → `ValueError(f"Owner '{effective_owner}' must be one of the room members.")`。
- `create_room(room_id, members, owner_id=effective_owner, title=title, context_policy=context_policy)`。
- `include_roles=True` 时 `mkdir -p <workspace_root>/rooms/<room_id>/files`（失败仅 debug 日志）。
- 返回值：恒有 `{"room_id","members"}`；当 `include_roles or title or owner_id or context_policy != "shared"` 时追加 `{"owner_id","title","context_policy"}`。

### 2.3 启动恢复 `load_rooms`（`runtime.py:457-493`，由 `start()` 在 `runtime.py:722` 调用）

```
for row in store.list_room_rows():            # ORDER BY created_at ASC
    permissions = store.get_room_members(row["room_id"])       # {bot_id: perms}
    members = [m for m in permissions.keys() if m in self.workers]   # 未知 bot 丢弃
    if len(members) < 1: continue                              # 注意：不校验 >=2
    create_room(row["room_id"], members, owner_id=row["owner_id"], title=row["title"],
                parent_room_id=row["parent_room_id"], topic=row["topic"],
                context_policy=row["context_policy"] or "shared",
                member_permissions=permissions, persist=False)
    for msg in store.list_room_messages(row["room_id"], limit=1000):
        room.message_log.append({"speaker","content","relays":0,"timestamp":msg["ts"]})
```

恢复语义的四个硬事实：

1. **`status` 列被忽略**：`CollaborativeGroupRoom` 没有 status 入参，新建对象恒 `"active"`。熔断暂停后的房间重启即恢复发言。
2. **恢复的消息行没有 `kind`**：`read_transcript_view` 会按 `speaker == "user"` 推断 user，其余按 `"assistant"`（`group.py:568-571`）。
3. **`relays` 重置为 0**，熔断计数不持久化。
4. 恢复只回放最近 1000 条；`create_room` 会再发一次 `harness.room.created`。

其余运行时状态（`pending_assignments`、`system_notices`、`late_replies`）不恢复，只有 `pending_notices` 表可在下一轮 `begin_round()` 时补投（§3.5）。

### 2.4 运行期变更入口

- `POST /api/rooms/{id}/say` → `runtime.room_say()`：`pending_rounds += 1`、`round_idle.clear()`、后台 `run_room_round`，立刻返回 `{"status":"accepted","room_id"}`（`runtime.py:674-687`）。
- `PUT /api/rooms/{id}`（`server.py:732-787`）：可改 `title`（`strip()[:80]`）、`topic`（`strip()[:200]`）、`member_permissions`（仅键 `can_speak/context_access/can_create_subgroup/allowed_tool_overrides`）、`add_members`（追加 `members`、`speaking_slots`、`register_session`、`permission_of`）、`context_policy`；随后 `runtime._persist_room(room)` 并发布 `room.{id}.updated`（sender `"server"`，payload = `room.to_dict()`）。

---

## 3. 一个回合：`run_room_round(room, instruction)`（`group.py:767-902`）

### 3.1 事件发射器

```python
async def _publish(kind, payload):
    if room.event_bus and not room.event_bus.is_closed:
        await room.event_bus.publish(Event(topic=f"room.{room.room_id}.{kind}",
                                           sender="group_room", payload=payload))
```

回合骨架用**异步** `publish`（`round_started`/`member_started`/`member_finished`/`round_completed`），其余全部用 `publish_nowait`。

### 3.2 逐步算法（忠实伪码）

```python
room.begin_round()                       # pending_rounds-1, round_running+1, round_idle.clear(),
                                         # round_spawned_children=0, 清空播报缓冲, load_pending_notices()

room.advance_turn(speaker="user", content=instruction, is_user=True)
#   → relays=0; status="active"; 事件 circuit_breaker_reset{reset_by:"user"}
#   → 解析 @mention 并插队; 事件 member_mentioned{speaker,mentioned}（每条提及一个）
#   → message_log 追加 {speaker:"user", content, kind:"user", relays:0, timestamp}
#   → DB append_room_message(kind="user"); 事件 turn_completed{...整条 record...}

# Dispatch 群主优先：仅当 dispatch 模式、owner 在队列、且指令里没有 @xxx 时，把 owner 提到队首
if (room.orchestrator_mode == "dispatch" and room.owner_id in room.speaking_slots
        and not re.search(r"@([a-zA-Z0-9_\-]+)", instruction)):
    room.speaking_slots.remove(owner); room.speaking_slots.insert(0, owner)

await _publish("round_started", {
    "instruction": instruction[:500],
    "members": list(room.members),
    "orchestrator_mode": room.orchestrator_mode,
})

outputs = []; seen = set()
assignment_order = []        # 群主分派的先后顺序
assigned_mode = False        # 一旦置 True，本轮不再复位
guard = 0
max_turns = max(1, len(room.speaking_slots) * 4)
round_completed = False
try:
    while guard < max_turns:
        guard += 1
        # 1) 把本轮新出现的 pending_assignments 键按插入序并入 assignment_order
        for candidate in room.pending_assignments:
            if candidate not in assignment_order:
                assignment_order.append(candidate)
        # 2) 下一个被分派且尚未发言的成员
        pending_next = next((b for b in assignment_order
                             if b in room.pending_assignments and b not in seen), None)
        if room.pending_assignments:
            assigned_mode = True          # 一旦有人分派，本轮只跑被分派者
        bot_id = pending_next if assigned_mode else \
                 next((b for b in room.speaking_slots if b not in seen), None)
        if bot_id is None:
            break
        seen.add(bot_id)

        worker = room.sessions.get(bot_id)
        if worker is None:
            continue                      # 无 worker：静默跳过，不产出 outputs 行
        if not room.permission_of(bot_id).can_speak:          # 被静音
            outputs.append(f"{bot_id}: [muted by room permission]")
            continue

        is_orchestrator = (room.orchestrator_mode == "dispatch"
                           and bot_id == room.owner_id
                           and (getattr(worker, "role", "") == "boss" or bot_id == "boss"))
        before_rows = len(room.message_log)
        member_instruction = room.build_member_instruction(bot_id, instruction)
        await _publish("member_started", {"member": bot_id})
        previous_room_id = getattr(worker, "current_room_id", None)
        worker.current_room_id = room.room_id        # 让 room_* 工具能解析到本房间
        try:
            result = await worker.run_turn(member_instruction)
        finally:
            worker.current_room_id = previous_room_id
            await _publish("member_finished", {"member": bot_id})

        if is_orchestrator:
            room.flush_orchestrator_announcements()  # 只提交最后一条播报（kind=user_visible）
            new_rows = room.message_log[before_rows:]
            visible = [r for r in new_rows if r.get("kind") == "user_visible"]
            if visible:
                outputs.append(f"{bot_id}: {visible[-1]['content']}")
            else:
                outputs.append(f"{bot_id}: [orchestrator: no user-visible announcement]")
                await _publish("orchestrator_no_announcement", {"member": bot_id})
            # 已 spawn 子会话或已无待执行分派 → 本轮结束，否则继续跑被分派成员
            if room.round_spawned_children > 0 or not room.pending_assignments:
                break
            continue

        outcome = room.advance_turn(speaker=bot_id, content=result)
        if outcome.get("status") == "paused":
            outputs.append(f"{bot_id}: [room paused by circuit breaker]")
            break
        outputs.append(f"{bot_id}: {result}")
    round_completed = True
finally:
    room.end_round(completed=round_completed)   # round_running-1; completed 时 ack notices
    room.drain_notices()                        # 无条件清空 system_notices
    await _publish("round_completed", {
        "speakers": [b for b in seen if b in room.members],
        "paused": room.status != "active",
        "spawned_children": list(room.child_rooms),
    })

return "\n".join(outputs) if outputs else "(no room member responded)"
```

返回值是**每个发言者一行** `f"{bot_id}: {result}"` 的拼接；空结果返回 `"(no room member responded)"`。

### 3.3 发言顺序（回答"谁先说话"）

1. **用户指令先入转录**（`speaker="user"`），并处理指令里的 `@`。
2. **默认顺序 = `speaking_slots` 顺序**，即构造时的 `members` 顺序；每轮按"队列里第一个未发言者"实时取头（不是单调游标，所以中途插队有效）。
3. **Dispatch 群主优先**：`orchestrator_mode == "dispatch"` 且 owner 在队列且指令中**没有任何 `@xxx`** → owner 移到队首。`legacy` 模式不重排（owner 按成员顺序发言，且其输出作为普通 assistant 消息入转录）。
4. **@提及插队**（`mention_member`，`group.py:178-193`）：
   - 触发点：用户指令、以及**每个** bot 回合的 `advance_turn`（即解析该 bot 输出文本）。
   - 正则 `r"@([a-zA-Z0-9_\-]+)"`（**只匹配 ASCII 字母/数字/下划线/连字符**，中文昵称匹配不到）。
   - 仅当 `mentioned in members and mentioned in speaking_slots` 才重排：先从队列 `remove`，再插到 `current_speaker` 之后；若 `current_speaker` 不在队列 → 插到下标 0。
   - 每插一次发一个 `member_mentioned`。
   - 已被 `seen` 的成员即使被再次提及也不会在同轮再发言（`seen` 过滤）。
   - `@自己` 被忽略（`m != speaker`）。
5. **分派优先（并压制其他成员）**：见 §5.3。
6. **上限**：`max_turns = max(1, len(speaking_slots) * 4)`，`guard` 达到即静默退出循环（不发任何"截断"事件）。

### 3.4 熔断器（circuit breaker，`group.py:205-243`）

- 阈值：`relay_limit = 3 * len(members)`，**构造时冻结**。
- 计数：`advance_turn(is_user=False)` 每次 `relays += 1`，包含：
  - 每个正常 bot 回合；
  - dispatch 群主 flush 出来的 `user_visible` 播报（也是 `is_user=False`）；
  - 父群里 `subgroup:<id>` 的结论汇报（`kind="result"`）。
- 触发：`relays >= relay_limit` → `status="paused"`，发 `circuit_breaker_tripped{"relays","limit"}`，**返回 `{"status":"paused","reason":"Circuit breaker: relay limit reached"}` 且该回合内容不写入转录**（`return` 在 append 之前）。
- 复位：任何 `is_user=True` 的 turn（即新一轮的 `instruction`）→ `relays = 0`、`status = "active"`，发 `circuit_breaker_reset{"reset_by": speaker}`。
- **房间已暂停时的非 user turn** 直接返回 `{"error": "Room is paused by circuit breaker."}`（注意：没有 `status` 键，所以回合循环里的 `outcome.get("status") == "paused"` 判断**不会**命中；实际停轮靠上面那次 trip 的返回值）。UI 若要表达"已暂停"，读 `room.status`。

### 3.5 回合生命周期钩子（`group.py:480-548`）

- `begin_round()`：`pending_rounds = max(0, pending_rounds-1)`；`round_running += 1`；`round_idle.clear()`；`round_spawned_children = 0`；清空 `_orchestrator_announcements`；`load_pending_notices()`（把 `pending_notices` 里 `drained_at IS NULL` 的行文本追加进 `system_notices` 并记录 id，去重按文本）。
- `end_round(completed)`：`round_running -= 1`；`completed=True` 时 `ack_pending_notices()`（`mark_pending_notices_drained(ids)` 写 `drained_at`）；清空播报缓冲；`round_running == 0 and pending_rounds == 0` 时 `round_idle.set()`。
- 异常路径：`round_completed = False` → 不 ack 通知，但 `drain_notices()` 仍然执行（通知会丢，但 DB 里仍未 drained，下一轮会再投一次）。

### 3.6 dispatch 编排者的特殊处理（`group.py:405-472, 852-885`）

- 判定 `is_orchestrator` 需要三项同时成立：`orchestrator_mode == "dispatch"`、`bot_id == owner_id`、`worker.role == "boss" or bot_id == "boss"`。
- 它的**普通 assistant 文本不写转录**（代码根本不对它调 `advance_turn`；只有它在回合内调用 `send_user_message` 才会进转录）。
- `send_user_message` 在 `round_running > 0 and dispatch and speaker == owner_id` 时**只缓冲**，返回 `{"buffered": True, ...}`；回合结束时 `flush_orchestrator_announcements()` **只提交缓冲区最后一条**，其余丢弃；提交走 `advance_turn(kind="user_visible")`（会 +relays）并发 `assistant_message`。
- 回合内没有产出可见播报 → `orchestrator_no_announcement{"member"}`。
- 只要本回合 spawn 过子会话（`round_spawned_children > 0`）就**立即结束父回合**，避免父编排者重复执行子任务。

---

## 4. 每个成员的上下文装配

### 4.1 有效上下文级别（`effective_context_level`，`group.py:649-658`）

```python
if context_policy == "isolated":        return "none"
access = permission_of(bot_id).context_access
if access == "none":                    return "none"
if context_policy == "summary" or access == "summary": return "summary"
return "full"
```

即：**房间策略与成员权限取更严格者**；`isolated` 对所有人（含群主）都返回 `"none"`（转录完全不注入）。

| context_policy | context_access | 级别 |
|---|---|---|
| shared | full | full |
| shared | summary | summary |
| shared | none | none |
| summary | full | summary |
| summary | summary / none | summary / none |
| isolated | 任意 | none |

### 4.2 转录渲染模板（`render_transcript`，`group.py:660-695`）

**full**（预算 `TRANSCRIPT_CHAR_BUDGET = 12000` 字符）：

```python
lines = []; used = 0
for record in reversed(self.message_log):                     # 从最新往前
    line = f"[{record.get('speaker', '?')}] {record.get('content', '')}"
    if used + len(line) > budget and lines:                   # 至少保留最后 1 条
        break
    lines.append(line); used += len(line)
return "\n".join(reversed(lines))                             # 恢复时间正序
```

- 单行格式**逐字**为 `[<speaker>] <content>`，中括号 + 一个半角空格。
- 预算按字符数算，**不计 `\n` 连接符**；内容不截断（单行可超预算，因为首行无条件收入）。
- **不过滤 `kind`**：`tool`/`notice`/`result` 行也会进共享上下文。

**summary**（预算 `TRANSCRIPT_SUMMARY_BUDGET = 6000` 字符）：

```python
records = self.message_log
if len(records) <= 6: chosen = records; omitted = 0
else:                 chosen = records[:2] + records[-4:]; omitted = len(records) - 6
lines = [f"……（早前 {omitted} 条发言已省略）……"] if omitted else []
used = sum(len(l) for l in lines)
for record in chosen:
    line = f"[{record.get('speaker','?')}] {str(record.get('content',''))[:300]}"   # 每条截 300 字
    lines.append(line); used += len(line)
    if used > budget: break
```

**none**：返回 `""`（或 `message_log` 为空时返回 `""`）。

### 4.3 成员指令拼装（`build_member_instruction`，`group.py:697-741`）

按顺序拼 section，用 `"\n\n"` 连接（空 section 跳过）：

| # | 条件 | 文本模板（逐字） |
|---|---|---|
| 1 | `transcript` 非空 | `=== 群聊共享上下文（房间 {room_id}{('：' + title) if title else ''}） ===\n{transcript}` |
| 2 | `owner_id and bot_id != owner_id` | `当前群主（老板）：{owner_id}。它负责分派任务与授权；按其分派执行。` |
| 3 | `system_notices` 非空 | `=== 系统通知 ===\n` + `"\n".join(f"- {n}" for n in notices)` |
| 4 | 该成员有分派 | `=== 群主分派给你的任务 ===\n` + `"\n".join(f"- {a}" for a in assignments)`，**读取即 `pop`**（只投递一次） |
| 5 | `file_index` 非空 | `=== 群文件空间（按 file_id 引用，路径可能被文件管家调整，永远以本清单为准） ===\n` + 每行 `f"- {f.file_id}: {f.path}" + (f"（{f.description}）" if f.description else "")` |
| 6 | 恒有 | `=== 本轮消息 ===\n{round_message}` |
| 7a | `bot_id == owner_id and orchestrator_mode == "dispatch"` | 见下方 dispatch 三段文本 |
| 7b | 否则 | `请以群成员身份回应本轮消息：直接给出结论/产出，简洁专业，必要时 @提及相关成员。` |

dispatch 编排者第 7a 段（逐字；源码由 5 个字符串字面量拼接，其中第 3、4 段之间**没有** `\n`，所以实际是 4 个换行行）：

```
你是本群编排者（Dispatch orchestrator）。你**不亲自执行任务**，也不要写文件或跑命令。
你的唯一用户出口是 send_user_message：只有通过它发送的内容会被用户看到，普通回复会被忽略。
路由规则：新的独立目标 → spawn_child_session；对已启动会话的追问/纠偏 → send_message；查看进度/结果 → read_transcript；一条消息包含多个独立目标 → 并行 spawn 多个子会话。
分派后用 send_user_message 给用户一句简短播报（做了什么、在等谁）。
```

**顺序副作用**：section 4 的 `pop` 发生在 section 1-3 渲染之后，因此"分派任务"文本**不会**出现在该成员本轮看到的转录里（转录里只有历史），但会出现在 `=== 群主分派给你的任务 ===` 段。

### 4.4 预算/截断常量汇总

| 常量 | 值 | 作用 |
|---|---|---|
| `ROOM_WORK_GRACE_MS` | `5000` | 长工具宽限（房间字段 `grace_ms`；`is_long_tool=True` 时回合延迟入 `late_replies`） |
| `TRANSCRIPT_CHAR_BUDGET` | `12000` | `full` 转录字符预算 |
| `TRANSCRIPT_SUMMARY_BUDGET` | `6000` | `summary` 转录字符预算（每条另截 300 字） |
| `instruction[:500]` | 500 | `round_started.instruction` |
| `report[:2000]` | 2000 | `subgroup_report.report` 与父群汇报正文 |
| `task[:400]` | 400 | `task_assigned.task` |
| `latest[:120]` / `latest[:500]` | 120 / 500 | 进度摘要 / `read_transcript` 的 `[result]` 行 |
| `latest_tool_output[:2000]` | 2000 | worker 无文本输出时的兜底（§10） |

### 4.5 系统通知的注入与清理

- 队列是**房间级**的（不是 per-member）：同一轮里每个成员都看到同样的通知列表。
- `begin_round()` 从 `pending_notices` 载入未 drained 的通知；`end_round(completed=True)` ack。
- `drain_notices()` 在**每轮 finally** 无条件清空内存队列 → 通知只保证注入一轮（且只保证注入"本轮实际发言的成员"）。
- 中途（某成员回合内）产生的通知（`file_moved`、`add_system_notice`）会立刻出现在**后续**成员的指令里；排在前面的成员本轮看不到，回合一结束就被清空（这是真实行为，重实现需保留或明确改进）。
- 通知文本不带署名，逐条以 `- ` 前缀列出。

---

## 5. 任务分派（`room_assign_task`）

### 5.1 工具契约（`room_admin.py:131-172`）

```python
class RoomAssignTaskArgs(BaseModel):
    member: str
    task: str = Field(..., min_length=1)
    room_id: Optional[str] = None
```

执行顺序：

1. `resolve_room(services, args.room_id, context.worker_session_id, context)`；失败返回 `ToolResult.fail(error=...)`。
2. `_owner_gate(room, caller)`：`if room.owner_id and caller != room.owner_id: return ERR_OWNER_ONLY`（**`owner_id` 为 `None` 时任何人通过**）。
3. `member not in room.members` → `ERR_UNKNOWN_MEMBER`（`"The target member is not in this room."`）。
4. `room.add_assignment(member, task)`。
5. 返回 `ToolResult.ok(output=json.dumps({...}))`，键为：

```json
{"status": "assigned", "room_id": "...", "member": "coder", "task": "...", "note": "该成员将在本房间下一轮优先发言。"}
```

（实际输出是单行、无多余空格的 `json.dumps(..., ensure_ascii=False, default=str)` 结果。）

`_payload()` 用 `json.dumps(fields, ensure_ascii=False, default=str)` → **单行 JSON 字符串**作为工具输出。

### 5.2 记录与事件（`add_assignment`，`group.py:380-395`）

```python
self.pending_assignments.setdefault(bot_id, []).append(str(task))
publish_nowait(f"room.{room_id}.task_assigned",
               payload={"member": bot_id, "task": str(task)[:400]}, sender="group_room")
```

- **不写 DB**（无 assignment 表）；进程重启即丢。
- **不改 `speaking_slots`**（注释明确：分派不改队列，靠回合器优先取分派者）。
- 同一成员多次分派 → 列表累积，下一轮一次性全部投递。

### 5.3 对发言顺序的影响（与 §3.2 对应）

- 回合每次迭代把 `pending_assignments` 的键按插入序并入 `assignment_order`；下一发言者 = `assignment_order` 中**仍有待办且未发言**的第一人。
- 只要 `pending_assignments` 非空过，`assigned_mode` 置 `True` 且**本轮不再复位** → 未被分派的成员全部闭嘴。
- 分派者发言时其任务被 `pop`；待办清空后 `pending_next is None` → `bot_id is None` → **本轮结束**。
- 因此典型链路：`boss`（dispatch）先说话 → 调 `room_assign_task(coder)` ×N → `boss` 回合结束；回合器只跑 coder（以及其它被分派者），其余成员不发言。
- 若 owner 用 `send_message(bot_id, ...)`（Dispatch 工具），落到的也是 `add_assignment`，行为完全相同（`session_info.py:216-223`）。

---

## 6. 权限

### 6.1 对象

`MemberPermission`（§1.2）：`can_speak: bool`、`context_access: "full"|"summary"|"none"`、`can_create_subgroup: bool`、`allowed_tool_overrides: list[str]|None`。

### 6.2 `set_permission`（`group.py:323-350`）

```python
if bot_id not in self.members: raise KeyError(f"Unknown member '{bot_id}' in room '{self.room_id}'.")
perm = self.permission_of(bot_id)            # 缺失则惰性创建默认权限并写入 member_permissions
# 逐字段更新：can_speak / context_access（非法值保留旧值）/ can_create_subgroup / allowed_tool_overrides
# 落库：store.set_room_members(room_id, {所有 member_permissions})   ← 全量替换，包含惰性创建的条目
# 事件：room.{room_id}.permission_changed {member, permissions:{四字段}}
```

注意 `permission_of()` 可为**不在 `members` 里的 bot_id** 建条目（如 `room_create_subgroup` 的 `permission_of(caller or "")`），该条目随后会被 `set_room_members` 一并写库。

### 6.3 `room_grant_permission`（`room_admin.py:175-244`）

参数：`member`、`can_speak?`、`context_access?`、`can_create_subgroup?`、`allowed_tools?`、`room_id?`。

流程：

1. resolve_room → `_owner_gate`（非群主 → `Permission denied: only the room owner may perform this action.`）。
2. `member not in room.members` → `ERR_UNKNOWN_MEMBER`。
3. 收集非 None 的字段（键名 `can_speak`/`context_access`/`can_create_subgroup`/`allowed_tools`）；全空 → `"Nothing to change: provide at least one permission field."`。
4. `perms = room.set_permission(member, **fields)`。
5. **热挂载/卸载工具**（仅当传入 `allowed_tools`）：

```python
worker = services.workers.get(member)
if worker is not None:
    overrides = fields["allowed_tools"]
    if overrides:
        base = ["room_file_save", "room_file_read", "room_file_list", "room_file_move"]
        worker.mount_tools(sorted(set(list(overrides) + base)))    # 并集 + 排序 + 去重
    else:
        worker.mount_tools([])                                     # 空列表 = 卸空
    if worker.mandate is not None:
        worker.mandate.allowed_tools = list(worker.mounted_tools)   # 回写 mandate
```

6. 返回 `{**perms, "room_id", "member", "status":"updated"}`。

**两个必须知道的坑（要原样保留或统一修正并写进实现注释）**：

1. **键名不匹配**：工具传的是 `allowed_tools=...`，而 `set_permission` 只认 `"allowed_tool_overrides"`，所以 `allowed_tool_overrides` **永远不会被这个工具更新**（`**fields` 吞掉未知键，不报错）。想更新该字段只能走 `PUT /api/rooms/{id}` 的 `member_permissions`。
2. **`mount_tools` 是收缩式**：`BaseAgent.mount_tools` 会用**当前** `mandate.allowed_tools` 过滤入参（`base.py:117-126`），而随后代码把 `mandate.allowed_tools` 覆盖为过滤结果。因此连续授权只会**越来越窄**，无法把 mandate 之外的工具真正挂上；`mount_tools([])` 则把工具面清空，只能靠再次赋权恢复（且受同一过滤限制）。

### 6.4 非群主调用管理工具的行为

- `room_assign_task` / `room_grant_permission` / `room_set_context_policy` / `send_user_message` / `spawn_child_session` / `send_message`：`_owner_gate` 返回错误字符串 → `ToolResult.fail(error=...)`，**不抛异常、不发事件、不改状态**，模型看到的是工具错误文本（worker 会把它作为 `ERROR: ...` 喂回上下文）。
- `room_create_subgroup`：群主**或** `permission_of(caller).can_create_subgroup` 为真才通过；否则同一错误文本。
- `room_list_members` / `room_file_list` / `room_file_read` / `read_transcript` / `list_sessions`：无 owner gate，只做房间解析与（`read_transcript` 的）读者校验。
- 静音（`can_speak=False`）只影响回合发言，不影响工具调用。

### 6.5 `room_set_context_policy`（`room_admin.py:247-282`）

`policy` 必须是 `shared|summary|isolated`，否则 `ValueError` → 工具失败。落地调用 `room.set_context_policy(policy)`：`self.context_policy = policy` → `upsert_room(... context_policy=...)`（用 `get_room()` 的其它字段填充，保留旧值）→ 事件 `context_policy_changed{"policy"}` → 返回 `{"status":"updated","room_id","context_policy"}`。

---

## 7. 小群（sub-group）

### 7.1 工具端（`room_create_subgroup`，`room_admin.py:285-345`）

```python
members: List[str]  # min_length=1
topic: str          # min_length=1
room_id: Optional[str]
```

1. `resolve_room` → 取能解析到的房间为父群。
2. 授权：`gate = _owner_gate(room, caller)`；`if gate and not room.permission_of(caller or "").can_create_subgroup: fail(gate)`。
3. `members` 去空、校验**全部已在父群**（`"Some members are not in the parent room."`）。
4. `services.create_subgroup` 不存在 → `"Subgroup creation is not available in this runtime."`。
5. `sub_room_id = create_subgroup(caller=caller or "user", member_ids=members, topic=topic, parent_room_id=room.room_id)`。
6. 返回 `{"status":"created","sub_room_id","parent_room_id","members","topic","note":"讨论在后台进行，结论将自动汇报回本群。"}`。
   - 注意：**该工具本身不发事件**；`child_spawned` 只在 `spawn_child_session` 工具里发（§11）。

### 7.2 建子群（`runtime.create_subgroup`，`runtime.py:566-609`）

```
parent = rooms[parent_room_id]                       # 否则 KeyError
members = dict.fromkeys(去空后的 member_ids)          # 去重保序
missing = [m for m in members if m not in parent.members]  → KeyError
if len(members) < 1: ValueError("A subgroup needs at least one member.")
sub_id = uuid4().hex[:6]（与现有房间冲突则重抽）
sub_owner = caller if caller in members else (parent.owner_id if parent.owner_id in members else members[0])
create_room(sub_id, members, owner_id=sub_owner,
            title=f"小群 · {topic[:24]}", parent_room_id=parent_room_id,
            topic=topic, context_policy="shared")
instruction = (f"小群讨论任务（由 {caller} 发起）：{topic}\n"
               "请围绕该话题给出明确结论与可执行建议；结论将汇报回大群。")
sub_room.pending_rounds += 1
sub_room.round_idle.clear()
_spawn_background_task(_run_subgroup_round(sub_id, instruction))
return sub_id
```

派生结果：子群 `context_policy` 恒 `"shared"`；`orchestrator_mode` 由 `owner_id == "boss"` 推导；子群**不自动加入**父群之外的成员；子群文件目录不预建（首次 `room_file_save` 时 `mkdir -p`）。

### 7.3 跑一轮 + 回收（`runtime._run_subgroup_round`，`runtime.py:611-658`）

```python
sub_room = rooms[sub_room_id]
try:
    report = await run_room_round(sub_room, instruction)
except Exception as exc:
    report = f"[小群讨论失败] {type(exc).__name__}: {exc}"
parent = rooms.get(sub_room.parent_room_id)
if parent is None: return
summary = f"[小群结论汇报] 子群 {sub_room_id}（{sub_room.topic}）讨论完毕：\n{report[:2000]}"
parent.advance_turn(speaker=f"subgroup:{sub_room_id}", content=summary,
                    is_user=False, kind="result")           # ← 会 +父群 relays，可能触发父群熔断
notice = (f'Task "{sub_room.title or sub_room.topic}" completed. '
          f'Use read_transcript with session_id "{sub_room_id}" to see the outcome, '
          f'then report to the user via send_user_message.')
parent.add_pending_notice(sub_room_id, "completed", notice)  # system_notices + pending_notices 表
publish_nowait(f"room.{parent.room_id}.subgroup_report",
               payload={"sub_room_id", "topic", "report": report[:2000]}, sender="group_room")
publish_nowait("session.child.completed",
               payload={"parent_session_id": parent.room_id, "session_id": sub_room_id,
                        "title": sub_room.title or sub_room.topic, "status": "completed"},
               sender="runtime")
```

父群侧可见性：

1. 转录里多一条 `[subgroup:<id>] [小群结论汇报] ...`，`kind="result"`，`relays` 递增；
2. `room.system_notices` 追加英文通知 → 父群**下一轮**每个成员指令的 `=== 系统通知 ===` 段可见；
3. `pending_notices` 表新增一行（`drained_at=NULL`），`begin_round()` 载入、`end_round(completed=True)` ack；
4. 事件 `subgroup_report`、`session.child.completed`；
5. 父群消息落库（`advance_turn` → `append_room_message(kind="result")`）。

`add_pending_notice` 的落库失败只 debug（`group.py:491-497`）；文本为空直接 return。

---

## 8. 群文件空间

### 8.1 磁盘布局

```python
def room_files_dir(workspace_root, room_id) -> Path:
    return (Path(workspace_root) / "rooms" / str(room_id).strip() / "files").resolve()
```

默认 `workspace_root = d:\能力测试\agentharness`（`config.py:189-192`）→ `d:\能力测试\agentharness\rooms\<room_id>\files\`。

- `room_files.path` 存**绝对路径**（`str(Path)`）。
- 目录仅在 `open_room(include_roles=True)` 时预建；`room_file_save` / `room_file_move` 会 `target.parent.mkdir(parents=True, exist_ok=True)` 兜底。

### 8.2 `file_id`

`uuid.uuid4().hex[:8]`（8 位十六进制，**每次 save 新生成**，不是内容哈希；覆盖同名文件会产生新的 file_id，旧索引条目保留）。

### 8.3 路径约束（`_safe_relpath` + `_target_path`，`room_files.py:40-73`）

```
cleaned = str(raw).strip().replace("\\", "/")
拒绝：空 / 以 "/" 开头 / 含 ":"（盘符）
分段丢弃 ""、"."，并且只要出现 ".." 就整体拒绝
target = (room_files_dir(workspace_root, context.extra["room_id"]) / rel).resolve()
再校验 target.relative_to(base) 且 context.is_path_safe(target)（工作区边界 + 非 C 盘）
```

**重要**：房间目录由 `context.extra["room_id"]` 决定，也就是 `worker.current_room_id`（回合期间由 `run_room_round` 设置）。因此在回合**之外**调用文件工具（无 `current_room_id`）时 `room_id` 为空串 → 基准目录变成 `<workspace>/rooms/files`，与解析到的房间不一致。重实现时建议改为用 `resolve_room` 得到的 `room.room_id`，并记录该偏差。

### 8.4 四个工具（`room_files.py`）

所有输出均为单行 JSON（`_payload`），所有房间解析都走 `resolve_room`（**显式传 `room_id` 时不做成员校验**）。

**`room_file_save`**（`is_mutating=True`）
- 参数：`filename`（相对名，允许 `a/b.md`）、`content`（UTF-8 文本）、`description=""`、`tags=[]`、`room_id?`。
- 行为：`mkdir -p` → `write_text(content, encoding="utf-8")` → `file_id = uuid4().hex[:8]` → `room.upsert_file(file_id, path=str(target), description, tags)`（内存 + `store.upsert_room_file`）。
- 事件：`room.{room_id}.file_saved`，**sender `"room_files"`**，payload `{"file_id","path","description"}`。
- 返回：`{"status":"saved","file_id","path","room_id"}` + `artifacts=[path]`。
- 失败文本：写失败 `"File write failed."`（output 里带异常串）；路径非法 `"Invalid relative filename (traversal or absolute path rejected)."` / `"Target path escapes the room file space."` / `"Target path is outside the workspace boundary."`。

**`room_file_read`**（`is_mutating=False`）
- 参数：`file_id`、`room_id?`。
- `room.file_index[file_id]` → `entry.path`；文件不存在或不安全 → `"Indexed file is missing or outside the workspace boundary."`；未知 id → `"Unknown file_id. Use room_file_list to see available files."`。
- 返回：**文件原文**（不是 JSON），`metadata={"file_id","path"}`。

**`room_file_list`**（`is_mutating=False`）
- 返回 `{"status":"listed","room_id","files":[entry.to_dict(), ...]}`，entry 键 `{file_id,path,description,tags,updated_at}`（顺序 = `file_index` 插入序）。

**`room_file_move`**（`is_mutating=True`）
- 参数：`file_id`、`new_filename`（相对）、`room_id?`。
- 校验：file_id 在索引里；源文件存在且安全；目标路径合法。
- 物理：`target.parent.mkdir(parents=True, exist_ok=True)` → `source.replace(target)`（`os.replace` 语义：同卷原子覆盖重命名）。
- 索引：`room.move_file(file_id, str(target))`：
  - `entry.path = new_path`，`entry.updated_at = now()`
  - `store.upsert_room_file(...)`（`room_files` 行 `path`/`updated_at` 刷新，`file_id` 不变）
  - **系统通知**（逐字）：
    `[文件位置变更] 群文件 {file_id}（{entry.description or '未描述'}）已从 {old_path} 移动到 {entry.path}，请使用 file_id 取用，勿再引用旧路径。`
  - 事件 `room.{id}.file_moved`，sender `"group_room"`，payload `{"file_id","old_path","new_path"}`（**无 name/description**）。
- 返回 `{"status":"moved","file_id","old_path","new_path","room_id","note":"新地址已广播给全体群成员。"}` + `artifacts=[new_path]`。

### 8.5 移动后的"实时同步"真实链路

1. 事件 `file_moved` → SSE → 前端可即时更新（`/api/events`，§11）。
2. 通知进入 `room.system_notices` → **下一次 `build_member_instruction` 时**进入每个发言者的 `=== 系统通知 ===` 段。
3. 每份指令里的 `=== 群文件空间 ... ===` 段都由**当前** `file_index` 重新渲染 → 新路径立刻体现。
4. 成员一律按 `file_id` 取文件：`room_file_read` 用索引里的最新 path，因此移动不破坏读取。
5. 若移动发生在回合中：只有**排在后面的**发言者能看到该通知；回合结束 `drain_notices()` 清空（DB 无该通知的持久行 —— 文件变更通知**不**写 `pending_notices`，只有小群完成通知写）。

---

## 9. Bot archetypes（`archetypes.py`）

`SubagentArchetype` 是 frozen dataclass，字段：`agent_type, display_name, description, when_to_use, system_prompt, default_model, allowed_tools(Optional[List[str]]), disallowed_tools(FrozenSet[str]), color, read_only, badge, tagline`（`archetypes.py:20-34`）。

注册表（`archetypes.py:273-281`）键：`explore / plan / general-purpose / general(别名) / teammate / boss / librarian`。查表 `get_archetype(name)` 做 `lower().strip()`，未知返回 `None`。

`create_subagent_config()`（`archetypes.py:289-349`）的派生规则：
- `allowed_tools` 非空 → 去掉 `disallowed_tools`；为空 → 用默认 7 件套 `["read_file","list_dir","grep_search","find_by_name","edit_file","write_file","shell"]` 再减 disallowed。
- `read_only=True` 或 mandate 已 read_only → 再剔除 `{"write_file","edit_file","shell","bash","powershell"}`。
- `agent_id = f"{agent_type}_{workspace[:8]}"`，`name = f"{display_name}Agent"`，`model = model_override or default_model`。
- `extra = {archetype, color, read_only, when_to_use, badge, tagline}`。

### 9.1 `explore` — Explore 🔍

| 项 | 值 |
|---|---|
| agent_type | `explore` |
| display_name | `Explore` |
| description | `Fast codebase exploration & research agent` |
| when_to_use | `Use this when you need to quickly find files by patterns (e.g. 'src/**/*.py'), search code for keywords (e.g. 'EventBus'), or answer architectural questions about the codebase. Operates in strict read-only mode using fast lightweight LLM configurations.` |
| default_model | `workbuddy/deepseek-v4.1-flash` |
| allowed_tools | `["read_file","list_dir","grep_search","find_by_name"]` |
| disallowed_tools | `{"write_file","edit_file","shell","bash","powershell"}` |
| color / badge / tagline | `cyan` / `🔍` / `只读代码探索员` |
| read_only | `True` |

system prompt（逐字）：

```text
You are an exploration and research agent for agentharness. Given the user or router directive, you should use the tools available to search and investigate the codebase. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and key findings.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use read_file when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless absolutely necessary.
- CRITICAL: You are running in read-only mode. All file modifications and shell execution are disallowed.
```

### 9.2 `plan` — Plan 📐

| 项 | 值 |
|---|---|
| agent_type | `plan` |
| display_name | `Plan` |
| description | `Software architect agent for designing implementation plans` |
| when_to_use | `Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs. Strictly read-only.` |
| default_model | `workbuddy/deepseek-v4.1-flash` |
| allowed_tools | `["read_file","list_dir","grep_search","find_by_name"]` |
| disallowed_tools | `{"write_file","edit_file","shell","bash","powershell"}` |
| color / badge / tagline | `blue` / `📐` / `架构规划师` |
| read_only | `True` |

system prompt（逐字）：

```text
You are a software architect and planning specialist for agentharness. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no write_file or file creation of any kind)
- Modifying existing files (no edit_file operations)
- Running destructive shell commands
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans.

## Your Process:
1. Understand Requirements: Focus on the requirements provided and analyze the technical constraints.
2. Explore Thoroughly: Read relevant files, find existing patterns and conventions, trace execution paths.
3. Design Solution: Create an implementation approach considering trade-offs and architectural decisions.
4. Detail the Plan: Provide a step-by-step implementation strategy, identify dependencies and sequencing.

## Required Output:
End your response with:
### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.py
- path/to/file2.py
- path/to/file3.py
```

### 9.3 `general-purpose` — General ⚙️

| 项 | 值 |
|---|---|
| agent_type | `general-purpose`（注册别名 `general`） |
| display_name | `General` |
| description | `General-purpose multi-step execution agent` |
| when_to_use | `General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Has access to full tooling including editing, file writing, and sandboxed shell execution.` |
| default_model | `workbuddy/deepseek-v4.1-flash` |
| allowed_tools | `None`（= 挂载全部允许工具） |
| disallowed_tools | `frozenset()` |
| color / badge / tagline | `yellow` / `⚙️` / `通用执行代理` |
| read_only | `False` |

system prompt（逐字）：

```text
You are an autonomous execution agent for agentharness. Given the user or router directive, you should use the tools available to complete the task.

# Tone and Style:
- Concise, short responses.
- Before your first tool call, state in one sentence what you are about to do.
- Keep text between tool calls to ≤25 words. Keep final responses to ≤100 words unless detail is requested.
- End-of-turn summary: one or two sentences. What changed and what's next.

# Coding Philosophy:
- Don't add features, refactor, or introduce abstractions beyond what the task requires.
- Three similar lines is better than a premature abstraction. No speculative abstractions.
- Don't add error handling or fallbacks for scenarios that can't happen. Trust internal code and framework guarantees.
- Always verify your changes before declaring completion.
```

### 9.4 `teammate` — Teammate 🧩

| 项 | 值 |
|---|---|
| agent_type | `teammate` |
| display_name | `Teammate` |
| description | `Collaborative peer agent for multi-agent rooms` |
| when_to_use | `Participates in collaborative multi-agent group discussions and peer review rounds.` |
| default_model | `workbuddy/deepseek-v4.1-flash` |
| allowed_tools | `None` |
| disallowed_tools | `frozenset()` |
| color / badge / tagline | `green` / `🧩` / `协作成员` |
| read_only | `False` |

system prompt（逐字）：

```text
You are a collaborative teammate agent participating in a multi-agent group room.
Operate sequentially within the speaking queue. Acknowledge fellow teammates with concise actionable insights.
Avoid repetitive conversational loops. Respect the group circuit breaker and room execution grace period.
```

### 9.5 `boss` — Boss 👑（群主 / Dispatch 编排者）

| 项 | 值 |
|---|---|
| agent_type | `boss` |
| display_name | `Boss` |
| description | `群聊编排者：路由任务、拉子会话、读取转录、向用户播报` |
| when_to_use | `每个群聊房间默认由 Boss 担任编排者；负责路由与汇报，不亲自执行。` |
| default_model | `workbuddy/deepseek-v4.1-flash` |
| allowed_tools | `["room_list_members","list_sessions","spawn_child_session","send_message","read_transcript","send_user_message","room_grant_permission","room_set_context_policy","room_file_list"]` |
| disallowed_tools | `{"write_file","edit_file","shell","bash","powershell","read_file","list_dir","grep_search","find_by_name"}` |
| color / badge / tagline | `amber` / `👑` / `编排者 · 只路由不执行` |
| read_only | `False`（但工具面被白名单限制） |

**注意**：`room_assign_task` / `room_create_subgroup` 被刻意排除在 boss 工具面之外（注释：会与 Dispatch 原语冲突并导致模型自读转录死循环）。boss 的 `mandate.max_iterations` 被压到 `min(旧值, 8)`（`runtime.py:334-336`）。

system prompt（逐字）：

```text
你是群聊房间的编排者（Dispatch orchestrator），不是执行者。

最重要的规则：
- 你**不亲自执行任务**：不要写文件、不要跑命令、不要做具体技术实现。
- 你**唯一的用户出口**是 send_user_message。普通 assistant 文本会被忽略，用户看不到。
- 子会话完成后，系统会把一条通知注入你的下一轮上下文；用 read_transcript 读取结果，
  再用 send_user_message 向用户汇报。

路由规则：
1. 新的独立目标 → spawn_child_session（标题 3–6 个词，brief 要自包含）。
2. 对已启动会话的追问、纠偏、补充 → send_message(session_id, message)。
3. 查看进度或结果 → read_transcript(session_id, max_wait_seconds)；必须带 session_id，
   不要读当前群（当前群的转录已经在本轮上下文里）。
4. 一条消息里包含多个独立目标 → 并行 spawn 多个子会话。
5. 需要治理房间时，用 room_list_members / list_sessions 查看现状，
   用 room_grant_permission / room_set_context_policy 调整权限与上下文策略。

重要：不要使用 room_assign_task / room_create_subgroup（已从你的工具面移除）。
分派后**立即**用 send_user_message 播报，不要在同一个回合里阻塞等待子会话；
子会话完成时系统会注入通知，你在后续回合再用 read_transcript 读取结果。
每轮最多调用一次 read_transcript；拿到结果后立即 send_user_message，然后结束回合。
同一回合多次 send_user_message 只会保留最后一条，不要用它刷进度。

播报要求：
- 分派后给用户一句简短播报：你做了什么、在等谁、预计产出是什么。
- 不要在播报里编造子会话还没产出的结论；没有结果就说"已派发，等待回报"。

你拥有最高权限，但不要滥用：静音/收回上下文只用于明确需要隔离的场景。
```

### 9.6 `librarian` — Librarian 🗂（群文件管家）

| 项 | 值 |
|---|---|
| agent_type | `librarian` |
| display_name | `Librarian` |
| description | `群文件管家：整理群文件空间、维护索引、文件地址变更实时同步` |
| when_to_use | `群聊房间需要共享文件空间时加入；负责归档与路径变更通知。` |
| default_model | `workbuddy/deepseek-v4.1-flash` |
| allowed_tools | `["room_file_save","room_file_read","room_file_list","room_file_move","read_file","list_dir"]` |
| disallowed_tools | `{"write_file","edit_file","shell","bash","powershell"}` |
| color / badge / tagline | `teal` / `🗂` / `群文件管家 · 地址同步` |
| read_only | `False`（`room_role=True` 时 mandate.read_only 强制 False） |

system prompt（逐字）：

```text
你是群聊房间的文件管家（Librarian），负责管理群文件空间。

你的职责：
1. 用 room_file_save 把成员产出的文档保存到群文件空间，文件名要清晰规范（如 reports/周报-2026-11.md）。
2. 用 room_file_list 维护文件索引；用 room_file_read 按 file_id 核对内容。
3. 需要归档、重命名时，用 room_file_move 移动文件：系统会自动把新地址广播给全体成员并写入系统通知，永不出现"找不到文件"。
4. 提醒所有成员：一律使用 file_id 引用文件，不要硬编码绝对路径，因为路径可能由你调整。

工作方式：
- 只管理群文件空间内的文件，不要越界到工作区其他目录。
- 每次保存/移动后用一句话说明文件清单的变化。
- 保持简洁，不做与文件管理无关的技术实现。
```

### 9.7 runtime 里另外两个默认 worker（不在注册表内）

`_initialize_default_workers`（`runtime.py:242-265`）创建：

| bot_id | role | mandate | system prompt |
|---|---|---|---|
| `coder` | `coder` | 默认 mandate：`["read_file","write_file","edit_file","list_dir","grep_search","find_by_name","shell"]`，`read_only=False`，`max_iterations=30`，`timeout_seconds=120` + 扩展加入 `skill_list`,`skill_invoke` | 无（`AgentConfig.system_prompt=None`，因此 `message_history` 里没有 system 消息） |
| `reviewer` | `reviewer` | `["read_file","list_dir","grep_search","find_by_name","room_file_read","room_file_list","skill_list","skill_invoke"]`，`read_only=True` | 见下 |

reviewer prompt（逐字，由三行字面量拼接，实际含一个 `\n`）：

```text
你是团队的审查员（Reviewer），负责独立核验产出，不下场代做。
核验时按 file_id 使用 room_file_read 读取群文件，或用 read_file 读取工作区文件；不要用 shell 做文件检查。逐项给出「通过 / 需修改」与证据，结论先行，简洁。
```

实现细节：设置 `reviewer.config.system_prompt` 后，仅在 `message_history[0]["role"] == "system"` 时覆盖其内容；由于该 worker 构造时 `system_prompt` 为 `None`，`message_history` 为空，所以**这条 prompt 只进了 config，没进消息历史**（`runtime.py:256-262`）。archetype worker 则显式 `insert(0, {"role":"system", ...})`（`runtime.py:311`）。

`_ensure_special_worker(archetype_name, room_role=False)` 的落地规则（`runtime.py:267-321`）：

```
allowed_tools = archetype.allowed_tools or ["read_file","write_file","edit_file","list_dir","grep_search","find_by_name"]
room_role=True → allowed_tools 追加(去重保序) ["room_file_save","room_file_read","room_file_list","room_file_move"]
mandate.allowed_tools = allowed_tools
mandate.read_only = False if room_role else archetype.read_only
worker = WorkerAgent(bot_id=archetype_name, role=archetype_name, mandate, registry, llm, event_bus, store,
                     mailbox=AgentMailbox(bot_id, event_bus))
worker.config.system_prompt = archetype.system_prompt
worker.config.name = archetype.display_name
worker.message_history.insert(0, {"role":"system","content":archetype.system_prompt})
worker.mount_tools(list(mandate.allowed_tools))
_attach_worker_extensions(worker)          # + skill_list / skill_invoke（进 mandate 与 mounted_tools）
if boss: _apply_boss_orchestrator_policy(worker)   # mandate.allowed_tools=ARCHETYPE.allowed_tools,
                                                   # read_only=False, max_iterations=min(…,8),
                                                   # mount_tools(该白名单)
```

---

## 10. 单个 bot 的回合（`worker.py`）

### 10.1 系统提示的构成

- `BaseAgent.__init__`：若 `config.system_prompt` 非空，`message_history.append({"role":"system","content":system_prompt})`（`base.py:94-95`）。
- archetype worker：由 `_ensure_special_worker` 显式插到 `message_history[0]`。
- 其余 worker（coder/reviewer）：构造时无 system prompt；`reviewer` 的 prompt 只落在 `config.system_prompt`（见 §9.7）。
- **每轮房间指令是 `role="user"` 消息**（不是 system），追加到历史尾部（`worker.py:212`）。
- 上下文压缩：`if self.compactor.should_compact(self.message_history): self.message_history, _ = compactor.compact(..., active_task_summary=instruction)`（`compact_threshold_ratio = 0.75`，`max_context_tokens` 默认见 `compactor.py`）。

### 10.2 工具面

```python
tool_schemas = self.registry.get_schemas(allowed_tools=self.mounted_tools) if self.mounted_tools else None
```

- 只挂 `mounted_tools` 里的工具；空列表 → `tools=None`（模型不能调工具）。
- 实际执行前 `invoke_tool` 再查一次：不在 `mounted_tools` → `ToolResult(success=False, error=f"Tool '{name}' is not mounted on this session.")`。
- `ToolRegistry.execute` 还有 mandate 级检查：`mandate.read_only and tool.is_mutating` → `Permission denied: Tool '<name>' is a mutating tool (is_mutating=True) and is prohibited under read_only mandate.`；超时用 `mandate.timeout_seconds` 包 `asyncio.wait_for`。

### 10.3 `run_turn(instruction)` 时序（`worker.py:95-201`）

1. `set_state(WORKING)` → 事件 `agent.{bot_id}.state_changed{"old_state","new_state"}`。
2. `worker.{bot_id}.turn_started`，payload `{"instruction": instruction}`（**全文，不截断**）。
3. `emit_heartbeat()` → `worker.{bot_id}.heartbeat{"worker_id", "assignment_id"?, "ticket_id"?}` + `store.update_assignment_heartbeat(...)`（有 assignment 时）。
4. mailbox 有 steering → `instruction = f"{instruction}\n[Steering Directive]: {steer.payload['instruction']}"`。
5. `output_text = await _execute_instruction(instruction)`。
6. 跟进队列：最多 `max_followups_per_turn = 10` 条，逐条取 `mailbox.fetch_next_nowait()`，非空 `instruction` 才跑；每条发 `worker.{bot_id}.followup_started{"sender","instruction"[:200]}`，指令前缀为 `f"[Follow-up from {sender}]: {instruction}"`；结果按 `"\n".join([主输出] + followups)` 合并。
7. `set_state(IDLE)` → heartbeat。
8. `worker.{bot_id}.turn_completed`，payload `{"output": output_text}`。
9. `context.stats.updated`，payload：
   `{"thread_id"(可空), "bot_id", "active_tokens", "usage_percentage", "distribution":{system,user,assistant,tool}, "last_turn":{prompt_tokens, completion_tokens, cache_read_tokens, cache_hit_rate}}`。

### 10.4 `_execute_instruction` 工具循环（`worker.py:203-305`）

```python
self.message_history.append({"role": "user", "content": instruction})
for _ in range(mandate.max_iterations):
    # 每轮先检查 mid-turn steering → append {"role":"system","content":f"[Mid-turn Steering Interrupt]: ..."}
    resp = await self.llm.generate(prompt=instruction, messages=self.message_history,
                                   tools=tool_schemas,
                                   model=self.config.model, temperature=float(self.config.temperature))
    content = getattr(resp, "content", None) or ""
    if content: output_text = content
    tool_calls = getattr(resp, "tool_calls", [])
    self.message_history.append({"role":"assistant", "content": content,
                                 **({"tool_calls":[tc.to_dict() for tc in tool_calls]} if tool_calls else {})})
    if not tool_calls: break
    has_error = False
    for tc in tool_calls:
        await self.emit_heartbeat()
        tool_res = await self.invoke_tool(tc.name, tc.arguments)
        self.message_history.append({"role":"tool", "tool_call_id": tc.call_id, "name": tc.name,
                                     "content": tool_res.output if tool_res.success else f"ERROR: {tool_res.error}"})
        if not tool_res.success:
            consecutive_tool_failures += 1
            output_text = f"Tool failure: {tool_res.error}"
            if consecutive_tool_failures >= self.max_consecutive_tool_failures:   # 默认 3
                has_error = True
            break                       # 一个失败就跳出本批工具
        else:
            consecutive_tool_failures = 0
            last_successful_tool_result = tool_res.output or ""
    if has_error: break
if not output_text and last_successful_tool_result:
    output_text = last_successful_tool_result[:2000]
return output_text
```

- `max_consecutive_tool_failures` 默认 `3`（`WorkerAgent(..., max_consecutive_tool_failures=3)`，`max(1, …)`）。
- 一次失败不会立刻杀回合（错误文本已进历史，模型可自我修复）；连续 3 次才 break。
- 最终输出为**模型最后一段有内容的 assistant 文本**；若模型最后一步只有工具调用，则回退到"最后一次成功的工具输出前 2000 字"。

### 10.5 工具调用事件的发布（`base.py:128-231` + `registry.py:274-392`）

- `agent.{bot_id}.tool_invoked`：`{"tool", "args": {k: str(v)[:200]}, "tool_use_message", "is_concurrency_safe"}`（sender = bot_id）
- `agent.{bot_id}.tool_result`：`{"tool", "success", "error", "tool_result_message"}`（sender = bot_id）
- `tools.{tool_name}.invoking`：`{"tool","ticket_id","args","tool_use_message","is_concurrency_safe"}`（sender `"tool_registry"`）
- `tools.{tool_name}.completed`：`{"tool","ticket_id","duration_ms","is_background","job_id","tool_result_message"}`
- `tools.{tool_name}.error`：`{"tool","ticket_id","error","duration_ms","tool_result_message"}`（超时文案：`Tool '<name>' timed out after <n>s (mandate limit).`）
- `ToolContext` 传参：`worker_session_id = agent_id`，`extra = {"llm","registry","worker","room_id": getattr(self,"current_room_id",None),"hook_engine","skill_manager"}`（`base.py:165-179`）。**房间工具靠 `extra["room_id"]` 自动定位房间**。

### 10.6 流式输出的事实

Python 版**没有 token 级流式事件**：没有 `*_delta` / `chunk` topic。UI 能拿到的粒度是：

- 整轮文本：`worker.{bot_id}.turn_completed{"output"}`
- 每次工具调用：`agent.*.tool_invoked` / `agent.*.tool_result` / `tools.<name>.invoking|completed|error`
- 状态：`agent.{bot_id}.state_changed`
- 转录落库：`room.{id}.turn_completed`

SSE 传输形状（`server.py:878-921`）：`GET /api/events`，每帧 `data: {"topic":...,"sender":...,"payload":...}\n\n`（**无 `event:` 名、无 `id:`**），空闲 15s 发 `: keepalive`。事件同时落库，可用 `GET /api/thread/{thread_id}/events?after_seq=&limit=` 回放；`room.*` 事件的 `thread_id` 由 `_persist_events` 归到 `room:<room_id>`（`runtime.py:769-773`）。

（Node 端口若用 pi 的 `text_delta` 做真流式，属于**增强**：需新增 topic 并在前端归约，不能替代上述契约事件。）

---

## 11. 事件总表（topic + payload 键）

### 11.1 房间事件（`room.<room_id>.<kind>`）

| topic 后缀 | sender | 触发点 | payload 键（精确） |
|---|---|---|---|
| `member_mentioned` | `group_room` | 每次 @提及成功插队 | `speaker`, `mentioned` |
| `circuit_breaker_reset` | `group_room` | user 指令进入房间 | `reset_by` |
| `circuit_breaker_tripped` | `group_room` | `relays >= relay_limit` | `relays`, `limit` |
| `late_reply_deferred` | `group_room` | `advance_turn(is_long_tool=True)` | `speaker`, `content`, `kind`, `timestamp`（扁平，即 late_record） |
| `turn_completed` | `group_room` | 每次成功 `advance_turn` | `speaker`, `content`, `kind`, `relays`, `timestamp` |
| `permission_changed` | `group_room` | `set_permission` | `member`, `permissions`（四字段对象） |
| `context_policy_changed` | `group_room` | `set_context_policy` | `policy` |
| `task_assigned` | `group_room` | `add_assignment` | `member`, `task`（≤400 字） |
| `assistant_message` | `group_room` | `send_user_message`（立即或 flush） | `speaker`, `content`, `kind`（恒 `"user_visible"`） |
| `file_moved` | `group_room` | `move_file` | `file_id`, `old_path`, `new_path` |
| `file_saved` | **`room_files`** | `room_file_save` | `file_id`, `path`, `description` |
| `round_started` | `group_room` | 回合开始 | `instruction`(≤500), `members`(数组), `orchestrator_mode` |
| `member_started` | `group_room` | 每个成员开始 | `member` |
| `member_finished` | `group_room` | 每个成员结束（finally，异常也发） | `member` |
| `orchestrator_no_announcement` | `group_room` | dispatch owner 本轮无可见播报 | `member` |
| `round_completed` | `group_room` | 回合收尾（finally，异常也发） | `speakers`(数组，顺序=set 迭代序), `paused`(bool), `spawned_children`(数组) |
| `child_spawned` | `group_room` | `spawn_child_session` 工具（**不是** `room_create_subgroup`） | `parent_room_id`, `session_id`, `title`, `members` |
| `subgroup_report` | `group_room` | 子群回投父群 | `sub_room_id`, `topic`, `report`(≤2000) |
| `updated` | **`server`** | `PUT /api/rooms/{id}` | 完整 `room.to_dict()` |

### 11.2 非房间事件（同一次房间活动会带出的）

| topic | sender | payload 键 |
|---|---|---|
| `harness.room.created` | `runtime` | `room_id`, `members`, `owner_id`, `title` |
| `session.child.completed` | `runtime` | `parent_session_id`, `session_id`, `title`, `status` |
| `worker.<bot_id>.turn_started` | bot_id | `instruction` |
| `worker.<bot_id>.followup_started` | bot_id | `sender`, `instruction`(≤200) |
| `worker.<bot_id>.turn_completed` | bot_id | `output` |
| `worker.<bot_id>.heartbeat` | bot_id | `worker_id`, `assignment_id`?, `ticket_id`? |
| `agent.<bot_id>.state_changed` | bot_id | `old_state`, `new_state` |
| `agent.<bot_id>.tool_invoked` | bot_id | `tool`, `args`, `tool_use_message`, `is_concurrency_safe` |
| `agent.<bot_id>.tool_result` | bot_id | `tool`, `success`, `error`, `tool_result_message` |
| `tools.<tool_name>.invoking` | `tool_registry` | `tool`, `ticket_id`, `args`, `tool_use_message`, `is_concurrency_safe` |
| `tools.<tool_name>.completed` | `tool_registry` | `tool`, `ticket_id`, `duration_ms`, `is_background`, `job_id`, `tool_result_message` |
| `tools.<tool_name>.error` | `tool_registry` | `tool`, `ticket_id`, `error`, `duration_ms`, `tool_result_message` |
| `context.stats.updated` | bot_id | `thread_id`, `bot_id`, `active_tokens`, `usage_percentage`, `distribution`, `last_turn` |

### 11.3 订阅/回放

- SSE 订阅 `"**"`（全部事件）；`room.*` 落库时 `thread_id = "room:<room_id>"`（无 payload.thread_id 时）。
- HealthBoard 消费 `room.*.circuit_breaker_tripped` 与 `room.*.circuit_breaker_reset` 做健康统计（`health.py:65-71`）。

---

## 12. 重实现核对清单（易错点）

1. `allowed_tools`（工具参数）vs `allowed_tool_overrides`（权限字段）**键名不一致**，Python 版后者永不被工具更新。
2. `mount_tools` 用**当前** mandate 过滤 → 授权只能收窄；`mount_tools([])` 后无法靠授权恢复。
3. `resolve_room`：显式传 `room_id` 时**不校验成员身份**；省略时依次用 `context.extra["room_id"]` → 唯一所属房间 → 报错（`ERR_MULTIPLE_ROOMS` / `ERR_NOT_MEMBER` / `ERR_NO_ROOM` / `ERR_ROOM_NOT_FOUND`）。
4. `_owner_gate` 在 `owner_id is None` 时对**任何人**放行。
5. `assigned_mode` 一旦置位本轮不复位 → 分派回合在分派者跑完后即结束。
6. 熔断状态不落库、重启恢复为 `active`；`relay_limit` 在构造时按成员数冻结。
7. 恢复的转录行丢失 `kind` 与 `relays`。
8. `@` 正则只认 ASCII；已被 `seen` 的成员不会再发言。
9. `read_transcript` 拒绝群主读**当前**房间（明确报错引导用 `session_id`）；`max_wait_seconds` 被 `min(…, 30)` 截断。
10. 系统通知是房间级且每轮结束清空：中途产生的通知只对后续发言者可见；文件变更通知不落 `pending_notices`，小群完成通知落。
11. `round_completed.speakers` 来自 `set`，顺序不保证与发言顺序一致（实现时建议改为按发言顺序，并在文档标注）。
12. `advance_turn` 在"已暂停"时返回 `{"error": ...}`（无 `status`），回合器只对 `{"status":"paused"}` 断轮。
13. `render_transcript("full")` 预算按字符、不含 `\n`、单行不截断；`summary` 每条截 300 字；两者都不过滤 `kind`。
14. 文件工具的房间目录取自 `context.extra["room_id"]`（回合内 = 当前房间），回合外为空 → `<ws>/rooms/files`。
15. `Path.replace` = `os.replace`，跨卷会失败（`OSError` → `"File move failed."`）。
16. `room_messages.seq` 是应用层 `MAX(seq)+1`，并发回合可能撞主键。
17. 所有工具输出为单行 JSON（`ensure_ascii=False`）；`room_file_read` 例外，输出文件原文。
18. 所有房间事件 `sender` 为 `"group_room"`；两处例外：`file_saved` → `"room_files"`，`room.{id}.updated` → `"server"`，`harness.room.created`/`session.child.completed` → `"runtime"`。
19. `grace_ms`/`late_replies`/`drain_late_replies` 是 DS-Bot 遗留原语，房间回合从不传 `is_long_tool=True`，因此实际不会产生 `late_reply_deferred`。
20. `CollaborativeGroupRoom.begin_round/end_round` 与 `pending_rounds` 的配对只由 `room_say` / `create_subgroup` / `follow_up_child_session` 维护；直接 `await run_room_round(...)` 时 `pending_rounds` 不减（`max(0, …)` 兜底）。

---

### 附：一轮的典型事件序列（dispatch 群主 + 分派）

```
room.<id>.circuit_breaker_reset {reset_by:"user"}
room.<id>.turn_completed        {speaker:"user", kind:"user", relays:0, ...}
room.<id>.round_started         {instruction≤500, members, orchestrator_mode:"dispatch"}
room.<id>.member_started        {member:"boss"}
  worker.boss.turn_started / agent.boss.tool_invoked(spawn_child_session) / ...
  room.<id>.assistant_message   {speaker:"boss", kind:"user_visible"}   ← flush
  room.<id>.turn_completed      {speaker:"boss", kind:"user_visible", relays:1}
room.<id>.orchestrator_no_announcement {member:"boss"}                 ← 若没播报
room.<id>.member_finished       {member:"boss"}
room.<id>.member_started        {member:"coder"}
  worker.coder.turn_started / tools.room_file_save.invoking / .completed
  room.<id>.file_saved          {file_id, path, description}
  room.<id>.turn_completed      {speaker:"coder", kind:"assistant", relays:2}
room.<id>.member_finished       {member:"coder"}
room.<id>.round_completed       {speakers:[...], paused:false, spawned_children:[...]}
```
