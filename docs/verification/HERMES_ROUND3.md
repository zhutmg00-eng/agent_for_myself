# 验收记录：Hermes 吸收第三轮（上下文 / 证据 / 审批 UI，2026-11-06）

> 工程：`D:\能力测试\fusion`；基线 = 第二轮结束时的 150 测试全绿。
> 参考：`reference/hermes/hermes-agent@ca43606`、`oh-my-hermes@1727425`（MIT，只读）。
> 结论：**上下文 O(N²)→常量（实测 37.4%）、证据阶梯落到真实回合、pi 压缩策略项目级覆盖、房间级工具面、审批 UI。197 测试全绿 + 真实群聊 PASS。**

## 1. 本轮新增

| 类型 | 文件 | 说明 |
|---|---|---|
| 代码 | `src/rooms/context.js`（399 行） | 每成员水位（kv）、确定性摘要、预算裁剪；`compose().stats` 带 `throughSeq/firstSeq` |
| 代码 | `src/rooms/evidence.js`（429 行） | `classifyClaims` 纯函数 + `ev_records` 表 + record/get/list/summary |
| 集成 | `src/rooms/room.js` | `composeContext` + 注入后推进水位 + 回合收尾写证据；`turn_completed` 事件带 `seq`/`evidence` |
| 集成 | `src/engine/bot.js` | 每 bot 写 `.pi/settings.json`（压缩策略）；`toolResults`（名称/ok/摘要）随回合返回 |
| 集成 | `src/store.js` | `rooms.settings_json` + `_migrate()`（旧库补列） |
| 集成 | `src/rooms/manager.js` / `Room#setSettings` / `src/api/server.js` | 房间级 `disabled_toolsets` 热更新（pi `setActiveToolsByName`，不重建会话） |
| 集成 | `src/api/server.js` | `GET /api/rooms/{id}/evidence`；`PUT /api/rooms/{id}` 接受 `settings`/`disabled_toolsets` |
| 前端 | `web/js/{api,store,app,views/settings}.js`、`web/app.css`、`web/index.html` | 审批面板：模式切换、待裁决列表（Approve/Deny + once/session/always）、审计、pending 徽标 |
| 测试 | `tests/context.test.mjs`（20）、`tests/evidence.test.mjs`（24）、`tests/store.test.mjs`(+1)、`tests/room.test.mjs`(+3) | 见 §2 |
| 文档 | `docs/hermes/{CONTEXT,EVIDENCE,APPROVALS_UI}.md` | 逐机制证据与取舍 |

## 2. 测试证据

```text
cd D:\能力测试\fusion; node --test
ℹ tests 198
ℹ pass 197
ℹ fail 0
```

新增覆盖点：
- 上下文：水位持久化/跨重开、增量只含新消息、首次退化、summary 不消费水位、预算裁剪与省略标注、`throughSeq` 只到实际注入的最后一条、超长单条截断、幂等。
- 证据：observed（成功工具结果）、prepared（只有文本）、mismatch（声称 file_id 不存在 / 声称保存但无 save）、工具失败、多 file_id 混合、幂等、跨重开、summary。
- 房间设置：旧库自动补 `settings_json` 列、`setSettings` 持久化与快照、空补丁不丢设置。
- 房间集成：第二轮只注入增量（prompt < 8000 字符且含本轮消息）、每次发言写一条证据（无工具 → prepared）。

## 3. 上下文成本探针（复现 `temp/ctx-probe/probe.mjs`）

| 轮次 | 旧：本轮注入总计（字符） | 新：本轮注入总计 |
|---|---|---|
| 1 | 4,617 | 6,048 |
| 3 | 13,857 | 6,048 |
| 6 | 27,717 | 6,048 |
| **6 轮合计** | **97,002** | **36,288（37.4%）** |

旧实现随轮次线性增长（累计二次），新实现每轮恒定 ≈ budget。

## 4. 真实群聊一轮（`tests/e2e_room.mjs --port 8795`）

```text
round finished=true in 143s
messages: 5（user → boss 分派 → coder 出稿 → librarian file_id=705c554b → reviewer 核验）
files: 1
replay events: 65
RESULT: PASS
```

落库证据（同一轮）：
- `ev_records`：`boss/coder/librarian/reviewer` 全部 `observed`（4/4）；
- 上下文水位：`ctx:wm:<room>:boss=1, coder=2, librarian=3, reviewer=4`（各自消费到自己发言前）；
- 每 bot 工作区 `.pi/settings.json` = `{compaction:{enabled:true,reserveTokens:12000,keepRecentTokens:16000}}`；
- `GET /api/rooms/{id}/evidence` → `{observed:4, prepared:0, mismatch:0, total:4}`；
- `PUT /api/rooms/{id} {disabled_toolsets:["exec"]}` → 快照 `settings.disabled_toolsets` 持久化。

## 5. 审批 UI（Playwright MCP 实测，隔离实例 8781）

| 项 | 结果 |
|---|---|
| 设置「审批」分区渲染 / 空态 | OK，控制台 **0 error** |
| 模式 yolo→ask | `PUT /api/approval/mode` **200** → `{ok:true,mode:"ask"}`，高亮随之后移 |
| 待裁决行 | 显示 tool / reason / input 预览 / 群聊·成员 / 相对时间 / 过期倒计时 |
| 批准 | `POST /api/approvals/{id}` **200** → 行消失 + 空态 + 审计新增「批准 · bash 一次 · user」 |
| 拒绝（scope 永久） | POST **200** → 审计新增「拒绝 · write 永久 · 人工拒绝」 |
| 过期单裁决 | 后端 409 `already_resolved`，前端按"已处理"提示并刷新 |
| 徽标 | pending=1 侧栏显示「1」，pending=0 隐藏 |
| 回归 | `node --test` 198/198 |

截图：`D:\能力测试\temp\approval-ui.png`（面板，881×721）、`D:\能力测试\temp\approval-badge.png`（侧栏徽标）。
过程中修掉的真实缺陷：行元素自带 `data-scope` 导致 `closest("[data-scope]")` 命中整行、吞掉「批准」点击 → 行改用 `data-approval-scope`。
细节与 8 条已知限制见 [APPROVALS_UI.md](../hermes/APPROVALS_UI.md)。

## 6. C 盘零新增

本轮所有运行数据在 `D:\能力测试\temp\{hermes-e2e4,ctx-probe,ui-approval}`；
`node --test` 使用 `D:\能力测试\temp\fusion-tests\*`；未新增任何 C 盘目录/文件（沿用第二轮检查口径：
`C:\AgentFusion`、`C:\能力测试`、`%USERPROFILE%\.pi|.fusion`、`%APPDATA%|%LOCALAPPDATA%\AgentFusion`）。

## 7. 下一轮候选（仍未做）

1. 证据阶梯接入 UI（消息气泡上的 observed/prepared 徽标）与 reviewer 的「必须 observed」硬约束。
2. omh 的 fanout 契约（写域冲突硬报错 + 依赖前沿调度）落到 `createSubgroup`。
3. `createSubgroup` 子房/session 泄漏（omh 分析发现的既有 bug）。
4. `chief.js` 与 `bot.js` 的 turn 骨架去重（~150 行），压缩/证据接线目前只覆盖群聊路径。
