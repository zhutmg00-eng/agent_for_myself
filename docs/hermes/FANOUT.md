# Fanout（写域 + 依赖纪律）吸收说明

> 交付物：`src/rooms/fanout.js`（389 行，纯常量 + 纯函数）、`tests/fanout.test.mjs`（24 用例）。
> omh 证据基于 `reference/hermes/oh-my-hermes`（`docs/FANOUT.md`、`src/plugin_bundle/omh/dag_core.py`、
> `src/coding/fanout.py`）；Fusion 证据基于本仓库当前文件。

## 1. omh 里是什么

1. **冻结前做确定性校验**：`omh coding fanout prepare` 在写 `fanout_contract/v2` 之前校验
   「写域重叠且没有 `depends_on` 边 = 硬错；依赖环 = 硬错；>4 单元无 spawn plan = 硬错」
   （`docs/FANOUT.md:12-20`）。
2. **校验顺序固定**：spawn plan 的闸门排在最后，先过写域重叠与依赖环——
   「a split that can never be frozen fails on its structure」（`FANOUT.md:135-137`）。
3. **调度按依赖前沿，不按波次**：一个单元在它依赖的单元全部完成、且池子有空位时立刻启动，
   慢兄弟不能饿死已就绪的依赖方（`FANOUT.md:313-320`）。
4. **DAG 内核只有一份**：`layer_of` 按「最长的父路径」分层，环上的节点留在 `stuck` 里
   （`dag_core.py:54-79`）；`ready()` 返回父节点全部满足的候选（`:92-94`）。
5. **引用错误先判**：`edge_problem()` 返回第一个坏引用——未知依赖或自依赖（`dag_core.py:44-51`），
   调用方各用各的错误类型与文案（`dag_core.py:12-20` 注释）。
6. **写域归一 + 前缀/通配判定**：`_scope_path()` 把 `\` 读成 `/`、casefold、走 `posixpath.normpath`，
   再算「它写在哪个目录下」与 glob（`dag_core.py:145-168`）；`_meets()` 判两条写域会不会写到同一个
   路径（`:171-181`）；`shared_scope_pairs()` 给出每对重叠单元与「是否直接有边」（`:184-209`）。
7. **重叠有边就串行化，没边就炸**：`detect_boundary_overlaps()` 对未串行化的重叠抛
   `FanoutContractError`，对已串行化的只记一条 resolution 注记（`fanout.py:413-430`）。
8. **拓扑序 = 层号 + id 排序**：`merge_order()` 用 `layer_of(..., strict=True)`，环则抛错
   （`fanout.py:436-441`）；单元 id、owner、非空 `file_scope` 在 `validate_fanout_units()` 里先过
   一遍（`fanout.py:244-300`）。
9. **边界纪律有下游依赖**：验证检查的 `depends_on` 同样拒绝未知、自依赖、环，且「一项检查只在它
   依赖的检查全部通过后才开始」（`FANOUT.md:579-589`）；调试型拆分还要求每个单元都能通过
   `depends_on` 走到复现单元，否则冻结失败（`FANOUT.md:479-499`）。

## 2. 为什么值得抄（对应我们群聊产品的缺口）

- **分派只有插入顺序**：`Room.assignTask` 把任务字符串 push 进 `pending_assignments`
  （`src/rooms/room.js:269-276`），`runRound` 按 `Object.keys(pending_assignments)` 的插入序点名
  （`:699-708`）。
- **没有写域概念**：两个成员可以同时被分派去改同一个文件，没有任何检测；谁先谁后取决于群主说话
  的先后，而不是依赖关系。
- **工具层也不表达依赖**：`room_assign_task` 只有 `member` + `task` 两个参数，描述里直接写
  「按分派顺序发言」（`src/rooms/tools.js:69-81`）。
- **没有可解释的失败**：现在只能靠成员自己说「我先改了 X」，群主无法在分派时就知道「这俩会打架」。
- **omh 的答案是数据化的**：写域 + 依赖是一等公民，冻结前就能算出冲突与执行顺序；我们把它降级成
  纯函数，先解决「校验与排序」，执行隔离留给后续。

## 3. 我们落地成什么（`src/rooms/fanout.js`）

**接口（与契约 §8.1 逐字一致；另加 `FANOUT_ERROR_CODES` 便于 UI 转述）**

| 导出 | 位置 | 说明 |
|---|---|---|
| `FANOUT_LIMITS` | `src/rooms/fanout.js:14` | `{ maxTasks: 12, maxScope: 8, maxIdLength: 40 }`，冻结 |
| `FANOUT_ERROR_CODES`（附加） | `:17` | 11 个错误码的公开清单，UI 只按 `code` 分支 |
| `normalizeScope(scope)` | `:77` | 字符串或数组 → `string[]`：小写、`\`→`/`、折叠重复斜杠、去尾斜杠、去空去重 |
| `scopesOverlap(a, b)` | `:118` | 按路径段判前缀（相等或一方是另一方前缀）；大小写/反斜杠不敏感 |
| `planTasks({tasks, members})` | `:137` | 校验 + 拓扑排序 → `{ok, errors, warnings, order, units, conflicts}` |
| `frontier(order, units)` | `:365` | 依赖已满足、可立即执行的 id（按 `order` 顺序） |

**错误码表（`errors[]` 的 `code` 是机器契约，`message` 是中文人话）**

| code | 触发条件 | 附带字段 |
|---|---|---|
| `invalid_task` | 任务不是对象 / `tasks` 不是数组 / `id` 非字符串 / `write_scope`、`depends_on` 非字符串数组或含空项 / 缺 `bot_id` | `task_id?` |
| `empty_id` | `id` 缺失或去空白后为空 | — |
| `id_too_long` | `id` 超过 40 字符 | `task_id` |
| `duplicate_id` | 同一 `id` 出现第二次（保留第一条） | `task_id` |
| `unknown_member` | `bot_id` 不在 `members` 里 | `task_id`、`other_id` |
| `unknown_dependency` | `depends_on` 指向未声明的 id | `task_id`、`other_id` |
| `self_dependency` | 任务依赖自己 | `task_id`、`other_id` |
| `cycle` | Kahn 分层后仍有节点未放置 | `task_id`（环上第一个） |
| `write_conflict` | 两任务写域重叠，且互不在对方依赖闭包里 | `task_id`、`other_id` |
| `too_many_tasks` | 声明任务数 > `maxTasks` | — |
| `scope_too_large` | 单任务归一后写域条目数 > `maxScope` | `task_id` |

**语义决定（契约没写死、由本实现固定下来的部分）**

- **写域重叠的放行条件是「依赖闭包」而不是「直接边」**：契约 §8.1 原文是「互不在对方的依赖闭包
  里 → `write_conflict`」。因此 `A→B→C` 且 A、C 写域重叠也放行（只记 `warnings`）。这比 omh 的
  `shared_scope_pairs(joined=直接边)`（`dag_core.py:184-209`）更宽松一档：跨层串行同样安全。
- **`units` 保持声明顺序**，`order` 才是拓扑序；`depth` 是 Kahn 层号（0 起），有环未放置时为 `-1`。
- **同层声明序**：每层按声明顺序收集 `ready`，因此无依赖任务保持群主分派的先后。
- **错误优先级固定**：`too_many_tasks` → 逐任务结构错误（声明序）→ 引用错误（`self`/`unknown`）→
  `cycle` → 写域冲突成对（声明序）。同输入必得同输出，UI/测试可以直接断言数组。
- **结尾 `*`/`**` 折成目录**（`src/**` → `src`，`**` → 空）；麻烦的是中间通配（`src/*.md`）——
  契约只定义了结尾通配，这里按字面保留并在 doc 里写明，避免"看起来支持 glob"的误解。
- **空写域合法**：不声明写域 = 不参与冲突检测（分析/写作类任务常见）；omh 要求非空 `file_scope`
  （`fanout.py:261-263`），我们放宽，把「声明写域」留成可选增强。
- **出错时 `order`/`units` 是尽力而为**（能排序的部分照常给出）；调用方应先看 `ok`。
- **`frontier` 的完成标记**：`units[]` 里 `done: true` 或 `status` 命中
  `done/completed/complete/ok/success/succeeded/passed` 视为已完成；没有标记时返回 depth 0 的起点。

**没有表结构**：纯函数不落库；`planTasks` 的输入是内存里的任务声明，持久化由 Lead 决定（见 §6）。

**采纳 / 改写 / 不采纳**

- 采纳：冻结前校验、写域重叠硬错、依赖环硬错、同层声明序、`depth` 分层、`frontier` 依赖前沿、
  错误码机器可读（omh 用异常文案，我们降级成 `{code, task_id, other_id, message}`）。
- 改写：① 放行条件从「直接边」放宽到「依赖闭包」（契约要求）；② 写域比较简化成「归一化 + 段前缀」，
  不做 fnmatch glob（`src/*.md` 不展开）；③ 上限从 omh 的 4 单元 spawn-plan 阈值换成 12 任务硬上限；
  ④ 错误不抛异常而是收集进 `errors[]`，便于一次看完所有问题。
- 不采纳：per-unit worktree / branch（`FANOUT.md:403-407`）——我们不 spawn 子进程，所有 bot 共用同一
  工作区；spawn plan 四问法（`FANOUT.md:104-151`）与 owner identity/类别路由；重试与
  `retry_blocked_by_side_effects`（`FANOUT.md:289-312`）；持久化 contract/journal——那是 Lead 的 store 决策。

## 4. 与 omh 的差异与取舍

- **范围**：omh 的 fanout 是"冻结 + 派发 + 观测 + 合并"的完整生命周期（`FANOUT.md:10-46`，1500+ 行文档）；
  我们只做生命周期第一步的**校验 + 排序**，执行仍由 `Room.runRound` 串行点名完成。
- **隔离**：omh 一单元一 worktree、一进程组（`FANOUT.md:403-407`）；我们同进程同工作区，所以
  `write_scope` 是"声明纪律"而不是"文件系统强制"，重叠只能靠硬报错拦住。
- **规模**：`dag_core.py` 209 行只覆盖图算法，`fanout.py` 48174 字节；我们 389 行覆盖校验 + 排序 +
  错误表，符合契约 §0.6「≤400 行/模块」。
- **语言/运行时**：omh 纯 Python + 异常；我们 ESM 纯函数 + `errors[]`，无 IO、无 LLM、确定性。
- **默认值**：omh 要求 ≥1 单元、非空 `file_scope`、owner 合法（`fanout.py:244-300`）；我们允许空写域，
  且 `members` 决定 `bot_id` 是否合法（`owner` 概念由群成员表承担）。
- **兜底**：`frontier` 是我们自己补的（omh 的 `ready()` 需要一个 `satisfied` 集合，`dag_core.py:92-94`），
  把"完成标记"放到 unit 上，保持两参数签名。

## 5. 验证证据

```text
$ cd D:\能力测试\fusion; node --test tests/fanout.test.mjs
ℹ tests 24   ℹ pass 24   ℹ fail 0   ℹ duration_ms 373.64
```

覆盖：上限/错误码常量、空输入、`normalizeScope`（大小写/反斜杠/尾斜杠/去重/结尾通配/根路径）、
`scopesOverlap`（相等、目录覆盖文件、`src` vs `src2`、数组、根 vs 相对）、正常 DAG（order/depth/units 形状）、
同层声明序与跨层聚合、单点依赖、未知成员、未知依赖、自依赖、依赖环（depth -1、环外可排序）、重复 id、
id 长度边界（40 过 / 41 报）、写域重叠硬报错（conflicts 对）、直接依赖放行、依赖闭包放行、
目录 vs 文件 + 大小写/反斜杠、任务数与写域上限、`invalid_task` 各形态、`frontier` 逐层推进与 `status`
形态、纯函数（确定性/不改入参/返回副本）、空写域、members 对象形态与依赖去重。

```text
$ cd D:\能力测试\fusion; node --test
ℹ tests 229   ℹ pass 229   ℹ fail 0
```

全量全绿（本轮基线 198，叠加本模块 24 个用例与并行模块的增量；交付时 229，数字随并行模块增长）。零 C 盘写入、数据根由
`tests/_helpers/env.mjs` 隔离、无新依赖。

## 6. Lead 接入清单

1. **`room_assign_task` 参数（`src/rooms/tools.js:69-81`）**
   - 新增可选参数：`task_id`（缺省由工具生成 `t1`/`t2`…）、`write_scope`（string[]）、
     `depends_on`（string[]）。`member`→`bot_id` 映射保持现状（工具参数仍叫 `member`）。
   - 工具内先做 dry-run：把「本次 + 已挂起的任务」交给 `planTasks`；`ok === false` 时把
     `errors.map(e => e.message)` 拼成工具错误返回（不要静默丢字段），`warnings` 作为成功提示附在结果里。
2. **`Room.assignTask` 累计（`src/rooms/room.js:269-276`）**
   - 建议签名扩成 `assignTask(botId, task, { id, write_scope, depends_on } = {})`，把任务存成结构化记录
     `{ id, bot_id, task, write_scope, depends_on }`；`pending_assignments[id]` 仍是数组，保持现有测试与
     API 兼容（字符串调用自动补 id 与空写域）。
   - 新增只读方法 `planAssignments()`：收集全部挂起任务 → `planTasks({tasks, members})`，供 `runRound`、
     工具层和 UI 共用一份真相；重启会丢挂起任务（内存态，`room.js:84`），如需跨重启由 Lead 决定落库。
3. **`runRound` 按 order 排（`src/rooms/room.js:697-708`）**
   - 把 `assignmentOrder` 的构建换成 `planAssignments().order`；当 `order` 为空但仍有挂起任务时回落到
     原来的插入顺序（坏计划不阻塞整轮，只在系统通知里报告 `errors`）。
   - 建议按层执行：每层取 `frontier(plan.order, units)`（标记上一轮已完成的单元）→ 逐个点名；没有
     依赖声明时所有任务 depth 0，行为与今天完全一致（同层声明序 = 分派顺序）。
   - 成员失败/无文本时不要标记完成（现状是 `continue`），下一层因此会等待——但"等待"在本轮循环里
     表现为继续找下一个可发言者；最坏情况本轮结束，错误写进 `system_notices` 即可。
4. **服务端暴露 plan（`src/api/server.js`，可选）**
   - `GET /api/rooms/:id/fanout` → `planAssignments()` 的 JSON（只读），供前端展示依赖图/冲突；
     是否暴露由 Lead 决定（本轮契约 §8.2 只要求 evidence，不强制这个）。
   - 若暴露：`ok:false` 时返回 200 + 计划体（沿用 API 现有错误风格），让前端渲染 `errors[]` 而不是 400。
5. **兼容性红线**
   - `room_assign_task` 不传新参数时行为必须与现在一致：串行、按分派顺序、`runRound` 结果不变
     （`tests/room.test.mjs:397-405` 已锁定 `pending_assignments.coder === ["写测试"]` 这类字符串形态）。
   - **需要 Lead 决策**：① `pending_assignments` 的存储形态（字符串数组 vs 结构化记录，建议后者 +
     兼容读取字符串）；② 是否把 `planAssignments()` 暴露成 API；③ 任务 id 由工具生成还是群主显式给
     （显式给才能让 `depends_on` 跨调用引用）；④ 成员失败时的语义——是否把该单元标成失败并让下游
     `frontier` 永远等不到（当前建议：本轮不阻塞，下一轮重试）。
