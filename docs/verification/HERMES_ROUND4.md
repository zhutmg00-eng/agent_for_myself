# 验收记录：Hermes 吸收第四轮（子群生命周期 / fanout 契约 / 证据可见，2026-11-06）

> 工程：`D:\能力测试\fusion`；基线 = 第三轮结束时 198 测试全绿。
> 参考：`reference/hermes/{hermes-agent@ca43606, oh-my-hermes@1727425}`（MIT，只读）。
> 结论：**子群泄漏修复 + 任务单元契约落地 + 证据从"库里有"变成"看得见、查得到、审查员必须用"。230 测试全绿 + 真实群聊 PASS + 打包冒烟 PASS。**

## 1. 本轮新增

| 类型 | 文件 | 说明 |
|---|---|---|
| 代码 | `src/rooms/fanout.js`（414 行） | 任务单元契约：`normalizeScope` / `scopesOverlap` / `planTasks` / `frontier`；错误码 11 个；写域重叠无依赖 → 硬报错 |
| 集成 | `src/rooms/room.js` | `assignTask(botId, task, {id, writeScope, dependsOn})` 分派时校验；`taskPlanBotOrder()` 拓扑序决定发言顺序；`retireSubgroup()` + `subgroup_history`（kv 持久化）；`subgroup_lifecycle` 设置 |
| 集成 | `src/rooms/manager.js` | `delete()` 递归删除子房；`create()` 透传 `settings` |
| 集成 | `src/rooms/tools.js` | `room_assign_task` 增加 `write_scope` / `depends_on`；新增只读工具 `room_evidence_status` |
| 集成 | `src/engine/archetypes.js` | 群协议增加 fanout 纪律；审查员硬约束「无 observed 证据只能判需修改」 |
| 集成 | `src/toolsets.js` | 新 `evidence` 工具集并入 `review` |
| 集成 | `src/store.js` | `deleteRoom` 级联删 `ev_records` |
| 集成 | `src/api/server.js` | `subgroup_lifecycle` 取值校验 |
| 前端 | `web/js/{api,store,app,views/group}.js`、`web/app.css` | 证据徽标（observed/prepared/mismatch）、群头汇总、检查器证据面板、SSE 刷新 |
| 测试 | `tests/fanout.test.mjs`（25）、`tests/room.test.mjs`（+5）、`tests/manager.test.mjs`（+1）、`tests/toolsets.test.mjs`（适配） | 见 §2 |
| 文档 | `docs/hermes/{FANOUT,EVIDENCE_UI}.md`、`docs/hermes/EVIDENCE.md` §7 | 证据与取舍 |

## 2. 测试证据

```text
cd D:\能力测试\fusion; node --test
ℹ tests 229
ℹ pass 229
ℹ fail 0
```

本轮覆盖点：
- fanout：空输入/正常 DAG/同层顺序/点依赖/未知成员与依赖/自依赖/环/重复 id/超长 id/写域重叠硬报错/有依赖边时重叠放行/目录 vs 文件前缀/大小写与反斜杠归一/超限/frontier/纯函数不改入参。
- 房间：分派冲突拒绝、加依赖后串行化通过、`runRound` 按拓扑序发言、小群默认回收（dispose+delete+history）、`keep` 模式保留、history 跨重开、`room_evidence_status` 工具返回汇总与逐条。
- 管理：父房删除级联删子房。
- 工具集：新增 `evidence` 面后 review/all 的展开与 size。

## 3. 真实群聊一轮（`tests/e2e_room.mjs --port 8797`）

```text
round finished=true in 198s
messages: 5（user → boss 分派 t1/t2 → coder 出稿 → librarian file_id=24ae3f15 → reviewer 核验）
files: 1
replay events: 76
RESULT: PASS
```

关键观察（app.log）：
- boss 的分派文本直接使用任务单元编号 `t1/t2`，说明 fanout 词汇进入了群协议；
- reviewer 的回合里同时出现 `room_file_read` 与 `room_evidence_status` 两次工具调用，最终结论引用 file_id 与 observed 状态；
- `ev_records` 记录 4 条回合判定（#2 boss / #3 coder / #4 librarian / #5 reviewer 全部 `observed`）；群文件仅 `24ae3f15 intro.md`。

## 4. 证据可见（Playwright 实测，隔离实例 8785）

| 项 | 结果 |
|---|---|
| 三态徽标 | 红「证据不符」/ 绿「已观测」/ 灰「仅声明」，class 与色值正确 |
| tooltip | 含判定口径；mismatch 附「声明了不存在的 file_id 9f3c2a1b」 |
| 群头汇总 | `1 已观测 · 1 仅声明 · 1 证据不符`（title 含全量数字） |
| 检查器 | 「证据阶梯 · 3 条判定」+ 最近不符判定 + 口径说明 |
| `null`/全 0 | 对照房间 0 徽标、0 chip、无面板，消息正常、无报错 |
| 控制台 | 0 error / 0 warning |

截图：`D:\能力测试\temp\evidence-ui.png`（1440×900）。细节见 [EVIDENCE_UI.md](../hermes/EVIDENCE_UI.md)。

## 5. 打包与冒烟

```text
node scripts/build_portable.mjs --app-only
→ resources/app 19.8 MB（src 495 KB · web 248 KB · pi 19.0 MB）

node scripts/smoke_desktop.mjs --isolated
→ /api/health 200 · 窗口 AgentFusion · 退出 code=0 · 无残留进程 · C 盘无新增
→ ✅ PASS
```

## 6. C 盘零新增

运行数据全部在 `D:\能力测试\temp\{hermes-e2e6,evidence-ui,ctx-probe}`；测试用 `temp\fusion-tests\*`；
C 盘相关目录（`C:\AgentFusion`、`C:\能力测试`、`%USERPROFILE%\.pi|.fusion`、`%APPDATA%|%LOCALAPPDATA%\AgentFusion`）无新增。

## 7. 下一轮候选

1. 群主「并行分派」的完整 DAG 执行（当前 fanout 只做校验 + 排序；`depends_on` 只保证顺序，不保证前序成功才启动后序）。
2. `chief.js` 与 `bot.js` 的 turn 骨架去重（~150 行；压缩/证据/工具结果目前只覆盖群聊路径，单聊 Chief 尚未接证据阶梯）。
3. 证据 → 验收的自动化：群主汇总时若 reviewer 判定与证据冲突，自动标红/阻断。
4. 记忆审查（omh：采纳/拒绝/延后都要写理由）接入 `memory` 工具。
