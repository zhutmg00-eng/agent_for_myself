# 上下文压缩：水位 / 摘要 / 预算（`src/rooms/context.js`）

> 作者：context-dev。契约：`docs/hermes/CONTRACT.md:187-204`（§7.1）。
> 参考源码（只读）：`hermes-agent` commit `ca43606`、pi 1.3.0 bundle（`node_modules/@earendil-works/pi-coding-agent/`）。
> 结构按 `docs/hermes/CONTRACT.md:164-172` 六节。

## 1. Hermes / pi 里是什么（证据）

1. **压缩是唯一被允许的上下文变更**。`agent/AGENTS.md:57-60`："The system prompt is byte-stable for the life of a conversation; the ONLY context mutation is compression. Anything that must inject content mid-conversation rides a user message or tool result, never the system prompt."
2. **摘要自己也是上下文压力源，所以要封顶**。`agent/context_compressor.py:826-829`：`_MIN_SUMMARY_TOKENS = 2000`、`_SUMMARY_RATIO = 0.20`、`_SUMMARY_TOKENS_CEILING = 10_000`（"Summaries above ~10K tokens are themselves a context-pressure source"）。
3. **摘要预算随窗口走，不是常数**。`context_compressor.py:2694`：`max_summary_tokens = min(int(context_length * 0.05), _SUMMARY_TOKENS_CEILING)`。
4. **小窗口抬高触发线**。`context_compressor.py:2751-2756`：`context_length < _SMALL_CTX_WINDOW_LIMIT` 时触发线取 `max(threshold_percent, _SMALL_CTX_THRESHOLD_PERCENT)`（≥75%），否则小模型会被压缩+摘要本身撑爆。
5. **逐字尾部有三重上限**。`context_compressor.py:925-930`：地板 10K / 上限 25K / `TAIL_MAX_CONTEXT_FRACTION = 0.20`。注释给的反例正是"受保护内容吃掉整个请求"：*"The lean floor alone is 61% of a 16K window … the 'protected' tail WAS the whole request and every compaction pass summarised six rows and reclaimed nothing."*
6. **摘要结构固定，新旧分开**。`context_compressor.py:1012-1014`：`_LEAN_SESSION_LOG_HEADING = "## Detailed Session Log (oldest first)"` + 单次 4000 tokens 预算；逐字用户消息 newest-first、详细日志 oldest-first。
7. **压缩无效要冷却，不能空转**。`context_compressor.py:2717-2723`：`_ANTI_THRASH_RECOVERY_SECONDS = 300.0`，结构上无可压缩内容时只算 no-op 不计失败（`:2725-2726`）。
8. **pi 侧的触发与保留**。`docs/compaction.md:29-35`：`contextTokens > contextWindow - reserveTokens`，`reserveTokens` 默认 16384；`:43-49`（切点从尾部回溯 `keepRecentTokens`、生成摘要、写 `firstKeptEntryId`、按摘要+保留段重建）；`:419-435`（`{"compaction":{"enabled":true,"reserveTokens":16384,"keepRecentTokens":20000}}`）。

## 2. 为什么值得抄（我们的缺口，本轮最严重）

- `src/rooms/room.js:407-437` 的 `renderTranscript()` 每轮把整份转录（≤12000 字符）重新算一遍，`room.js:474-478` 的 `buildInstruction()` 再把它拼进**同一条持久 pi 会话**。同一会话里前几轮的内容本来就在上下文里，于是**第 N 轮重复前 N−1 轮的量，注入成本近似 O(N²)**。
- 截断是**静默**的：`room.js:429-435` 只在超预算时 `break`，既没有 `omitted` 计数也没有摘要，模型不知道少看了什么。
- pi 的自动压缩按**会话 token** 触发（`docs/compaction.md:29-35`），而这份人工注入量与轮次成正比；`reserveTokens=16384` 的触发线永远落在注入量之后，压缩追不上注入。
- 群聊放大系数：每个成员是**独立会话**，同一份转录按成员数各灌一遍（探针里 3 人 = ×3）。
- 水位/摘要的语义在 Hermes 里是分层的（摘要预算、逐字尾部上限、omitted 计数），我们这里只取"字符层"那一层——token 层仍然交给 pi 自己的压缩。

## 3. 我们落地成什么

**接口**（逐字实现 `CONTRACT.md:189-197`，无新增方法）：`createRoomContext({ store, roomId, now })` 返回
`deltaFor / markInjected / digestText / compose / watermark / stats`。

**水位（唯一持久化状态）**：`store.getKV/setKV`，键 `ctx:wm:<roomId>:<botId>`，值 = 已被注入过的最大 `seq`（整数）。
不建表、不改 `store.js`、不依赖 `room_messages` 之外的数据；`seq` 由 `store.appendRoomMessage()` 单调分配（`src/store.js:327-341`）。

**`digestText({ maxChars = 1600 })`：确定性、无 LLM、无网络、无时间戳**（同输入必同输出，便于缓存与断言）。
按优先级拼四段，装不下就停（低优先级不插队），一段都装不下时只留标题（标题仍超预算就按预算截断并标注）；四段全为空时返回空串：

| 顺序 | 内容 | 上限 |
|---|---|---|
| 1 | 群主题（`rooms.topic`） | 一行 |
| 2 | 最近 3 条成员结论（`speaker !== "user"`） | 每条 120 字 |
| 3 | 群文件清单（`file_id` + 名称） | 20 条 |
| 4 | 未决分派（识别 `room_assign_task` 形态文本） | 5 条 |

**`compose(botId, { level, roundMessage, budget })` 的装配顺序**：
`本轮消息（永不裁剪，最后一段）` ← `digest`（≤ min(1600, budget/3)） ← `delta`（从新到旧整条收入，等价于"从旧到新整条丢弃"）。
省略标注 `（已省略 N 条更早发言）` 放在**增量块首行**（被省略内容原本所在的位置，与 `room.js:413-417` 现有 summary 行为一致）；
单条超过 `budget/3` 时截断并标注 `（已截断，原文 N 字）`；`level="summary"` 只看最近 4 条**且不消费水位**；`level="none"` 返回空串与全零 stats。
首次无水位退化为最近 30 条，并把窗口之前的条数计入省略。

**幂等**：`compose` 成功装配后**自己前进水位**到"本次真正注入的最大 seq"（即 `stats.throughSeq`，被预算裁掉的旧消息不算），
因此同一成员连续两次 `compose` 第二次 `deltaCount === 0`（只剩 digest）；`markInjected` 是显式确认入口且**单调不减**（水位倒退会造成重复消费）。
`stats` 里另外给出 `throughSeq`（本次真正注入的最大 seq；`summary`=0 表示不消费；一条都没注入时回落成当前水位）与
`firstSeq`（本次注入的最小 seq，0 表示没有逐条发言）——这两个字段是 Lead 集成时追加的**向后兼容增补**（契约 §7.1 原有四字段不变），
供 `room.js` 直接 `markInjected(botId, stats.throughSeq)`，避免把没注入的消息误标成已读。

**与 Hermes 的采纳/改写/不采纳**：
- 采纳：水位（但用 `seq` 而非 token 边界）、`omitted` 必须显式计数、单条与摘要各有独立上限（对应 `:826-829` 的"摘要自己也要封顶"）。
- 改写：Hermes 的摘要由 auxiliary LLM 生成；我们这里是**确定性拼装**——群聊的摘要只需要"主题/结论/文件/未决"这四类稳定事实，LLM 摘要交回 pi 的 compaction，避免每轮一次额外模型调用。
- 不采纳：`:826-829` 的 2000/0.20/10000 具体数值（token 级、大窗口假设，我们这层是字符级且更小）；`:925-930` 的 10K/25K 尾部（我们按字符预算 + 整条丢弃）；`:2717-2723` 的 anti-thrash 冷却（我们没有 LLM 调用可以 thrash）；`## Historical Task Snapshot` 的 REFERENCE ONLY 前缀（我们用"本轮消息永远是最后一段"达到同一效果）。

## 4. 与 Hermes 的差异与取舍

| 维度 | Hermes | 我们 | 取舍理由 |
|---|---|---|---|
| 规模 | `context_compressor.py` 5100 行 Python | `context.js` 383 行 ESM | 铁律 ≤400 行/模块，且我们只做注入层 |
| 计量单位 | token（有 tokenizer） | 字符（零依赖） | 不新增依赖；字符预算是保守近似，真正的 token 压缩交给 pi |
| 摘要 | auxiliary LLM 生成，结构化小节 | 确定性四段摘要 | 可在测试里字节级断言；群聊需要可复现 |
| 触发 | 窗口占用率 / 阈值 | 逐回合（成员每次发言前） | 我们的问题是"每轮注入量"，不是"会话自然增长" |
| 持久化 | 会话内 `CompactionEntry` | kv 水位（跨进程） | 群聊会话是持久 pi 会话，水位必须活过重启 |
| 缓存不变量 | 系统提示字节稳定 | 同（注入走 user 消息，`room.js:499` 的 `=== 本轮消息 ===` 之后） | digest 变化只影响 prompt 尾部 |

**已知边界**：`deltaFor/compose` 的读取窗口上限是 200 条（`DEFAULT_DELTA_LIMIT`）；若某成员离线很久，窗口之前的发言不会逐条注入，
但会被计入 `stats.trimmed` 并在增量块首行标注——这与 Hermes "omitted 必须可见"的精神一致（对照 `context_compressor.py:925-930`
对"受保护尾部 = 整个请求"的反例注释）。

## 5. 验证证据

```text
> cd D:\能力测试\fusion; node --test tests/context.test.mjs
✔ 20 个用例全部通过（tests 20 / pass 20 / fail 0）
```

用例覆盖（`tests/context.test.mjs`，20 个）：水位持久化跨 `Store` 重开、`markInjected` 单调与非法值、`deltaFor` 字段/顺序/`limit`、
首次 compose 退化到 30 条并标注省略、`summary` 档不消费水位、`level=none`、预算裁剪与省略标注、超长单条按 `budget/3` 截断、
本轮消息优先级与去重、digest 确定性（换实例/跨 compose 一致、无时间戳）、digest 优先级与 120 字截断、空房间、文件清单 20 条、
`room_assign_task` 识别与"识别不到就不写"、幂等（第二次 delta 为空）、`stats()`（bots 来自 kv 且跨实例）、参数校验、
`throughSeq` 只到实际注入的最后一条（`firstSeq` 连续尾窗）、预算撑爆时 `throughSeq=0` 且不认领水位（下次仍可补发）。

**成本探针**（仓库外 `D:\能力测试\temp\ctx-probe\probe.mjs`，3 名成员 × 6 轮，旧实现等价于 `room.js:407-437`，新实现 `compose(botId,{budget:6000})`）：

| 轮次 | 累计消息 | 旧：单成员转录字符 | 旧：本轮注入总计 | 新：本轮注入总计 | 占比 |
|---|---|---|---|---|---|
| 1 | 4 | 1539 | 4617 | 6048 | 131% |
| 2 | 8 | 3079 | 9237 | 6048 | 65% |
| 3 | 12 | 4619 | 13857 | 6048 | 44% |
| 4 | 16 | 6159 | 18477 | 6048 | 33% |
| 5 | 20 | 7699 | 23097 | 6048 | 26% |
| 6 | 24 | 9239 | 27717 | 6048 | 22% |

旧实现单轮注入量随轮次**线性增长**（累计二次）；新实现**每轮恒定**。6 轮合计 97002 → 36288 字符（**37.4%**），
第 6 轮单轮 27717 → 6048。新实现在第 1 轮反而更大（多了 digest 的固定开销），这是"用常量摘要换掉线性增长"的预付成本。

## 6. Lead 接入清单（逐条）

1. **`src/rooms/room.js:407-437`**：`renderTranscript(botId)` 整体替换为
   `const ctx = this._roomContext ??= createRoomContext({ store: this.store, roomId: this.room_id });`
   `const { text, stats } = ctx.compose(botId, { level: this.effectiveContextLevel(botId), roundMessage, budget: 6000 })`。
   建议把 `roomContext` 实例挂在 Room 上（一个房间一个），不要每轮新建——水位缓存才有意义。
2. **`src/rooms/room.js:474-511`**：`buildInstruction()` 里 `const transcript = this.renderTranscript(botId)` 换成上面的 `compose().text`；
   `=== 群聊共享上下文 ===` 这个外层标题可以去掉，compose 自带 `群上下文摘要` / `自上次注入以来的新发言` / `本轮消息` 三段。
   注意 `transcript` 为空时原本不加段落（`room.js:478`），compose 同样返回空串，行为兼容。
3. **注入后调用 `markInjected`（用 `stats.throughSeq`，不是"当前最新 seq"）**：
   `if (stats.throughSeq) ctx.markInjected(nextId, stats.throughSeq)`。
   `throughSeq` 是**本次真正写进 instruction 的最大 seq**：被 budget 裁掉的旧消息、`summary`/`none` 档（恒 0）、
   一条都塞不下的回合（回落成当前水位）都不会被误标成已读；`markInjected` 单调不减，重复调用是幂等的空操作。
   `compose` 内部也已按同一个 `throughSeq` 前进水位，所以这行是确认，不是必需。
4. **`round_completed`（`room.js:678-684`）：不需要触发 digest 重建**。`digestText()` 是纯函数、按需计算（读尾部 100 条），
   没有缓存也就没有失效问题。如果 Lead 想加缓存，失效键用"最后一条 `room_messages.seq`"而不是回合事件——
   子群结论（`room.js:742-756`）和文件变更不一定伴随 `round_completed`。
5. **`file_saved`（`src/rooms/files.js:113-127`）：不需要额外通知**。文件清单每次 `compose` 现取 `listRoomFiles`，
   下一次注入自动带上；若希望"本回合立刻可见"，把 `buildInstruction` 里 compute digest 的时机放在 `fileIndexText()` 之后即可。
6. **`say()`（`room.js:516-540`）**：用户消息先落库再开跑，compose 会把"最后一条等于 `roundMessage` 的 user 发言"从 delta 里剔掉，
   Lead **直接传 `roundMessage` 即可**，不要自己删尾部消息（删了会导致水位与渲染不一致）。
7. **`restore`（`src/rooms/manager.js:50-79`）：无需恢复任何上下文状态**——水位在 kv 里，进程重启后第一次 `compose` 自动接上。
8. **需要 Lead 决策的三点**（我按下面实现，改名/改序都很容易）：
   - 省略标注位置：契约写"追加"，我放在**增量块首行**（被省略内容原本的位置）。要对齐"整段末尾"只需改 `compose` 里 `deltaParts` 的顺序。
   - `compose` 自动前进水位（否则"连续两次 compose 不重复消费"的验收过不了）。如果 Lead 需要"只读探测"，用 `deltaFor()`（不消费）。
   - `stats` 的 `throughSeq/firstSeq` 是按 Lead 要求追加的向后兼容字段（原四字段不变）；如果你只想认契约原文四字段，删掉这两个返回键即可，内部前进水位仍按 `throughSeq` 逻辑。
   - `stats()` 的 `bots` 用 `kv` 前缀扫描得出（`SELECT k FROM kv` 后按 `ctx:wm:<roomId>:` 过滤），只读、不建表；若 Lead 认为不该扫共享 kv 表，可降级为进程内已知成员数。
9. **与 §7.4 的 pi 设置配合**：`src/engine/bot.js` 写 `.pi/settings.json` 时，`compaction.reserveTokens` 保持 16384 量级即可；
   我们把"每轮人工注入"从 O(N²) 压回常量后，pi 的压缩只需要处理会话自然增长，两者不再互相追赶。
10. **可选端点**（`src/api/server.js`）：`GET /api/rooms/:id/context` → `{ stats, watermarks: {botId: seq}, digest }`，
    给 UI 的"上下文"面板用；数据全部来自 `createRoomContext` 的三个只读方法，不需要新表。
