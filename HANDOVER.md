# 交接文档（HANDOVER）

> 项目：**AgentFusion · 群聊智能体工作台**
> 交接日期：2026-11-06 ｜ 代码状态：可运行、294 测试全绿、源码版与打包版真实群聊均 PASS
> 读者：接手的同事（预期熟悉 Node.js / 前端；不需要读过 Hermes 源码）

---

## 0. 30 秒速览

- **这是什么**：一个 Electron 桌面软件。内核是成熟的 **pi**（`@earendil-works/pi-coding-agent` 1.5.0）——
  工具循环、会话管理、压缩、Agent Skills、钩子都由它提供；我们只在其上做「群聊协作」这件事。
- **怎么跑**：先启动本机 Magpie 网关（OpenAI 兼容，默认 `http://127.0.0.1:3425/v1`），
  再 `npm start` 打开 `http://127.0.0.1:8720`，或双击打包好的 `AgentFusion.exe`。
- **怎么验**：`node --test`（294 例，不联网、不需要网关）；真实回合用 `node tests/e2e_room.mjs`。
- **代码量**：`src/` 29 个 JS 文件（约 1.1 万行）、`web/` 零构建前端、`tests/` 20 个文件。
- **依赖**：**零 npm 依赖**（`dependencies: {}`）。所有能力用 Node 内置模块 + pi 的 bundle 实现。
- **绝对约束**：运行数据只写 **D 盘**（默认 `D:\AgentFusion`，指向 C 盘会拒绝启动）；仓库里不含任何密钥。

---

## 1. 交付物清单

| 类别 | 位置 | 说明 |
|---|---|---|
| 应用源码 | `src/` | 服务端：房间编排、引擎、审批、工具集、技能、记忆、上下文、证据、fanout/执行器、学习闭环、HTTP API |
| 前端 | `web/` | 零构建 vanilla JS/CSS；群聊、Chief、机器人、设置（审批/提案/能力/用量） |
| 桌面壳 | `desktop/` | Electron main/preload/splash；数据根重定向、单实例、打包运行 |
| 脚本 | `scripts/` | `build_portable.mjs`（便携版打包）、`smoke_desktop.mjs`（桌面冒烟）、`start_dev.mjs` |
| 测试 | `tests/` | 294 个单测/接口测试 + 3 个真实 e2e 脚本（`e2e_room`、`e2e_packaged`、辅助） |
| 设计文档 | `docs/` | 产品规格、Hermes 逐机制文档、采纳矩阵、验收记录（见 [`docs/INDEX.md`](docs/INDEX.md)） |
| 用户手册 | `交付说明.md` | 面向最终用户的操作说明（建群、分派、文件、小群、设置） |
| 参考源码 | `reference/README.md` | Hermes / oh-my-hermes 的**固定提交**克隆方法（不随仓库分发） |

> 本仓库**不含** `node_modules/`、`dist/`、运行数据、日志、`.pi-agent/` 和参考源码；
> 这些要么可重建，要么属于本机状态。

---

## 2. 环境与依赖

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **>= 22.19（推荐 24.x）** | 用到 `node:sqlite`（`DatabaseSync`）、`fetch`、`node:test`、ESM |
| Electron | **45.x**（仅打包需要） | 不装也行：开发模式直接跑浏览器；打包时脚本按下面顺序找 Electron dist |
| pi | **1.5.0**（`@earendil-works/pi-coding-agent`） | 运行时会从 `node_modules`、`../agentharness/desktop/node_modules`、`D:\tools\pi` 或 `FUSION_PI_PACKAGE` 找 |
| Magpie 网关 | OpenAI 兼容，默认 `http://127.0.0.1:3425/v1` | 模型名 `auto/deepseek-v4.1-flash`；apiKey 用占位串 `magpie-local` 即可 |
| 操作系统 | Windows 10/11（主目标） | 路径守卫、Electron 打包、C 盘检查都是按 Windows 写的 |

关键环境变量：

| 变量 | 默认 | 用途 |
|---|---|---|
| `FUSION_DATA_ROOT` | `D:\AgentFusion` | 数据根（SQLite、工作区、日志、设置、头像）。**C 盘会被拒绝** |
| `FUSION_PORT` | `8720` | 服务端口 |
| `FUSION_GATEWAY` | `http://127.0.0.1:3425/v1` | 网关地址 |
| `FUSION_ELECTRON_DIST` | 自动探测 | 打包时 Electron dist 路径 |
| `FUSION_PI_PACKAGE` | 自动探测 | 打包时 pi 包路径 |
| `FUSION_TEST_ROOT` | `D:\能力测试\temp\fusion-tests`（自动退化到系统临时目录） | 单测数据根（也会强制非 C 盘） |
| `FUSION_SINGLE_INSTANCE` | `1` | 设为 `0` 可并行开多个实例（打包 e2e 用） |

---

## 3. 快速开始

```powershell
# 0) 前置：Magpie 网关已在 127.0.0.1:3425 运行（否则界面能开、发消息报错）

# 1) 开发模式（浏览器）
npm start                      # 或 npm run dev（固定 8720）
# 打开 http://127.0.0.1:8720

# 2) 桌面包（需要 Electron 45 dist，见 §2）
node scripts/build_portable.mjs            # 全量：Electron 运行时 + resources/app
node scripts/build_portable.mjs --app-only # 只重建 resources/app（改代码后快速验证）
# 产物：dist\AgentFusion-win64\AgentFusion.exe（免安装目录版，可整体拷走）

# 3) 测试
node --test                    # 294 例，离线，数据根隔离
node tests/e2e_room.mjs        # 真实群聊一轮（需要网关，约 1–3 分钟）
node tests/e2e_packaged.mjs --port 8814 --data-root D:\能力测试\temp\pkgdata
node scripts/smoke_desktop.mjs --isolated   # 桌面冒烟（启动→健康检查→截图→退出→C 盘检查）
```

> **注意**：打包版 e2e 与桌面冒烟**不要并发跑**。两个 Electron 实例会互相干扰退出
> （我们踩过：并发时打包版窗口被提前关闭，表现为 `database is not open`）。
> 单测可以任意并行。

---

## 4. 目录结构

```text
agent_for_myself/
├── README.md                 # 项目介绍（先读这个，再读 HANDOVER）
├── HANDOVER.md               # 本文
├── 交付说明.md                # 最终用户操作手册
├── package.json              # scripts + fusion 打包配置；无 npm 依赖
├── .gitignore
├── src/
│   ├── main.js               # 入口：启动 HTTP 服务 + 打开浏览器（桌面模式由 Electron 调用）
│   ├── config.js             # 路径/端口/网关/Electron/pi 探测；assertNotC 守卫
│   ├── store.js              # SQLite（node:sqlite）：迁移、房间/消息/文件/事件/用量/KV
│   ├── approvals + hooks     # 审批分层与钩子编排（见 §6）
│   ├── toolsets.js           # 命名工具集 / includes / 角色裁剪
│   ├── memory.js             # 持久记忆（scope + FTS5 + 审计）
│   ├── events.js / log.js    # 事件总线与日志
│   ├── engine/
│   │   ├── pi.js             # pi 内核加载（createAgentSession / SessionManager / ResourceLoader）
│   │   ├── runtime.js        # 模型/网关/gateway 探测
│   │   ├── bot.js            # BotRunner：把 pi 会话包成「成员回合」，挂工具与 hooks
│   │   ├── archetypes.js     # 8 个角色（老板/工程师/审查员/文件管家/侦察员/文案/分析师/规划师）
│   │   └── chief.js          # 单聊「总管」会话
│   ├── rooms/
│   │   ├── manager.js        # 房间生命周期（恢复/删除/级联）
│   │   ├── room.js           # 回合编排：分派、发言顺序、上下文、证据、学习、小群
│   │   ├── context.js        # 水位 + 增量 + 确定性摘要 + 预算裁剪
│   │   ├── evidence.js       # observed/prepared/mismatch 证据阶梯
│   │   ├── fanout.js         # 任务单元契约（写域冲突、依赖拓扑序）
│   │   ├── executor.js       # 执行状态机（失败沿依赖边跳过下游）
│   │   ├── files.js          # 群文件空间（file_id 引用）
│   │   └── tools.js          # 房间内工具（分配/权限/文件/证据/技能/记忆）
│   ├── skills/
│   │   ├── guard.js          # 技能安装静态扫描（21 条规则）
│   │   ├── telemetry.js      # 技能用量事件
│   │   ├── curator.js        # 提案/审查/采纳 + stale/archive
│   │   ├── learn.js          # 经验 → playbook 草稿（质量闸门 + signature）
│   │   └── judge.js          # reviewer 三态裁决解析
│   └── api/server.js         # 全部 HTTP API（约 2800 行；见 §7）
├── web/                      # 零构建前端（api.js / store.js / app.js / views/ / app.css）
├── desktop/                  # Electron 壳（main.cjs / preload.cjs / splash.html）
├── scripts/                  # 打包、冒烟、开发启动
├── tests/                    # 294 例 + e2e
└── docs/                     # INDEX + 规格 + Hermes 文档 + 验收记录
```

---

## 5. 架构总览

### 5.1 分层

```text
┌──────────────────────────── Electron 桌面壳（desktop/）────────────────────────────┐
│  数据根重定向到 D 盘 · 单实例锁 · 启动 splash · 加载 http://127.0.0.1:PORT          │
└──────────────────────────────────────┬─────────────────────────────────────────────┘
                                       │ HTTP + SSE
┌──────────────────────────────────────▼─────────────────────────────────────────────┐
│ web/（vanilla JS）：群聊 / Chief / 机器人 / 设置（审批·提案·能力·用量）             │
└──────────────────────────────────────┬─────────────────────────────────────────────┘
                                       │ REST + /api/events
┌──────────────────────────────────────▼─────────────────────────────────────────────┐
│ src/api/server.js：路由、校验、SSE 广播、静态资源                                  │
├────────────────────────────────────────────────────────────────────────────────────┤
│ src/rooms/room.js：一次群消息 = 一个 Round                                          │
│   分派(fanout) → 发言顺序(executor) → 每成员回合(pi 会话) → 证据判定 → 学习提案     │
│   ├─ context.js   本轮注入什么（水位/摘要/预算）                                   │
│   ├─ evidence.js  回合声明 vs 工具事实                                             │
│   └─ skills/learn + judge：回合质量 → 技能草稿/裁决                                │
├────────────────────────────────────────────────────────────────────────────────────┤
│ src/engine/bot.js：pi createAgentSession + 工具集 + hooks + 压缩配置                │
│ src/engine/archetypes.js：角色 → 提示词 / 工具面 / 模型                             │
├────────────────────────────────────────────────────────────────────────────────────┤
│ src/{approval,hooks,toolsets,memory}.js：审批地板/缓存/熔断/审计、工具面、记忆      │
├────────────────────────────────────────────────────────────────────────────────────┤
│ src/store.js：SQLite（房间/消息/文件/事件/用量/审批/技能/记忆/证据/KV）             │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 一条群消息的完整生命周期（`Room.runRound`）

1. **入口**：`POST /api/rooms/{id}/say` 写入用户消息，触发 `runRound(instruction)`。
2. **发言槽**：有 `@成员` 只跑被点名的人；否则群主优先。
3. **群主分派**：群主回合可调 `room_assign_task`（可带 `task_id` / `write_scope` / `depends_on`）。
   分派时用 `planTasks()` 校验：**两个任务写同一片区域且没有依赖 → 直接拒绝**（把原因回给群主改成分步）。
4. **顺序**：`executor` 用依赖拓扑序选下一个成员；上游失败/无产出 → 下游 `skipped`，写系统通知并广播 `task_skipped`，兄弟分支照常。
5. **每个成员回合**：
   - `composeContext()` 取「上次水位之后」的新消息 + 摘要，超预算就裁剪；
   - `buildInstruction()` 拼角色提示词 + 本轮任务 + 上下文 + 群文件索引；
   - `BotRunner.run()` 起 pi 会话，工具调用经 `hooks`（静态 deny → 审批地板/模式/缓存 → 人工等待），
     `toolResults` 回传每个工具的真实结局；
   - 结果写入 `room_messages`，同时 `evidence.record()` 判定 observed/prepared/mismatch；
   - 更新执行计划（失败会向下游传播 skip）。
6. **群主汇总**：群主可再发言，引用证据与文件；`turn_completed` 事件带 `seq` + `evidence`。
7. **学习闭环**：回合结束后 `proposeLearningSkill()`：
   - 质量闸门：≥2 个成员回合、无 mismatch、reviewer 通过（在场未表态 → 不学）、`auto_propose_skills` 模式；
   - 生成五段 playbook（目标/步骤/验收/证据 file_id/适用场景）+ signature 去重；
   - `curator.propose()` 只产生 `proposed`，**必须人工在「设置 → 提案」采纳**才落盘（落盘前还会过技能守卫）。
8. **收尾**：发 `round_completed`（含本回合证据统计），前端刷新。

---

## 6. 模块手册（改代码前先看这里）

### 6.1 `src/approval.js` —— 审批
- 模式：`yolo`（默认）/`smart`/`ask`；**8 条硬地板**在任何模式下都拦（C 盘写入、`rm -rf`、外发网络等）。
- 三态缓存：`once`（一次性）/`session`（本会话）/`always`（跨重启，落库）。
- 拒绝熔断：连续拒绝达阈值后直接 deny，不再弹窗。
- 审计：`appr_audit` 记录 decision/scope/by/mode/reason/ts。
- 关键 API：`createApproval({store,now,denialThreshold})` → `evaluate/request/resolve/waitFor/pending/audit/stats`。
- 扩展点：加地板 → `FLOORS`；加安全命令 → `SHELL_DEV_SAFE_RE` / `isSafeCompoundCommand()`。

### 6.2 `src/hooks.js` —— pi 钩子接入
- 顺序：静态规则（allow/deny regex）→ 地板 → 缓存/模式 → `waitFor()` 人工等待。
- fail-closed：策略异常/超时一律阻断。
- 通过 `createHooksExtension()` 注入 pi 的 `tool_call` / `tool_result` / `session_before_compact` 等事件。

### 6.3 `src/toolsets.js` —— 工具面
- 15 个命名工具集（file/room/room_files/skills/memory/web/evidence/...），支持 `includes` 递归与**末端减除**。
- `ROLES`：owner/worker/member/reviewer/librarian/writer/guest；`ARCHETYPE_TOOLSETS` 把角色映射到工具集。
- 房间级 `disabled_toolsets` 热更新；改工具面不用重建 pi 会话。
- 扩展点：加工具 → 先在 `src/rooms/tools.js` 里定义，再加进对应 `TOOLSETS` 与 `CORE_TOOLS`。

### 6.4 `src/skills/*`
- `guard.js`：21 条规则 → allow/review/block；`adopt()` 前必扫。
- `telemetry.js`：`skill_usage_events`，14 天半衰期评分。
- `curator.js`：`propose / review / adopt`；`transitions()` 负责 stale/archive。
- `learn.js`：`evaluateLearningGate()` + `buildSkillDraft()`（纯函数，无 IO）。
- `judge.js`：`judgeReviewer({turns})` → `{verdict, matched, reasons}`（纯函数）。

### 6.5 `src/memory.js`
- 三级 scope：`global`（跨房间）/`room`/`bot`；FTS5 检索；去重；`mem_audit`。
- 工具面：`memory` 动作 save/replace/remove/search/list。

### 6.6 `src/rooms/context.js`
- 水位 KV：`ctx:wm:<room>:<bot>`；`deltaFor()` 只取新消息；`digestText()` 生成确定性摘要；
  预算裁剪（默认 12k 字符级）；`compose()` 一次性返回 `{text, throughSeq, stats}`。
- 效果：3 成员 6 轮注入 97,002 → 36,288 字符（−62.6%）。
- **不要**把记忆/摘要塞进 system prompt：pi 的 prompt 前缀缓存要求历史稳定（Hermes 的第一不变量）。

### 6.7 `src/rooms/{fanout,executor}.js`
- `fanout.planTasks({tasks, members})` → `{ok, errors, order, units, conflicts}`；
  写域按路径段判前缀；错误码 11 个；依赖闭包放行。
- `executor.createExecutionPlan/markResult/nextReady/isComplete`：6 状态机，
  失败向**传递下游**传播 `skipped`，兄弟不动。
- `Room.assignTask()` 是唯一分派入口；`runRound` 用 `_readyBot` 决定谁先跑。

### 6.8 `src/api/server.js`
- 14 组路由（rooms/messages/files/approvals/skills/memory/evidence/learn/events/models/health...）。
- 资源获取统一走 `getRoomObject(app, roomId)`；SSE `/api/events` + thread replay。
- 新增端点：先加 `ROUTES`，再在对应段落实现；错误统一 `sendJson(res, status, {error})`。
- 前端契约见 `web/js/api.js`（每个函数对应一个端点，注释带路径）。

### 6.9 `web/` 与 `desktop/`
- 前端无构建：改完刷新即可；状态集中在 `web/js/store.js`，视图在 `web/js/views/`。
- 桌面壳负责：把 `app.getPath('userData')` 等重定向到数据根、单实例、启动 splash、退出时停服务。

---

## 7. 数据模型与存储

默认根：`D:\AgentFusion`（`FUSION_DATA_ROOT` 可覆盖；C 盘直接拒绝）。

```text
D:\AgentFusion\
├── data\fusion.db          SQLite：全部结构化数据
├── workspace\              每个 bot / 房间的工作目录
├── rooms\<room>\files\     群文件本体（file_id 索引在 DB）
├── agents\                 各 agent 的会话状态
├── sessions\               pi 会话
├── logs\app.log            排障日志
├── .fusion\                设置、hooks、技能、头像
└── temp\                   临时
```

主要表（`src/store.js` 与各模块的 `SCHEMA`）：

| 表 | 用途 |
|---|---|
| `rooms` / `room_members` | 房间（含 `settings_json`）、成员与权限 |
| `room_messages` | 消息（用户/成员/系统），`seq` 是房间内序号 |
| `room_files` | 群文件索引（`file_id` → 路径/描述/tags） |
| `events` | 事件流（SSE 回放、验收取数） |
| `usage` | token/耗时用量 |
| `kv` | 水位、去重签名、杂项状态 |
| `bots` / `tickets` / `pending_notices` | 机器人配置、单聊票据、系统通知 |
| `appr_*` | 审批缓存与审计（`approval.js`） |
| `skill_usage_events` / `skill_curator_state` / `skill_proposals` | 技能遥测、策展、提案（`skills/*`） |
| `mem_entries` / `mem_fts` / `mem_audit` | 记忆与全文索引（`memory.js`） |
| `ev_records` | 证据阶梯（`rooms/evidence.js`） |

迁移策略：`store._migrate()` 用 `PRAGMA table_info` + `ALTER TABLE` 增量加列；**不要**手改库结构，
新增列请走迁移函数（参考 `rooms.settings_json` 的加法）。

---

## 8. Hermes 吸收说明（这套东西从哪来）

六轮吸收的完整对照见 [`docs/hermes/ADOPTION_MATRIX.md`](docs/hermes/ADOPTION_MATRIX.md)：
**18 项采纳/改写/部分、4 项明确不采纳、1 项未做**，每项都带 Hermes 源码行号与我们的测试。

- 为什么抄：Hermes 把「长任务的可靠性」拆得很细（审批地板、证据、压缩、失败传播、技能沉淀），
  正是群聊多 agent 最容易翻车的地方。
- 怎么抄：**按语义重写**为纯 JS，不复制源码、不引入 Python；需要对照时按
  [`reference/README.md`](reference/README.md) 的固定提交克隆。
- 我们明确**没抄**：多平台网关、cron/kanban/语音、Python 契约层整体移植、训练轨迹/评测集
  （理由见矩阵 §1 与 `docs/hermes/HERMES_ARCH.md` §9）。
- 新增机制的流程：读 `docs/hermes/CONTRACT.md` 对应章节 → 写纯模块（无 IO）→ 单测 →
  在 `room.js`/`bot.js` 接线 → 真实 e2e → 写 `docs/hermes/<NAME>.md` + 验收记录 → 更新采纳矩阵。

---

## 9. 测试与验收

| 层 | 命令 | 说明 |
|---|---|---|
| 单测/接口 | `node --test` | **294 例**，无网络/无 LLM；数据根自动重定向并清理 |
| 真实群聊（源码） | `node tests/e2e_room.mjs --port 8803` | 需要网关；约 1–3 分钟；校验消息/文件/事件/证据 |
| 真实群聊（打包） | `node tests/e2e_packaged.mjs --port 8814 --data-root <D盘目录>` | 驱动真实 exe |
| 桌面冒烟 | `node scripts/smoke_desktop.mjs --isolated` | 启动→health→窗口文本→截图→退出→无残留→C 盘零新增 |

当前基线（2026-11-06）：

- 单测 **294/294 pass**；
- 源码版 e2e **PASS**（107s，含 `skill_proposed`）；
- 打包版 e2e **PASS**（52s，打包版内部自己生成了学习提案）；
- 冒烟 **PASS**；C 盘零新增。

验收记录全部在 `docs/verification/`（每一轮的失败、修复、证据都在里面，包括真实 e2e 抓到的
reviewer 否定语境误判）。**改动核心逻辑后，请至少跑「单测 + 源码版 e2e」；改桌面壳/打包脚本要加跑打包版与冒烟。**

---

## 10. 开发约定与已知坑

1. **D 盘限定**：`config.assertNotC`、审批地板、Electron 路径重定向、冒烟 C 盘快照，四道防线。
   新写路径时一律用 `config.DIRS`，不要自己拼绝对路径。
2. **零 npm 依赖**：加依赖要先在群里/评审里说清理由；目前 `dependencies: {}`。
3. **ESM + 无构建**：服务端与前端都是原生 ESM/脚本；前端改完刷新，不要引入 bundler。
4. **pi 是 bundle**：`src/engine/pi.js` 从 `@earendil-works/pi-coding-agent` 的 `dist/bundle/index.js` 动态加载；
   升级 pi 前先跑全量测试，注意 `createAgentSession`/`SettingsManager` 的签名变化。
5. **prompt 前缀缓存**：除压缩外不要改历史消息；记忆走回合提示词，工具面热更新不重建会话。
6. **审批默认 `yolo`**：本地开发体验优先；对外演示/交付前把模式切到 `smart` 或 `ask`（设置页可切）。
7. **Electron 单实例**：并行跑多个实例要设 `FUSION_SINGLE_INSTANCE=0`；**打包 e2e 与冒烟不要并发**。
8. **端口占用**：e2e 脚本会 `taskkill` 自己的进程树；残留服务用
   `Get-NetTCPConnection -LocalPort <port> | Stop-Process` 清理。
9. **数据根隔离**：所有测试/探针必须走 `FUSION_DATA_ROOT` 或 `tests/_helpers/env.mjs`；
   不要把测试数据写进默认 `D:\AgentFusion`。
10. **文档风格**：`docs/hermes/*.md` 统一六节（是什么/为什么/怎么用/边界/验证/接入）；
    改行为要同步对应文档与 `ADOPTION_MATRIX.md` 的状态列。

---

## 11. 当前边界与推荐下一步

**已知边界（不影响现有闭环）**

- `pending_assignments` 仍是内存态：进程重启会丢「已分派未执行」的任务；
- 失败单元**不跨轮重试**（executor 终态先到先得，没有 `resumeUnit`）；
- 单聊 Chief 还没有接证据阶梯与房间压缩；
- 学习提案的标题是启发式提炼（可能仍带指令残片），正文是纯文本展示；
- 群主「并行」目前只保证顺序/依赖，不保证前序成功才启动后序（失败→跳过是有的）。

**推荐顺序**

1. 结构化 pending 落库 + 失败重试（`executor.resumeUnit` 语义）；
2. `chief.js` 接证据/压缩，顺手抽 `chief/bot` 的 turn 骨架（约 150 行重复）；
3. 群主汇总与证据冲突时自动标红/阻断；
4. 提案面板增强：Markdown 渲染、guard 拦截后的重试、分页；
5. 如果要跨平台：网关/渠道层是另一个话题，先别动内核。

---

## 12. 交接清单（接手时需要拿到/确认）

- [ ] **仓库权限**：能把代码推到 `github.com/zhutmg00-eng/agent_for_myself`；
- [ ] **Magpie 网关**：地址、模型名、是否共享；确认 `apiKey` 只是本地占位（不是真密钥）；
- [ ] **Electron 45 dist**：路径（`FUSION_ELECTRON_DIST`），或允许 `npm i -D electron@45` 后走本地 `node_modules`；
- [ ] **pi 包**：确认版本 1.5.0（`FUSION_PI_PACKAGE`）；
- [ ] **数据根**：确认同事机器上 `D:\AgentFusion` 可用（或统一改用 `FUSION_DATA_ROOT`）；
- [ ] **C 盘策略**：不可放宽；
- [ ] **演示账号/群**：现有 `D:\AgentFusion` 里的房间是否要迁移（目前不含在仓库里）。

---

## 13. 常见问题排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 界面能开、发消息报错 | 网关没起/地址不对 | 起 Magpie；检查 `FUSION_GATEWAY`；`GET /api/health` 看 `gateway_url` |
| 启动即退 | 数据根指向 C 盘 / Electron 单实例冲突 | 看 `logs\app.log`；设 `FUSION_DATA_ROOT` 到 D；并行实例设 `FUSION_SINGLE_INSTANCE=0` |
| 打包报「未找到 Electron dist」 | 只装了源码没装 Electron | 设 `FUSION_ELECTRON_DIST` 或 `npm i -D electron@45` |
| `database is not open` | 多个 Electron 实例互相干扰退出 | 串行跑打包 e2e / 冒烟；杀干净残留进程 |
| 群聊卡住不动 | 网关慢 / 审批在等人工 / 熔断 | 看 `/api/approvals`；提速照 `APPROVAL.md` 切 `yolo`；看 `logs\app.log` 的 `member failed` |
| 测试写不进 D 盘 | 没有 D 盘或目录权限 | 设 `FUSION_TEST_ROOT` 到可写目录（仍会拒绝 C 盘） |
| 技能提案一直空 | 回合不达标（<2 回合/有 mismatch/reviewer 未表态） | 设置 → 提案 看 `report`；或手动 `POST /api/rooms/{id}/learn` 看返回原因 |
| 页面样式没更新 | 浏览器缓存 | `Ctrl+F5`；前端无构建，改完直接刷新 |

---

## 14. 关键文件速查

| 想改什么 | 先看 |
|---|---|
| 群聊一轮怎么跑 | `src/rooms/room.js#runRound` |
| 分派/依赖/写域 | `src/rooms/fanout.js`、`src/rooms/executor.js`、`tools.js#room_assign_task` |
| 上下文变短了/变长了 | `src/rooms/context.js` |
| 证据三态判定 | `src/rooms/evidence.js`、`engine/archetypes.js` 审查员提示词 |
| 审批为什么被拦 | `src/approval.js#FLOORS`、`src/hooks.js` |
| 某个角色有哪些工具 | `src/toolsets.js`、`src/engine/archetypes.js` |
| 技能怎么安装/提案 | `src/skills/{guard,curator,learn,judge}.js` |
| 记忆为什么没注入 | `src/memory.js#contextBlock`、`room.js#memoryBlock` |
| 新增 API | `src/api/server.js`（ROUTES + 段落）与 `web/js/api.js` |
| 打包/冒烟 | `scripts/build_portable.mjs`、`scripts/smoke_desktop.mjs` |
| 验收历史 | `docs/verification/` |

---

## 15. 最后一句

这套东西的复杂度集中在 **「回合编排 + 证据 + 审批」** 三处；其余都是围绕它们的支撑。
接手时建议先跑一遍 `node --test`，再跑一次 `node tests/e2e_room.mjs`，
然后从 `HANDOVER §5.2` 的生命周期顺着读 `room.js` —— 读完就能动手。
