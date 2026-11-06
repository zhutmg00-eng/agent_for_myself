# 验收记录：Hermes 吸收第二轮（2026-11-06）

> 工程：`D:\能力测试\fusion`（pin 版本 `package.json` 0.1.0，pi 内核 1.5.0，Electron 45）
> 参考源码：`D:\能力测试\reference\hermes\hermes-agent@ca43606`、`oh-my-hermes@1727425`（均 MIT，只读）
> 结论：**4 个机制落地 + 1 份下一轮采纳方案；150 个单测全绿；真实群聊一轮 PASS；C 盘零新增。**

## 1. 交付物清单

| 类型 | 文件 | 行数 | 说明 |
|---|---|---|---|
| 代码 | `src/approval.js` | 733 | 8 条地板 + once/session/always 缓存 + 熔断 + 审计 + `waitFor()` 阻塞审批 |
| 代码 | `src/toolsets.js` | 358 | 14 个命名工具集 + `includes` + 3 姿态 + 7 身份面 + 末端减除 |
| 代码 | `src/skills/guard.js` | 331 | 21 条安装闸门规则 → allow/review/block |
| 代码 | `src/skills/telemetry.js` | 246 | 用量事件 + 14 天半衰期评分 + stale/archive 判定 |
| 代码 | `src/skills/curator.js` | 357 | 提案 → 评审 → adopt（guard 前置）→ 落盘 `DIRS.skills` |
| 代码 | `src/memory.js` | 476 | 三级 scope × 两类 target、FTS5 + bigram 兜底、去重、审计、注入块 |
| 集成 | `src/hooks.js` | 413 | 静态规则 → 地板 → 缓存/模式 → `await waitFor()`；失败 fail-closed；坏正则不再静默失效 |
| 集成 | `src/engine/{archetypes,bot}.js` | 379 / 568 | `ARCHETYPE_TOOLSETS` 身份面；BotRunner 按 `(roomId,botId)` 传审批上下文 |
| 集成 | `src/rooms/{room,tools,manager}.js` | 713 / 457 / ~250 | 记忆注入块 + `memory` 工具 + 技能遥测 + 删房清记忆 |
| 集成 | `src/api/server.js` | 2842 | 新增审批/技能/记忆/工具集端点（E26–E28）与 `updateStoredBot` 工具面 |
| 测试 | `tests/approval.test.mjs` 等 7 个文件 | — | 150 用例（见 §2） |
| 文档 | `docs/hermes/{README,HERMES_ARCH,CONTRACT,APPROVAL,TOOLSETS,SKILLS,MEMORY,OMH_AND_CONTEXT}.md` | — | 架构解剖 + 逐模块取舍 + 下一轮方案 |
| 文档 | `docs/BORROWED.md` §5、`README.md`、根 `README.md` | — | 对外可读的落地说明 |

## 2. 测试证据（`cd D:\能力测试\fusion; node --test`）

```text
ℹ tests 150
ℹ pass 150
ℹ fail 0
ℹ duration_ms 1971.8
```

| 文件 | 用例 | 覆盖重点 |
|---|---|---|
| `tests/approval.test.mjs` | 27 | 地板（yolo 下仍拦）、三态缓存、熔断、模式、审计、waitFor（allow/deny/timeout/abort）、复合命令逐段判定、工作区路径策略 |
| `tests/hooks_gate.test.mjs` | 8 | **真实扩展驱动**：静态 deny → 地板 → ask→批准/拒绝/超时/abort → 坏正则 fail-closed → 未注入审批时零行为变化 |
| `tests/toolsets.test.mjs` | 19 | includes 展开、disabled 双语义、姿态、身份面、顺序稳定、循环防御、深冻结 |
| `tests/skills_guard.test.mjs` | 20 | 21 条规则（危险 shell / 注入 / 隐藏字符 / 体积 / frontmatter）与 verdict |
| `tests/skills_curator.test.mjs` | 14 | 遥测评分排序、stale/archive、propose→review→adopt、guard 拦截写盘 |
| `tests/memory.test.mjs` | 21 | FTS5 命中/退化、中文 bigram、去重、衰减、注入预算、审计、跨重开持久化 |
| 既有 4 个文件 | 41 | store / files / room 编排 / manager（零回归） |

## 3. 真实群聊一轮（`node tests/e2e_room.mjs --port 8794`）

```text
room created: 686876
task sent, waiting for round_completed ...
round finished=true in 130s
messages: 5（user → boss 分派 → coder 出稿 → librarian file_id → reviewer 核验）
files: 1  4b2c59d6 intro.md — coder 撰写的 AgentFusion 产品简介终稿（76 字），原样保存供 reviewer 逐字核验
replay events: 63
RESULT: PASS
```

事件主题包含 `worker.<bot>.tool_invoked / tool_result / turn_completed`、`room.<id>.file_saved /
round_completed`，说明 pi 工具循环、群文件 file_id、SSE 回放与 DB 落库在新审批层之下全部正常。

## 4. 集成探针（`node temp/probe_hermes_int.mjs`，已隔离数据根）

```json
{
  "coderTools": ["read","write","edit","bash","grep","find","ls","room_list_members","room_file_list","room_file_read","memory"],
  "memorySearch": ["本项目统一用 Node 24 与 node:sqlite"],
  "memoryBlockHasRoom": true,
  "memoryBlockHasBot": true,
  "readAllow": "allow",
  "cDriveFloor": "deny（floor.c-drive-write）",
  "devTestAllow": "allow（node --test）",
  "pipeAsk": "ask（串联/重定向）",
  "curlAsk": "ask（网络）",
  "memoryToolMounted": true,
  "memoryToolOk": true,
  "waitOutcome": "allow",
  "adoptBlocked": true,
  "adoptOk": true,
  "adoptedFileExists": true
}
```

## 5. HTTP 端点冒烟（`node src/main.js --port 8770`）
| 端点 | 实测 |
|---|---|
| `GET /api/health` | `wiring`: approval / telemetry / curator / memory 全 `ok` |
| `GET /api/toolsets` | 14 个工具集 |
| `GET /api/approvals` | `{approvals:[], mode:"smart", stats:{...}}`（模式可写） |
| `PUT /api/approval/mode` | `{ok:true, mode:"ask"}` → 再 GET 生效 |
| `POST /api/memory` → `GET /api/memory/search?q=floor` | 写入回显 + 检索命中（score 1.15） |
| `POST /api/skills/proposals` → `review` → `adopt` | 201 → 200 → `ok:true`，`GET /api/skills` 出现新技能 |
| `PUT /api/bots/coder {disabled_toolsets:["exec"]}` | 返回 `disabled_toolsets:["exec"]`，工具面持久化 |

## 5.1 打包产物与桌面冒烟

```text
node scripts/build_portable.mjs --app-only
→ resources/app 19.7 MB（src 425 KB · web 214 KB · pi 19.0 MB）
→ 校验通过；src/approval.js、src/toolsets.js、src/memory.js、src/skills/* 均已随包

node scripts/smoke_desktop.mjs --isolated
[smoke] /api/health 200（2886ms）· 窗口 "Chief · AgentFusion" · 首屏 1050ms
[smoke] 进程退出 code=0，无残留进程，端口释放
[smoke] C 盘无新增（检查 5 个目录）
[smoke] ✅ PASS（5.8s）
```

## 6. C 盘零新增

检查 `C:\AgentFusion`、`C:\能力测试`、`%USERPROFILE%\.pi|.fusion|.hermes`、
`%APPDATA%|%LOCALAPPDATA%\AgentFusion`：全部不存在或 3 小时内零新文件。
所有运行数据在 `D:\能力测试\temp\hermes-{probe,int,e2e}` 与 `D:\能力测试\temp\fusion-tests\`，
Hermes 源码副本在 `D:\能力测试\reference\hermes\`。

## 7. 已知限制与下一轮（详见 `docs/hermes/OMH_AND_CONTEXT.md`）

1. **审批 UI 尚未接入前端**：目前用 `/api/approvals` + SSE `worker.<bot>.approval_requested` 消费，
   默认 `yolo` 下不影响主流程；做监督模式前需要设置页的审批面板。
2. **房间级 `disabled_toolsets` 未落库**：目前是 bot 级 + 房间级尚未加 `settings_json` 列。
3. **上下文压缩仍是 pi 自带策略**：omh 分析给出的高 ROI 做法是接 `session_before_compact`
   钩子 + 水位标记，下一轮做。
4. **证据阶梯（observed vs prepared）**：成员产出目前只有 `text`，没有 `observed` 标记，
   下一轮按 omh `HARNESS_QUALITY.md:757-781` 的语义补。
5. `src/approval.js` 733 行、`src/memory.js` 476 行超出契约 400 行参考值（功能内聚，暂不拆）。
