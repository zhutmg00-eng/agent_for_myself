# Hermes 吸收集成契约（Lead 所有 · 所有人遵守）

> 目标工程：`D:\能力测试\fusion`（pi 内核 + 群聊 2.0）。
> 参考源码（只读）：`D:\能力测试\reference\hermes\hermes-agent`（commit `ca43606`，2026-11-05T23:01-05:00）
> 与 `D:\能力测试\reference\hermes\oh-my-hermes`（commit `1727425`，2026-11-06T13:34+09:00）。均 MIT。

## 0. 铁律（违反即返工）

1. **零 C 盘写入**：任何运行期/构建期写入必须落在 `D:\...`。测试必须用 `tests/_helpers/env.mjs` 隔离数据根。不要 `npm install`（无新依赖）。
2. **不新增 npm 依赖**；只用 Node 内置模块（`node:sqlite`、`node:crypto`、`node:fs`…）。
3. **源码是 ESM JavaScript**（`.js`），Node ≥ 22.19。风格对齐现有 `src/` 文件：顶部块注释写"为什么"，中文注释/文案，`log` 用 `createLogger(scope)`。
4. **不要改动任何共享文件**。本轮你只能"新建"文件。共享文件清单（Lead 独占）：
   `src/store.js`、`src/hooks.js`、`src/engine/*`、`src/rooms/*`、`src/api/server.js`、`src/main.js`、`src/config.js`、`src/skills.js`、`src/events.js`、`package.json`、`README.md`、`tests/` 下已存在的文件。
   需要接入点时，写进你的 doc 的"Lead 接入清单"一节。
5. **不伪造**：每个能力必须有测试证明真实运行；doc 里每个结论都要带 `文件:行号` 或 URL 证据。
6. **只引用 Hermes 的语义，不复制它的规模**：Hermes 单文件动辄 5–15 万行，我们只取可落地的内核语义（≤400 行/模块）。

## 1. 文件所有权（互不重叠）

| 负责人 | 新建文件 |
|---|---|
| **approval** | `src/approval.js`、`tests/approval.test.mjs`、`docs/hermes/APPROVAL.md` |
| **toolsets** | `src/toolsets.js`、`tests/toolsets.test.mjs`、`docs/hermes/TOOLSETS.md` |
| **skills** | `src/skills/guard.js`、`src/skills/telemetry.js`、`src/skills/curator.js`、`tests/skills_guard.test.mjs`、`tests/skills_curator.test.mjs`、`docs/hermes/SKILLS.md` |
| **memory** | `src/memory.js`、`tests/memory.test.mjs`、`docs/hermes/MEMORY.md` |
| **omh 分析** | `docs/hermes/OMH_AND_CONTEXT.md`（只写文档，不改代码） |
| **Lead** | 契约/集成/总文档/端到端验证 |

## 2. 公共约定

- 模块都用**工厂函数**导出，构造时传 `{ store, ... }`，内部用 `store.db`（`node:sqlite` 的 `DatabaseSync`）执行 SQL；**各自 `CREATE TABLE IF NOT EXISTS` 自建表**，不要改 `store.js`。
- 时间：`nowIso()` 可在 `src/store.js` 导入（`export { nowIso }`）。ID：`makeId()` 同上。
- 所有表名/索引名加模块前缀，避免冲突：`appr_*`、`mem_*`、`skill_*`、`ts_*`。
- 失败要可解释：返回 `{ ok, error? }` 或抛 `Error`，不要静默吞掉。
- 日志：`createLogger("approval")` 等，测试里 `FUSION_VERBOSE=0` 已由 env helper 设置。

## 3. 模块接口（必须与签名一致，Lead 按此集成）

### 3.1 `src/approval.js`
```js
export const APPROVAL_MODES = ["yolo", "smart", "ask"]; // 宽松 -> 严格
export const DECISIONS = ["allow", "deny", "ask"];
export const SCOPES = ["once", "session", "always"];

// 不可绕过的硬地板（deny 且不可审批通过）；与 fusion 铁律一致
export const FLOORS = [ /* {id, match:{tool,arg,pattern}, reason} */ ];

export function createApproval({ store, now = () => Date.now(), log } = {}) -> Approval

Approval {
  // 模式：全局默认 + 可按房间覆盖（scopeKey = roomId 或 "global"）
  getMode(scopeKey = "global") -> "yolo" | "smart" | "ask"
  setMode(mode, { scopeKey = "global", by = "system" } = {}) -> { ok, mode }

  // 判定：先地板，后缓存（once/session/always），再按模式给 allow/ask
  evaluate({ tool, input, ctx = { roomId, botId } }) ->
    { decision: "allow"|"deny"|"ask", reason, patternKey, rule? }

  // 挂起审批：落库 + 返回 id；同 patternKey 在 session 内复用
  request({ tool, input, ctx, reason, patternKey, ttlMs = 10 * 60_000 }) ->
    { id, status: "pending"|"already_pending", approval }

  // 人工裁决：scope=once/session/always
  resolve(id, { decision, scope = "once", by = "user", reason = null }) ->
    { ok, approval } | { ok: false, error }

  pending({ roomId, botId, limit = 50 }) -> row[]
  list({ limit = 50, roomId } = {}) -> row[]
  audit({ limit = 100, roomId } = {}) -> row[]
  clearSession({ roomId, botId } = {}) -> { ok, cleared }
  stats() -> { pending, approved, denied, expired, byMode }
}
```
语义要求（对齐 Hermes，证据见 `docs/hermes/APPROVAL.md`）：
- **地板优先**：`FLOORS` 命中直接 deny，任何模式/缓存/审批都不能放行（Hermes 的 hardline / floor 语义）。
- **缓存三态**：`once` 只放行一次；`session` 在 `(roomId,botId)` 会话内按 `patternKey` 放行；`always` 持久化到 `appr_cache` 且跨重启生效。
- **patternKey**：对 tool+关键参数做规范化（命令去空白/大小写折叠、路径折叠到父目录），使"同类操作"复用一次批准。
- **拒绝熔断**：同一会话连续拒绝达到阈值（默认 3）后，不再弹审批，直接 deny 并在 reason 里说明（Hermes denial breaker）。
- **来源留痕**：每条裁决记录 `by`、`mode`、`scope`、`ts`、`reason`，写 `appr_audit`。
- `yolo` 仍受地板约束；`smart` 对只读/低危自动放行、对写/删/网络/系统命令问审批；`ask` 对非只读一律问。

### 3.2 `src/toolsets.js`
```js
export const CORE_TOOLS = [];            // 本项目群的 pi 内置工具全集（读/写/执行/搜索…）
export const TOOLSETS = { name: { description, tools: [], includes: [] } };
export const POSTURES = { coding: {...}, review: {...}, minimal: {...} };

export function listToolsets() -> [{ name, description, tools, includes, size }]
export function expandToolset(name, { disabled = [], seen = new Set() } = {}) -> string[]
export function resolveToolsets(names, { disabled = [], extra = [] } = {}) -> string[]
export function toolsForRole({ role = "member", toolsets = [], disabledToolsets = [], extraTools = [] }) -> string[]
export function isKnownToolset(name) -> boolean
export function unknownToolsets(names) -> string[]
```
语义要求：
- 命名工具集可 `includes` 复用（Hermes `TOOLSETS` 字典 + `includes`）。
- `disabled` 是**管线末端严格减除**，可写工具名或工具集名（Hermes `disabled_toolsets` 的语义）。
- 提供 `posture`（coding/review/minimal）级别的裁剪，等价 Hermes 的 `_CODING_TOOLS`。
- 输出**去重且顺序稳定**（声明顺序，便于断言）。

### 3.3 `src/skills/*`
```js
// guard.js
export const SEVERITIES = ["info", "warn", "block"];
export const RULES = [ /* {id, severity, test(line|text), why} */ ];
export function scanSkillText(text, { name = "skill" } = {}) ->
  { verdict: "allow"|"review"|"block", findings: [{ rule, severity, line, excerpt, why }] }
export function shouldInstall(result, { force = false } = {}) -> { allow, reason }
export function formatScanReport(result) -> string

// telemetry.js
export function createSkillTelemetry({ store } = {}) -> {
  record({ skill, event: "list"|"view"|"invoke"|"error", roomId, botId, ok = true, ms = 0, detail = null }) -> row
  stats({ sinceDays = 30 } = {}) -> [{ skill, views, invokes, errors, lastUsed, score, status }]
  of(skill) -> { views, invokes, errors, lastUsed }
}

// curator.js
export function createCurator({ store, telemetry, skillsDir, now = () => Date.now() } = {}) -> {
  transitions({ staleDays = 30, archiveDays = 90 } = {}) -> { stale: [], archive: [], revived: [] }
  propose({ title, body, evidence = [], roomId = null, botId = null, tags = [] }) -> { id, status: "proposed" }
  listProposals({ status = null, limit = 50 } = {}) -> row[]
  review(id, { decision: "adopt"|"reject"|"defer", reason, by = "user" }) -> { ok, proposal } | { ok:false, error }
  adopt(id) -> { ok, skill, guard } | { ok:false, error }   // 先 guard 扫描，block 则拒绝写入
  report() -> { proposed, adopted, rejected, archived, stale }
}
```
语义要求：
- **guard** 是安装闸门：frontmatter 必须合法、体积上限、危险 shell（`rm -rf /`、`curl|sh`、`base64 -d|sh`）、凭据外泄、提示注入标记、bidi/零宽隐藏字符。命中 `block` 必须拒绝安装。
- **telemetry** 是"技能使用遥测"：每次 list/view/invoke 落库，`stats()` 给出 score（使用频次 + 近期性）。
- **curator** 是闭环：长期未用 → stale → archive；**经验沉淀 → 提案（propose）→ 人工/群主 review → adopt 时 guard 扫描通过后写盘**（写入 `skillsDir/<slug>/SKILL.md`，frontmatter 含 `name/description/version/source`）。
- 不调用 LLM、不联网；纯确定性逻辑。

### 3.4 `src/memory.js`
```js
export function createMemory({ store, now = () => Date.now() } = {}) -> Memory

Memory {
  save({ scope = "room", roomId = null, botId = null, target = "memory", content, tags = [], pinned = false, source = "agent" }) -> entry
  replace(id, { content, tags, pinned } = {}) -> entry
  remove(id) -> { ok, removed }
  get(id) -> entry | null
  list({ scope, roomId, botId, target, limit = 100 } = {}) -> entry[]
  search({ query, scope, roomId, botId, limit = 10 } = {}) -> [{ entry, score }]
  contextBlock({ scope = "room", roomId, botId, budgetChars = 2000 } = {}) -> string
  audit({ limit = 50 } = {}) -> row[]
  stats() -> { total, pinned, byScope }
}
```
语义要求：
- 持久记忆分 `target: memory`（世界/项目事实）与 `user`（用户偏好画像），`scope: room|bot|global`。
- `search` 用 **SQLite FTS5**（`mem_fts`，`content=` 外部内容表）优先，中文按二元组/分词兜底：FTS 无命中时退化为 `LIKE`。排序 = 相关度 + pinned 加成 + 时间衰减。
- `contextBlock` 生成注入群聊上下文的一段 Markdown（按预算截断、pinned 优先），供 Lead 接入回合装配。
- 每次写/删记 `mem_audit`；`remove` 属于破坏性操作，`source` 需记录。

## 4. 测试规范

- 文件：`tests/<name>.test.mjs`，**第一行导入** `import { TEST_DATA_ROOT } from "./_helpers/env.mjs";`，再 `import { Store } from "../src/store.js";`。
- 用 `node:test` 的 `test()`/`describe()`；断言用 `node:assert/strict`。
- 每个模块 ≥ 8 个用例，覆盖：正常路径、边界、错误路径、持久化（重开 store 仍生效）、并发/幂等（如适用）。
- 运行：`cd D:\能力测试\fusion; node --test tests/<name>.test.mjs`（必须全绿；同时保证 `node --test` 全量不因你而红）。
- 测试里禁止真实 LLM 调用、禁止网络、禁止读写数据根之外。

## 5. 文档规范（`docs/hermes/<X>.md`）

每篇 ≤ 200 行，结构固定：
1. **Hermes 里是什么**（3–8 条，每条带 `tools/approval.py:1234` 这种证据）
2. **为什么值得抄**（对应我们群聊产品的哪个缺口）
3. **我们落地成什么**（接口 + 表结构 + 关键语义差异，明确"采纳/改写/不采纳"）
4. **与 Hermes 的差异与取舍**（规模、语言、运行时约束）
5. **验证证据**（测试命令 + 用例数）
6. **Lead 接入清单**（需要 Lead 在 hooks/bot/tools/server 里做的具体改动，逐条列点）

## 6. 交付判定

- `node --test tests/<你的文件>.test.mjs` 全绿；
- `node --test`（全量）不因你变红；
- 你的 doc 通过第 5 节结构审查；
- 没有改动共享文件（`git` 不可用，以 Lead 抽查 + 文件时间戳为准）。

---

## 7. 第三轮契约（2026-11-06 · Hermes 第二轮吸收）

> 基线：`node --test` 150/150 全绿。本轮目标见 `docs/hermes/OMH_AND_CONTEXT.md` 的三条高 ROI。

### 7.1 `src/rooms/context.js`（context-dev）
```js
export function createRoomContext({ store, roomId, now = () => Date.now() } = {}) -> {
  deltaFor(botId, { limit = 200 } = {}) -> [{ seq, speaker, content, kind, ts }]
  markInjected(botId, seq) -> { ok }
  digestText({ maxChars = 1600 } = {}) -> string
  compose(botId, { level = "full", roundMessage = "", budget = 6000 } = {}) ->
    { text, stats: { digestChars, deltaCount, totalChars, trimmed } }
  watermark(botId) -> number
  stats() -> { bots, digestChars, messages }
}
```
- 水位持久化到 `store.getKV/setKV`（key 前缀 `ctx:wm:<roomId>:<botId>`），不得改 store.js。
- `deltaFor` 从 `store.listRoomMessages(roomId, limit)` 取 seq > 水位的消息。
- `digestText` **确定性、不调 LLM**：群主题 + 最近 3 条成员结论（截断）+ 群文件清单（file_id + 名称）+ 未决分派（若有）。
- `compose`：level `none`→空串；`summary`→digest + 最近 4 条；`full`→digest + delta（首次无水位时退化为最近 30 条）；超 `budget` 从最旧的整条丢弃并在末尾标注「已省略 N 条」。
- 必须处理中文与超长单条（单条超过 1/3 budget 时截断并标注）。

### 7.2 `src/rooms/evidence.js`（evidence-dev）
```js
export const EVIDENCE_STATUS = ["observed", "prepared", "mismatch"];
export function classifyClaims({ text = "", toolCalls = [], files = [], knownFileIds = [] } = {}) ->
  { status, claims: [{ kind, text, evidence? }], reasons: [] }
export function createEvidence({ store, now = () => Date.now() } = {}) -> {
  record({ roomId, botId, messageSeq, text, toolCalls, knownFileIds }) -> record
  get({ roomId, messageSeq }) -> record | null
  list({ roomId, limit = 50 }) -> record[]
  summary({ roomId }) -> { observed, prepared, mismatch, total }
}
```
- 判定：无成功工具结果 → `prepared`；有成功工具结果 → `observed`；声明了 `file_id` 但不在 `knownFileIds` 或工具失败仍声称成功 → `mismatch`。
- 工具结果形态：`[{ name, ok, summary }]`；`file_id` 用正则 `file_id[：:]\s*`?([0-9a-f]{6,})`` 与 `` `([0-9a-f]{6,})` `` 两种写法。
- 表 `ev_records(room_id, message_seq, bot_id, status, claims_json, ts)` 自建；不调 LLM。
- 额外导出纯函数 `classifyClaims` 便于用例表驱动。

### 7.3 审批 UI（ui-dev，只改 `web/`）
- 新增设置面板「审批」：模式选择（yolo/smart/ask，PUT `/api/approval/mode`）、待裁决列表（GET `/api/approvals`，每行 Approve/Deny + scope once/session/always，POST `/api/approvals/{id}`）、审计（GET `/api/approvals/audit`）。
- 顶栏或设置入口显示 pending 数徽标；SSE 收到 `worker.*.approval_requested|approval_resolved` 时刷新。
- 只用现有端点（见 §3 与 server.js E26），不新增依赖、不需要构建步骤；风格与现有设置页一致。
- 交付 `docs/hermes/APPROVALS_UI.md`（截图 + 交互说明 + 已知限制）。

### 7.4 Lead 负责
- `src/engine/bot.js`：给每个 bot cwd 写 `.pi/settings.json`（`compaction.reserveTokens/keepRecentTokens`，值可由 env `FUSION_RESERVE_TOKENS`/`FUSION_KEEP_RECENT_TOKENS` 覆盖）。
- `src/rooms/room.js`：用 `compose()` 替换整份转录注入，注入后 `markInjected`；回合结束 `evidence.record`。
- `src/store.js` + `src/rooms/manager.js`：房间级 `settings_json`（`disabled_toolsets` 等）。
- `src/api/server.js`：证据查询端点 + 房间设置端点。
- 回归、e2e、文档与验收记录。

---

## 8. 第四轮契约（2026-11-06 · Hermes 第三轮吸收）

> 基线：`node --test` 198/198 全绿。来源：`docs/hermes/OMH_AND_CONTEXT.md` §2a/§2c + 本轮产品化缺口。

### 8.1 `src/rooms/fanout.js`（fanout-dev）
```js
export const FANOUT_LIMITS = { maxTasks: 12, maxScope: 8, maxIdLength: 40 };
export function normalizeScope(scope) -> string[]          // 去空、小写、posix、去尾斜杠
export function scopesOverlap(a, b) -> boolean             // 前缀/相等即重叠（D:/ws 覆盖 D:/ws/a.md）
export function planTasks({ tasks = [], members = [] } = {}) -> {
  ok: boolean,
  errors: [{ code, task_id?, other_id?, message }],   // 机器可读，UI/工具直接转述
  warnings: string[],
  order: string[],                                    // 拓扑序（同层保持声明序）
  units: [{ id, bot_id, write_scope: string[], depends_on: string[], depth }],
  conflicts: [[idA, idB]]
}
export function frontier(order, units) -> string[]   // 依赖已满足、可立即执行的 id
```
规则（对齐 omh `docs/FANOUT.md:14-20,313-320`）：
- `id` 唯一、非空、≤40 字符；`bot_id` 必须是群成员；`depends_on` 必须指向已声明 id；禁止自依赖；**循环依赖报错**（Kahn 拓扑，解析不出则 `cycle`）。
- 两个任务 `write_scope` 重叠且**互不在对方的依赖闭包里** → `write_conflict` 硬报错（这是 omh 的核心纪律：并行写同一片区域必须显式串行化）。
- 单任务 scope 超过 `maxScope`、任务数超过 `maxTasks` → 报错。
- `order` 为拓扑序（同层声明序），`frontier` 返回当前可执行集合；纯函数、无 IO、无 LLM、确定性。

### 8.2 证据徽标（evidence-ui-dev，只改 `web/`）
- E21 `GET /api/rooms/{id}/messages` 每条消息已带 `evidence`（`observed|prepared|mismatch|null`）；`turn_completed` 事件 payload 带 `evidence`。
- 在群聊消息气泡/元信息上渲染徽标：`observed`（绿）、`prepared`（灰，"仅声明"）、`mismatch`（红，"证据不符"），`null` 不渲染；hover 显示一句话解释与 `docs/hermes/EVIDENCE.md` 的判定口径。
- 群聊头/检查器（inspector）显示本群证据汇总（`GET /api/rooms/{id}/evidence` 的 `summary`），空态不显示。
- 只在 `web/**` 内改动 + 新建 `docs/hermes/EVIDENCE_UI.md`；Playwright 截图验证；不得破坏现有交互。

---

## 9. 第五轮契约（2026-11-06 · Hermes 第四轮吸收）

> 基线：`node --test` 230/230 全绿。目标：补齐 Hermes 的「经验 → 技能」学习闭环，并把 fanout 从校验推进到执行短路。

### 9.1 `src/rooms/executor.js`（fanout-dev）
```js
export const UNIT_STATES = ["pending", "ready", "running", "done", "failed", "skipped"];
export function createExecutionPlan({ units = [], order = [] } = {}) -> {
  order: string[],
  units: Record<string, { id, bot_id, depends_on: string[] }>,
  states: Record<string, "pending"|"ready"|"running"|"done"|"failed"|"skipped">,
  skippedReason: Record<string, string>
}
export function nextReady(plan) -> string[]        // pending 且所有依赖 done 的 id（按 order）
export function markRunning(plan, id) -> plan
export function markResult(plan, id, { ok, reason = null } = {}) ->
  { plan, changed: string[], skipped: string[] }   // 失败向下游传递 skip（传递闭包）
export function isComplete(plan) -> boolean
export function summarize(plan) -> { done, failed, skipped, pending, running }
```
语义（对齐 omh fanout 的「依赖前沿 + 失败短路」）：
- 单元状态机单向：pending→ready→running→done/failed/skipped；重复标记幂等。
- 任一单元 `failed`，其**传递下游**全部变 `skipped`（`skippedReason = "上游 <id> 失败"`）；兄弟分支不受影响。
- `nextReady` 只返回「依赖全部 done」的 pending；无依赖的 roots 从一开始就 ready。
- `isComplete` = 没有 pending/ready/running。
- 纯函数、无 IO、无 LLM、确定性；不改入参（返回新 plan 或空）。

### 9.2 `src/skills/learn.js`（skills-dev）
```js
export function evaluateLearningGate({ turns = [], evidenceSummary = null, reviewerVerdict = null, settings = {} } = {}) ->
  { ok: boolean, reason: string }   // 不满足时给出可读原因（"只有 1 个成员回合" / "存在 mismatch"…）
export function buildSkillDraft({
  instruction, roomId, roomTitle, topic, members = [], turns = [], files = [], evidenceSummary = null, reviewerVerdict = null, tags = []
} = {}) -> { title, body, tags, signature } | null
```
语义（对齐 Hermes「复杂任务后自动创建技能；技能在使用中改进」）：
- **质量闸门**：至少 2 个成员回合、且没有 `mismatch`、且（若有 reviewer）reviewer 结论为通过；否则不产出。
- **草稿**：Markdown playbook（目标 / 步骤（按回合顺序） / 验收标准 / 证据（file_id 列表） / 适用场景），标题从任务指令提炼（去掉称呼与标点，≤40 字）；body 不含 frontmatter（curator adopt 时统一加）。
- **signature**：`sha1(normalized title + "\n" + normalized body)`，用于跨回合去重（Lead 存 kv 判重）。
- 纯函数、无 IO、无 LLM、确定性。

### 9.3 Lead 接入
- `Room.runRound` 末尾：`evaluateLearningGate` → `buildSkillDraft` → 去重 → `curator.propose({ title, body, evidence, roomId, tags: [...tags, "auto"] })`；房间设置 `auto_propose_skills`（默认 `"observed"`，可选 `"off"`）。提案只在有 `curator` 时发生，失败静默。
- `Room.runRound` 循环：用 `executor` 状态机替代纯顺序——失败/无文本的成员回合标记 `failed`，下游 `skipped` 并写 system notice；不影响无依赖的兄弟。
- `GET /api/skills/proposals` 已存在，前端暂无入口（下一轮）。

---

## 10. 第六轮契约（2026-11-06 · Hermes 第五轮吸收）

> 基线：`node --test` 267/267 全绿。

### 10.1 `src/skills/judge.js`（skills-dev）
```js
export const VERDICTS = ["pass", "reject", "null"];   // "null" 表示无法判定（没表态/没有 reviewer）
export function judgeReviewer({ turns = [], reviewerId = null } = {}) -> {
  verdict: "pass" | "reject" | null,
  reviewer: string | null,          // 命中的 reviewer bot_id（多 reviewer 时任一 reject 的那个或第一个 pass）
  matched: string | null,           // 触发判定的片段（≤80 字），供日志/UI 解释
  reasons: string[]                 // 判定依据的人话（"reviewer 未表态" / "命中否定语境" …）
}
```
语义（替换 `Room._reviewerVerdict` 的文本启发式）：
- `reviewerId`：字符串/数组；未传时按 bot_id 含 `review`（不区分大小写）推断；没有 reviewer 回合 → `null`。
- **没表态 ≠ 通过**：reviewer 文本为空、或只有「稍后复核 / 还没看 / 待我看完 / pending」等 → `null`。
- **否定语境**：「不用修改 / 无需修改 / 不需要修改 / 没有问题，不用改」→ `pass`（不是 reject）；「未通过 / 不通过 / 需修改 / 需要修改 / 打回 / 退回」→ `reject`。
- **中英混合**：`LGTM / approved / pass / ship it` → pass；`changes requested / needs changes / rejected / not approved / nits?（nits 不算 reject，记 pass）`。
- 多 reviewer：任一 `reject` → `reject`；全部 `pass` → `pass`；否则 `null`。
- 纯函数、无 IO、无 LLM、确定性；同输入同输出；输入不被修改。

### 10.2 技能提案面板（ui-dev，只改 `web/**`）
- 设置新增「技能提案」分区（或并入「能力」分区）：列出 `proposed` / `approved` / `rejected` 提案（标题、来源房间、tags、正文前 3 行、证据 file_id）。
- 操作：**采纳**（先 `POST /api/skills/proposals/{id}/review {decision:"adopt"}`，再 `POST /api/skills/proposals/{id}/adopt`；失败时展示 guard 拒绝原因）、**拒绝/延后**（review 带 reason）。
- 数据源：`GET /api/skills/proposals?status=`、`GET /api/skills/usage`（可选）、E29 的 observed 计数可用于解释"为什么值得采纳"。
- 刷新：进入分区拉取；操作后刷新；SSE `room.*.skill_proposed` 时若面板打开则防抖刷新。
- 空态、错误降级（端点 404/失败不 toast、不阻塞）、中文文案、复用现有样式变量。

### 10.3 Lead 接入
- `Room._reviewerVerdict` 改为调用 `judgeReviewer`；`_round_turns` 保持 `{bot_id, text, evidence, ms}`。
- 提案面板的端点已存在（`src/api/server.js` E27），无需新增；若 UI 需要 `evidence.file_ids` 已在提案 evidence JSON 里。
- 验证：单测 + 真实 e2e（学习闭环仍应触发；reviewer 判定日志可查）+ 打包冒烟。
