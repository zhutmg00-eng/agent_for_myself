# 证据阶梯（observed / prepared / mismatch）吸收说明

> 交付物：`src/rooms/evidence.js`（397 行 = 纯函数 `classifyClaims` + 自建表 `ev_records`）、`tests/evidence.test.mjs`（23 用例）。
> 契约：`docs/hermes/CONTRACT.md:205-221`（第三轮 §7.2）。Hermes 证据基于 `reference/hermes` 的
> `hermes-agent` commit `ca43606` 与 `oh-my-hermes` commit `1727425`；Fusion 证据基于本仓库当前文件。
> 记号：`文件:行号`。

## 1. Hermes 里是什么

1. **声明是一等产物，且字段有界**：模型通过 `omh_todo action=record` 在 checkpoint 下落一条 `kind`
   （verification/review/qa）、`verdict`、有界 `summary`、`findings`、`claimed_source`（model/host_exit/
   independent_review/ci）、`claimed_evidence_state`（prepared_not_observed 或 observed）与最多 8 条证据引用；
   不接受 transcript / prompt / log / raw output（`docs/HARNESS_QUALITY.md:743-755`）。
2. **落库即降级为"声明"**：每行读回时都写成 `standing: model_declaration`、`observed: false`，无论写入方声称什么；
   "磁盘上一行写着 `observed: true` 是 malformed，不是证据"（`HARNESS_QUALITY.md:757-761`）。
3. **读路径区分"没有"与"声明没问题"**：`store_state` 是 absent/empty/present，`sources` 每类有
   absent/stale/declared_no_findings/declared_findings 四态，半个 binding 直接拒绝（`HARNESS_QUALITY.md:774-782`）。
4. **done 必须绑定一条真实调用**：plan todo 的 done 取"该 item 窗口内、未被其他 item 占用的最近一次
   `terminal`/`write_file`/`patch` 调用"，一次命令最多关一项，绑定一旦失败就 sticky（`HARNESS_QUALITY.md:802-822`）。
5. **prepared coverage 抬不高 observed achievement**：prepared coverage 只衡量"计划里阶段齐不齐"，
   observed goal-achievement 在有匹配的当前证据之前恒为 0（`docs/ROLES.md:13`）。
6. **角色选择也只是 prepared guidance**；findings 不是 fix 证据，"merge-ready is not merged"
   （`roles/reviewer.md:13`、`:45-47`）。
7. **委派结果自带状态三件套**：`status ∈ {completed, interrupted, failed}`、`exit_reason ∈
   {completed, max_iterations, interrupted, error}`、`truncated == (exit_reason == "max_iterations")`
   （`tools/delegate_tool.py:376-383`）；schema 不命中仍保留原始文本与 `schema_valid:false`，绝不丢结果
   （`delegate_tool.py:817-823`）。

## 2. 为什么值得抄（对应我们群聊产品的缺口）

- **成员回合一落库就只剩一个字符串**：`room_messages` 只存 speaker/content/kind/ts（`store.js:348-362`），
  工具结局不落库；本轮开工时 `bot.js` 的回合结果只有 `toolsUsed` 名字列表，没有成功/失败与摘要
  （现已补在 `bot.js:466-482` 并在 `:554` 返回，见 §6）。
- **失败与"没产出"被写成中文 notice**：`room.js:739-746` 把 `result.error` 与空文本都拼成
  `system_notices` 字符串，机器读不出来，也不落表。
- **UI 只有正文**：即便库里有证据，"群主说已保存"与"文件管家真的 `room_file_save` 过"在消息列表里仍同形，
  除非读取时把 `ev_records` 按 seq 合进来（§6 第 4 条仍待做）。
- **工具回显本身在诱导混淆**：`room_file_save` 成功时返回「已保存：file_id=…」（`src/rooms/tools.js:243`），
  一个没调过工具的成员只要复述这句话，看起来就和真保存一样。
- 这正是 omh 分析里点名的缺口：「声明与观察分家、空分母不是 0%、'读不到'不能渲染成'没问题'」
  （`docs/hermes/OMH_AND_CONTEXT.md:12`、`:37`）。

## 3. 我们落地成什么（`src/rooms/evidence.js`）

**接口（与契约 §7.2 完全一致；末尾两个附加导出不影响契约签名）**

```js
export const EVIDENCE_STATUS = ["observed", "prepared", "mismatch"];   // evidence.js:20
export const EVIDENCE_LABELS = { observed: "已观测", prepared: "仅声明", mismatch: "证据不符" };  // :23
export function classifyClaims({ text = "", toolCalls = [], files = [], knownFileIds = [] } = {})
  -> { status, claims: [{ kind, text, evidence? }], reasons: string[] };   // :164
export function createEvidence({ store, now = () => Date.now() } = {})
  -> { record, get, list, summary };                                        // :292
```

**判定优先级（mismatch 最高，纯函数无 IO，表驱动 `CLAIM_RULES`，`evidence.js:41`）**

| 优先级 | 条件 | status | 原因码 |
|---|---|---|---|
| 1 | 文本点名的 file_id 不在 `knownFileIds`/`files` 里 | `mismatch` | `unknown_file_id:<id>` |
| 2 | 声称已保存/已写入，但没有**成功**的 `room_file_save` | `mismatch` | `claim_save_without_successful_room_file_save` / `claim_save_but_room_file_save_failed` |
| 3 | 声称已读取，且 `room_file_read` 调用过但全失败 | `mismatch` | `claim_read_but_room_file_read_failed` |
| 4 | 至少一条工具成功（`ok === true`，`ok:1` 也认） | `observed` | `tool_ok:<name>` |
| 5 | 没有工具调用 / 工具全失败 | `prepared` | `no_tool_calls` / `no_successful_tool_call` + `tool_failed:<name>` |

- **file_id 两种写法**（契约 `CONTRACT.md:218`）：`file_id:` / `file_id：` + 可选反引号 + 6+ 位 hex
  （`evidence.js:30`，允许 `FILE_ID ：` 这种大小写与全角冒号/空白）；以及反引号包裹的 6+ 位 hex
  （`:31`）。统一小写归一后再比对，按出现位置排序去重。
- **工具结果形态**：`[{ name, ok, summary }]`；只有显式 `true`（或 `1`）算成功，`ok:"true"`、缺 `ok`、
  非对象条目都按失败/忽略处理（`evidence.js:88-99`）；`summary` 压成单行并截到 160 字符。
- **claims** 是三类声明的并集：`file_id`（带 `{file_id, known, form}`）、`saved`/`read`（带
  `{tools, ok, failed}` 计数）、`tool`（每个工具事件一条，最多 20 条，防止 `claims_json` 无界）。
- **不调 LLM、不发事件、不读网络**；`now` 可注入，测试用固定时钟。
- **已知限制（有意为之）**：声称识别是正则表驱动、不做语义解析——引用别人的话（"如果看到'已保存'…"）
  可能被当成自己的声称；除 save/read 外的成功声称没有专门规则，只按"工具全失败 -> prepared"处理。
  提高判定力需要逐条加规则，而不是引入 LLM 判定（那会把"证据"变成又一个声明）。

**存储（`evidence.js:234-257`）**

```sql
CREATE TABLE IF NOT EXISTS ev_records(
  room_id TEXT NOT NULL, message_seq INTEGER NOT NULL, bot_id TEXT,
  status TEXT NOT NULL, claims_json TEXT NOT NULL DEFAULT '[]', ts TEXT NOT NULL,
  PRIMARY KEY(room_id, message_seq)
);
CREATE INDEX IF NOT EXISTS idx_ev_records_room_status ON ev_records(room_id, status);
```

- `record` 幂等：`(room_id, message_seq)` 唯一，冲突时覆盖为最新判定（`ON CONFLICT ... DO UPDATE`），
  重复记录不会长行；`claims_json` 存 `{ claims, reasons }`，`get`/`list` 原样回放。
- `record` 省略（或传 null）`knownFileIds` 时，自动取 `store.listRoomFiles(roomId)` 的 file_id 兜底（`evidence.js:310-318`），
  避免"刚保存的文件"被判成 mismatch；显式传空数组则完全按调用方口径判。
- `list` 返回最近 N 条、按 `message_seq` 升序（与 `store.listRoomMessages` 口径一致）；`summary` 返回
  `{ observed, prepared, mismatch, total }`，空房间全 0（不伪造百分比）。
- 校验失败抛 `Error`（roomId 空、messageSeq 非非负整数、store 缺 `db/prepare`），不静默吞。

## 4. 与 Hermes / omh 的差异与取舍

| 项 | 决定 | 理由 |
|---|---|---|
| 声明 vs 观察分家 | **采纳** | 这是 omh 的全部价值（`HARNESS_QUALITY.md:757-761`、`ROLES.md:13`） |
| claims 有类型 + 证据引用 | **采纳/改写** | 只保留 file_id / saved / read / tool 四类，字符串原因码而非通用 JSON 契约 |
| 完整 prepared coverage 阶梯（delegation_prepared→dispatch_observed→…） | **不采纳** | 我们没有 dispatch 阶段，可观测副作用只有 pi 工具调用一种；引入阶梯只会多出一排永远打不了勾的格子（`OMH_AND_CONTEXT.md:37`） |
| revision/environment 绑定与 `stale` 判定 | **不采纳** | 群聊回合是一次性讨论，不绑定"变更集"；重开库仍可回放同一条判定（`HARNESS_QUALITY.md:788-794` 的语义不适用） |
| `store_state` / `sources` 四态 | **改写** | 我们用"查不到记录（`get` 返回 null）" vs "记录说 prepared" 区分，等价于 absent vs declared_no_findings，但不做读侧 projection |
| checkpoint + 多调用写入 | **不采纳** | 一个回合一条 `ev_records`，不要求 set/checkpoint 三步 |
| "空分母不是 0%" | **采纳计数口径** | `summary` 只报计数；UI 必须把 `total:0` 显示成"暂无判定"而不是"0% 已观测"（`OMH_AND_CONTEXT.md:150`） |
| 有界摘要、存原文 | **采纳** | claim 文本 ≤160 字符、每回合 ≤20 条工具声明，不存 transcript |

## 5. 验证证据

```text
$ cd D:\能力测试\fusion; node --test tests/evidence.test.mjs
ℹ tests 23
ℹ pass 23
ℹ fail 0
```

```text
$ cd D:\能力测试\fusion; node --test
ℹ tests 197
ℹ pass 197
ℹ fail 0
```

（197 = 本轮并行开发的其它模块用例 + 本文件 23 例；交付时基线 150 全绿，本次未引入红。数字会随并行模块增加。）

覆盖：三态判定（prepared 只有文本 / observed 成功 read+已知 file_id / mismatch 未知 file_id 与无成功 save）、
工具全失败、多 file_id 一真一假、大小写/全角冒号/空白、反引号写法、中英文否定语境、`files` 与
`knownFileIds` 等价、读失败仍声称已读、工具结果形态容错、纯函数冻结入参无副作用、record 幂等、
list 取最近 N 条、summary 三态与空房间、跨重开持久化、knownFileIds 省略时群文件兜底、
入参校验、跨房间隔离与全局 summary。

约束核对：零新依赖（只用 `node:sqlite` 经 store）、零 C 盘写入（`tests/_helpers/env.mjs` 重定向）、
ESM、只新建 `src/rooms/evidence.js` / `tests/evidence.test.mjs` / 本文件，未改共享文件。

## 6. Lead 接入清单

**已接线（本轮并行集成，2026-11-06 15:00 前后已在当前树验证）**

1. `src/engine/bot.js`：`tool_execution_end` 累计 `toolResults.push({ name, ok: !event.isError, summary })`
   （`bot.js:477-489`，`summary` 来自 `summariseResult(event.result)`）；`_runTurn` 返回值带
   `toolResults`（`bot.js:554`）。
2. `src/rooms/room.js`：`evidenceStore` 懒加载（`room.js:136-147`）；成员发言 `appendRoomMessage`
   拿到 seq（`:759-770`）后 `record({ roomId, botId, messageSeq, text, toolCalls: result.toolResults })`
   （`:771-786`；未传 `knownFileIds` → 走本模块的群文件兜底，数据源是 `store.listRoomFiles`（`store.js:412`））；`turn_completed` 附带 `seq` 与
   `evidence`（`:789`）。
3. `src/api/server.js`：路由 `ROUTES.roomEvidence`（`:2327`）+ `GET /api/rooms/{id}/evidence`
   （E29，`:2753-2771`，返回 `{ room_id, summary, records }`）。

**仍待 Lead 做**

4. **E21 消息合并证据**：`GET /api/rooms/{id}/messages`（`server.js:2743-2751`）目前不带
   `evidence_status`。两条路：(a) 前端一次拉 E29，用 record 上的 `message_seq` 映射；
   (b) 在 `listRoomMessages`（`server.js:1103`）读时 LEFT JOIN `ev_records`，无记录给 `null`
   （"没判定" ≠ "仅声明"）。
5. **UI 徽标**：`web/` 目前没有任何 evidence 引用。在 `web/js/views/group.js` 消息渲染处按
   `evidence_status` 渲染小徽标（`EVIDENCE_LABELS`：observed 绿 / prepared 灰 / mismatch 红，`null` 不渲染）；
   tooltip 列 `reasons`（`unknown_file_id` = 引用了不存在的文件；`claim_save_*` = 声称保存但无成功保存；
   `claim_read_*` = 声称读取但读取失败；`tool_failed:*` = 工具失败）；SSE `turn_completed` 已带
   `evidence` 字段（`room.js:789`），在 `web/js/store.js` 的事件合并处更新即可。
6. **房间删除清理**：`store.deleteRoom`（`store.js:278-286`）不删 `ev_records`——E29 因 `roomExists`
   会先 404 不暴露，但全局 `summary()` 会计入孤儿行。建议在 `manager.js:249` 的删除路径补
   `DELETE FROM ev_records WHERE room_id = ?`（表名见 §3），或让我加 `remove({ roomId })`（契约未要求，未擅自加）。

**需要 Lead 决策的点**

- **`file_id=` 写法**：`room_file_save` 回显是 `file_id=…`（`rooms/tools.js:243`），不在契约 §7.2
  的两种写法内。要不要加第三种（`[：:=]`）？加上能覆盖"复述工具回显"，但超出契约字面。
- **`claims_json` 结构**：存 `{claims, reasons}`（可回放原因码），不是裸数组；E29 已按此返回，
  前端按 `record.claims` / `record.reasons` 消费。
- **失败回合是否留痕**：目前没有 `message_seq` 就不记录（失败回合不落 `room_messages`）；
  若要"失败也留一条"，需在 `room.js:739-746` 先落 `kind:"error"` 消息再 record。
- **`knownFileIds` 兜底已被采纳**：`room.js:775-781` 不传该参数，等价于"以本群文件空间为准"；
  如需严格口径（显式传列表）请明确。

---

## 7. Lead 集成补充（2026-11-06 第四轮）

1. **工具化查询**：新增轮内工具 `room_evidence_status`（`src/rooms/tools.js#evidenceTools`，只读），
   返回 `observed/prepared/mismatch` 汇总 + 最近 N 条逐条判定（含 `reasons`）。挂进
   `TOOLSETS.evidence`，并并入 `review` 合集与成员默认面；审查员提示词增加硬约束：
   **对方声称完成但没有 observed 证据时，只能判「需修改」**（`src/engine/archetypes.js:140`）。
2. **消息级可见**：E21 `GET /api/rooms/{id}/messages` 每条消息附带 `evidence`（`null` 表示"没判定"，
   区别于 `prepared`）；`turn_completed` 事件带 `seq` 与 `evidence`，前端可即时渲染徽标。
3. **兼容 `file_id=`**：`room_file_save` 的回显格式是 `file_id=xxxx`（`rooms/tools.js:243`），
   `FILE_ID_FIELD_RE` 已扩展为 `[：:=]` 三种分隔符（新增用例覆盖）。
4. **级联清理**：`store.deleteRoom` 现在同时删除 `ev_records`（证据随房间消失，避免 `summary()` 出现孤儿）。
5. **UI**：见 `docs/hermes/EVIDENCE_UI.md`（消息徽标 + 群内证据汇总）。
