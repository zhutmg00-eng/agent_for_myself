# OMH + Hermes 上下文/委派机制吸收清单

> 只读分析，本轮零代码改动。证据基线：`hermes-agent` commit `ca43606`、`oh-my-hermes` commit `1727425`（`docs/hermes/CONTRACT.md:4-5`），以及本仓已装的 pi 1.3.0 bundle（`node_modules/@earendil-works/pi-coding-agent/`）。
> 交付结构按 Lead 本轮任务书五节；`CONTRACT.md:164-172` 的六节模板面向单机制模块文档，本篇沿用其证据纪律（每条结论带 `文件:行号`）。
> 记号：**S** ≈ 半个工作日、**M** ≈ 1–2 天、**L** ≈ 3 天以上（含测试与回归）。

## 1. 一句话结论

下一轮按 ROI 只做这三件：

1. **上下文改为「水位 + 压缩」，不再每轮重灌整份转录**——现在 `room.js` 每轮把最多 12000 字符转录重新拼进同一条持久会话的 prompt，而 pi 的压缩阈值按 `contextTokens` 算，永远追不上这个人工注入量，成本近似 O(N²) 且截断是静默的。
2. **引入证据阶梯（observed vs prepared）**——`.omh` 整套价值就在这一条：声明与观察分家、空分母不是 0%、"读不到"不能渲染成"没问题"；我们现在的成员产出只有一个 `text` 字符串，群主说完成和 reviewer 验证过在库/UI 里完全同形。
3. **任务单元契约（写域 + 依赖前沿 + 结果 schema）**——这是 fanout 里可移植的最小内核：`write_scope` 相交且无 `depends_on` 是硬报错，调度按依赖前沿而不是波次，子任务失败有 `status/exitReason/truncated` 三件套且原始产出永不丢弃。

不选 delegation 全量、worktree 隔离、插件 hook 全套，理由见 §4 与各节风险行。

## 2. 逐机制分析

### a. fanout 契约 / DAG 并行（omh）

**证据**：`docs/FANOUT.md:14-20`（冻结 `fanout_contract/v2`：边界重叠且无 `depends_on` 是硬错、依赖环是硬错、>4 单元无 spawn plan 是硬错，goal 只存 digest）；`FANOUT.md:106-109`（>4 单元必须说明理由，否则"记录的不再是分解而是猜测"）；`FANOUT.md:145-147`（spawn plan 是 prepared 理由，不是切分正确性或已运行的证据）；`FANOUT.md:313-320`（admission 是依赖前沿，不是 wave barrier，慢兄弟不能饿死已就绪的依赖方）；`FANOUT.md:403-407`（一单元一 worktree，预存路径/分支是 error，绝不静默复用）；`FANOUT.md:289-312`（重试：先判瞬时性，再判 replay-safe——有副作用就只标 `retry_blocked_by_side_effects`，绝不从 base 重跑）；`FANOUT.md:274-288`（不许嵌套、单次 spawn 有上限）。

**我们的缺口**：`room.js:568-636` 是单队列串行；并发上限只靠 `maxTurns = speaking_slots × 4`（`room.js:560`）和 relay 熔断（`room.js:612-618`）；`pending_assignments` 按插入顺序出队而非 DAG（`room.js:570-581`）；唯一的"并行"是 `createSubgroup`，而它阻塞等子群整轮跑完（`room.js:692-698`），失败只降级成一句 notice（`room.js:699-701`）。

**接口草案**（建议新建 `src/rooms/plan.js`，由 Lead 接进 `runRound`）：
```js
export const UNIT_STATUS = ["pending","ready","running","completed","failed","refused","interrupted","unknown"];
export function validatePlan(units, { spawnPlanThreshold = 4 } = {}) ->
  { ok: true, plan } | { ok: false, errors: [{ code: "boundary_overlap"|"dependency_cycle"|"spawn_plan_required"|"unknown_unit", detail }] };
export function frontierOf(units, done) -> string[];            // 依赖前沿，不是波次
export function nextReady(units, state) -> { unit, slotsLeft } | null;
```
**工作量 M**。**风险 高**：群聊的回合语义（谁先说、`speaking_slots`、熔断）与并行调度天然冲突；worktree 隔离在我们的群文件空间里不成立（非 git），必须先想清楚"写域"是 `room_files.path` 前缀还是 bot workspace 路径。

### b. 证据纪律：observed evidence vs prepared coverage（omh）

**证据**：`docs/HARNESS_QUALITY.md:48-71`（`harness_quality/v1`：`evidence_ladder` + `overclaim_guards`，"A prepared coding_delegation.json is not implementation evidence."）；`HARNESS_QUALITY.md:91-93`（阶梯只在对应 runtime/wrapper 证据 observed 时打勾）；`HARNESS_QUALITY.md:757-761`（每条声明落库即 `standing: model_declaration`、`observed: false`，"a row with `observed: true` on disk is malformed, not evidence"）；`HARNESS_QUALITY.md:774-782`（`store_state` 与 `sources` 四态区分，"没有记录"与"记录里声明没发现问题"永不读成一样；半个 binding 直接拒绝）；`HARNESS_QUALITY.md:802-821`（plan 的 done 必须绑定一条真实 `terminal`/`write_file`/`patch` 调用）；`docs/ROLES.md:13`（prepared coverage 衡量计划完整度，observed achievement 在有匹配证据前恒为 0）；`roles/reviewer.md:13,45`（role 选择只是 prepared guidance；findings 不是 fix 证据）；`docs/MEMORY.md:963-984`（durability receipt 四态，逐级不可越级）；`docs/MEMORY-SYNC-FIDELITY.md:14-41`（`ready` 除非 evidence class 是观测，否则拒绝）。

**我们的缺口**：成员回合结果只有 `{ text, error, ms, usage }`（`bot.js:450`），没有 claim/standing/observed；`room.js:602-610` 把"失败"和"没产出文本"都写成中文 `system_notices` 字符串，机器读不出来；`subgroup_report`（`room.js:728`）把子群结论当既成事实广播。

**接口草案**（建议新建 `src/evidence.js`）：
```js
export const EVIDENCE_STATES = ["prepared_not_observed","observed","not_observed","unknown"];
export const LADDER = ["delegation_prepared","dispatch_observed","result_observed","verification_recorded","review_recorded"];
export function declare({ kind, verdict, summary, evidenceRefs = [], claimedSource = "model" }) ->
  { id, standing: "model_declaration", observed: false, evidenceState, refs };
export function observe(id, { by, kind, ref, ok }) -> { ok, record };   // 唯一能置 observed:true 的入口
export function advanceLadder(unitId, rung, evidence) -> unit;          // 拒绝用 prepared 抬级
export function readVerdicts({ runId }) ->
  { store_state: "absent"|"empty"|"present",
    sources: { verification: "absent"|"stale"|"declared_no_findings"|"declared_findings" }, rows };
```
**工作量 S**。**风险 低**：纯附加字段 + 一个门禁，但需要 Lead 决定"谁有权 observe"（当前只有群主/文件管家有动作，普通成员没有可观测副作用）。

### c. 记忆审查：采纳/拒绝/延后都要写理由（omh）

**证据**：`docs/MEMORY.md:888-911`（Admission 四出口 Remember / Refuse / Retrieve instead / Defer；Defer 的语义是"送去 review 而不是先留下"）；`MEMORY.md:893-899`（默认 auto-safe 只对安全候选在同一次操作批准，不安全/含相对时间/重复/派生内容才 pending）；`MEMORY.md:618`（`project_memory_review_record/v2` 是不可变准入证据）；`MEMORY.md:525`（`domain-reject` 必须带 `--reason`）；`MEMORY.md:963-984`（写入不是一件事，四个 receipt 状态各自点名自己观测到的事实）。

**我们的缺口**：`CONTRACT.md:123` 已定义 `review(id, { decision, reason, by })`，但没规定 `reason` 必填、没规定 reject/defer 的理由落库、没有 receipt 状态；`save()` 写即生效（`CONTRACT.md:139`），表达不出"候选待审"。

**接口草案**（`src/memory.js` 属 memory 同事，这里只给增量签名，不动表结构）：
```js
review(id, { decision, reason, by }) -> { ok, record } | { ok: false, error: "reason_required" };
receipt(id) -> "candidate_persisted" | "approved_record_persisted" | "indexes_refreshed" | "replay_ready";
capture({ scope, content, mode = "auto-safe" }) -> { entry, autoApproved: boolean, held?: { because } };
```
**工作量 S**。**风险 低**，但要与 memory 同事对齐所有权（`CONTRACT.md:25`），别在 `memory.js` 里重复实现。

### d. 上下文压缩：触发 / 保留 / 摘要结构 / 缓存不变量（Hermes + pi）

**证据（pi 侧，已被我们依赖）**：`docs/compaction.md:32,35`（触发式 `contextTokens > contextWindow - reserveTokens`，默认 16384）；`:45`（`keepRecentTokens` 默认 20k）；`:83`（重复压缩从上次 `firstKeptEntryId` 起算，保留早前压缩幸存的消息）；`:151-166`（`CompactionEntry`：summary / firstKeptEntryId / tokensBefore / usage / details）；`:234-236`（摘要小节 Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps，压缩额外带 Critical Context）；`:297-310`（`session_before_compact` 可提供 `preparation.firstKeptEntryId`）；`dist/core/compaction/compaction.d.ts:28-33,59`（`CompactionSettings{enabled,reserveTokens,keepRecentTokens}` + `shouldCompact(contextTokens, contextWindow, settings)`）；`dist/core/extensions/types.d.ts:621,633,643,1216-1218`（`session_before_compact` / `session_compact` / `session_compact_failed` 已导出）。

**证据（Hermes 侧，策略值可抄）**：`context_compressor.py:826-829`（摘要比例 0.20、地板 2000 tokens、上限 10000）；`:2694`（`max_summary_tokens = min(5% × context, 10000)`）；`:2751-2756`（窗口 < 512K 时触发线抬到 ≥ 75%）；`:925-930`（lean tail：地板 10K、上限 25K、硬占窗口 20%）；`context_compressor_tail.py:23-38`（tail ≤ 触发线的 50%）；`:257,260-300`（`## Historical Task Snapshot` + 强 REFERENCE ONLY 前缀，明确"最新用户消息才是 active task"）；`:934-935`（逐字用户消息 newest-first）；`:1012-1014`（详细日志 oldest-first）；`:1029-1030`（anchor index 7000 字符）；`:510`（summary 结束标记）；`agent/AGENTS.md:57-63`（"the ONLY context mutation is compression"，系统提示字节稳定，中途注入只能走 user 消息或 tool result）；`:83-86`（两层：网关卫生 85%、agent compressor 50%；先 prune 旧工具结果不调 LLM，再定边界，再让 auxiliary 模型写结构化摘要）。

**我们的缺口（本轮最严重）**：`room.js:441-443` 把 `renderTranscript` 结果整体拼进每轮指令，而同一会话里已存着前几轮 → 第 N 轮重复 N−1 轮内容，成本近似 O(N²)；`room.js:25,420-427` 只在 12000 字符处硬截并 `break`，没有 omitted 计数、没有摘要、没有水位；`bot.js:350-410` 与 `chief.js:263-303` 的事件订阅里没有任何 compaction 分支；`manager.js:50-79`（`restore`）也不恢复任何上下文水位。

**接口草案**（建议新建 `src/engine/context.js`，pi 侧只接线不改内核）：
```js
export function assess({ usage, contextLength, settings }) -> { shouldCompact, tokens, threshold, blockReason };
export function tailBudget({ contextLength, thresholdTokens }) -> number;   // clamp(2.5% 窗口, 10K, 25K) ∧ ≤50% 触发线
export function summaryBudget(contextLength) -> number;                     // min(5%, 10K)，地板 2000
export function buildTail({ messages, keepRecentTokens }) -> { headEnd, tailStart, firstKeptEntryId };
export function contextBlock({ transcript, watermarkSeq, budgetChars }) -> { text, throughSeq, omitted, digest };
export function assertCacheInvariant({ systemPromptA, systemPromptB }) -> { ok, diff? };  // 必须字节相等
```
**工作量 M**。**风险 中**：压缩是唯一被 sanction 的缓存破坏点（`agent/AGENTS.md:57-63`），做错会同时烧钱并丢上下文；先只做"水位 + omitted 计数"，把摘要交给 pi 自查，第二步再接管 `session_before_compact`。

### e. 委派：子代理隔离与结果契约（Hermes）

**证据**：`tools/delegate_tool.py:203-260`（子代理构建：depth 派生 role `:243-245`、独立 toolsets `:256`、临时 system prompt `:257-260`）；`:302-305`（`platform="subagent"`、`skip_context_files=True`、`skip_memory`）；`:376-383`（结果契约：`status ∈ {completed, interrupted, failed}`、`exit_reason ∈ {completed, max_iterations, interrupted, error}`、`truncated == (exit_reason === "max_iterations")`）；`:817-823`（`output_schema` 不命中：一次有界纠正重试后仍 `completed`，原始文本放 summary，`schema_valid:false`，绝不丢弃）；`:593-598`（depth 超限直接报错）；`:623-628`（单任务不可路由就单独 refused，只有全不可跑才是 tool error）；`tools/async_delegation.py:48-59`（并发 3、保留 50 条、7 天、1000 pending、8 次投递、48h 重放、300s claim lease）；`:291-340`（归属进程消失 → `status:"unknown"` + 已记录的子结果 + transcript 尾/git 快照）；`:94-97`（停滞按进度判定 450s/1200s，不设 wall-clock 超时）。

**我们的缺口**：回合结果没有 `status/exitReason/truncated`（`bot.js:450`），分不清"迭代预算耗尽"和"报错"；失败只写中文 notice（`room.js:604,608`），不落表、不能回放；`createSubgroup` 回收是把子群 `message_log` 拼字符串并截到 2000 字符（`room.js:696-702`），结构化信息全丢；没有 output schema。

**接口草案**（建议新建 `src/rooms/delegate.js`）：
```js
export const CHILD_STATUS = ["completed","interrupted","failed","unknown"];
export function runChild({ parentRoom, unit, signal }) -> {
  unitId, status, exitReason, truncated, summary, schemaValid, schemaErrors, sessionRef, ms, usage };
export function delegateBatch({ parentRoom, units, concurrency = 2 }) -> { batchId, units };
export function collect(batchId) -> { completed, pending, refused: [{ unitId, reason }] };
export function recoverAbandoned({ now }) -> { recovered, unknown };  // 归属消失 → unknown + 部分结果
```
**工作量 M**。**风险 中**：我们跑在同进程 session 内，"归属进程消失"没有 `pid + started_at` 可判（`async_delegation.py:277-288`），只能降级为"回合超时 → unknown"。

### f. 插件 hook 的 fail-closed 分类（omh + Hermes）

**证据**：`docs/PLUGIN-HOOK-CONTRACT.md:33-42`（`effect` 六值：policy_gate / prompt_context_contributor / result_transformer / lifecycle_callback / observer / unknown）；`:44-51`（`host_contract`：bounded / caller_thread / queued_worker / unknown）；`:53-60`（`timeout_semantics`：fail_closed / fail_open / not_applicable）；`:58`（"`pre_tool_call` is the only hook the host treats this way"——超时即 block）；`:74`（"Absence from the mapping is never reported as safe."）；`:76-82`（契约未定必须有独立风险类别，否则"我读不到"会渲染成"这是好的"）；`plugins/AGENTS.md:89`（hook 名单：pre/post_tool_call、pre/post_llm_call、on_session_start/end）；`tools/plugin_guard_context.py:3-6`（装前扫描是 advisory 静态契约，不是安全证明）。

**我们的缺口（三处 fail-open，全在 `src/hooks.js`）**：`:145-148` `hooks.json` 解析失败就把策略置空，只 warn 一行；`:265-268` `denyPattern` 正则非法时 `safeRegex` 返回 null 后 `continue`，该 deny 规则被静默跳过；`:311-319` 求值抛错时注释写着 "allowing call" 并直接放行。另外没有 effect/timeout 分类，所有规则同步无限期求值。

**接口草案**（改 `src/hooks.js`）：
```js
export const HOOK_EFFECT = ["policy_gate","prompt_context_contributor","result_transformer","lifecycle_callback","observer","unknown"];
export const TIMEOUT_SEMANTICS = ["fail_closed","fail_open","not_applicable"];
export function classifyRule(rule) -> { effect, hostContract, timeoutSemantics };   // 未知名 → unknown，不猜
export function compileRules(rules) -> { rules, errors: [{ id, code }] };           // 非法正则 → 该规则 deny-all
export async function checkToolCall(event, compiled, { timeoutMs = 1500 }) ->
  { decision: "allow"|"deny"|"ask", reason, rule, degraded?: "invalid_rule"|"timeout"|"eval_error" };
export function hooksDocument() -> { enabled, count, degraded: [{ id, code }], rules };  // 降级必须在 UI 可见
```
**工作量 S**。**风险 低**：改的是 fail-open→fail-closed，可能让现有用户的自定义 hooks 突然拦人；必须同时把 `degraded` 暴露到 `/api/hooks` 与设置页（`hooksDocument` 已有该出口，`hooks.js:185-205`）。

## 3. 映射到 fusion 的具体文件（建议改法，未实施）

| 文件 | 函数 | 改法 |
|---|---|---|
| `src/rooms/room.js` | `renderTranscript` `:398-428` | 签名改 `renderTranscript(botId, { watermarkSeq, level }) -> { text, throughSeq, omitted }`；用 `store` 的 seq 水位代替字符截断，`omitted` 必须回传并写入指令（`……早前 N 条已压缩，见摘要`）。 |
| `src/rooms/room.js` | `buildInstruction` `:439-474` | 增加 `contextBlock` 入参，不再内部重算转录；把 `=== 群聊共享上下文 ===` 换成"摘要 + 水位后增量"，保证同一 bot 相邻两轮系统提示字节不变。 |
| `src/rooms/room.js` | `runRound` `:529-650` | ① 分派走 `plan.frontierOf()` 而非 `assignmentOrder`（`:570-581`）；② 每个 `member_finished` 产出 `evidence.declare()`（`:600`）；③ 失败分支 `:603-610` 改为结构化 `unit.status` + notice，不再只拼中文。 |
| `src/rooms/room.js` | `createSubgroup` `:658-731` | 改为 `delegateBatch({ units: [picked] })` 并 `await collect()`；`report` 保留结构化 `units[]`，截断前先落库，2000 字符只约束"回传父群的摘要"。 |
| `src/rooms/room.js` | `say` `:479-503` | `message_log.push` 时记录自增 seq（或复用 `room_messages` 的 seq），作为水位来源；`pending_rounds` 折叠避免积压。 |
| `src/rooms/manager.js` | `create` `:90-194` / `restore` `:50-79` | `create` 接受 `context_settings`（reserveTokens/keepRecentTokens）与 `units` 初值；`restore` 恢复每个 room 的水位与未完成 unit。 |
| `src/engine/bot.js` | `_createSession` `:199-252` | 在 `extensions`（`:210`）追加 `createCompactionExtension()`（实现 `session_before_compact`）；用 `settingsManager` 传入压缩设置，不改 pi 内核。 |
| `src/engine/bot.js` | `_runTurn` `:321-478` | 订阅 `session_compact` / `session_compact_failed`，发布 `worker.<bot>.context_compacted{tokensBefore,tokensAfter,firstKeptEntryId}`；返回值补 `contextTokens`。 |
| `src/engine/chief.js` | `_createSession` `:116-158` / `_runTurn` `:197-378` | 同上；单聊是最容易先验证压缩的地方（无群聊回合干扰），建议先在这里灰度。 |
| `src/hooks.js` | `checkToolCall` `:224-280` / `createHooksExtension` `:306-344` | 按 §2f 改成 `compileRules + decide with timeout`；三处 fail-open（`:145-148`、`:265-268`、`:311-319`）全部改为 deny + `degraded` 标记。 |
| `src/store.js`（**Lead 独占**，仅描述） | 新增表 | `ctx_watermark(room_id,bot_id,through_seq)`、`ev_claim(id,unit_id,kind,verdict,standing,observed,refs_json)`、`fanout_unit(room_id,unit_id,owner,write_scope_json,depends_on_json,status)`；不改现有 DDL（`docs/FUSION_SPEC.md:216-240`）。 |
| `src/api/server.js`（**Lead 独占**） | 新增/扩展端点 | `GET /api/rooms/:id/context`（水位 + omitted + 压缩历史）、`POST /api/rooms/:id/verdicts`、`GET /api/hooks` 增加 `degraded`。 |

## 4. 明确不采纳清单

| 不采纳 | 一句理由 |
|---|---|
| 多平台网关（Telegram/Discord/Slack… 适配器） | 我们是单机桌面群聊工作台，接入 20 个 IM 平台只换来长期维护税（`plugins/AGENTS.md:93`、`hermes-agent/AGENTS.md` 的 gateway 面）。 |
| cron 调度器 / 定时任务 | 群聊回合由人触发；后台定时会让成本模型与熔断语义同时失效（`hermes-agent/AGENTS.md` 项目结构 `cron/`）。 |
| kanban 板与 `executor_progress_binding` | 它绑定的是外部进程的 pid/生命周期，我们所有 bot 都是同进程 session，没有可绑定的 pid（`plugins/AGENTS.md:92`、`FANOUT.md:340-365`）。 |
| per-unit git worktree + branch | 群文件空间不是 git 仓库，`<repo>-fanout-<unit>` 无从谈起（`FANOUT.md:403-407`）；改成 `write_scope` 前缀声明 + 冲突硬报错。 |
| Python 契约层整体移植（`src/contracts/*`、上百个 `omh` 子命令、byte-exact docs gates） | 我们是 ESM JS、单模块 ≤400 行（`CONTRACT.md:16`），跨语言契约层会引入运行时与生成物闸门两套负担。 |
| plugin-catalog / `plugin.yaml` 生态（105 个清单、SHA pin、移除黑名单） | 我们还没有插件市场；先做 hook 的 fail-closed，再谈分发（`plugins/AGENTS.md:66-83`）。 |
| `omh reported_rate/v1` 全套 JSON 形状 | 只保留一条可用原则"空分母不是 0%，报 `percent:null`"，其余形状对内部 KPI 过重（`oh-my-hermes/AGENTS.md`「Reporting Our Own Numbers」）。 |
| `pre_verify` / `pre_gateway_dispatch` 类 gate | 我们只有 `tool_call` 一个闸门；没有 verify 阶段就不该抄它的 fail-open 语义（`PLUGIN-HOOK-CONTRACT.md:59`）。 |
| 记忆 7 维 fidelity（`memory_sync_fidelity/v1` 全量） | 我们没有外部 provider 同步，只取"四态 receipt + reason 必填"两条（`MEMORY-SYNC-FIDELITY.md:14-41`）。 |
| Jev 网络工具 / TUI 更新检查等 scoped 网络客户端 | 与铁律"零新依赖、可离线"直接冲突（`oh-my-hermes/AGENTS.md` Implementation Boundaries）。 |
| `spawn_plan` 的四问法（why_parallel 等） | 它的价值在"拒绝猜测式分解"，我们先用 >4 单元硬要求写一句话理由即可，不做 280 字符四字段（`FANOUT.md:126-151`）。 |

## 5. 验收建议（每项落地后怎么证明有效）

| 项 | 测试/演示 | 通过标准 |
|---|---|---|
| d. 上下文水位 | `tests/context_watermark.test.mjs`：假 store 造 5 轮、每轮 3 条消息 | 第 5 轮指令只含水位后的消息；`omitted` 等于实际省略条数；`throughSeq` 单调递增 |
| d. 缓存不变量 | 同测试内对同一 bot 取相邻两轮 `buildInstruction` 的"系统段" | 字节相等（`assertCacheInvariant(...).ok === true`） |
| d. 压缩接线 | 假 usage 超阈值 → 触发 `session_before_compact`；再超一次 | 第一次摘要含 Goal/Constraints/Progress/Key Decisions/Next Steps；第二次从上次 `firstKeptEntryId` 起算（对齐 `docs/compaction.md:83`） |
| d. 端到端成本 | `scripts/` 起真服务，群聊跑 4 轮，读 `usage` 表 | 第 4 轮 input tokens ≤ 第 1 轮 × 2（现状近似线性叠加） |
| b. 证据阶梯 | `tests/evidence.test.mjs` 三个用例：只有声明 / 有 observe / 读空 store | 第一条永远 `observed:false`；`readVerdicts` 对三种状态给出不同 `store_state` 与 `sources`，且不合并"absent"与"declared_no_findings" |
| b. 端到端 | 群聊让 coder 说"已完成"但 reviewer 未验证 | UI 显示 `Test · not_observed`，不显示"验证通过" |
| a. 计划校验 | `tests/plan.test.mjs`：重叠写域无依赖 / 有环 / 5 单元无理由 | 三种都返回 `ok:false` 且 `code` 可断言；4 单元无理由通过 |
| a. 前沿调度 | 三步 DAG（A→B、A→C） | B/C 在 A 完成后立即就绪；无关慢兄弟不阻塞 |
| e. 结果契约 | `tests/delegate.test.mjs`：迭代耗尽 / 抛错 / schema 不命中 | `exitReason` 分别为 `max_iterations`/`error`/`completed`；`truncated` 只在第一种为 true；schema 不命中时 `summary` 仍在 |
| e. 中止回收 | 子任务超时中途 kill | 返回 `status:"unknown"` + 已产出部分，不抛异常、不留悬挂 unit |
| f. fail-closed | `tests/hooks_failclosed.test.mjs`：坏 JSON / 非法 `denyPattern` / 求值抛错 / 超时 | 四种都 `decision:"deny"` 且 `degraded` 有值；`/api/hooks` 能读到降级项 |
| 全局 | `node --test` 全量 | 不因本次改动变红（`CONTRACT.md:174-179`） |

---
**本次未覆盖但值得下一轮开题**：`docs/FANOUT-EXECUTOR-EVIDENCE.md`（会话/失败诊断的观测口径）、`omh goal board` 的只读编排板投影（`docs/DELEGATION_FIRST_COMPLETENESS.md:55`，把 goal ledger + fanout contract + observation journal 合成一个有序板，"done" 字样不能替代已观测事件）、`context_compressor.py` 的 anti-thrash 断路器（`:2717-2726`，压缩无效时暂停并冷却 300s）——最后这条在我们接通 pi 压缩后很可能立刻需要。
