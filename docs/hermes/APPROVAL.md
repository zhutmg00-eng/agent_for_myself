# 审批分层（approval）· Hermes 语义移植

> 目标工程：`D:\能力测试\fusion`（pi 内核 + 群聊多智能体）。
> 参考源码（只读）：`D:\能力测试\reference\hermes\hermes-agent`（commit `ca43606`）。
> 交付：`src/approval.js` + `tests/approval.test.mjs`（24 用例全绿）+ 本文。
> 一句话：把 Hermes「硬地板先于 yolo、三态授权、拒绝熔断、裁决留痕」的四层语义，落成一个
> 纯确定性、可阻塞等待、可审计的 JS 模块，接在 pi 的 `tool_call` 之前。

## 1. Hermes 里是什么

1. **三种审批模式**：`manual`（默认）/`smart`/`off` —— `tools/approval_context.py:263` 定义
   `_VALID_MODES`，`:294-302` 读取全局配置或**房间策略**（`room_policy.approval_mode`）。
2. **yolo 冻结 + 地板优先**：`--yolo` 在 import 时冻结成 `_YOLO_MODE_FROZEN`（`tools/approval.py:46-48`，
   防止技能运行期改环境变量提权）；`_floor_block` 在 yolo / `mode=off` 之前执行（`approval.py:1151-1174`，
   调用点 `:1188`、`:1247`）。
3. **硬地板清单**：`detect_hardline_command`（`tools/approval_detection.py:365-390`）匹配
   `HARDLINE_PATTERNS`（`:124-157`）：`rm -rf /`、系统目录递归删除、home、`mkfs`、`dd of=/dev/*`、
   fork bomb、`kill -1`、`shutdown/reboot`、`systemctl poweroff`；命令位置前缀 `_CMDPOS` 在 `:99-103`，
   引号里的同形文字不算命令。
4. **三态授权**：`_session_approved`（`approval.py:55`）+ 永久白名单（`:60`）；
   `_approval_scope` 返回 `permanent`/`session`（`:394-407`）；`_persist_choice` 里 `once` 什么都不存，
   `session` 只存会话，`always` 同时写永久 allowlist（`:436-449`、`:422-425`）。
5. **永久白名单持久化**：`_read_permanent_allowlist`（`approval.py:454-484`）/
   `save_permanent_allowlist`（`:505`）/ `_sync_permanent_from_disk`（`:376-391`，手改配置即时生效）。
6. **拒绝熔断**：`_denial_tally`（`approval.py:70`），阈值默认 3、`0` 关闭（`:74-79`），
   连续拒绝累加（`:82-90`）、任何批准清零（`:93-96`、`:590-593`）；`_denial_breaker_addendum`
   追加 “CIRCUIT BREAKER … STOP attempting variations”（`:99-117`）；smart 自动拒绝也计数（`:863`）。
7. **pattern_key**：危险检测直接返回**类别描述**作为 pattern_key（`approval_detection.py:1917-1919`，
   `_iter_dangerous_descriptions` 在 `:1869-1875`），因此「同类操作」复用一次批准。
8. **挂起 + 留痕**：`submit_pending`（`approval.py:270-273`）、网关队列与 `/approve` `/deny`
   （`:128-178`）、`clear_session` 撤回全部会话态（`:312-334`）；`approval_provenance.py:1-8`
   定义「为什么这条命令没弹窗就跑了」，`:11-18`/`:30-49` 生成来源文案。
9. **smart 是辅助 LLM**：`_smart_approve` 调 `call_llm`（`tools/approval_smart.py:88-146`，prompt 在
   `:17-32`），命令文本当不可信输入、先剥 shell 注释（`:36-65`）。

## 2. 为什么值得抄

- `src/hooks.js` 只有静态 deny/allow（`hooks.js:224` 的 `checkToolCall`），**没有「问人」这一步**：
  群聊里 5 个 bot 并发跑工具，没人值守时要么全放（危险）要么全拦（不可用）。
- 群聊需要**按房间**的松紧度（老板群 yolo、外部群 ask），Hermes 的房间策略正好对应。
- 一次批准要能记住（同类操作别再问）、要能撤销（换会话就清）、要能永久保存（跨重启），且
  **必须有一条谁都绕不过的底线**（我们的铁律：零 C 盘写入）。
- 被连拒三次后 agent 会疯狂换写法重试——熔断是真实痛点（Hermes #82846 的教训写在
  `approval.py:64-71` 的注释里）。

## 3. 我们落地成什么

### 接口（与 `CONTRACT.md` §3.1 一致，`waitFor` 为 Lead 追加）

```js
export const APPROVAL_MODES = ["yolo", "smart", "ask"];
export const DECISIONS = ["allow", "deny", "ask"];
export const SCOPES = ["once", "session", "always"];
export const FLOORS = [{ id, match: { tool, arg, pattern }, reason }];

export function createApproval({ store, now = () => Date.now(), log, denialThreshold = 3 })
  -> { getMode, setMode, evaluate, request, resolve, waitFor,
       pending, list, audit, clearSession, stats }
```

- `evaluate({tool,input,ctx:{roomId,botId}}) -> {decision, reason, patternKey, rule?}`。
- `request(...) -> {id, status:"pending"|"already_pending", approval}`；同 patternKey 复用。
- `resolve(id,{decision,scope,by,reason}) -> {ok,approval} | {ok:false,error}`；
  重复/过期裁决返回 `error:"already_resolved"`（带 `status`）。
- `waitFor(id,{timeoutMs,signal}) -> {outcome:"allow"|"deny"|"timeout"|"aborted", id, reason?}`。

### 判定顺序（`src/approval.js` 内 `evaluate`）

```
FLOORS（deny，不可审批）→ 缓存 always > session > once → 拒绝熔断（deny）→ 模式（allow/ask）
```

### 表（全部 `appr_` 前缀，模块自建索引）

| 表 | 作用 | 关键列 |
|---|---|---|
| `appr_settings` | 全局 + 房间模式 | `scope_key`(`global`/roomId), `mode`, `by`, `updated_at` |
| `appr_requests` | 挂起/已裁决单 | `id, tool, input_json, room_id, bot_id, pattern_key, status(pending/approved/denied/expired/cancelled), decision, scope, by, created_at, decided_at, expires_at, ttl_ms` |
| `appr_cache` | 三态授权 | 主键 `(pattern_key, scope, room_id, bot_id)`，`uses_left`（once=1，session/always=-1），`expires_at` |
| `appr_audit` | 裁决留痕 | `ts, decision, tool, scope, by, mode, reason, pattern_key, room_id, bot_id, request_id` |

### 八条地板（`FLOORS`）

`floor.c-drive-write`（写/改 C 盘路径）、`floor.c-drive-command`（命令含 C 盘绝对路径，对齐
`hooks.js:242-250`）、`floor.rm-rf-root`、`floor.disk-format`（format/diskpart/mkfs/dd）、
`floor.system-power`（shutdown/reboot）、`floor.system-dir-write`、`floor.system-dir-command`
（System32/Program Files/%SystemRoot%）、`floor.credential-exfil`（curl/wget 等 + `.env`/密钥）。
正则均带命令位置锚点，`git commit -m "rm -rf /"` 这样的引号数据不会误伤（对齐
`approval_detection.py:118-119` 的注释）。地板命中时 `request()` 直接抛错，**没有任何审批路径**。

### 默认模式为什么是 yolo（Lead 集成期修正）

Hermes 是「一个人对着终端」的产品，smart 问人时人就在键盘前；AgentFusion 是**多智能体群聊**，
一轮里 boss 分派、coder 跑 `ls; find … | head`、librarian 落盘，全程没有人逐条批准。
实测两次真实 e2e：默认 smart 时整轮分别卡在 `room_assign_task` 与 coder 的只读探索命令上，
240s 超时失败。因此：

- **默认 `yolo`**：只受 8 条地板约束（C 盘、rm -rf /、格式化、关机、系统目录、凭据外泄），
  这已经比引入审批层之前「完全没有地板」更安全；
- **`smart` / `ask` 是显式监督模式**：UI 或 `PUT /api/approval/mode` 开启。`smart` 现在做了
  「复合命令逐段判定」（`ls; find | head` 全段只读放行，含 `rm`/`curl`/重定向/内联代码的段仍问），
  但依然可能挂起无人值守的回合 —— 这是监督模式的应有语义，不是缺陷。

### patternKey 规范化

- shell 命令：折叠连续空白 + 小写（`npm  test` ≡ `NPM Test`）；超过 160 字符时尾部换成 sha1 前 8 位。
- 路径：反斜杠转 `/`、去尾斜杠、**折叠到父目录**（`D:/ws/a.md` ≡ `D:/ws/b.md`）。
- 房间工具：用 `name/file_id/bot_id/topic` 作为关键面，写文件内容不参与。
- 键永远带工具名：`bash:cmd:…`、`write:dir:…`、`room_file_save:room:…`。

### 语义对照

| Hermes | 我们 | 判定 |
|---|---|---|
| hardline / floor 先于 yolo（`approval.py:1151`） | `FLOORS` 先于缓存与模式 | **采纳** || manual/smart/off（`approval_context.py:263`） | `smart/ask/yolo`（命名按契约） | **改写**（映射：off→yolo、manual→smart、strict 档另设 ask）；`yolo` 是**产品默认**（见下） |
| smart 守卫调辅助 LLM（`approval_smart.py:88`） | 确定性启发式：只读放行；构建/测试命令（`node --test`、`npm test`、`npm run <script>`、`git status/diff/log`…，且**不含** `; & \| > <` 与 `$()`）额外放行；写/删/网络/未知问人 | **改写**（契约禁止 LLM；dev-safe 白名单见 `src/approval.js` 的 `SHELL_DEV_SAFE_RE`） |
| 三态 `once/session/always`（`approval.py:436`） | 同一语义，落 `appr_cache` | **采纳** |
| 永久 allowlist 写 config.yaml（`:505`） | `always` 行写 SQLite，跨重启 | **改写**（不碰用户配置） |
| 熔断只加严拒绝文案（`:99-117`） | 达阈值后**不再 ask**，直接 deny（契约要求） | **改写**（更硬，并给 `clearSession` 恢复口） |
| session 态在进程内（`approval.py:55`） | `session` 行在构造时清空 | **采纳**（session 不跨重启，`always` 才跨） |
| 网关队列/多 transport（`:128-178`） | 单进程 `waitFor` + AbortSignal | **不采纳**（群聊只有一个 Web UI） |
| redaction / sudo stdin / parser-limit / container 判定 | — | **不采纳**（不是本轮缺口） |

## 4. 与 Hermes 的差异与取舍

- **规模**：Hermes 的审批面是 `approval.py` 1381 行 + `approval_detection.py` 1929 行 + 3 个兄弟模块
  （`approval_smart.py` 170、`approval_floors.py` 205、`approval_provenance.py` 49）。我们只取内核，
  单文件 705 行（含 54 空行、69 行注释，核心代码约 580 行）。略超契约 §0.6 的 400 行参考值，
  原因是 8 条地板 + 4 张表 + 阻塞等待合在一个模块里；如果 Lead 要压到 400 行以内，可把
  `FLOORS` 与分类器拆成 `src/approval_floors.js`（当前按「只新建这三个文件」的约定没拆）。
- **语言/运行时**：同步 SQLite（`node:sqlite`）+ Promise，无线程锁；Hermes 用 `threading.Lock`
  保护进程内字典（`approval.py:53`），我们靠 Node 单线程 + 主键冲突兜底。
- **无 LLM**：Hermes 的 smart 是「不确定就问模型」，我们是「按工具/命令类别三分」。
  `smart` 的误报会比 Hermes 高，但结果可复现、零延迟、零成本。为了让默认 `smart` 不把产品卡死，
  增加了一条**构建/测试白名单**（`SHELL_DEV_SAFE_RE`）：`node --test`、`npm test`、`npm run <script>`、
  `git status/diff/log/show/branch` 等标准动作直接放行；任何串联/重定向（`; & | > <` `$()`）都会
  先被 `SHELL_UNSAFE_RE` 拦下转为 ask，所以「白名单命令 + 管道」仍然要人工批准。这条是在
  Lead 集成时补的，已同步进测试（`tests/approval.test.mjs` 的模式判定用例与 `tests/hooks_gate.test.mjs`）。
- **熔断恢复**：Hermes 批准即清零（`:590-593`），我们的熔断会抑制 ask，因此在 `clearSession`
  里清零并撤回等待者；`resolve(allow)` 也会清零。
- **always 的作用域**：Hermes 永久白名单是 profile 级（跨会话），我们做成**跨房间、跨重启**；
  若产品要求「A 群的 always 不能给 B 群」，需要 Lead 决策后改 `grantCache` 的 room 粒度。
- **超时**：Hermes 是「沉默不是同意」（`approval.py:802-804`）；我们在 `waitFor` 超时时把请求
  落库为 `expired` 并返回 `{outcome:"timeout"}`，`pending()` 不再返回僵尸单。

## 5. 验证证据

```text
> cd D:\能力测试\fusion; node --test tests/approval.test.mjs
ℹ tests 24   ℹ pass 24   ℹ fail 0   （duration ≈1.2s）

> node --test        # 全量
ℹ tests 117  ℹ pass 117 ℹ fail 0
```

24 个用例：契约常量/地板结构、模式（默认/房间覆盖/非法值）、模式持久化、C 盘地板（yolo 下仍拦 +
不可审批）、rm/format/diskpart/shutdown 地板、系统目录（路径 + 命令）、凭据外泄（含误伤反例）、
地板先于缓存（手塞 always 行仍 deny）、smart/ask/yolo 判定、once 一次性、session 作用域与
clearSession/重启失效、always 跨重启跨房间、熔断触发与 clearSession 恢复、批准清零熔断、
request 幂等、resolve 幂等与错误路径、TTL 过期、patternKey 规范化、审计字段与 stats、
waitFor 唤醒（allow/deny）、waitFor 超时落库、AbortSignal 中止、晚到 waitFor 与 clearSession 唤醒。

## 6. Lead 接入清单

> 状态（2026-11-06 13:2x）：第 2 项已由 Lead 合并进 `src/hooks.js`；其余待接。

1. **单例构造（待接）**：在 `src/api/server.js` 的 `buildApp` 里（`app.hooksModule` 注入点附近，
   `src/api/server.js:448-466`）`const approval = createApproval({ store: app.store })`，挂
   `app.approval`。**必须单例**：`createApproval` 构造时会清 `appr_cache` 的 session 行（对齐
   Hermes 进程内 session 态），每回合重建会把 `session` 授权清掉。
2. **pre-tool 判定链（已合并）**：`src/hooks.js:342-425` 的 `createHooksExtension` 已经实现
   「静态规则 → `approval.evaluate` → deny 阻断 / ask 落单 → `await waitFor` → 未批准则 block」，
   新增选项 `approval/approvalContext/approvalTimeoutMs/onApprovalRequested/onApprovalResolved`
   （`src/hooks.js:328-332`）。要点：`ask` 分支必须 await 且 fail-closed（现在 evaluate/request
   抛错都会 block，见 `hooks.js:382`、`:400`）；`hooks.json` 的规则先跑只会**加严**，因为
   `checkToolCall` 的 `allow` 只是返回 `null`，随后仍会过地板，绕不过去。
3. **构造点传参（待接）**：两个扩展构造点要补 `approval` 实例与每 bot 的
   `approvalContext:{roomId,botId}`——`src/engine/bot.js:209`、`src/engine/chief.js:135`；
   `bot.js:260` 另有一个 `pi.on("tool_call")` 监听，注意合并，别重复拦截。
4. **abort 接线（部分）**：`waitFor` 已接收 `ctx?.signal`（`hooks.js:409`）；需确认 pi 的
   `tool_call` 事件确实带 `signal`，否则用户点「停止」时审批要等到超时才返回。
5. **HTTP 端点（待接）**（参考现有 `/api/hooks`，`src/api/server.js:2399-2413`，视图函数 `:1307`）：
   - `GET  /api/approval/status` → `{ mode, stats }`（`getMode()` + `stats()`）
   - `GET  /api/approval/mode?scopeKey=` / `POST /api/approval/mode` → `setMode`
   - `GET  /api/approval/pending?roomId=&botId=` → `pending(...)`
   - `GET  /api/approval/requests?limit=&roomId=`、`GET /api/approval/audit?...`
   - `POST /api/approval/:id/resolve` `{decision, scope, by, reason}` → `resolve`，把
     `{ok:false,error}` 映射成 409（`already_resolved`）/404（不存在）
   - `POST /api/approval/clear` `{roomId,botId}` → `clearSession`（熔断恢复口）
6. **设置页/群卡片（待接）**：pending 列表渲染成「批准一次/本会话/永久/拒绝」四按钮，`always`
   按钮要提示「跨房间、跨重启生效」；audit 页用于解释「这条为什么没弹窗」。
7. **测试**：不要改 `tests/approval.test.mjs`；端到端验证请在 `tests/` 新建文件，覆盖
   「C 盘写入被地板拦」「ask → resolve → 放行」两条真实链路。
