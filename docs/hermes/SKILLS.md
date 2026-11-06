# 技能系统：安装守卫 + 用量遥测 + 策展闭环

> 迁移自 Hermes Agent 的 `tools/skills_guard.py`、`tools/skill_usage.py`、`agent/curator.py`
> （只读参考：`D:\能力测试\reference\hermes\hermes-agent`，commit `ca43606`；下文证据路径都以
> `hermes-agent/` 为根）。契约见 `docs/hermes/CONTRACT.md` §3.3。本文件只讲 `src/skills/*`，
> 需要改共享文件的地方集中在第 6 节。

## 1. Hermes 里是什么

1. **安装闸门是一条三步流水线**：`scan_skill` 产出 `ScanResult`，`should_allow_install` 给安装决策，
   `format_scan_report` 给人看（`tools/skills_guard.py:746`、`:822`、`:838`）。
2. **威胁规则是数据表**：`THREAT_PATTERNS`（`:154`）每条是 `(regex, pattern_id, severity, category,
   description)`，编译一次缓存（`:536`）；单文件扫描在 `scan_file`（`:698`）。
3. **verdict 取最严重发现**：critical → dangerous，high → caution，medium/low 只算信息（`:953`）。
4. **安装策略按"信任等级 × verdict"查表**：`INSTALL_POLICY`（`:30-37`），`force` 只能越过非危险结论，
   危险结论 force 无效（`:822-835`）；信任等级由来源推断（`:942`）。
5. **结构检查独立于文本规则**：文件数/单文件/总大小上限、可疑二进制、意外可执行位、逃逸软链
   （`:592`、`:852-894`）。
6. **隐藏字符单独成档**：零宽与 bidi 控制字符逐个命名并报 `U+XXXX`（`:603-610`）。
7. **遥测是"计数 + 时间戳"侧车**：`use_count/view_count/patch_count/last_activity_at/state/pinned`
   （`tools/skill_usage.py:348`），每次 bump 只改两个字段（`:448`）；`latest_activity_at` 刻意排除
   `created_at`（`:123`），让"从未使用"和"很久没用"可区分。
8. **策展是纯函数 + 状态机**：`apply_automatic_transitions`（`agent/curator.py:209`）按
   `stale_after_days/archive_after_days` 在 active/stale/archived 间打标；首次见到先锚定时钟
   （`:234-238`）；`use_count == 0` 不算过期（`:250-255`）；只 archive 不删除；`should_run_now`
   管运行节奏（`:160`），状态落在 `.curator_state`（`:40-42`）。

## 2. 为什么值得抄

- 我们的 `src/skills.js` 只做发现与渲染（`loadSkills` `:111`、`SkillRegistry` `:219`、`invoke` `:259`），
  **没有任何安装校验**：任何落进 `.fusion/skills` 的 SKILL.md 都会被下一次 reload 当成可信指令
  （`src/skills.js:68` 只要求 name + description）。群里谁都能往这个目录写文件。
- `src/rooms/tools.js:289` 的 `skill_list` / `skill_invoke` 不记录任何使用信息，无法回答
  "这个技能还有人用吗、该不该归档"。
- 群聊最有价值的知识是"这个群怎么把某类活干成"，现在只能人肉往技能目录复制；bot 自己总结的正文
  没有一道闸门就不该落盘。
- 所以需要三件互补的东西：**装前闸门**（guard）、**使用遥测**（telemetry）、
  **从经验到技能的人机闭环**（curator：propose → review → adopt）。

## 3. 我们落地成什么

### 3.1 接口（与 CONTRACT §3.3 一致，括号内是新增的便利方法）

```js
// guard.js
export const SEVERITIES = ["info", "warn", "block"];
export const LIMITS = { description: 200, bodyWarn: 24_000, bodyBlock: 128_000 };
export const RULES = [/* {id, severity, category, why, test(text, lines) -> [{line, excerpt}]} */];
scanSkillText(text, { name }) -> { name, verdict, findings, bytes, scannedAt }
shouldInstall(result, { force }) -> { allow, reason, verdict, forced, requiresConfirm }
formatScanReport(result) -> 中文报告

// telemetry.js
export const EVENTS = ["list", "view", "invoke", "error"];
createSkillTelemetry({ store, now }) -> { record, stats, of, recent, count, prune }

// curator.js
export const STATES = ["active", "stale", "archive"];
export const REVIEW_DECISIONS = ["adopt", "reject", "defer"];
createCurator({ store, telemetry, skillsDir, now }) ->
  { transitions, propose, listProposals, review, adopt, report, getProposal, listStates, pin }
```

### 3.2 表结构（模块自建，前缀 `skill_`，不改 `store.js`）

```sql
skill_usage_events(id PK, skill, event, room_id, bot_id, ok, ms, detail, ts, ts_ms)
  INDEX (skill, ts_ms), (ts_ms)                      -- 事件流水；counts 走窗口，lastUsed 走全生命周期
skill_curator_state(skill PK, state, pinned, last_used, anchor, reason, updated_at)
  INDEX (state)                                      -- 打标结果；anchor = 首次纳入策展的归类时钟
skill_proposals(id PK, title, body, evidence, room_id, bot_id, tags, status, reason,
                reviewed_by, skill, guard_verdict, created_at, updated_at, reviewed_at, adopted_at)
  INDEX (status, created_at DESC)                    -- 经验提案 → 人拍板 → 落盘留痕
```

`state` 只有 active/stale/archive 三态，archive 只是打标；`status` 是提案状态机
proposed → approved → adopted / rejected / deferred。

### 3.3 21 条规则（`RULES` 是数据，可被测试与 UI 逐条引用）

| id | 严重度 | 拦什么 |
|---|---|---|
| frontmatter-missing | block | 没有 `---` 包裹的 frontmatter |
| frontmatter-required | block | 缺 `name` / `description`（loader 会静默跳过） |
| frontmatter-name-slug | warn | name 不是 ASCII slug |
| description-too-long | warn | description > 200 字符 |
| missing-body | warn | 正文不足 20 字符 |
| body-too-large | warn | 全文 > 24k 字符（该整合了） |
| skill-too-large | block | 全文 > 128k 字符 |
| rm-rf-root | block | `rm -rf /`、`~`、整盘；PowerShell `Remove-Item -Recurse -Force C:\` |
| curl-pipe-shell | block | `curl/wget … \| sh\|bash\|pwsh`、`sh -c "$(curl …)"`、`iwr \| iex` |
| base64-decode-exec | block | `base64 -d \| sh`、解码后写 `.sh` 再执行、`FromBase64String` + `iex` |
| encoded-payload | warn | ≥200 字符的 base64 长串 |
| chmod-777 | warn | `chmod 777` / `a+rwx` |
| credential-exfiltration | block | 读 `.ssh/id_*`、`.env`、`.aws/credentials`、`.netrc` 且同行有网络/管道动词 |
| hardcoded-secret | warn | `sk-`/`ghp_`/`AKIA`/`xox*`/`AIza` 与 `key: "…"` 形态 |
| prompt-injection | block | "ignore previous instructions"、中文"忽略之前的指令"、伪造系统提示 |
| approval-bypass | block | "绕过审批/沙箱"、`--dangerously-skip-permissions` |
| hidden-unicode | block | 零宽与 bidi 控制字符（文件头 BOM 豁免） |
| system-path-write | block | 写 C 盘 / `/etc` / `/usr` / Windows / LaunchAgents |
| path-traversal | warn | 三级以上 `../` |
| reverse-shell | block | `/dev/tcp/`、`nc -e`、`bash -i >&` |
| sudo-usage | warn | `sudo`、以管理员身份运行 |

判定：任一 block → `verdict = "block"`；≥1 warn → `"review"`；否则 `"allow"`。单条规则抛错降级成
一条 warn 发现，绝不静默放行；同一规则最多报 5 条。

### 3.4 采纳 / 改写 / 不采纳

- **采纳**：block/warn 分级与"最严重 finding 决定 verdict"；安装决策表 + force 语义；零宽字符清单；
  体积与结构检查；遥测字段（use/view + last_activity）与"首次见到先锚定"、"use=0 不算过期"；
  "只打标不删除"。
- **改写**：400 条正则 → 21 条带中文 `why` 的一等公民规则；JSON 侧车 + 文件锁 → SQLite 表；
  LLM 策展提示词 → `propose → review → adopt` 人机闭环，adopt 前必过 guard。
- **不采纳**：信任等级白名单（我们只有本地库一个来源）；`.skillignore`、内容哈希缓存、docstring/
  代码块掩码（依赖完整包目录扫描）；LLM 策展、consolidation、cron 引用重写、tar.gz 备份
  （需要 hub/cron/LLM 三个面，本轮没有）。

## 4. 与 Hermes 的差异与取舍

- **规模**：Hermes 三个文件 962 + 773 + 1218 行；我们 355 + 267 + 395 行（契约 §0.6 的 ≤400 行/模块）。
- **语言与运行时**：Python + JSON 侧车 + 文件锁 → ESM + `node:sqlite`，同步 API，零新依赖；
  并发安全由 SQLite 事务/唯一键保证，不再需要 `flock`。
- **描述上限**：Hermes 是 60 字符（`skills/AGENTS.md:28`）；中文信息密度低，放宽到 200 字符并降级为 warn。
- **体积口径**：Hermes 按字节（单文件 256KB / 整包 5MB / 50 文件，`:592`）；我们只扫单份文本，
  按字符 24k warn / 128k block。
- **信任模型**：Hermes 有 builtin/trusted/community/agent-created 四级策略（`:30-37`、`:942`）；
  我们对所有来源一视同仁，用 block/review/allow 三态 + force 留痕代替。
- **迁移风险**：`adopt()` 写入的目录名与 frontmatter `name` 必须一致（否则下次 `loadSkills()` 会出现
  "目录名 ≠ 技能名"的重复项），代码里已强制；提案落盘后调用方需要 `app.skills.reload()` 才能看到。

## 5. 验证证据

```powershell
cd D:\能力测试\fusion
node --test tests/skills_guard.test.mjs tests/skills_curator.test.mjs   # 34 pass / 0 fail
node --test                                                            # 全量 117 pass / 0 fail（含其它模块）
```

- guard：20 个用例。覆盖规则集自检（≥10 条、字段齐全）、干净技能 allow、缺 frontmatter/description、
  `curl|bash`、`rm -rf /`（且 `rm -rf ./build` 不误伤）、`base64 -d|sh`、中英文提示注入、零宽字符与
  文件头 BOM 的区分、`.ssh` 私钥外发、`chmod 777`/`sudo` 判 review、C 盘写入、体积两档、
  `shouldInstall` 的 block/force/allow 三态、报告文案、规则抛错降级、单规则发现数上限。
- curator/telemetry：14 个用例。覆盖四类事件记账与 `of()`、非法事件报错、`stats` 窗口计数与 score
  排序（invoke > view、越新越高）、`prune`、跨进程重开仍可读、propose 落库与 evidence/tags 解析、
  review 三态与错误路径、adopt 通过 guard 后写盘（frontmatter 五字段齐全）、**adopt 被 guard 拦截时
  目录为空**、rejected/deferred/重复 adopt 拒绝、transitions 的 stale/archive/revived 与"不删文件"、
  pinned 豁免、report 计数。

## 6. Lead 接入清单

### A. `src/rooms/tools.js` —— 让 `skill_list` / `skill_invoke` 记遥测

1. `skillTools({ skills, botId })` 增加 `telemetry`、`roomId` 两个参数；`createRoomTools` 的 ctx 同步加，
   在 `src/rooms/tools.js:357` 处传入 `telemetry` 与 `room.room_id`。
2. `skill_list` 成功分支（`:301-307`）：对返回列表里的每个技能记一条
   `telemetry.record({ skill: s.name, event: "list", roomId, botId })`。
3. `skill_invoke` 成功分支（`:314-320`）：记 `{ event: "invoke", ms: Date.now() - started, roomId, botId }`。
4. `skill_invoke` 的 `fail(...)` 之前（`:316`）：记 `{ event: "error", ok: false, detail: err.message }`。
5. **遥测绝不能影响工具结果**：`record()` 对非法事件/空技能名会抛错，调用处包一层 try/catch 并
   `log.warn`；`skill_list` 一批 N 条 `list` 事件增长很快，建议在维护任务里调用
   `telemetry.prune({ olderThanDays: 180 })`（或按 `stats()` 的 status 只保留 active/stale 的明细）。
6. `skill_view`（若有"读全文"路径，目前 `get()` 在 `:315`）→ 记 `event: "view"`；`invoke` 已经包含读全文，
   两者都记会重复计分，建议只保留 `invoke`。

### B. `src/api/server.js` —— 需要的端点

1. **装配**（`buildApp` 里 `app.skills` 之后，`:426-444` 附近）：
   `app.skillTelemetry = createSkillTelemetry({ store: app.store })`；
   `app.skillCurator = createCurator({ store: app.store, telemetry: app.skillTelemetry, skillsDir: DIRS.skills })`。
   `skillsDir` 必须是 `src/config.js:28` 的 `DIRS.skills`，否则 `adopt()` 写的目录不在 `SkillRegistry` 的
   扫描面里（`src/skills.js:21-23`）。
2. `GET /api/skills` 已存在（`:21`、`:1253`）：可在 `skillList()` 里按 `skillTelemetry.stats()` 的
   score 排序并附带 `status`；不排序也能工作，先接端点再接排序。
3. `GET /api/skills/usage?sinceDays=30` → `stats()`（每行含 views/lists/invokes/errors/lastUsed/score/status）。
4. `POST /api/skills/scan` body `{ text, name }` → `formatScanReport(scanSkillText(text, { name }))`，
   给"导入前预览"用；`shouldInstall()` 的 `requiresConfirm` 直接回给前端做二次确认。
5. `GET /api/skills/proposals?status=proposed` → `listProposals({ status })`。
6. `POST /api/skills/proposals` body `{ title, body, evidence, roomId, botId, tags }` → `propose(...)`；
   入参校验失败（缺 title/body）返回 400。
7. `POST /api/skills/proposals/:id/review` body `{ decision, reason, by }` → `review(...)`；`ok:false` → 400。
8. `POST /api/skills/proposals/:id/adopt` → `adopt(id, { by })`（仅接受 `approved`）；**`ok:false` 时把 `formatScanReport(result.guard)`
   一起返回**（这正是群主看到的"为什么不能装"），并在成功后调用 `app.skills.reload()`。
9. `GET /api/skills/curator/report` → `report()`；`POST /api/skills/curator/transitions` → `transitions()`。
   建议启动后每 24h 触发一次（幂等，重复调用不会重复打标），不要放进请求路径。
10. `POST /api/skills/:name/pin` body `{ pinned }` → `pin(name, pinned)`；pinned 技能豁免自动归档。

### C. 群聊回合结束后如何触发 `propose()`

1. **触发点**：`src/rooms/room.js` 回合收尾（transcript 落库之后）或 `src/engine/bot.js` 拿到最终回复后；
   不要在工具调用中途触发，否则会把半成品步骤写成技能。
2. **触发条件（确定性，不叫 LLM）**：同一 `roomId + botId` 在最近 N 轮里 ≥2 次 `invoke` 同一技能且
   都 `ok`，或群主在消息里明确说"记住这个做法 / 沉淀成技能"。只满足其一才提案，避免每轮都产垃圾。
3. **内容**：`title` = 任务类短描述（≤200 字符）；`body` = 本回合**实际工具调用序列**归纳出的步骤
   （编号列表 + 每步的验收点）；`evidence` = `["room:<roomId>#seq<n>", "cmd:<关键命令>"]`；
   `roomId` / `botId` / `tags` 照实填。
4. **去重**：先 `listProposals({ status: "proposed" })`，同 `roomId` 同 `title` 且 7 天内已存在就跳过。
5. **不自动 adopt**：提案只在群里留一条通知（"已记录提案 <id>，群主确认后可用 /skills adopt <id> 落盘"）；
   `adopt()` 必须发生在 `review(id, { decision: "adopt" })` 之后，guard 永远在写盘之前跑。
6. **失败兜底**：`propose()` 抛错（缺字段）只记 `log.warn`，不影响回合收尾——提案是"有价值则沉淀"，不是回合成功的必要条件。
