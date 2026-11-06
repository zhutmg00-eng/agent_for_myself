# reviewer 裁决解析（judge）：三态 + 可解释

> 参考源码：`reference/hermes/hermes-agent`（commit `ca43606`）、`reference/hermes/oh-my-hermes`
> （commit `1727425`），均 MIT；行号以这两份快照为准。契约：`docs/hermes/CONTRACT.md` §10.1。
> 交付：`src/skills/judge.js`、`tests/judge.test.mjs`、本文档。本文件只讲裁决解析；学习闭环见
> `docs/hermes/LEARN.md`，安装闸门见 `docs/hermes/SKILLS.md`。

## 1. Hermes / omh 里是什么

1. **review 产物是三态 verdict**：`Verdict: [Approved ✅ | Changes Requested 🔴 | Reviewed 💬]`
   （`skills/software-development/github/references/review-output-template.md:10`）。
2. **三态有显式决策表**（同文件 `:45-49`）：`Approved` = 零 critical/warning、只剩 suggestions；
   `Changes Requested` = 存在任一 critical/warning；`Reviewed 💬` = 只有观察、没有结论。
3. **严重度与"是否阻断"分离**（`:38-43`）：Critical 阻断、Suggestion 不阻断 —— 所以 nits/suggestions
   不该判 reject（契约 §10.1 的 "nits 记 pass" 同源）。
4. **状态流转靠事件种类，不靠散文**：kanban 的 `changes_requested` 是从 run outcome 映射出的终态
   （`hermes_cli/kanban_db.py:2251-2258`），并据此决定任务状态（`:2281-2287`）。
5. **机器可读块优于散文猜测**：curator 强制要求 structured summary，理由写得很直白——下游工具要能
   区分 consolidations 与 prunings，不能靠人话推断（`agent/curator.py:448-469`）。
6. **reviewer 是角色，不是证据**：omh 明确 "Review findings are not fix evidence; merge-ready is not
   merged"（`oh-my-hermes/docs/ROLES.md:191`），角色选择本身不是 review evidence（`:21`）；verdict
   只允许 PASS/FAIL/PARTIAL 且必须附证据位置（`omh-agent-ops-review/SKILL.md:73`）。

## 2. 为什么需要

旧实现是 `Room._reviewerVerdict`（`src/rooms/room.js:1012-1017`）的一句正则：命中「需修改/不通过/
未通过/退回/打回」→ `reject`，**其余一律 `pass`**。三类误判在群聊里都很常见：

1. **没表态 → pass**：「我稍后复核」「还没看完」会被当成通过。学习闸门（`src/skills/learn.js`）要求
   "有 reviewer 时必须通过"，于是没复核过的经验直接进了提案队列。
2. **否定语境 → reject**：「不用修改」「无需修改」含有「需修改」子串，被误判打回。
3. **词形陷阱**：「未通过率 0.3%」「通过率 98%」是度量名，不是裁决；旧正则会把前者判 reject。

再加上群聊中英混用（LGTM / changes requested），判定必须从"一句话正则"升级成**显式优先级 + 三态 +
可解释**的纯函数。

## 3. 我们落地成什么

### 3.1 接口（与 §10.1 一致）

```js
export const VERDICTS = ["pass", "reject", "null"];   // "null" 是字符串形式，实际返回值为 null
judgeReviewer({ turns = [], reviewerId = null } = {}) -> {
  verdict: "pass" | "reject" | null,
  reviewer: string | null,     // 打回的那个 / 第一个 pass；没有 reviewer 回合时 null
  matched: string | null,      // 触发判定的片段（含上下文，≤80 字）
  reasons: string[],           // 逐条人话依据 + 多 reviewer 聚合说明
}
```

`turns[]` 形状固定 `{ bot_id, text, evidence, ms }`（与 `Room._round_turns` 一致）；`reviewerId`
支持字符串、数组，不传/空数组时按 `bot_id` 含 `review`（不区分大小写）推断。

### 3.2 判定优先级（顺序即语义）

| 顺序 | 规则 | 例子 | 结果 |
|---|---|---|---|
| 0 | 先抹掉「否定式修改」（无需/不用/不需要/不必 + 修改/调整/改动/返工/重做） | 「无需修改」 | 交给第 2 步判 |
| 1 | 显式拒绝：未通过/不通过/需修改/打回/退回/驳回/否决/changes requested/needs changes/not approved/rejected/needs fix | 「需要修改第 2 步」 | `reject` |
| 2 | 显式通过：通过（≠通过率）/同意/批准/没问题/无需修改/LGTM/approved/pass/ship it/looks good/nits | 「LGTM，两条 nits」 | `pass` |
| 3 | emoji：🔴❌👎🚫⛔ → reject；✅✔👍🟢 → pass | 「🔴 有阻塞」 | 对应三态 |
| 4 | 未表态：稍后/还没看/待确认/tbd/pending/will review | 「稍后复核」 | `null` |
| 5 | 兜底：没有明确结论（没表态 ≠ 通过） | 「数据见附件」 | `null` |

补充规则：
- **同一 reviewer 多回合**：最后一次有效表态说了算（「需修改」→「已改，通过」= pass）；之后再来一句
  未表态不覆盖已有结论。
- **多 reviewer**：任一 `reject` → `reject`；全部 `pass` → `pass`；否则 `null`（不按通过处理）。
- **reviewerId 指定但无回合** → `null`，`reasons` 说明原因。

### 3.3 可解释性

- `matched`：以命中片段为中心取上下文，总长 ≤80 字（超长补省略号），供日志/UI 解释"凭什么"。
- `reasons`：逐条 `"reviewer-b：命中拒绝表述「需要修改」（不通过）"`；多 reviewer 时追加
  `"多 reviewer 取最严格结论：reviewer-b 判不通过"` / `"多 reviewer 未全部表态（1/2 通过）…"`。

### 3.4 采纳 / 改写 / 不采纳

- **采纳**：三态 verdict、显式决策表、"严重度 ≠ 阻断"（nits 记 pass）、"没表态单独成态"。
- **改写**：Hermes 的 verdict 由结构化 review 产物/run outcome 驱动（我们没有 PR/CI 事件），只能解析
  人类散文 → 确定性正则 + 优先级 + 否定语境预处理。
- **不采纳**：LLM 当裁判（不可测、可被注入）、超出三态的更多状态、PR/merge/CI 语义。

## 4. 与 Hermes 的差异与取舍

- **输入形态**：Hermes 有 review 模板与 CI 事件；我们只有群聊自由文本，所以正则覆盖面更宽，但用
  "显式表态优先、未表态兜底"的顺序保证不把沉默当同意。
- **判定主体**：Hermes 由 reviewer 按模板表态、状态机消费事件；我们是纯函数，无状态、无 IO。
- **三态对齐**：`pass ↔ Approved ✅`、`reject ↔ Changes Requested 🔴`、`null ↔ Reviewed 💬 / 无裁决`。
- **中文优先**：中文话术（稍后复核、不用修改、打回）是一等公民；英文大小写不敏感。
- **规模**：`judge.js` 281 行（契约 §0.6 ≤400），零依赖（不用 crypto/fs）。
- **边界**：只判"reviewer 这一轮有没有表态"，不判断 reviewer 是否有资格、也不判断产物质量。

## 5. 验证证据

```powershell
cd D:\能力测试\fusion
node --test tests/judge.test.mjs      # 22 pass / 0 fail
node --test                           # 289 pass / 0 fail（267 基线 + 本模块 22）
```

22 个用例覆盖：常量与返回形状；无 reviewer 回合；reviewer 文本为空；「稍后复核」判 null；中文显式
通过；「需要修改」判 reject；三种否定式修改（不用/无需/不需要）判 pass；「未通过率 / 通过率」词形
陷阱判 null；LGTM+nits 判 pass；Changes requested 判 reject；英文否定语境（no changes needed /
no blocking issues / doesn't need work）判 pass 且非否定表述仍 reject；多 reviewer 任一 reject /
全 pass / 混合未表态；reviewerId 单值 / 数组 / 大小写推断 / 指定但无回合；matched ≤80 字与 reasons
可解释；同一 reviewer 多回合的覆盖顺序；emoji ✅/🔴/💬；确定性、不改入参、不写盘、非法入参不抛错。

## 6. Lead 接入清单

1. **替换 `Room._reviewerVerdict`**（`src/rooms/room.js:1012-1017`）：
   ```js
   import { judgeReviewer } from "../skills/judge.js";

   _reviewerVerdict(turns = []) {
     const judged = judgeReviewer({ turns, reviewerId: this.settings?.reviewer_ids ?? null });
     this._last_reviewer_judgement = judged;   // 可选：给日志/事件/UI 解释用
     return judged.verdict;
   }
   ```
   `_round_turns` 保持 `{ bot_id, text, evidence, ms }` 不变（§10.3）。
2. **reviewerId 来源**：不传即按 `bot_id` 含 `review` 推断（兼容现有 `reviewer` 命名）；若房间以后
   有显式角色配置（如 `settings.reviewer_ids`），把字符串/数组直接传给 `judgeReviewer`。
3. **可解释性落到事件**：`proposeLearningSkill` 里可把 `judged.matched / judged.reasons` 带进
   `skill_proposed` 或 `log.debug`，回答"这轮为什么可以学 / 为什么没学"。
4. **行为变化（预期内）**：
   - 「稍后复核」不再算 pass（返回 null）；「不用修改」不再算 reject；「未通过率」不再误判。
   - ⚠️ 语义衔接：`learn.evaluateLearningGate` 把 `reviewerVerdict = null` 当作"本轮没有 reviewer"→
     **不阻塞**。所以"reviewer 在场但没表态"目前不会卡住学习。若产品要"reviewer 没表态就卡住"，
     下一轮给闸门加一个 `reviewerPresent`（或让 judge 返回 `verdict:null + reviewer:非空`，由 Lead
     在调用处判断 `judged.reviewer && judged.verdict === null`）。**需要你拍板**。
5. 无新端点：提案面板仍用 `GET /api/skills/proposals?status=`；`judgeReviewer` 只被 Room 调用。
6. 测试与冒烟：`node --test tests/judge.test.mjs`、`node --test`（288）、真实 e2e 里 reviewer 回合
   照常驱动学习闭环，日志里能看到 verdict 与 matched。

---

## 7. Lead 集成补充（真实 e2e 回归）

1. 已接入 `Room.judgeReviewerTurn`，并把 `reviewerPresent` 交给学习闸门：**reviewer 在场但未表态 → 不沉淀**。
2. 真实 e2e 发现并修复一个否定语境漏网：reviewer 写「本环节**无需退回**」时，
   `无需` 的否定预处理只覆盖「修改/调整/返工/重做」，`退回` 被拒绝模式命中 → 误判 reject。
   已把 `退回/打回/驳回/否决` 纳入否定预处理，并加回归用例（「总判定：通过 … 本环节无需退回」→ pass）。
3. `skill_proposed` 事件携带 `reviewer:{verdict,reviewer,matched}`，日志里可回答「为什么这一轮能学/没学」。
