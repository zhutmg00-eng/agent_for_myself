# 验收记录：Hermes 吸收第六轮（reviewer 裁决纯函数 / 技能提案面板，2026-11-06）

> 工程：`D:\能力测试\fusion`；基线 = 第五轮结束时 267 测试全绿。
> 参考：`reference/hermes/{hermes-agent@ca43606, oh-my-hermes@1727425}`（MIT，只读）。
> 结论：**reviewer 裁决从「文本启发式」升级为可解释三态纯函数；学习闭环补上人工面（提案列表 + 两段式采纳）。290 测试全绿 + 真实 e2e + 打包冒烟。**

## 1. 本轮新增

| 类型 | 文件 | 说明 |
|---|---|---|
| 代码 | `src/skills/judge.js`（289 行） | `judgeReviewer({turns, reviewerId})` → `{verdict, reviewer, matched, reasons}`；否定语境预处理、度量词形陷阱、中英混合、多 reviewer、emoji、同 reviewer 多回合取最后有效表态 |
| 集成 | `src/skills/learn.js` | 闸门新增可选 `reviewerPresent`（§9.2 超集）：**reviewer 在场但未表态 → 不沉淀**（沉默不是通过） |
| 集成 | `src/rooms/room.js` | `judgeReviewerTurn()` 替换 `_reviewerVerdict`；`proposeLearningSkill` 把 `reviewerPresent` 交给闸门，`skill_proposed` 事件带 `reviewer:{verdict,reviewer,matched}` |
| 前端 | `web/js/{api,store,views/settings}.js`、`web/app.css` | 「提案」分区：状态筛选、卡片、正文折叠、file_id chips、两段式采纳（review→adopt）、拒绝/延后 + 原因、proposed 徽标、SSE 防抖刷新 |
| 测试 | `tests/judge.test.mjs`（22）、`tests/room.test.mjs`（+2） | 见 §2 |
| 文档 | `docs/hermes/{JUDGE,SKILL_PROPOSALS_UI}.md`、`LEARN.md` §7 | 证据与取舍 |

## 2. 测试证据

```text
cd D:\能力测试\fusion; node --test
ℹ tests 290
ℹ pass 290
ℹ fail 0
```

关键新增覆盖：
- **judge**：没表态 → null（旧启发式会误判 pass）、「没有问题，不用修改」→ pass（旧实现误判 reject）、「未通过率 0.3%」→ null、LGTM+nit vs changes requested、多 reviewer 任一 reject、emoji、同 reviewer 多回合。
- **Room 集成**：reviewer 在场但「稍后复核」→ 不提案；「不用修改」→ 提案（verdict=pass）；「需要修改」→ 拒绝。

## 3. 真实群聊一轮（`tests/e2e_room.mjs --port 8801`）

```text
round finished=true in 77s
messages: 5（user → boss 分派 t1/t2/t3 → coder → librarian file_id=0765c044 → reviewer「结论：通过」）
files: 1
replay events: 64（含 room.03b6a1.skill_proposed）
RESULT: PASS
```

`skill_proposed` 事件 payload（可解释性证据）：
```json
{"proposal_id":"87b92f6c1e30","source":"round",
 "reviewer":{"verdict":"pass","reviewer":"reviewer","matched":"结论：通过（依据：room_file_read 实读 file_id 0765c044…）"}}
```
`ev_records` 4 条（boss/coder/librarian/reviewer）全部 `observed`；学习闸门放行并落库 `proposed` 提案。

## 4. 技能提案面板（Playwright 实测，隔离实例 8787）

| 项 | 结果 |
|---|---|
| 卡片渲染 | 4 张（待评审 2 / 已通过 1 / 已拒绝 1），标题/来源群/提出者/tags/file_id chips 正确 |
| 筛选 | 待评审 2 → 已通过 1 → 已拒绝 1 → 全部 4 |
| 正文折叠 | line-clamp 3 → 展开，按钮切换 |
| **采纳** | `review` 200 + `adopt` 200 → toast「已安装技能 skill-7bbe23e32e35」→ `GET /api/skills` 出现该技能 |
| **拒绝** | `review` 200 → 状态已拒绝 + 评审意见 |
| 徽标 | 提案计数 2 → 1 → 0 隐藏 |
| 控制台 | 0 error / 0 warning |

截图：`D:\能力测试\temp\skill-proposals.png`、`skill-proposals-adopted.png`。细节见 [SKILL_PROPOSALS_UI.md](../hermes/SKILL_PROPOSALS_UI.md)。

## 5. 打包与冒烟

```text
node scripts/build_portable.mjs --app-only
node scripts/smoke_desktop.mjs --isolated
→ ✅ PASS（health 200、窗口正常、退出 0、无残留进程、C 盘零新增）
```

## 6. C 盘零新增

运行数据在 `D:\能力测试\temp\{hermes-e2e8,proposal-ui,...}`；C 盘相关目录无新增。

## 7. 下一轮候选

1. **结构化 pending + 失败重试**：`pending_assignments` 落库、`failed` 单元跨轮重试（executor 需 `resumeUnit` 语义）。
2. **单聊 Chief 接证据/压缩** + `chief.js`/`bot.js` turn 骨架去重。
3. **提案质量**：草稿标题仍可能带指令前缀（如「请群主分派：…」），可在 learn 里做更强的标题提炼。
4. **提案面板**：Markdown 渲染、guard 拦截后的回滚/重试、分页。
