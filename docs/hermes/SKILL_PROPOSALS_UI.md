# 技能提案面板（学习闭环 E27 · 前端入口）

> 目标工程：`D:\能力测试\fusion`（纯静态 ESM，无构建、无框架、无 CDN）。
> 后端学习闭环见 `src/skills/curator.js` + `docs/hermes/SKILLS.md`；本文只覆盖**设置里的提案面板**。
> 契约：`docs/hermes/CONTRACT.md` §10.2（`node --test` 基线 267，本轮实测 290 全绿）。

## 1. 缺口：提案落库了，人看不见也采纳不了

真实回合里 `Room` 已经在自动 `curator.propose(...)`（`src/rooms/room.js:1083` 还发 `skill_proposed` 事件），
提案进 `skill_proposals` 表后停在 `proposed`，只能靠 curl 走
`review → adopt` 两段式才会写成 `SKILL.md`。产品上等于「学习闭环只转了一半」。

本面板把这条路补齐：**看提案 → 决定采纳/拒绝/延后 → 采纳后技能真的进技能库（能力分区可见）**。

## 2. 交互路径

```
设置（Ctrl+,）
 └─ 左栏「提案」（有 proposed 时带数字徽标）
     ├─ 筛选：[全部 N] [待评审 N] [已通过 N] [已拒绝 N]      ← 点击即按 status 重新拉取
     ├─ 刷新：手动重拉（进分区时也会自动拉一次；SSE 新提案会防抖刷新）
     └─ 提案卡 ×N
          ├─ 头部：状态标签（待评审/已通过/已拒绝/已延后/已采纳）· 标题 · 相对时间
          ├─ 元信息：来源群聊（roomId 解析为群名）· 提出者 · 基于 N 个回合 · tags
          ├─ 正文：默认折叠 3 行（CSS line-clamp）→「展开全文 / 收起」
          ├─ 证据：file_id chips（去重，最多 6 个 + 「+N」）
          ├─ 评审意见（rejected / deferred / approved 且有 reason 时）
          ├─ 已采纳：绿色「已安装技能 <slug> · 时间」
          ├─ guard 提示：上次落盘被判为 block/review 时的原因（黄色）
          └─ 操作（非 adopted）：[原因输入（可选）] [采纳] [拒绝] [延后]
                ├─ 采纳：POST review {decision:"adopt"} → POST adopt → toast「已安装技能 <slug>」
                └─ 拒绝/延后：POST review {decision:"reject"|"defer", reason} → toast + 刷新
```

空态按筛选切换文案（「当前没有待评审的提案…」/「没有已拒绝的提案…」）；端点 404 或请求失败时，
面板顶部出现一行降级提示，列表退化为空态，**不弹 toast、不阻塞其它分区**。

## 3. 端点映射（全部复用 E27，未新增后端）

| 用途 | 请求 | 返回 / 用法 |
|---|---|---|
| 列提案 | `GET /api/skills/proposals?status=&limit=50` | `{proposals[], report}`，report 供筛选按钮计数 |
| 评审 | `POST /api/skills/proposals/{id}/review` `{decision, reason?, by:"user"}` | `{ok, proposal}`；409 `{ok:false,error}`（已 adopted / 未知裁决） |
| 落盘 | `POST /api/skills/proposals/{id}/adopt` `{by:"user"}` | `{ok, skill:{slug,...}, guard}`；409 `{ok:false, error, guard?}`（guard 阻断） |
| 技能库刷新 | `GET /api/skills` | 采纳成功后服务端已 `reload()`，前端再拉一次让「能力」分区同步 |
| 用量（可选） | `GET /api/skills/usage?days=30` | 已封装 `api.skillUsage()`，本面板暂未展示 |

### 两段式采纳（关键实现）

`adopt` 端点只接受 `approved` 状态的提案（`curator.js:304`），所以「采纳」在 UI 上必须打两次请求：

```js
// store.adoptSkillProposal(id)
const reviewed = await api.reviewSkillProposal(id, { decision: "adopt", by });   // → approved
const adopted  = await api.adoptSkillProposal(id, { by });                        // → adopted + 写盘
```

- 任一步失败返回结构化结果 `{ ok:false, stage:"review"|"adopt", error, guard? }`，视图按阶段提示
  （「批准失败：…」/「落盘失败：guard 阻断：…」），**不会出现"半成功还报成功"**。
- 落盘阶段被 guard 拦住时，后端把 `guardVerdict=block` 与 `reason="guard 阻断：…"` 写回提案，
  列表刷新后卡片上出现黄色提示，原因直接给到用户。
- 成功后 store 会 `refreshSkills()`，与「能力」分区的技能列表保持一致。

## 4. 数据形状（camelCase + evidence 里的 snake_case）

`curator.toProposal()`（`src/skills/curator.js:107`）返回 camelCase：
`{id,title,body,evidence[],roomId,botId,tags[],status,reason,reviewedBy,skill,guardVerdict,createdAt,updatedAt,reviewedAt,adoptedAt}`；
但 `evidence` 数组元素是 snake_case：`{room_id, round_id, file_ids[]}`。

`api.normalizeSkillProposal`（`web/js/api.js:307`）统一这两层，并兼容 `fileIds/roomId/created_at` 等写法，
UI 只读归一后的字段。

## 5. 截图

主视图（筛选 + 待评审卡片 + 已拒绝卡片的评审意见）：

![技能提案面板](../../../temp/skill-proposals.png)

滚到底部（已采纳卡片显示「已安装技能 skill-…」）：

![已采纳](../../../temp/skill-proposals-adopted.png)

原图：`D:\能力测试\temp\skill-proposals.png`、`D:\能力测试\temp\skill-proposals-adopted.png`（均 1020×720）。

## 6. 验证证据（2026-11-06，Playwright MCP 实测）

隔离实例：

```powershell
cd D:\能力测试\fusion
$env:FUSION_DATA_ROOT='D:\能力测试\temp\proposal-ui'
node src/main.js --port 8787
# 造数据（真实 HTTP，不是直接插库）：4 条提案，其中 1 条 review(adopt) 成 approved、
# 1 条 review(reject) 成 rejected、1 条保持 proposed、1 条后补 proposed
node D:\能力测试\temp\seed-proposals.mjs
```

| 检查点 | 实测结果 |
|---|---|
| 列表渲染 | 4 张卡：待评审 2 / 已拒绝 1 / 已通过 1；标题、来源群名、提出者、回合数、tags、file_id chips 均正确 |
| 筛选 | 待评审 2 → 已通过 1 → 已拒绝 1 → 全部 4；按钮计数与 `report` 一致 |
| 展开 | `.prop-body` line-clamp 3（56.9px）→ `is-expanded` 后 284.5px，按钮变「收起」 |
| 采纳（两段式） | `POST .../review` **200** + `POST .../adopt` **200**；toast「已安装技能 skill-7bbe23e32e35」；卡片变「已采纳」并显示已安装技能；`GET /api/skills` 出现 `skill-7bbe23e32e35` |
| 拒绝（带 reason） | toast「已拒绝该提案」；状态变「已拒绝」；卡片显示「评审意见 与已有技能重复，先不收录 · user」；筛选取值同步（已拒绝 2 → 1） |
| 导航徽标 | `提案` 右侧数字随 `report.proposed` 变化（2 → 1，0 时隐藏） |
| 控制台 | **0 error / 0 warning** |
| 后端回归 | `node --test` **290 pass / 0 fail**（本轮只改 `web/**` + 本文档，未碰 `src/`、`tests/`、`package.json`） |

## 7. 已知限制

1. **不轮询**：列表只在进分区、点筛选、点刷新、采纳/拒绝后拉取；SSE `room.*.skill_proposed` 仅在
   「提案」分区**打开时**防抖 400ms 刷新，其它时候事件被丢弃（避免给后台房间白打接口）。
2. **两段式没有回滚**：review 成功但 adopt 失败时，提案会停在 `approved`（已通过），需要用户再点一次
   采纳或手动处理；界面不会伪造成功。
3. **guard 只在落盘阶段拦**：拦截后提案仍是 `approved` + `reason="guard 阻断：…"`，卡片用黄色提示展示，
   不会自动改为 rejected（改状态属于人工决策）。
4. **中文标题的 slug 不可读**：后端 `slugify` 只保留 ASCII，中文标题会退化成 `skill-<提案id>`
   （截图里可见）；这是 curator 行为，前端只展示结果。
5. **正文是纯文本**：转义后 `white-space: pre-wrap`，没有渲染 Markdown；折叠是 CSS 3 行而非真正截断 DOM。
6. **证据只到 file_id**：去重后最多 6 个 chip + 余量计数，`round_id` 只以「基于 N 个回合」呈现；
   完整 claims/回合明细要看房间里的证据徽标（E29）。
7. **筛选缺 adopted/deferred**：只有 全部/待评审/已通过/已拒绝 四个入口；`adopted`、`deferred` 只能在
   「全部」里看到（`GET ...?status=adopted` 本身可用）。
8. **没有分页**：固定 `limit=50`，提案更多时只显示最近 50 条。
9. **端点 404 静默降级**：旧版后端没有 E27 时，面板显示一行「技能提案端点不可用：…」并退化为空态，
   不 toast、不影响其它分区。
10. **采纳后技能列表刷新失败不重试**：`refreshSkills()` 失败会被吞掉，「能力」分区要等下次启动才会出现新技能。

## 8. Lead 接入清单

本 UI 不需要 Lead 改后端。可选后续：

1. 若想要「已采纳 / 已延后」快捷筛选，只需在 `PROPOSAL_FILTERS` 加两项（API 已支持任意 status）。
2. 若希望正文用 Markdown 渲染，`web/js/markdown.js` 的 `renderMarkdown` 可直接复用（注意折叠高度）。
3. 若后续在房间头加「本群提案 N」入口：`openSettings({ tab: "proposals" })` 已支持指定分区。
