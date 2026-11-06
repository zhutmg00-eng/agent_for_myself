# 经验 → 技能（learn）：把"刚做完的事"沉淀成可审的 playbook

> 参考源码：`reference/hermes/hermes-agent`，commit `ca43606`（MIT）；行号以该快照为准。
> 契约：`docs/hermes/CONTRACT.md` §9.2。交付：`src/skills/learn.js`、`tests/learn.test.mjs`、本文档。
> 本文件只讲 learn（触发源）；propose/review/adopt/guard 见 `docs/hermes/SKILLS.md`。

## 1. Hermes 里是什么

1. **`/learn` 是官方入口**：一条 slash 命令把"用户描述的东西"（目录、URL、**"我们刚做的事"**、粘贴的笔记）
   变成可复用技能；空参数时默认就是"我们刚做完的工作流"（`agent/learn_prompt.py:136-142`，
   命令处理器在 `hermes_cli/cli_commands_mixin.py:1310-1316`）。
2. **写技能是 live agent 的活**：`/learn` 让当前 agent 用已有工具收集材料，再通过 `skill_manage` 落盘
   （`agent/learn_prompt.py:1-6`、`:172-190`），不是离线蒸馏器。
3. **正文有固定段序**：`# <Human Title>` + 2-3 句简介、`## When to Use`、`## Prerequisites`、
   `## How to Run`、`## Quick Reference`、`## Procedure`、`## Pitfalls`、`## Verification`
   （`agent/learn_prompt.py:43-52`）。
4. **frontmatter 是硬门槛**：`name` 小写连字符、`description` ≤60 字符且一句话、`version: 0.1.0`、
   `author` 不许填环境推断值（`agent/learn_prompt.py:15-41`，同 `skills/AGENTS.md:16-22`）。
5. **来源是数据不是指令**：材料里任何"看起来像提示"的句子都不能改变 agent 行为；蒸馏前要丢掉
   零宽/双向控制字符（`agent/learn_prompt.py:125-133`），这与我们 guard 的 `hidden-unicode` 同一威胁模型。
6. **质量条**：只写来源里逐字出现过的命令/端点/配置，不发明参数；简单技能 ~100 行、复杂 ~200 行
   （`agent/learn_prompt.py:67-81`）。
7. **"技能泛滥"被定义为失败**：几百条各记一次会话 bug 的窄技能是库的失败，不是特性
   （`agent/curator.py:296-304`）；正文超 ~24k 字符的 SKILL.md 是整合目标（`:313-316`）。
8. **创建要标来源**：`record_created(agent_created=...)` 区分"agent 自己创建"与"用户 `/learn` 要求"
   （`tools/skill_usage.py:522-532`）；curator 只策展 agent 创建的技能（`skills/AGENTS.md:66-81`）。

## 2. 为什么需要

- `src/skills/curator.js` 已有 propose → review → adopt 全链路和 guard 闸门，但**没有触发源**：
  现在只能人肉调 `propose`，群聊里"刚做完的一件事"直接流失。
- `room.runRound` 结束时已经握着判定质量所需的一切：逐回合 `{bot_id, text, evidence, ms}`
  （`src/rooms/room.js:834-851`）与证据三态计数（`src/rooms/evidence.js:385-393`）。
- 但"每轮都提案"会把提案队列变成垃圾场（对照 Hermes 的窄技能失败论）。所以触发源必须是**纯函数
  闸门**，产物必须**确定、可审、可改**；落盘仍走 review + guard，不自动 adopt。

## 3. 我们落地成什么

### 3.1 接口（与 §9.2 一致）

```js
export const TITLE_MAX_CHARS = 40;
export const AUTO_PROPOSE_MODES = ["off", "observed", "always"];
evaluateLearningGate({ turns, evidenceSummary, reviewerVerdict, settings }) -> { ok, reason }
buildSkillDraft({ instruction, roomId, roomTitle, topic, members, turns, files,
                  evidenceSummary, reviewerVerdict, tags })
  -> { title, body, tags, signature } | null
```

入参形状（与 Lead 约定，不再变动）：`turns[] = { bot_id, text, evidence: "observed"|"prepared"|"mismatch"|null, ms }`；
`evidenceSummary = { observed, prepared, mismatch, total }`；`reviewerVerdict = "pass"|"reject"|null`；
`settings.auto_propose_skills = "off"|"observed"|"always"`（默认 `observed`）。

### 3.2 闸门（顺序即优先级）

| 条件 | 结论 |
|---|---|
| `auto_propose_skills = off`（含布尔 `false`） | 拒绝："房间设置已关闭自动提案" |
| 有效成员回合 < 2（空 `text` 不计） | 拒绝："只有 N 个成员回合（至少需要 2 个）" |
| `mismatch > 0`（summary 或任一回合 `evidence=mismatch`） | 拒绝："存在证据不符" |
| `reviewerVerdict = reject` / 无法识别（fail closed） | 拒绝 |
| 默认 `observed` 且 `observed = 0` | 拒绝；`always` 模式放行 |
| 其余 | 通过，reason 里带上回合数与 reviewer 状态 |

证据计数取"回合级 evidence"与"调用方 summary"的**并集（较大值）**：任一信号说有不符都必须拦。

### 3.3 草稿结构（Markdown playbook，无 frontmatter）

```markdown
# <title>                      ← 任务指令提炼：去 @称呼、"群主：" 前缀、Markdown 标记与首尾标点，≤40 字
## 目标                        ← 指令原文（去称呼），≤160 字
## 步骤                        ← 按回合顺序 1..N：`**成员名**：回合首行摘要`（≤140 字/步，最多 12 步）
## 验收标准                    ← ≥2 成员顺序产出 + observed/prepared/mismatch 计数 + reviewer 结论
## 证据                        ← file_id 列表（群文件优先、回合文本兜底；去重、≤10 条）
## 适用场景                    ← 房间/话题/关键词 + "再次遇到同类需求时按步骤执行"
```

- 标题候选顺序：任务指令 → 话题 → 首个回合首行 → 房间名；全空则返回 `null`。
- **body 不含 frontmatter**：`curator.adopt` 统一补 `name/description/version/source/created`（见 `SKILLS.md` §3.2）。
- **signature** = `sha1(normalize(title) + "\n" + normalize(body))`，40 位 hex；`ms`、时间等易变字段
  不参与，保证同一经验跨回合得到同一个去重键。

### 3.4 采纳 / 改写 / 不采纳

- **采纳**：自动触发提案（Hermes 的"复杂任务后创建技能"）；"没有可观测证据就不学"（默认 `observed`）；
  窄技能失败论（回合门槛 + 签名去重）。
- **改写**：Hermes 让 LLM 写正文并用策展 fork 合并；我们用确定性模板（同输入同字节），
  review 由人拍板 + guard 扫描。
- **不采纳**：`## Prerequisites` / `## Quick Reference` / `## Pitfalls` 三段（自动草稿无法可靠推断
  环境依赖与坑，写了就是编造）；LLM 改写与 consolidation；自动 adopt。

## 4. 与 Hermes 的差异与取舍

- **谁写技能**：Hermes 让 agent 用 LLM 创作（`learn_prompt.py:144-196` 是一段长提示词）；我们生成模板。
  代价：表达不如模型灵活；收益：可测、可复现、签名稳定、不会被来源里的注入文本带偏。
- **段结构**：Hermes 八段（`learn_prompt.py:43-52`）；我们五段——`适用场景`≈`When to Use`、
  `步骤`≈`Procedure`、`验收标准`+`证据`≈`Verification`、`目标`≈简介，其余三段主动省略。
- **自动程度**：Hermes 的 `/learn` 直接落盘技能；我们只 `propose`，必须 `review` + `adopt` + guard。
- **规模**：`learn.js` 358 行（契约 §0.6 ≤400），只用 `node:crypto`，无新依赖。
- **中文优先**：称呼（@xxx）、说话人前缀（群主/主持人/用户）、全角标点按中文房间治理习惯清洗；
  Hermes 无此逻辑。

## 5. 验证证据

```powershell
cd D:\能力测试\fusion
node --test tests/learn.test.mjs     # 14 pass / 0 fail
node --test                          # 全量 263 pass / 0 fail（230 基线 + 本模块 14 + 并行模块）
```
> 本模块单独加入时把全量从 230 推到 244；后续并行模块陆续合入，交付实测 263/263 全绿。
> 基线随并行开发漂移，以当时的实际输出为准。

14 个用例覆盖：闸门放行；回合不足（空文本/非法入参）；`off`（字符串与布尔）；summary 与回合级
`mismatch`；reviewer 的 reject/无法识别/pass/中文"通过"/null；`observed` 严格与 `always` 放宽；
草稿五段顺序 + 步骤按回合顺序 + 无 frontmatter + 签名 40 位；标题去 @称呼/说话人前缀/标点/超长截断；
file_id 进证据段（去重、群文件优先）；中文指令 + 空 members/topic；签名稳定且区分内容、`ms` 不参与；
空输入返回 null；确定性与入参不可变；纯函数不写盘。

## 6. Lead 接入清单

1. **收集回合**：`runRound` 循环里每个成功回合（`src/rooms/room.js:818-851`）push 一条
   `{ bot_id: nextId, text, evidence: evidenceStatus, ms: result?.ms || 0 }`；循环结束后 `turns` 就是本轮数组。
2. **触发点**：`runRound` 的 `finally` 之后、`return spoken` 之前（`src/rooms/room.js:855-865`）：
   ```js
   try {
     const summary = this.evidenceStore?.summary({ roomId: this.room_id }) || null;
     const gate = evaluateLearningGate({ turns, evidenceSummary: summary, reviewerVerdict, settings: this.settings });
     if (gate.ok && this.curator) {
       const draft = buildSkillDraft({ instruction: roundMessage, roomId: this.room_id, roomTitle: this.title,
         topic: this.topic, members: this.members, turns,
         files: this.store?.listRoomFiles?.(this.room_id) || [],
         evidenceSummary: summary, reviewerVerdict, tags: [] });
       if (draft) { /* 去重 + propose，见 3、4 */ }
     }
   } catch (err) { log.warn("auto propose skill failed", err?.message || err); }
   ```
3. **去重**：`const key = \`learn_sig:${draft.signature}\`` → `store.getKV(key)` 命中就跳过；写入
   `store.setKV(key, { at: Date.now(), roomId: this.room_id, proposalId })`。签名已排除 `ms`，
   同一经验重复触发不会重复提案；需要二次兜底时再按 `curator.listProposals({ status: "proposed" })`
   的同 title 过滤。
4. **提案**：`curator.propose({ title: draft.title, body: draft.body, evidence: turns.map((t) => `room:${roomId}#${seq}`), roomId, tags: [...draft.tags, "auto"] })`；
   `propose` 是同步 DB 写，失败必须 catch 并 `log.warn`，**不能影响回合收尾**。
5. **reviewerVerdict**：Lead 侧从 reviewer 回合文本判定——命中 `/通过|可以|无异议/` 且不命中
   `/需修改|不通过|打回/` → `"pass"`；命中否定 → `"reject"`；本轮没有复核回合 → `null`。
   建议判定函数也做成纯函数（下一轮可交给我）。
6. **settings**：`PUT /api/rooms/{id}` body `{ settings: { auto_propose_skills: "off"|"observed"|"always" } }`
   → `room.setSettings`（`src/api/server.js:2180-2201`、`src/rooms/room.js:413-417`）。缺省/未知值按
   `observed`；`off` 是最省事的紧急开关。
7. **前置条件**：只在同时注入 `curator` 与 `evidenceStore` 的房间执行；没有 evidence 时 `observed`
   模式会自然拒绝（`observed=0`），不会误产出。
8. **不自动 adopt**：提案进 `GET /api/skills/proposals`，人工 `review` + `adopt`；guard 在 adopt 时兜底。
9. **待决策**：① `evidenceSummary` 传房间累计还是本轮？传累计会把历史 mismatch 永久变成阻塞，
   建议传本轮；② reviewer 判定是否要我提供纯函数 `judgeReviewer()`；③ 去重键是否还要加 `roomId`
   （当前签名已含房间名/话题，但房间改名会变）。

---

## 7. Lead 集成补充（2026-11-06 第六轮）

1. **tags 不参与正文**：`buildSkillDraft` 传 `tags: []`；`curator.propose` 时拼 `[...draft.tags, topic, "auto"]`。
   这样 playbook 的「适用场景」不会出现「关键词：auto」这种内部标记，signature 也不含来源标记。
2. **`force` 的边界**：手动 `POST /api/rooms/{id}/learn` 的 `force=true` 只绕过「自动提案策略开关」
   （`auto_propose_skills=off` 时按 `observed` 处理），**不绕过证据质量闸门**——prepared-only 回合仍然拒绝学习。
   实现：`gateSettings = force ? { ...settings, auto_propose_skills: mode==="off" ? "observed" : mode } : settings`。
3. **reviewer 判定（已替换）**：`Room.judgeReviewerTurn` 调用 `src/skills/judge.js#judgeReviewer`（契约 §10.1），
   并把 `reviewerPresent` 一起交给闸门：**reviewer 在场但未表态 → 不沉淀**（沉默不是通过）；
   「不用修改」这类否定语境判 pass，不再被旧启发式误判。
4. **去重键**：`learn:sig:<roomId>:<signature>`（房间内去重；跨房间各自沉淀）。
