# 集百家之长：pi / omp / Hermes 架构调研与融合版落点

> 调研对象：`pi`（@earendil-works/pi-coding-agent 1.3.0，本地完整包）、`omp`（can1357/oh-my-pi，MIT）、`Hermes` 生态（NousResearch/hermes-agent + rlaope/oh-my-hermes，均 MIT）。
> 目标：为 `D:\能力测试\fusion`（引擎 = 本地 pi SDK；UI = 旧前端；数据 = node:sqlite；业务 = 群聊 2.0）提供"抄什么、抄到哪个文件、先抄哪个、会踩什么坑"的可执行结论。
> 本文只写一个文件（本文件），其它路径全部只读。所有引用均带本地路径或 URL；未验证的内容单独标注。

---

## 0. 阅读指南与结论速览

### 0.1 本文结构

| 章节 | 内容 | 读者 |
|---|---|---|
| 0 | 速览、方法论、验证过的事实 | 所有人 |
| 1 | pi：定位、分层、目录、运行时、关键机制 | 架构 / 引擎实现者 |
| 2 | pi SDK 精确 API 对照（本任务硬性要求） | 引擎实现者（第一优先） |
| 3 | omp：定位、架构、机制（多 provider / 子代理 / 审批 / 记忆） | 产品 / 编排实现者 |
| 4 | Hermes：Hermes Agent 本体 + oh-my-hermes 契约层 | 群聊 / 权限 / 记忆实现者 |
| 5 | 三项目横向对比 | 所有人 |
| 6 | 可借鉴清单大表（机制 / 证据 / 落点 / 优先级 / 风险） | 排期用 |
| 7 | 融合版模块映射、DB schema、SSE 协议、群聊 2.0 映射 | 实现者 |
| 8 | 明确不采纳清单及理由 | 评审用 |
| 9 | 给实现者的 20 条落地建议 | 上手第一天 |
| 10 | 证据索引与未验证事项 | 复核用 |

### 0.2 一句话结论

- **pi 是"引擎"，不是"产品"。** 它把会话、压缩、技能、扩展、工具、模型运行时全部做成了可注入的 SDK 边界；我们几乎不需要改 pi，只需要在 `DefaultResourceLoader` + `createAgentSession` + `session.subscribe` 三个点上做适配，就能把群聊 2.0 跑起来。**风险最大的是"会话持久化"**：pi 的事实来源是 JSONL（`SessionManager`），我们的构想是 SQLite，二者必须明确"谁是投影、谁是事实"。
- **omp 是"把 pi 做成 IDE 级产品"的答案。** 它是 pi-mono 的 fork，多出来的东西几乎全在"外围"：子代理 `task`（agent 定义用 Markdown 前 置元数据 + model role 路由 + worktree 隔离 `pi-iso`）、审批分层（read/write/exec + yolo + 受限目录 + 缓存）、记忆（5 种后端 + `memory://` URL + `learn` 沉淀技能）、统一 FS/URL 协议（`agent://`、`skill://`、`pr://`）。**这些外围机制绝大多数不依赖 Rust**，是我们最该抄的部分；它的 Rust 内核（bash 引擎、grep、AST）是"不采纳"清单。
- **Hermes 生态是本项目"业务契约"的最强参考。** Hermes Agent 本体提供了成熟的 skills（curator + usage 遥测 + 强制写作规范）、审批（`approval.py` 71KB + floor/yolo/smart 分层）、工具集（`toolsets.py` 单字典 + 平台级开关）、委托（`delegate_tool.py`）；oh-my-hermes 在它之上叠了一层"**只做契约、不假装执行**"的 Python 层：DAG 编排（`/dag-ulw`）、fanout 契约（`fanout_contract/v2`，worktree 隔离 + 依赖 + 边界冲突硬报错）、"可采纳/拒绝/延后都要写理由"的记忆审查、插件 hook 的 fail-closed/fail-open 分类、以及"observed evidence vs prepared coverage"的证据分层。**这正是群聊 2.0 需要的"权限 + 共享上下文 + 可审计"叙事。**

### 0.3 三项目定位对照（一句话版）

| 项目 | 是什么 | 代码规模/构成 | 对我们的角色 |
|---|---|---|---|
| pi | 可嵌入的 coding-agent SDK + CLI | TS（Node ≥22.19），`dist/` 已编译，含 41 篇 docs + 14 个 SDK 示例 + 90+ 扩展示例 | **引擎底座（已选定）** |
| omp | pi 的"全功能产品化" fork | TS（Bun 1.4.4+）+ Rust crates（~80k 行）+ 100+ 篇 docs | **机制参考（子代理/审批/记忆/协议）** |
| Hermes | 自学习 agent 平台 + 其上的流程契约层 | Python（hermes-agent 单仓库 1.4GB 量级；oh-my-hermes ~300MB 含文档） | **业务契约 / 群聊与权限叙事参考** |

---

## 1. 方法论：怎么读、怎么验、验到了什么

### 1.1 取证方式

1. **本地直读**（不依赖网络，可复现）：
   - `D:\tools\pi\node_modules\@earendil-works\pi-coding-agent\docs\*.md`（41 篇）
   - `...\dist\**\*.d.ts`（类型即契约，比文档更权威）
   - `...\examples\sdk\*.ts`（01–14，官方 typecheck 过）
   - `...\examples\extensions\**`（90+ 个真实扩展）
   - `D:\能力测试\fusion\.data\pi-agent\{models.json,settings.json}`、`D:\能力测试\fusion\scripts\smoke_pi.mjs`
2. **联网抓取**（原始文件优先于网页）：
   - GitHub API：`api.github.com/repos/{can1357/oh-my-pi, rlaope/oh-my-hermes, NousResearch/hermes-agent}`（元数据、目录树）
   - raw：`raw.githubusercontent.com/.../main/README.md`、`docs/*.md`、`AGENTS.md`
   - jsDelivr 兜底（raw 触发 429 时）：`cdn.jsdelivr.net/gh/<repo>@main/<path>`
3. **交叉验证**：一个机制至少两处证据（文档 + 代码路径/AGENTS.md/README），不一致时以代码路径与类型定义为准。

### 1.2 本次实际验证过的关键事实（可作为立项依据）

| # | 事实 | 证据（本地） |
|---|---|---|
| F1 | pi 1.3.0 的 SDK 入口导出 `createAgentSession / SessionManager / DefaultResourceLoader / ModelRuntime / defineTool / SettingsManager` 等全部关键符号 | `dist/index.d.ts` 第 3、9、15、19、20、21、22 行 |
| F2 | `createAgentSession` 的可注入边界共 12 项（cwd/agentDir/modelRuntime/model/thinkingLevel/scopedModels/noTools/tools/excludeTools/customTools/resourceLoader/sessionManager/settingsManager/sessionStartEvent） | `dist/core/sdk.d.ts:10-66` |
| F3 | `DefaultResourceLoader` 支持 `systemPrompt` / `appendSystemPrompt` / `additionalSkillPaths` / `extensionFactories` 等 20+ 覆盖点 | `dist/core/resource-loader.d.ts:70-124` |
| F4 | 会话持久化是 JSONL + 树（`id`/`parentId`），版本 3，11 种 entry 类型 | `docs/session-format.md:22-208` |
| F5 | 自动压缩触发条件为 `contextTokens > contextWindow - reserveTokens`（默认 16384 / keepRecent 20000） | `docs/compaction.md:29-37,431-437` |
| F6 | RPC 模式的线上协议是**严格 JSONL、只按 LF 切分**，且明确禁止用 Node `readline`（U+2028/2029） | `docs/rpc.md:50-57`、`docs/json.md:15-19` |
| F7 | 融合版已有可跑的 pi 冒烟脚本（magpie 网关 + in-memory session + 流式 delta） | `D:\能力测试\fusion\scripts\smoke_pi.mjs` |
| F8 | omp 的仓库本体是 pi-mono 的 fork，README 自述 "Fork of Pi (badlogic/pi-mono) by Mario Zechner" | omp README 尾部 Philosophy 段 |
| F9 | omp 的 `task` 子代理定义来自 `~/.omp/agent/agents/*.md` 与 `.omp/agents/*.md` 的 frontmatter（tools/spawns/model/thinking/output/blocking/structured/prewalk/advisor） | omp `docs/task-agent-discovery.md` |
| F10 | oh-my-hermes 明确"从不 patch 或替换 Hermes"，只做本地契约层 | omh README 首段 |
| F11 | Hermes 的插件 hook 契约区分 `policy_gate / prompt_context_contributor / result_transformer / lifecycle_callback / observer`，且 `pre_tool_call` 超时是 **fail-closed** | omh `docs/PLUGIN-HOOK-CONTRACT.md` |

### 1.3 三条"必须先定"的架构决策（本文建议值）

| 决策 | 选项 | 建议 | 理由 |
|---|---|---|---|
| 会话事实来源 | pi JSONL / 我们 SQLite / 双写 | **双写，SQLite 为事实，JSONL 为引擎投影** | pi 的 `SessionManager` 是模型上下文的唯一权威（`docs/sdk.md:38-41`），绕不开；但群聊需要跨房间查询、文件索引、审计，必须进 SQLite |
| 群成员 = 1 个 pi session？ | 每人一 session / 每群一 session | **每"成员人格"一 session，群是编排层** | omp 的 `task` 也是每子代理一个 child session；Hermes 的 delegate 同样隔离。共享上下文由"渲染进 prompt"实现，而不是共享内存 |
| 权限拦截点 | 自研 tool 包装 / pi `tool_call` 事件 | **pi `tool_call` 扩展事件 + 自研 approval 表** | `tool_call` 可 `{block:true,reason}`（`docs/extensions.md:167-179`），是官方唯一 fail-safe 拦截点 |

---

<!--CHUNK2-->

---

## 5. Hermes 吸收落地（2026-11-06，第二轮）

> 与第 4 章「调研 + 设计」不同，本章记录**已经写进代码并通过测试**的采纳项。
> 完整分析见 [`docs/hermes/`](hermes/)：架构解剖 [HERMES_ARCH.md](hermes/HERMES_ARCH.md)、
> 逐模块取舍 [APPROVAL.md](hermes/APPROVAL.md) / [TOOLSETS.md](hermes/TOOLSETS.md) /
> [SKILLS.md](hermes/SKILLS.md) / [MEMORY.md](hermes/MEMORY.md)、
> 下一轮候选 [OMH_AND_CONTEXT.md](hermes/OMH_AND_CONTEXT.md)。

### 5.1 源码基线

| 项目 | commit | 规模 | 用途 |
|---|---|---|---|
| `NousResearch/hermes-agent`（MIT） | `ca43606`（2026-11-05T23:01-05:00） | 22,595 文件 / 232 MB | 审批、工具集、技能、记忆、压缩语义 |
| `rlaope/oh-my-hermes`（MIT） | `1727425`（2026-11-06T13:34+09:00） | 3,827 文件 / 105 MB | 契约层：fanout、证据阶梯、记忆审查、hook fail-closed |

落盘位置 `D:\能力测试\reference\hermes\`（只读参考，不参与打包，不写 C 盘）。

### 5.2 已落地（代码 + 测试 + 文档）

| # | 机制 | 落地文件 | 语义要点 | 测试 |
|---|---|---|---|---|
| H1 | 审批四级闸门 | `src/approval.js`（705 行） | 8 条不可审批地板 → 三态缓存（once/session/always）→ 模式（yolo/smart/ask）→ 人工审批队列；连续拒绝 3 次熔断；`appr_audit` 留痕；`waitFor()` 同进程唤醒（不轮询 DB） | `tests/approval.test.mjs` 24 例 + `tests/hooks_gate.test.mjs` 8 例 |
| H2 | 命名工具集 | `src/toolsets.js`（395 行） | 14 个工具集 + `includes` 组合 + 姿态（coding/review/minimal）+ 7 个身份面 + 末端严格减除（工具名/工具集名同义） | `tests/toolsets.test.mjs` 19 例 |
| H3 | 技能守卫 | `src/skills/guard.js`（355 行） | 21 条规则（frontmatter、危险 shell、凭据外泄、提示注入、bidi/零宽、越界路径）→ allow/review/block | `tests/skills_guard.test.mjs` 20 例 |
| H4 | 技能用量遥测 | `src/skills/telemetry.js`（267 行） | `skill_usage_events`；score = 频次加权 × 14 天半衰期；stale/archive 判定 | 同上 + `skills_curator.test.mjs` 14 例 |
| H5 | 技能策展闭环 | `src/skills/curator.js`（396 行） | stale/archive 流转、经验提案（propose）→ 人工 review → **adopt 前必过 guard**，落盘到 `DIRS.skills` | `tests/skills_curator.test.mjs` 14 例 |
| H6 | 持久记忆 | `src/memory.js`（522 行） | room/bot/global 三级 scope × memory/user 两类 target；FTS5 优先 + bigram 兜底；pinned/时间衰减排序；去重；`mem_audit` | `tests/memory.test.mjs`（memory-dev 交付） |
| H7 | 记忆注入 + 记忆工具 | `src/rooms/room.js#memoryBlock`、`src/rooms/tools.js#memoryTools` | 每轮按预算注入三级记忆块（不塞 system prompt，避免破坏 pi 前缀缓存）；`memory` 工具支持 save/replace/remove/search/list | 探针实证（见 5.4） |
| H8 | 审批接入 pi | `src/hooks.js#createHooksExtension` | 静态规则 → 地板 → 缓存/模式 → `await waitFor()`；异常一律 fail-closed；坏正则不再让 deny 规则静默消失 | `tests/hooks_gate.test.mjs` 8 例 |

### 5.3 与调研结论的差异（改写了哪几条）

- **N5「Python 契约层整体移植」仍然不采纳**，但拆出可移植的**语义**分别落在 H1/H3/H5/H6 四个 JS 模块。
- **N7「记忆子系统」从"未采纳"改为"已采纳"**：只做 522 行的最小内核（写入闸门、检索、注入、审计），不做 Hermes 的 provider 体系。
- **Hermes 的 smart 守卫（调辅助 LLM）改写为确定性分类器**：新增「构建/测试命令白名单」，否则默认模式会把 `node --test` / `npm test` 全部挂起，产品不可用。
- **审批队列不接消息网关**：单进程 `waitFor()` + AbortSignal，UI 通过 `/api/approvals` 与 SSE `worker.<bot>.approval_requested` 消费。

### 5.4 验证证据（可复现）

```powershell
cd D:\能力测试\fusion
node --test                                  # 294 tests / 294 pass（新增 250 例）
node src/main.js --port 8770                 # 启动后 wiring 全绿
# GET /api/health → wiring: approval/telemetry/curator/memory 均 ok
# GET /api/toolsets → 14 个命名工具集
# POST /api/memory → save；GET /api/memory/search?q=floor → 命中
# POST /api/skills/proposals → POST .../review → POST .../adopt → /api/skills 出现新技能
```

真实群聊一轮（真 LLM + 真工具循环）见 `tests/e2e_room.mjs`；本轮回归结论记录在
`docs/verification/`（见验收记录）。

### 5.5 第三轮（同日，上下文/证据/审批 UI）

| # | 机制 | 落地文件 | 语义要点 | 证据 |
|---|---|---|---|---|
| H9 | 上下文水位 + 确定性摘要 + 预算裁剪 | `src/rooms/context.js`（399 行）+ `room.js#composeContext` | 每成员水位存 `kv`；摘要由主题/最近结论/文件清单确定性生成；`budget` 从旧到新整条裁剪并标注省略；`throughSeq/firstSeq` 保证「被裁掉的旧消息不被误标已读」 | `tests/context.test.mjs` 20 例；成本探针：6 轮 × 3 成员 97,002 → 36,288 字符（**37.4%**），第 6 轮单轮 27,717 → 6,048 |
| H10 | 证据阶梯 observed / prepared / mismatch | `src/rooms/evidence.js` + `room.js` 回合收尾 + `GET /api/rooms/{id}/evidence` | 用 `BotRunner.toolResults`（新增：名称/ok/结果摘要）判定；声明 `file_id` 但查不到 → mismatch；`ev_records` 幂等落库 | `tests/evidence.test.mjs` 24 例；真实 e2e 中 4 个成员回合全部记为 `observed` |
| H11 | 审批面板（前端） | `web/js/**` | 模式切换（yolo/smart/ask）、待裁决列表（Approve/Deny + once/session/always）、审计、pending 徽标；SSE `approval_requested` 驱动刷新 | Playwright 截图 + 交互验证 |
| H12 | pi 压缩策略项目级覆盖 | `config.js#COMPACTION` + `engine/bot.js` | 每个 bot cwd 写 `.pi/settings.json`：`reserveTokens=12000`、`keepRecentTokens=16000`（可从环境覆盖），让压缩更早发生 | 真实 e2e 工作区实测文件内容 |
| H13 | 房间级工具面裁剪 | `store.js`（rooms.settings_json 迁移）+ `Room#setSettings` + `PUT /api/rooms/{id}` | `disabled_toolsets` 房间维度生效；pi `setActiveToolsByName` 热更新，不重建会话 | `tests/store.test.mjs` 旧库补列用例 + `tests/room.test.mjs` setSettings 用例 |

### 5.6 第四轮（同日，fanout 契约 / 子群生命周期 / 证据可见）

| # | 机制 | 落地文件 | 语义要点 | 证据 |
|---|---|---|---|---|
| H14 | 小群生命周期回收 | `src/rooms/room.js#retireSubgroup` + `manager.delete` 级联 | 结论回传后默认 `dispose`（释放每成员常驻 pi session + 删房间记录）；`subgroup_lifecycle=keep` 可保留；历史 id 存 kv（`subgroup:history:<room>`）可追溯；父房删除递归删子房 | `tests/room.test.mjs`（回收/保留/历史持久化）+ `tests/manager.test.mjs`（级联） |
| H15 | 任务单元契约（omh fanout 最小内核） | `src/rooms/fanout.js` + `Room.assignTask` + `room_assign_task` 工具 | 任务单元 `{id, bot_id, write_scope, depends_on}`；写域重叠且无依赖 → **分派时硬报错**；拓扑序决定本轮发言顺序，`frontier()` 给可执行前沿 | `tests/fanout.test.mjs`（25 例）+ `tests/room.test.mjs`（冲突拒绝/顺序） |
| H16 | 审查员的证据硬约束 | `src/rooms/tools.js#evidenceTools` + `engine/archetypes.js` | 新只读工具 `room_evidence_status`；审查员提示词要求「对方声称完成但没有 observed 证据 → 只能判需修改」 | 真实 e2e 中 reviewer 实际调用了该工具（见验收记录） |
| H17 | 证据徽标 | `web/js/views/group.js` 等 | 消息元信息渲染 observed（绿）/ prepared（灰·仅声明）/ mismatch（红·证据不符），群头与 inspector 显示汇总与最近不符判定 | Playwright 截图 + `docs/hermes/EVIDENCE_UI.md` |

### 5.7 第五轮（同日，执行短路 + 学习闭环）

| # | 机制 | 落地文件 | 语义要点 | 证据 |
|---|---|---|---|---|
| H18 | 执行短路（DAG 失败传播） | `src/rooms/executor.js`（6 状态机）+ `Room._markTaskResult` | 单元状态 pending→ready→running→done/failed/skipped；上游失败沿依赖边**传递跳过**下游，兄弟分支不受影响；被跳过写系统通知并触发 `task_skipped` 事件 | `tests/executor.test.mjs`（15 例）+ `tests/room.test.mjs`（上游失败/兄弟不受影响） |
| H19 | 经验 → 技能提案（学习闭环） | `src/skills/learn.js` + `Room.proposeLearningSkill` + `POST /api/rooms/{id}/learn` | 质量闸门（≥2 回合、无 mismatch、reviewer 通过、`auto_propose_skills` 模式）→ 五段 Markdown playbook → signature 去重 → `curator.propose`；**不自动 adopt**（仍走 review + guard） | `tests/learn.test.mjs`（14 例）+ `tests/room.test.mjs`（自动提案/去重/off） |
| H20 | 手动学习入口 | `POST /api/rooms/{id}/learn` | 对应 Hermes 的「the workflow we just went through」斜杠命令；人工触发 force=true，跳过自动模式开关但仍过闸门 | 真实 HTTP 冒烟 |

### 5.8 第六轮（同日，裁决纯函数 / 提案面板）

| # | 机制 | 落地文件 | 语义要点 | 证据 |
|---|---|---|---|---|
| H21 | reviewer 裁决三态纯函数 | `src/skills/judge.js`（289 行） | `pass/reject/null` + `matched/reasons`；未表态 ≠ 通过；否定语境（“不用修改”）不误判；度量词形（“未通过率 0.3%”）不算裁决；中英混合；多 reviewer 任一 reject；emoji | `tests/judge.test.mjs` 22 例 + `tests/room.test.mjs` 集成 2 例 |
| H22 | 学习闸门识别「reviewer 在场未表态」 | `src/skills/learn.js` + `Room.judgeReviewerTurn` | `reviewerPresent` 是 §9.2 超集：沉默的 reviewer 不阻塞被当成通过，而是**不沉淀** | 同上 |
| H23 | 技能提案面板 | `web/js/{api,store,views/settings}.js` + CSS | 状态筛选/卡片/正文折叠/file_id chips/两段式采纳（review→adopt）/拒绝延后带原因/徽标/SSE 防抖 | Playwright 截图 + `docs/hermes/SKILL_PROPOSALS_UI.md` |
