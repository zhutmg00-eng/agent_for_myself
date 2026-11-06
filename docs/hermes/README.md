# Hermes 吸收档案（`docs/hermes/`）

本目录是从 **Hermes 生态**（`NousResearch/hermes-agent` + `rlaope/oh-my-hermes`，均 MIT）
吸收到 AgentFusion 的完整证据链：架构解剖 → 逐机制取舍 → 落地代码 → 验证。

源码副本（只读，不参与打包）：
`D:\能力测试\reference\hermes\hermes-agent`（commit `ca43606`）与
`D:\能力测试\reference\hermes\oh-my-hermes`（commit `1727425`）。

| 文档 | 回答什么问题 | 对应代码 |
|---|---|---|
| [HERMES_ARCH.md](HERMES_ARCH.md) | Hermes 到底是什么架构？工具/审批/技能/记忆/压缩/委派分别怎么设计？我们抄什么、不抄什么？ | —（总纲） |
| [ADOPTION_MATRIX.md](ADOPTION_MATRIX.md) | **总表**：18 项采纳/改写/部分、4 项明确不采纳、1 项未做，逐项带证据与验证 | 全工程对照 |
| [CONTRACT.md](CONTRACT.md) | 本轮并行开发的接口契约与文件所有权（团队协作基线） | `src/approval.js`、`src/toolsets.js`、`src/skills/*`、`src/memory.js` |
| [APPROVAL.md](APPROVAL.md) | 审批四级闸门怎么落到 Node/SQLite：地板、三态缓存、熔断、审计、阻塞等待 | `src/approval.js` + `src/hooks.js` |
| [TOOLSETS.md](TOOLSETS.md) | 命名工具集/姿态/身份面/末端减除怎么替代写死的工具白名单 | `src/toolsets.js` + `src/engine/{archetypes,bot}.js` |
| [SKILLS.md](SKILLS.md) | 技能安装闸门（guard）、用量遥测、策展闭环（提案→评审→落盘） | `src/skills/{guard,telemetry,curator}.js` + `src/rooms/tools.js` |
| [MEMORY.md](MEMORY.md) | 持久记忆的 scope 模型、FTS5 检索、注入预算、审计与去重 | `src/memory.js` + `src/rooms/{room,tools}.js` |
| [CONTEXT.md](CONTEXT.md) | 上下文水位 + 确定性摘要 + 预算裁剪：把每轮重灌整份转录的 O(N²) 成本压成常量 | `src/rooms/context.js` + `src/rooms/room.js` |
| [EVIDENCE.md](EVIDENCE.md) | 证据阶梯：observed / prepared / mismatch，区分「真做过」与「只是声称」 | `src/rooms/evidence.js` + 回合收尾 |
| [APPROVALS_UI.md](APPROVALS_UI.md) | 审批面板：模式切换、待裁决列表、审计与徽标 | `web/js/**` |
| [FANOUT.md](FANOUT.md) | 任务单元契约：写域重叠硬报错、依赖拓扑序与前沿（omh fanout 最小内核） | `src/rooms/fanout.js` + `room_assign_task` |
| [EVIDENCE_UI.md](EVIDENCE_UI.md) | 证据徽标：消息上的 observed / prepared / mismatch 与群内证据汇总 | `web/js/views/group.js` |
| [EXECUTOR.md](EXECUTOR.md) | 执行短路：依赖前沿 + 失败沿依赖边传播的 6 状态机 | `src/rooms/executor.js` |
| [LEARN.md](LEARN.md) | 学习闭环：回合质量闸门 → 技能草稿 → 提案（不自动 adopt） | `src/skills/learn.js` + `Room.proposeLearningSkill` |
| [JUDGE.md](JUDGE.md) | reviewer 裁决三态纯函数：未表态 ≠ 通过、否定语境、中英混合、多 reviewer | `src/skills/judge.js` |
| [SKILL_PROPOSALS_UI.md](SKILL_PROPOSALS_UI.md) | 技能提案面板：筛选/卡片/两段式采纳/拒绝延后 | `web/js/views/settings.js` |
| [OMH_AND_CONTEXT.md](OMH_AND_CONTEXT.md) | oh-my-hermes 的契约层（fanout / 证据阶梯 / 记忆审查 / hook 分类）与 Hermes 压缩、委派 —— **下一轮候选** | 部分已接入（见上） |

## 一句话取舍

- **采纳语义，不采纳实现规模**：Hermes 单个模块动辄 7 万行，我们每个模块 ≤ 720 行，
  只保留可验证的内核语义（地板、三态、遥测、策展、注入）。
- **不引入第二语言运行时**：Hermes 是 Python，我们是 Node + pi；所有能力用 ESM 重写，
  零新增 npm 依赖，只用 `node:sqlite` / `node:fs` / `node:crypto`。
- **不采纳渠道层**：多平台网关、cron、kanban、语音、computer_use 与「群 = 房间」模型冲突，
  明确不做（理由见 [HERMES_ARCH.md §9](HERMES_ARCH.md)）。

## 验证入口

```powershell
cd D:\能力测试\fusion
node --test                       # 全量单测（含 Hermes 吸收层 100+ 例）
node tests/hooks_gate.test.mjs    # 审批接入 pi tool_call 的判定链
node tests/e2e_room.mjs           # 真实群聊一轮（需要 Magpie 网关）
```
