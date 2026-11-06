# 持久记忆（memory）：Hermes → AgentFusion

> 参考源码：`reference/hermes/hermes-agent`，commit `ca43606`（2026-11-05），MIT。行号以该快照为准；
> fusion 侧行号会随并行编辑漂移，请用函数名定位。
> 交付：`src/memory.js`、`tests/memory.test.mjs`、本文档。表前缀 `mem_*`，运行时只用 Node 内置模块。

## 1. Hermes 里是什么

1. **两个库、两种目标。** `memory`（个人笔记：环境/约定/工具怪癖/教训）与 `user`（用户画像：名字/角色/偏好/风格）；
   工具只有一个 `target` 参数，值域写死在 `tools/memory_tool.py:331-335`。schema 明说"记忆每轮注入，必须小且高信号"
   （`tools/memory_tool.py:373-397`）。
2. **一条记忆 = 一条事实。** 条目用 `\n§\n` 分隔（`tools/memory_tool_store.py:26`），整库字符上限 2200 / 1375
   （`:188-195`）；`add` 对完全相同的条目幂等跳过（`:527-529`）。
3. **注入 = 冻结快照 + 每回合召回块。** MEMORY.md/USER.md 在会话开始时拍快照进系统提示，中途写入不改提示以保
   prompt 前缀缓存（`tools/memory_tool_store.py:649-652`）；检索到的召回内容另走 `<memory-context>` 围栏
   （`agent/memory_context.py:169-185`），并删掉块内重复 bullet（`:123-166`）。
4. **写入有闸门。** `_apply_write_gate` 把 add/replace/remove/patch 交给 write_approval，返回允许/拒绝/挂起
   （`tools/memory_tool.py:131-140`、`:84-102`）；回放挂起写时用 `matched_entry` 钉住审批时看到的那一条，条目变了
   就拒绝（`apply_memory_pending`，`:353-370`）。
5. **破坏性操作有单独地板。** `destructive_ops()` 列出 replace/remove/patch；无人值守的后台 review fork 里这些操作
   只能挂起、不能落地（`tools/memory_tool.py:173-176`、`:179-219`）。
6. **批量原子，预算只看最终态。** 一次调用可以"删旧的 + 加新的"，上限只在批量结果上检查，任何一步失败整批不写
   （`tools/memory_tool_store.py:576-647`，预算检查 `:618-629`）。
7. **old_text 容错匹配。** 引号/破折号/空白折叠后比对，"整条精确匹配"优先于子串，歧义时报错而不是猜
   （`:80-109`）。
8. **中文/短词的退化路径。** trigram 要求每词 ≥3 字符，1–2 字 CJK 词只能掉到 LIKE 全表扫（`hermes_state_fts.py:34-40`）；
   Hermes 用外挂 `cjk_unicode61` 分词器解决（`:113-128`），拿不到扩展时由路由层回退 `like_scan`
   （`hermes_state_search.py:1104-1119`）。
9. **FTS 是外部内容表 + 触发器。** `content=` 指向视图，三个触发器维护索引（`hermes_state_fts.py:41-98`）；
   查询前先清洗 FTS5 特殊字符（`hermes_state_search.py:1012-1046`），MATCH 失败则 fail-open（`:1137-1144`），
   LIKE 回退的 SQL 形状见 `:143-151`。

## 2. 为什么值得抄

- 群聊里每个成员每回合都从零认识世界：**房间事实、项目约定、用户偏好**必须跨回合存活。
- 群聊是多 agent 共享会话，**"谁在哪个房间记了什么"必须可审计、可删除**；Hermes 的 memory/user 边界 + 写入闸门
  正是这个问题的答案。
- 我们的检索场景就是中文：**FTS5 默认分词对中文子串无效**，没有退化路径时"记了却搜不到"会直接劝退用户。
- 上下文预算是硬约束：**置顶优先 + 按预算截断**比"全塞进去"更贴近真实模型窗口。

## 3. 我们落地成什么

### 3.1 接口（与 CONTRACT §3.4 一致，★ 为叠加项）

```js
createMemory({ store, now = () => Date.now() }) -> Memory
save({ scope = "room", roomId = null, botId = null, target = "memory", content, tags = [], pinned = false,
       source = "agent" }) -> entry & { deduped }        // 同归属下高相似内容会合并，deduped: true
replace(id, { content, tags, pinned }) -> entry
remove(id) -> { ok, removed } | { ok: false, error }     // ★ remove(id, { source, reason }) 留痕
get(id) -> entry | null
list({ scope, roomId, botId, target, limit = 100 }) -> entry[]
search({ query, scope, roomId, botId, limit = 10 }) -> [{ entry, score }]
                                                         // ★ searchDebug(...) -> { path: fts|like|none|empty, hits }
contextBlock({ scope = "room", roomId, botId, budgetChars = 2000 }) -> string
audit({ limit = 50 }) -> row[]
stats() -> { total, pinned, byScope }
★ clear({ scope, roomId, botId, source, reason }) -> { ok, removed }   // 删除房间/机器人时批量清理
★ rebuildFts() -> { ok }                                              // 索引重建（修库/运维）
```
`entry` 为驼峰：`{ id, scope, roomId, botId, target, content, tags, pinned, source, createdAt, updatedAt }`。
`createMemory` 还接受 `halfLifeDays`（默认 30）、`pinnedBonus`（0.25）、`decayWeight`（0.15）、
`dedupeThreshold`（0.85）四个可选参数。

### 3.2 表

```sql
mem_entries(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, scope, room_id, bot_id, target, content,
            tags_json, pinned, source, created_at, updated_at)
mem_fts     -- FTS5 外部内容表：content='mem_entries', content_rowid='seq',
            -- tokenize='unicode61 remove_diacritics 2'；ai/ad/au 三个触发器同步
mem_audit(id, entry_id, action, scope, room_id, bot_id, target, source, reason, detail_json, ts)
```
首次打开时若本地 kv 标记 `mem:fts_rebuilt:v1` 缺失，执行一次 `INSERT INTO mem_fts(mem_fts) VALUES('rebuild')`
（对齐 Hermes 的 rebuild 入口）；触发器让"直接 SQL 改库"也保持索引一致（有测试）。

### 3.3 关键语义（采纳 / 改写 / 不采纳）

- **采纳**：一条事实一条记录（`§` 语义）、target 二值、`add` 幂等 → `save` 去重、外部内容表 + 触发器、首开重建。
- **改写**：MEMORY.md 文件 + 文件锁 → SQLite 表（`node:sqlite` 自带 WAL；`src/store.js:124-126`）。
- **改写**：CJK bigram 扩展 → "FTS 优先 → LIKE 子串 + 二元组打分"（无扩展环境下唯一可行路径）。
- **改写**：`old_text` 定位 → 按 `id` 定位：群聊的写入方是模型与 HTTP，id 比"模型重述原文"可靠；`replace`/`remove`
  都要求显式 id。
- **不采纳**：审批挂起/回放（`apply_memory_pending`）——属于 `src/approval.js` 的职责；本模块只保证 `remove`
  留下 `source`/`reason` 并写 `mem_audit`（见 §6 第 2 条）。
- **不采纳**：磁盘记忆文件、`.bak` 漂移备份——群聊形态没有"用户手改记忆文件"的入口。

### 3.4 排序与检索

`score = 相关度 + (pinned ? 0.25 : 0) + 0.15 × 0.5^(age / 30d)`；半衰期可配，时间基准是注入的 `now()`。
- 相关度：整串子串命中 = 1；否则 `0.9 × max(二元组覆盖率, 词覆盖率)`（中文二元组、英文词）；单字/单词只认子串。
- 候选：FTS5 MATCH（逐词加引号，ASCII 词加前缀星）→ 零命中或全部不可评分时退 LIKE（整串 + 二元组 OR，≤6 词）。
- 去重：同 `scope+room+bot+target` 内 `similarity ≥ 0.85`（bigram Dice / 词 Jaccard）**或**"包含关系且短的一半以上
  被包含"即合并；新内容是超集时采用新文本，否则保留原文只刷 `updated_at`（避免静默丢细节）。
- `filters` 把归属维度绑定到 scope：`global` 忽略 roomId/botId、`room` 只认 roomId、`bot` 只认 botId——房间工具与
  HTTP 层习惯三个参数一起传，这里负责归一。

## 4. 与 Hermes 的差异与取舍

- **规模**：Hermes 相关文件 477 + 740 + 956 + 185 + 582 + 1562 行；我们 530 行（51 行注释 + 54 空行 + 425 行代码）。
  **超出契约 §0.6 的 400 行目标 130 行**：中文双路径检索、评分、去重、审计、上下文块都在一个文件里。若必须达标，
  可把 `contextBlock` 渲染拆成独立模块（本轮遵守"只新建指定文件"的约束，没有拆）。
- **运行时**：无 fcntl/msvcrt、无文件锁；单进程 + SQLite 单写者 + WAL（`src/store.js:124-126`）。
- **不冻结快照**：Hermes 冻结是为 prompt 前缀缓存（单会话、单 system prompt）；群聊每回合重拼 `buildInstruction`，
  记忆块属于"回合上下文"而非 system prompt（`src/rooms/room.js:447-471`），所以每回合现取（`src/rooms/room.js:479-480`）。
- **contextBlock 只取单一 scope**：Hermes 的 `build_system_prompt` 把多个 provider 块拼接
  （`agent/memory_manager.py:350-354`）；我们把拼接留给调用方（room → bot → global），避免拼接后同一条记忆出现两次。
- **不脱敏**：Hermes 在 provider 出站前 `_redact_for_provider`（`agent/memory_manager.py:99-135`）；我们的记忆只落
  本地库、不发外部 provider，本轮不做；若将来同步到外部 provider 需要补。
- **去重比 Hermes 激进**：Hermes 的 `add` 只做完全相等幂等（`memory_tool_store.py:527-529`），我们放宽到"高度相似"，
  因为群聊里模型每次重述同一事实的措辞都不同。

## 5. 验证证据

```
cd D:\能力测试\fusion
node --test tests/memory.test.mjs
# ℹ tests 21   ℹ pass 21   ℹ fail 0   ℹ duration_ms ~1000
```
21 个用例覆盖：save/get 默认值、非法入参、list 过滤与置顶排序、英文 FTS（前缀、词序无关）、中文 LIKE 退化与整段
token、触发器同步（直接 SQL 插入/更新/删除）、FTS 特殊字符不炸、pinned 加成、时间衰减（半衰期可配）、去重
（相似/超集/非超集）、replace、remove 留痕、clear 批量清理、contextBlock 严格 scope + 三段拼接不重复、预算截断
计数、audit、stats、跨重开持久化、FTS 重建。

集成烟测（与仓库里已落地的接入一起跑通）：
- `createRoomTools({ room, botId, memory })` 暴露 `memory` 工具，save/search/list/remove 跑通（`src/rooms/tools.js:350-442`）。
- `createApp()` 后 `app.wiring.memory === "ok"`，`app.memory` 可读写（`src/api/server.js:549-563`）。
- `node --test` 全量：147 项全绿（含本模块 21 项）。

## 6. Lead 接入清单

已落地（合并后请抽查）：
1. `src/api/server.js:549-563`：`createApp` 里 `createMemory({ store: app.store })`，注入 `app.memory` 并记 `wiring.memory`。
2. `src/api/server.js:2304`、`:2628-2683`：`GET/POST /api/memory`、`GET /api/memory/search`、`GET /api/memory/audit`、
   `DELETE /api/memory/{id}`。
3. `src/rooms/room.js:346/375`（构造器与 runner 传入）→ `:454-471 memoryBlock()` → `:479-480` 注入 `buildInstruction`
   （room 1400 / bot 800 / global 600 字符预算）。
4. `src/rooms/tools.js:350-442 memoryTools()`、`:451/479` 接入 `createRoomTools({ memory })`；
   `src/toolsets.js:83-84` 的 `memory` 工具集已声明该工具名。

待 Lead 决策/建议：
1. **房间删除后的记忆清理**：`store.deleteRoom()` 不碰 `mem_entries`。建议在 RoomManager 删房间的路径上调用
   `memory.clear({ scope: "room", roomId, source: "system", reason: "房间已删除" })`（已提供，逐条写审计）。
2. **破坏性操作挂审批**：若 `src/approval.js` 要拦 agent 的 `remove`，在 `memoryTools` 的 remove 分支先
   `approval.evaluate({ tool: "memory", input: { action: "remove", id } })`；需要 `createRoomTools` 把 approval 传进
   `memoryTools`（现状未注入，`src/rooms/tools.js:350` 只收 `memory/roomId/botId`）。
3. **记忆管理 UI**：`GET /api/memory` 已返回 `entries + stats`；置顶/编辑建议加 `PATCH /api/memory/{id}`（映射到
   `replace`），当前 HTTP 层只有 GET/POST/DELETE。
4. **search 的 target 过滤**：`/api/memory/search` 目前没透传 `target`；前端若要"事实/偏好"分列表，加一个 query
   参数即可（模块已支持）。
5. **e2e**：建议 Lead 补一条 server 层用例覆盖 `POST /api/memory` → `GET /api/memory/search` → `DELETE`，与模块单测互补。
6. **行数决策**：是否接受 530 行（超 §0.6 的 400 行），或在下一轮把 `contextBlock` 渲染拆出独立模块。
