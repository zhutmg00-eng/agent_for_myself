# AgentFusion · 群聊智能体工作台

> 本工程不再从零手写 harness：以成熟的 **pi**（`@earendil-works/pi-coding-agent` 1.5.0）为内核，
> 在其上叠加我们的「群聊协作」构想，并用 Electron 打包成可直接双击运行的桌面软件。
>
> 关键约束：**零 C 盘写入**（数据、缓存、临时、Electron userData 全在 D 盘）。
>
> **第一次接手请先读 [`HANDOVER.md`](HANDOVER.md)**（环境、架构、模块手册、踩坑、交接清单）；
> 文档总目录见 [`docs/INDEX.md`](docs/INDEX.md)。

## 1. 立即运行

| 方式 | 操作 |
|---|---|
| **安装** | `npm install`（只装 pi；单测不需要网关） |
| **开发模式（浏览器）** | `npm start`（或 `node src/main.js`），打开 `http://127.0.0.1:8720` |
| **桌面打包** | `node scripts/build_portable.mjs`（增量：`--app-only`）→ `dist\AgentFusion-win64\AgentFusion.exe` |
| **单元测试** | `node --test`（294 例，离线，不需要网关） |
| **真实群聊验收** | `node tests/e2e_room.mjs`（需要网关） |
| 冒烟验证 | `node scripts/smoke_desktop.mjs --isolated` |

运行前提：本机 Magpie 网关 `http://127.0.0.1:3425/v1` 可用（OpenAI 兼容，自动发现 9 个模型）。
数据目录默认 `D:\AgentFusion`（可用 `FUSION_DATA_ROOT` 覆盖，若指向 C 盘会直接拒绝启动）。

## 2. 构想 → 实现对照

| 构想（《项目推进·说明》） | 本工程实现 |
|---|---|
| a. 一个 agent 当群主，给成员赋权、分派任务、决定是否共享上下文 | `boss` archetype + `room_assign_task / room_grant_permission / room_revoke_permission / room_set_context_policy / room_set_topic` 工具；回合编排中群主优先、分派后只跑被分派成员 |
| b. 群文件空间 + 专门的文件管家 + 地址变化实时同步 | `librarian` archetype + `room_file_save/read/list/move` 工具；文件统一用 **file_id** 引用，`move` 后自动发 `file_moved` 事件 + 全房间系统通知（下一轮注入所有成员上下文） |
| c. 每个成员有特点标识 | 8 个 archetype（emoji + 主色 + badge + 签名），前端侧栏/消息流/成员 chips 全量呈现 |
| d. 成员间拉小群讨论特定工作 | `room_create_subgroup` 工具；小群跑一轮后结论写回父群消息、发 `subgroup_report` 事件并通知全员 |
| 工具调用 / skill 管理 / hook / 上下文管理参照优秀开源项目 | 全部由 pi 内核提供：工具循环、会话树与分支、自动压缩（compaction）、Agent Skills（`SKILL.md`）、扩展与 `tool_call` 拦截钩子；本工程把 skill 与 hooks 做成设置页可查看的配置面 |
| 禁止污染 C 盘 | 全链路路径守卫：`config.assertNotC`、hooks 内置 C 盘写/命令守卫、`approval` 的 C 盘地板、Electron `app.setPath` 重定向、打包冒烟自动做 C 盘快照对比 |
| 最终交付可打开的软件 | `dist/AgentFusion-win64/AgentFusion.exe`（Electron 45 + pi 1.5.0，免安装目录版） |
| **第二轮：吸收 Hermes**（审批 / 工具集 / 技能策展 / 记忆） | `src/approval.js`（地板+三态缓存+熔断+审计+阻塞审批）、`src/toolsets.js`（命名工具集+姿态+身份面）、`src/skills/*`（安装闸门+用量遥测+提案→评审→落盘）、`src/memory.js`（三级 scope + FTS5 + 注入块）；细节见 [docs/hermes/](docs/hermes/) |

## 3. 架构

```
src/
├── config.js    路径/端口/环境引导（必须在 import pi 之前跑 bootstrapEnv）
├── log.js       文件日志（D 盘 logs/app.log）
├── events.js    EventBus：事件落库 + SSE 扇出
├── store.js     node:sqlite 持久化（rooms/members/messages/files/notices/events/usage/tickets）
├── skills.js    技能发现（.fusion/skills + agents/_shared/skills + 仓库 .pi-agent/skills）
├── skills/      Hermes 吸收：guard（安装闸门）/ telemetry（用量遥测）/ curator（策展闭环）
├── hooks.js     hooks.json → pi tool_call 拦截扩展（含 C 盘守卫 + 审批闸门）
├── approval.js  审批分层：地板 / once-session-always 缓存 / 熔断 / 审计 / 阻塞等待
├── toolsets.js  命名工具集：includes 组合 / 姿态 / 身份面 / 末端严格减除
├── memory.js    持久记忆：room/bot/global + memory/user，FTS5 检索 + 审计 + 去重
├── engine/
│   ├── pi.js          pi bundle 入口加载（v1.5.0，自包含）
│   ├── runtime.js     ModelRuntime + 网关模型目录 → agents/_shared/models.json
│   ├── archetypes.js  8 个 archetype（人设/工具面/标识/模型）+ ARCHETYPE_TOOLSETS
│   ├── bot.js         BotRunner：每 (room,bot) 一个 pi AgentSession（工具面 + 审批上下文）
│   └── chief.js       单聊总控（router.* 事件流）
├── rooms/
│   ├── files.js   群文件空间（file_id / move / 通知）
│   ├── tools.js   群管理 + 群文件 + skill 遥测 + memory 的 pi 自定义工具
│   ├── room.js    回合编排 / 上下文装配（记忆注入 + 水位摘要）/ 小群 / 证据落库
│   ├── context.js 上下文水位 + 确定性摘要 + 预算裁剪（Hermes 压缩语义）
│   ├── evidence.js 证据阶梯 observed / prepared / mismatch
│   └── manager.js
├── api/server.js HTTP + SSE + 静态托管（29 个旧端点 + 审批/技能/记忆/工具集新端点）
└── main.js       CLI 入口
web/              前端（复用既有 UI，纯静态 ESM）
desktop/          Electron 壳（进程内起服务）
scripts/          打包 / 冒烟 / 开发启动
docs/             FUSION_SPEC、CONTRACT_API、CONTRACT_ROOM、BORROWED、hermes/
tests/            e2e_room.mjs 等验收脚本
```

数据目录：

```
D:\AgentFusion\
├── data\fusion.db          房间/消息/文件索引/事件/用量
├── workspace\              bot 工作区（rooms\<room>\<bot>、chief\）
├── rooms\<room>\files\     群文件物理目录
├── agents\{_shared,<bot>}\ pi agentDir（models.json / skills / SYSTEM）
├── sessions\               pi 会话 JSONL
├── logs\                   应用与桌面日志
├── cache\ temp\            进程级缓存与临时目录
└── .fusion\                settings.json / hooks.json / skills / avatars
```

## 4. 内核：pi 是怎么被用起来的

- 每个机器人是一个 pi `AgentSession`（懒创建、按 `(room, bot)` 隔离），通过
  `DefaultResourceLoader` 注入人设（`systemPromptOverride`）、群聊协议（`appendSystemPrompt`）、
  技能路径与 hooks 扩展；通过 `customTools` 注入群聊工具；用 `tools` 白名单裁剪内置工具。
- 流式输出与工具执行来自 `session.subscribe()`（`message_update` / `tool_execution_start|end`），
  转换成 `worker.<bot>.*` 事件给前端。
- 上下文管理交给 pi：会话树、自动压缩、分支摘要；房间层只负责"这一轮给成员看什么"（共享/摘要/隔离三种策略）。
- 模型来自 `.fusion` 之外的 `agents/_shared/models.json`（每次启动从网关 `/v1/models` 重新生成，
  `zcode/*` 走 anthropic-messages，其余走 openai-completions），默认 `auto/deepseek-v4.1-flash`。

## 5. 测试与验收

```powershell
# 单元/接口测试（294 个用例，无网络/无 LLM，约 2s）
cd D:\能力测试\fusion
node --test                                   # 等价的显式写法：node --test "tests/**/*.test.mjs"

# 真实群聊一轮（需要网关）
node src/main.js --port 8731
node tests/e2e_room.mjs --port 8791

# 打包版真实一轮（启动 exe 后驱动一轮，验证交付物本身）
node tests/e2e_packaged.mjs --port 8811

# 打包与冒烟
node scripts/build_portable.mjs
node scripts/smoke_desktop.mjs --isolated
```

已验证（2026-11-06）：

- 真实群聊回合：boss 分派 → coder 出稿（真实工具调用）→ librarian 落盘 `file_id` → reviewer 按 `file_id` 核验 → `round_completed`，全程 SSE 事件与 DB 回放一致（约 83s）。
- 重启持久化：重启后房间、消息、文件索引全部恢复。
- 群文件 `move`：`file_id` 不变、`file_moved` 事件 + 系统通知入队、`room_file_read` 仍可读。
- 小群：创建 → 跑一轮 → 结论回传父群（`subgroup_report` + `<subgroup:...>` 消息）。
- 打包冒烟：exe 启动 1.3–1.7s、health 200、窗口渲染 AgentFusion、退出 code 0、无残留进程、C 盘零新增。
- 单元测试：`node --test` → **294 tests / 294 pass**（store、files、room 编排、manager + Hermes 吸收层 250 例，全程隔离数据根、不联网）。
- 打包版真实一轮：`tests/e2e_packaged.mjs` → 65s 完成 boss→coder→librarian(file_id)→reviewer 并落库。
- **Hermes 吸收层（第二轮）**：审批地板/三态缓存/熔断/审计（`src/approval.js` + `src/hooks.js`）、命名工具集（`src/toolsets.js`）、技能守卫/遥测/策展（`src/skills/*`）、持久记忆 + 注入（`src/memory.js` + `src/rooms/*`），全部有独立测试与文档。\n- **Hermes 吸收层（第三轮）**：上下文「水位 + 确定性摘要 + 预算裁剪」（`src/rooms/context.js`，实测 6 轮注入 97,002 → 36,288 字符）、证据阶梯 observed/prepared/mismatch（`src/rooms/evidence.js` + `GET /api/rooms/{id}/evidence`）、pi 压缩策略项目级覆盖（每 bot `.pi/settings.json`）、房间级 `disabled_toolsets` 热更新、审批面板（`web/`）。\n- **Hermes 吸收层（第四轮）**：任务单元契约（`src/rooms/fanout.js`：写域重叠硬报错 + 依赖拓扑序，接进 `room_assign_task` 与本轮发言顺序）、小群生命周期回收（结论回传后释放会话并删房，父房级联删子房，历史存 kv）、证据工具 `room_evidence_status` + 审查员硬约束、消息级证据徽标（`web/js/views/group.js`）。\n- **Hermes 吸收层（第五轮）**：执行短路（`src/rooms/executor.js`：上游失败沿依赖边跳过下游，兄弟不受影响）、学习闭环（`src/skills/learn.js`：回合质量达标→五段 playbook 草稿→signature 去重→技能提案，人工 review 后才 adopt）、手动 `POST /api/rooms/{id}/learn`。\n- **Hermes 吸收层（第六轮）**：reviewer 裁决升级为可解释三态纯函数（`src/skills/judge.js`：未表态 ≠ 通过、否定语境/度量词形/中英混合/多 reviewer）、学习闸门识别「reviewer 在场未表态」、技能提案面板（设置页「提案」：筛选/卡片/两段式采纳/拒绝延后）。

已知限制（不影响主流程）：

- 单聊 Chief 只做代码级适配，`router.*` 过程态（计划卡）未逐帧验证，完成后的结果展示正常。
- 熔断阈值按成员数 ×3，超限后房间暂停，发新消息即复位。
- 群文件路径在存储层是相对路径（UI 只展示 file_id 与文件名，不需要绝对路径）。
- 审批默认 `yolo`：8 条地板（C 盘写入/命令、`rm -rf /`、格式化/分区、关机重启、系统目录、凭据外泄）**永远拒绝**，其余不打扰；想要逐条把关就切 `smart`（工作区内写入/群工具/只读与构建测试命令放行，删除、联网、工作区外写入、未知工具挂起等人工裁决）或 `ask`（几乎全部执行都问）。挂起通过 `/api/approvals` 裁决，10 分钟超时按拒绝处理；连续拒绝 3 次触发熔断。

## 6. 设计资料

| 文档 | 内容 |
|---|---|
| [docs/FUSION_SPEC.md](docs/FUSION_SPEC.md) | 融合架构总规格（模块签名、数据模型、回合算法、验收标准） |
| [docs/CONTRACT_API.md](docs/CONTRACT_API.md) | 从旧 Python 服务端逐端点逆推出的 HTTP/SSE 契约（29 端点） |
| [docs/CONTRACT_ROOM.md](docs/CONTRACT_ROOM.md) | 群聊行为契约（回合算法、上下文模板、权限、小群、文件同步） |
| [docs/BORROWED.md](docs/BORROWED.md) | pi / omp / Hermes 开源 harness 调研与借鉴清单（含第二轮 Hermes 落地记录） |
| [docs/hermes/](docs/hermes/) | Hermes 吸收档案：架构解剖、审批/工具集/技能/记忆逐模块取舍、下一轮候选 |

## 7. 常见问题

- **网关没开**：启动日志会显示 `gateway=offline`，模型回退到 `agents/_shared/models.json` 里已有条目；
  建群/发消息会失败并给明确报错，开启 Magpie 后重启应用即可。
- **端口被占**：服务端自动从 8720 起逐端口重试（最多 10 次），桌面壳日志会打印实际端口。
- **想清空数据**：关闭应用后删除 `D:\AgentFusion`（不会影响软件本体）。
