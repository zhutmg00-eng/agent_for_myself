# 验收记录：Hermes 吸收第五轮（执行短路 / 学习闭环，2026-11-06）

> 工程：`D:\能力测试\fusion`；基线 = 第四轮结束时 230 测试全绿。
> 参考：`reference/hermes/{hermes-agent@ca43606, oh-my-hermes@1727425}`（MIT，只读）。
> 结论：**fanout 从校验推进到执行短路（失败沿依赖边传播）；Hermes 最标志性的「经验 → 技能」闭环落地并在真实 e2e 里自动触发。267 测试全绿 + 真实群聊 PASS + 打包冒烟 PASS。**

## 1. 本轮新增

| 类型 | 文件 | 说明 |
|---|---|---|
| 代码 | `src/rooms/executor.js`（263 行） | 6 状态机（pending/ready/running/done/failed/skipped）+ `nextReady` 前沿 + `markResult` 失败向传递下游传播 + `isComplete`/`summarize` |
| 代码 | `src/skills/learn.js`（368 行） | `evaluateLearningGate`（≥2 回合/无 mismatch/reviewer 通过/模式开关）+ `buildSkillDraft`（五段 playbook + sha1 signature） |
| 集成 | `src/rooms/room.js` | `_refreshExecutionPlan` / `_readyBot` / `_markTaskResult`（跳过下游 + `task_skipped` 事件 + 系统通知）；`proposeLearningSkill`（自动提案 + kv signature 去重）；`recentTurns`/`_reviewerVerdict` |
| 集成 | `src/api/server.js` | `POST /api/rooms/{id}/learn`（手动触发，force=true 仍过质量闸门）；`settings.auto_propose_skills` 取值校验（off/observed/always） |
| 测试 | `tests/executor.test.mjs`（19）、`tests/learn.test.mjs`（14）、`tests/room.test.mjs`（+3 集成） | 见 §2 |
| 文档 | `docs/hermes/{EXECUTOR,LEARN}.md`、`docs/BORROWED.md` §5.7 | 证据与取舍 |

## 2. 测试证据

```text
cd D:\能力测试\fusion; node --test
ℹ tests 266
ℹ pass 266
ℹ fail 0
```

本轮集成用例：
- **学习闭环**：达标回合产出提案、同经验二次去重（kv signature）、`auto_propose_skills=off` 不提案。
- **执行短路**：上游 coder 失败 → 依赖它的 reviewer 不跑、兄弟 writer 照跑、`system_notices` 出现「被跳过」。

## 3. 真实群聊一轮（`tests/e2e_room.mjs --port 8798`）

```text
round finished=true in 91s
messages: 5（user → boss 分派 t1/t2/t3（带依赖）→ coder → librarian file_id=61adb44b → reviewer 核验）
files: 1
replay events: 62（含 room.<id>.skill_proposed）
RESULT: PASS
```

关键观察：
- boss 的分派文本显式使用 `t1/t2/t3` 与「t2 依赖 t1、t3 依赖 t2」，fanout 词汇已进入群协议；
- reviewer 引用 `room_evidence_status` 的 observed 结论作为核验依据；
- **`room.368986.skill_proposed` 事件在同一轮触发**：`skill_proposals` 新增一条 `proposed`（id `a465c61ae4f8`），body 为五段 playbook（目标/步骤/验收标准/证据 file_id/适用场景），`kv` 记录 signature `learn:sig:368986:a0be52a0…`；
- `ev_records` 4 条（#2 boss / #3 coder / #4 librarian / #5 reviewer）全部 `observed`。

## 4. 手动学习入口（HTTP 冒烟，隔离实例 8773）

```text
GET  /api/skills/proposals        → 1 条（自动提案）
POST /api/rooms/368986/learn {"instruction":"写一份发布说明"}
  → 200 {"ok":true,"draft":{"title":"写一份发布说明"},"proposal":{"status":"proposed"}}
再次 POST（同指令）                → {"ok":false,"reason":"重复经验（signature 已存在）"}
POST 房间设置 auto_propose_skills=off 后再手动调用 → 仍可提案（force 只绕过自动策略开关）
prepared-only 回合手动调用          → 拒绝（证据质量闸门不放松）
```

## 5. 打包与冒烟

```text
node scripts/build_portable.mjs --app-only
→ resources/app 19.9 MB / 1155 files（src 529 KB · web 248 KB · pi 19.0 MB）

node scripts/smoke_desktop.mjs --isolated
→ ✅ PASS（health 200、窗口正常、退出 0、无残留进程、C 盘零新增）
```

## 6. C 盘零新增

运行数据在 `D:\能力测试\temp\{hermes-e2e7,evidence-ui,ui-approval,...}`，测试用 `temp\fusion-tests\*`；
C 盘相关目录（`C:\AgentFusion`、`C:\能力测试`、`%USERPROFILE%\.pi|.fusion`、`%APPDATA%|%LOCALAPPDATA%\AgentFusion`）无新增。

## 7. 下一轮候选

1. **学习提案的前端入口**：设置页展示 `proposed` 列表 + review/adopt（后端已有；与审批面板同模式）。
2. **失败重试与结构化 pending**：`failed` 单元跨轮重试、`pending_assignments` 落库（重启不丢）。
3. **reviewer 判定纯函数**：把文本启发式收敛为 `judgeReviewer({turns})`（skills-dev 已提议）。
4. **单聊 Chief 接证据/压缩**：`chief.js` 与 `bot.js` 的 turn 骨架去重。
