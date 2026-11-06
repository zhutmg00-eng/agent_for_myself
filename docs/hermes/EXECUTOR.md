# Executor（执行期短路）吸收说明

> 交付物：`src/rooms/executor.js`（263 行，纯函数）、`tests/executor.test.mjs`（19 用例）。
> omh/Hermes 证据基于 `reference/hermes/oh-my-hermes/docs/FANOUT.md`、`reference/hermes/hermes-agent/tools/delegate_tool.py`；
> Fusion 证据基于本仓库当前文件。

## 1. omh / Hermes 里是什么

1. **admission 按依赖前沿，不按波次**：一个单元在它依赖的单元全部完成、池子有空位时立刻启动，
   慢兄弟不能饿死已就绪的依赖方（`FANOUT.md:313-320`）。
2. **失败只挡下游，不挡兄弟**：`FANOUT.md:636-638`「Dependency bar. A satisfied dependency means only
   that the owner agent process exited 0. It is not verified, reviewed, or correct work. Failed units
   block their dependents, never their independents.」
3. **被挡住的行记 `skipped`、从不运行**：`FANOUT.md:536-538`「Plan rows recorded `skipped` — blocked
   behind a failed dependency or deferred behind the fan-in — never ran…」；验证检查同理：
   「A failed check blocks its dependents (recorded `skipped`, never run) while unrelated checks finish」
   （`FANOUT.md:589-590`）。
4. **短路要带原因**：reproduction hold 的未满足项记 `blocked_by_dependency`，并给出
   `blocked_reasons: {<unit>: "reproduction_not_observed"}`（`FANOUT.md:497-500`）。
5. **失败不重放已观测的工作**：重试先判瞬时性、再判 replay-safe，有副作用就只标
   `retry_blocked_by_side_effects`，绝不从 base 重跑（`FANOUT.md:289-312`）。
6. **Hermes 的 delegate 用结构化状态回传失败**：`status ∈ {completed, interrupted, failed}`，
   结构化失败（`failed=True` / 非空 error）即使带着 summary 也算 failed；另有 `exit_reason` 与
   `truncated`（`tools/delegate_tool.py:376-383`）。
7. **失败条目照样回传**：子任务失败时 `run.await_child()` 的 `failure_entry` 直接返回（`:407-408`）；
   异常路径构造 `status="failed"` 的 entry（`:423-432`），父级不会裸等，也不会把失败当成功。
8. **原始产出永不丢弃**：即使 schema 校验失败，「the child's raw text is still returned as summary,
   never discarded」（`delegate_tool.py:820-822`）。
9. **我们自己的吸收清单早就写了这条**：`docs/hermes/OMH_AND_CONTEXT.md:30` 提议
   `frontierOf(units, done)`（依赖前沿，不是波次），`:129` 把「分派走前沿而非 assignmentOrder」
   列为 `runRound` 的接入项。

## 2. 为什么值得抄（对应我们群聊产品的缺口）

- **分派已经会校验，但执行仍然只看顺序**：`Room.assignTask` 现在用 `planTasks` 在分派时拒绝冲突
  （`src/rooms/room.js:281-310`），可 `runRound` 只是把拓扑序换成发言顺序（`:312-328`、`:751-770`）。
- **上游失败仍会继续点名下游**：成员跑失败或没产文本时，只 push 一条 `system_notices` 然后
  `continue`（`room.js:800-808`），下一个依赖它的成员照样拿到任务和旧上下文——群里看起来在推进，
  实际是在用坏输入继续算。
- **失败原因机器读不出来**：notice 是中文句子（`:802`、`:806`），下游不知道自己为什么该等。
- **没有"跳过"的概念**：`assignmentOrder`/`seen`（`:735-770`）里只有"没跑过"，没有"因上游失败不能跑"，
  UI 与验收都分不清"还没轮到"和"永远轮不到"。
- **omh 的答案是状态机**：单元有单向状态、失败短路、skip 带原因；我们把它降级成纯函数，
  先解决"该不该跑、跳过为什么"，执行仍由 `Room.runRound` 串行完成。

## 3. 我们落地成什么（`src/rooms/executor.js`）

**接口（与契约 §9.1 逐字一致）**

| 导出 | 位置 | 说明 |
|---|---|---|
| `UNIT_STATES` | `src/rooms/executor.js:17` | `["pending","ready","running","done","failed","skipped"]`，冻结 |
| `createExecutionPlan({units, order})` | `:114` | 建计划：roots 初始 `ready`、其余 `pending`；`order` 缺省用声明序，传入时保留已知 id 再补齐 |
| `nextReady(plan)` | `:156` | 按 `order` 返回状态为 `ready`/`pending` 且依赖全部 `done` 的 id |
| `markRunning(plan, id)` | `:175` | `ready` 或依赖已满足的 `pending` → `running`；其它情况原样返回 |
| `markResult(plan, id, {ok, reason})` | `:197` | 写 `done`/`failed`；失败把**传递下游**标 `skipped`，返回 `{plan, changed, skipped}` |
| `isComplete(plan)` | `:241` | 没有 `pending`/`ready`/`running`（空计划算完成） |
| `summarize(plan)` | `:254` | `{done, failed, skipped, pending, running}`（`ready` 归入 `pending`） |

**计划形状**：`{ order: string[], units: Record<id, {id, bot_id, depends_on}>, states: Record<id, state>,
skippedReason: Record<id, string> }`。`units` 只保留契约里的三个字段（`write_scope`/`depth` 丢弃，
执行期不需要）；`order` 始终覆盖全部单元。

**状态机（单向；终态不可逆；重复标记幂等）**

| 从 | 事件 | 到 | 说明 |
|---|---|---|---|
| — | `createExecutionPlan` | `ready`（roots）/ `pending` | 无依赖即 root |
| `ready` / 依赖已满足的 `pending` | `markRunning` | `running` | 依赖未满足时原样返回（不许抢跑） |
| `pending`/`ready`/`running` | `markResult {ok: true}` | `done` | 只有**严格 `true`** 才算成功（fail closed） |
| `pending`/`ready`/`running` | `markResult {ok≠true}` | `failed` | 缺省 `ok` 按失败处理 |
| `pending`/`ready` 的传递下游 | 任一上游 `failed` | `skipped` | 兄弟分支不动；已 `done`/`running` 的回退不了 |
| 终态 | 任意标记 | 不变 | 先到先得，返回空 `changed` |

**失败传播规则**

| 场景 | 结果 | `skippedReason` |
|---|---|---|
| 直接下游 | `skipped`，不再出现在 `nextReady` | `上游 <id> 失败` |
| 传递下游（A→B→C，A 失败） | B、C 都 `skipped`，同一个根因 | 同上（根因是本次失败的 id） |
| 兄弟分支（无依赖关系） | 状态不变，照常可跑 | — |
| 已 `running`/`done` 的下游 | 不回退（本调用只改 `pending`/`ready`） | — |
| 未知 id、未知依赖 | 原样返回 / 永远等不到（调用方先用 `planTasks` 校验） | — |

**其它语义决定**

- **`ready` 与 `pending` 都可被 `nextReady` 返回**：契约要求 roots 一开始就 `ready`，同时要求
  `nextReady` 返回「依赖全 done 的 pending」；两者都返回才能既表达初始态又表达推进。`markRunning`
  对「依赖已满足的 pending」等价于先 `ready` 再 `running`，状态不回退（对契约表格的宽松化，见 §4）。
- **`summarize` 把 `ready` 归入 `pending`**：契约给的五个计数键没有 `ready`，归入 `pending` 才能让
  五项之和等于单元数；`ready` 本身只用于 `nextReady` 的初始态。
- **fail closed**：`markResult` 只认 `ok === true`；`ok: 1`、缺省 `ok` 都按失败处理，避免"拿不准就当成功"。
- **终态先到先得**：已 `failed` 的单元迟到 `ok:true` 不会翻案；已 `skipped` 的下游迟到结果也不生效
  （否则会绕过上游失败直接算完成）。
- **纯度**：每次调用都返回新 plan（`clonePlan` `:69` 连单元对象一起复制），入参 plan/units/order 不被修改；
  未知 id 的非法调用直接返回原 plan。

**没有表结构**：纯函数不落库；执行状态由 `Room` 持有（见 §6）。

**采纳 / 改写 / 不采纳**

- 采纳：依赖前沿、失败短路、`skipped` + 原因、单向状态机、终态幂等、fail closed。
- 改写：① omh 用异常与 journal 记录状态，我们用纯状态对象 + 返回值；② omh 的 `blocked_reasons`
  是每单元原因映射，我们的 `skippedReason` 只记根因 id（够 UI 显示）；③ omh 的 `skipped` 由调度器
  写入，我们的 `markResult` 同步把传递闭包标掉（调用方不必自己遍历）。
- 不采纳：worktree / 进程组 / 超时 kill（`FANOUT.md:403-407`）、重试分类（`:289-312`）、
  verification plan 与 repair 循环（`:570-640`）、`merge_order` 合并阶段、journal 落盘。

## 4. 与 omh / Hermes 的差异与取舍

- **范围**：omh 的短路发生在"派发 + 观测 + 重试 + 合并"完整流水线里；我们只做执行期的**状态与前沿**，
  真正的执行仍是 `Room.runRound` 的串行成员回合，没有并发池。
- **隔离**：omh 一单元一 worktree/进程组；我们同进程同工作区，所以失败短路是"防止用坏输入继续算"
  的语义，不是文件系统级隔离。
- **状态词汇**：omh 的 unit 有 `blocked`/`not_observed`/`verification_failed` 等更细的状态与原因；
  我们的六个状态取契约最小集，`skipped` 承载"被上游挡住"这一种含义。
- **Hermes delegate 对照**：Hermes 的子任务失败仍然回传结构化 entry（`delegate_tool.py:376-383`、
  `:407-408`），我们的 `markResult` 同样保留失败单元本身（`failed`）并把原因传给下游，
  而不是让下游"猜"；但 Hermes 的 `interrupted`/`truncated` 概念我们没有引入。
- **规模**：omh `fanout_dispatch.py` 32 万字节；本模块 263 行，符合契约 §0.6 的「≤400 行/模块」。
- **语言/运行时**：ESM 纯函数、无 IO、无 LLM、确定性；omh 是 Python + 子进程 + journal。

## 5. 验证证据

```text
$ cd D:\能力测试\fusion; node --test tests/executor.test.mjs
ℹ tests 19   ℹ pass 19   ℹ fail 0   ℹ duration_ms 369.63
```

覆盖：`UNIT_STATES` 常量、空计划、计划布局（roots ready / 其余 pending / order 声明序）、单链成功逐层推进、
失败短路（直接下游 + 传递下游 + 兄弟分支）、失败原因透传（含 reason 与无 reason 两种文案）、
镜像依赖（A→B、C→B 互相等待）、菱形依赖（B 完成不提前放行 D）、多 root 按 order 返回、
幂等（重复 markRunning/markResult、终态先到先得）、fail closed（`ok` 缺省 / 非 `true` 都算失败）、
`isComplete` 边界、`summarize` 计数（ready 归入 pending）、未知 id/未知依赖容错、
`markRunning` 守卫（依赖未满足不许跑）、units 的 Record 形态与 order 补齐、纯函数（确定性/不改入参/不共享结构）、
已 skip 的下游不接受迟到结果。

```text
$ cd D:\能力测试\fusion; node --test
ℹ tests 266   ℹ pass 266   ℹ fail 0
```

全量全绿（本轮基线 230，叠加本模块 19 个用例与并行模块的增量；交付时 266，数字随并行模块增长）。
零 C 盘写入、数据根由 `tests/_helpers/env.mjs` 隔离、无新依赖。

## 6. Lead 接入清单（`Room.runRound`）

1. **建计划（分派模式开始时）**
   - `Room.assignTask` 已经在维护 `this.task_plan`（`room.js:281-310`）并做 `planTasks` 校验；
     在 `runRound` 进入分派模式时（`room.js:739` 之后）取
     `const plan = planTasks({ tasks: this.task_plan, members: this.members });`
     `if (plan.ok) this.execPlan = createExecutionPlan({ units: plan.units, order: plan.order });`
   - `planTasks().units` 自带 `bot_id`/`depends_on`，`write_scope`/`depth` 会被 executor 忽略，无需裁剪。
   - **生命周期**：`task_plan` 每轮开头清空（`room.js:739`），所以 `execPlan` 也是每轮一份；下一轮把
     `pending_assignments` 结构化后，再把两者一起跨轮持有。
2. **驱动循环（替换 `room.js:751-770` 的 assignmentOrder 查找）**
   - 计划存在时：`const ready = nextReady(this.execPlan)`；从 `ready` 里挑「对应 `bot_id` 还有挂起任务且
     本轮没说过话」的第一个 `unitId`；没有则 `break`（或回落到现有 `speaking_slots` 逻辑）。
   - 跑之前 `this.execPlan = markRunning(this.execPlan, unitId)`；`unitId → bot_id` 用
     `this.execPlan.units[unitId].bot_id`，挂起任务文本仍从 `pending_assignments[bot]` 取第一条
     （一个成员多条任务时只消费一条，见决策点 3）。
3. **收结果（`room.js:792-808` 之后）**
   - `const ok = !result?.error && Boolean(text);`
     `const out = markResult(this.execPlan, unitId, { ok, reason: result?.error || (text ? null : "无文本产出") });`
     `this.execPlan = out.plan;`
   - `for (const id of out.skipped)`：`this.system_notices.push(\`任务 ${id} 已跳过：${this.execPlan.skippedReason[id]}\`)`，
     并建议 emit 一个 `task_skipped` 事件（`{ task_id, member, reason }`）给 UI/日志；被 skip 的成员不要
     再进 `seen`，executor 本身也不会再返回它。
   - 失败单元自己的 notice 保持现状（`room.js:801-807`），executor 只负责下游短路。
4. **终止条件**：`nextReady()` 为空且 `isComplete(this.execPlan)` 为真 → 本轮结束；`guard < maxTurns`
   保留（防御任务计划与 speaking_slots 不一致）。legacy 模式（无 `task_plan`）完全保持现状，
   `taskPlanBotOrder()`（`room.js:312-328`）可继续作为没有 executor 时的兜底。
5. **回合汇总（可选）**：`round_completed` / `round_summary` 里带 `summarize(this.execPlan)`，
   让前端一次看到 `done/failed/skipped/pending/running`；失败单元 + skipped 下游的数量是验收信号。
6. **需要 Lead 决策的问题**
   - `task_skipped` 事件名与 payload 是否新增（建议 `{ task_id, member, reason }`，只读、不影响现有事件）。
   - 一个成员被分派多个任务时，本轮成员文本归属哪个 unit（当前串行回合只能取第一条；下轮结构化
     `pending_assignments` 后消解）。
   - `failed` 单元要不要在下一轮重试（本轮按契约「执行器轮」不做，omh 的重试分类也只留在 doc 里）。
   - `execPlan` 跨轮持有的时机（本轮跟 `task_plan` 一起每轮重建；若 Lead 想让失败状态跨轮保留，
     需要把 `task_plan` 的清理逻辑一起改）。
