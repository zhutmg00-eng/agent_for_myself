# AgentFusion 融合架构规格（单一事实来源）

> 目标：不再从零写 harness。以 **pi（@earendil-works/pi-coding-agent 1.3.0）** 为成熟内核（工具循环、会话/分支、上下文压缩、技能、扩展、权限钩子），在其上叠加 **我们的群聊构想**（群主赋权/分派/上下文策略、群文件空间+实时路径同步、成员标识、小群讨论），复用已验证的 Web 前端与 Electron 桌面壳，交付可直接双击运行的软件。

## 0. 铁律

1. **零 C 盘写入**：所有运行期写入（数据、缓存、临时、日志、Electron userData）必须落在 `D:\AgentFusion` 或工作区 D 盘目录。任何模块发现目标路径以 `C:` 开头必须抛错。
2. 仅依赖 `@earendil-works/pi-coding-agent`（用 **bundle 入口**，见 §2），其余全部用 Node 内置模块（`node:sqlite`、`node:http`、`node:crypto`、`node:fs`…）。不新增 npm 依赖。
3. 源码为 **ESM JavaScript**（无 TS 构建步骤）。Node ≥ 22.19（开发 24.x，Electron 45 内置 24.22）。
4. 前端复用 `D:\能力测试\agentharness\frontend\web`（已验证），仅做**最小适配**；API/SSE 契约必须对齐 `docs/CONTRACT_API.md` 与 `docs/CONTRACT_ROOM.md`。
5. 不伪造：所有功能必须真实可跑（真 pi 会话 + 真 LLM 调用 + 真落库/落盘）。

## 1. 目录结构

```
fusion/
├── package.json              # type: module, main: desktop/main.cjs
├── .pi-agent/                # pi agentDir（D 盘）：models.json / settings.json / skills/
├── src/
│   ├── config.js             # 路径/端口/环境/C 盘守卫
│   ├── log.js                # 日志（.data/logs/app.log）
│   ├── events.js             # EventBus（落库 + SSE 扇出）
│   ├── store.js              # node:sqlite 持久化
│   ├── skills.js             # 技能发现（.pi-agent/skills + 数据目录 skills）
│   ├── hooks.js              # hooks.json → pi tool_call 拦截扩展
│   ├── engine/
│   │   ├── pi.js             # bundle 入口解析 + env 引导（必须在 import pi 前调用）
│   │   ├── runtime.js        # ModelRuntime + 网关模型目录 → .pi-agent/models.json
│   │   ├── archetypes.js     # 8 个 archetype（人设/工具/emoji/色/badge）
│   │   ├── bot.js            # BotRunner：每 (room,bot) 一个 pi AgentSession
│   │   └── chief.js          # 单聊总控 session（router.* 事件）
│   ├── rooms/
│   │   ├── files.js          # 群文件空间（file_id / move / 通知）
│   │   ├── tools.js          # 群管理 + 群文件 + skill 的 pi 自定义工具
│   │   ├── room.js           # Room 编排（回合/上下文策略/分派/权限/小群）
│   │   └── manager.js        # RoomManager（建群/恢复/查询）
│   ├── api/
│   │   └── server.js         # HTTP + SSE + 静态（契约见 CONTRACT_API.md）
│   └── main.js               # CLI 入口：node src/main.js
├── web/                      # 前端（复用+适配）
├── desktop/                  # Electron 壳：main.cjs / preload.cjs / splash.html
├── scripts/                  # 打包/冒烟/开发脚本
├── tests/                    # node:test 测试
├── docs/
└── dist/                     # 交付产物（AgentFusion-win64/）
```

数据根：`FUSION_DATA_ROOT`，默认 `D:\AgentFusion`：

```
D:\AgentFusion\
├── data\fusion.db            # SQLite
├── workspace\                # 工具工作区
│   ├── chief\<session>\
│   └── rooms\<roomId>\<botId>\
├── rooms\<roomId>\files\     # 群文件物理目录
├── agents\<botId>\           # 每 bot 的 pi agentDir（SYSTEM.md/models.json 生成的副本）
├── sessions\                 # pi session jsonl（PI_CODING_AGENT_SESSION_DIR）
├── logs\
├── cache\  temp\
└── .fusion\                  # settings.json / hooks.json / avatars/ / skills/
```

## 2. pi 内核接入

- **入口解析**：`src/engine/pi.js` 导出 `loadPi()`，动态 `import(pathToFileURL(entry))`，入口优先级：
  1. `process.env.FUSION_PI_ENTRY`
  2. `<repo>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js`（若存在）
  3. `<repo>/node_modules/@earendil-works/pi-coding-agent/dist/index.js`
  4. 同上，但根为 `D:/tools/pi`
- **必须**在 `loadPi()` 之前设置（`src/config.js#bootstrapEnv()`）：
  `PI_CODING_AGENT_DIR=<data>/agents/_shared`、`PI_CODING_AGENT_SESSION_DIR=<data>/sessions`、`PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`，并 `TEMP/TMP=<data>/temp`。
  （若进程已 import 过 pi 则 env 不生效——所以 `bootstrapEnv()` 必须是任何 import 之前的第一步。）
- 会话创建（`engine/bot.js`）：
  ```js
  const loader = new DefaultResourceLoader({
    cwd: botWorkspace,
    agentDir: sharedAgentDir,
    settingsManager: SettingsManager.create(botWorkspace, sharedAgentDir),
    noExtensions: true,
    noContextFiles: true,
    additionalSkillPaths: [skillsDir],
    systemPromptOverride: (base) => personaBlock + "\n\n" + (base || ""),
    appendSystemPrompt: [roomProtocolBlock],
    extensionFactories: [hooksExtension, toolEventExtension],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: botWorkspace, agentDir: sharedAgentDir, modelRuntime, model,
    sessionManager: SessionManager.create(botWorkspace, sessionsDir),
    resourceLoader: loader, tools: activeToolNames, customTools: roomTools,
    thinkingLevel: "off",
  });
  ```
- 权限热更新：`session.setActiveToolsByName(names)`（已确认存在）。
- 流式：`session.subscribe(evt => ...)`；文本 `evt.type==="message_update" && evt.assistantMessageEvent.type==="text_delta"`；工具 `evt.type` 属于 `tool_execution_start|update|end`。实现前请再核对 `dist/core/agent-session.d.ts`。
- 模型目录：启动时 GET 网关 `/v1/models`，生成 `.pi-agent/models.json`（provider `magpie`）：`zcode/*` 用 `api:"anthropic-messages", baseUrl:"http://127.0.0.1:3425"`，其余 `api:"openai-completions", baseUrl:"http://127.0.0.1:3425/v1"`；`compat: {sendSessionAffinityHeaders:true}`。网关不可用时回退到 `.pi-agent/models.json` 现有文件。默认模型 `auto/deepseek-v4.1-flash`。

## 3. 模块接口（实现必须与签名一致）

### `src/config.js`
```js
export const ROOT, DATA_ROOT, DIRS /* {data,workspace,rooms,agents,sessions,logs,cache,temp,fusion} */;
export const PORT_DEFAULT = 8720, GATEWAY_URL;
export function bootstrapEnv();     // 任何 pi import 之前调用
export function ensureDirs();
export function assertNotC(p);      // C: 路径抛 Error
export function dataPath(...parts);
```

### `src/log.js`
```js
export function createLogger(scope) // {info,warn,error,debug}
export function readTail(n)         // 最近 n 行，供 /api/context 或诊断
```

### `src/events.js`
```js
export class EventBus {
  constructor(store)
  subscribe(fn) -> unsubscribe        // fn({seq,ts,topic,sender,payload,thread_id})
  async publish({topic, sender, payload, thread_id}) // 落库 + 扇出，返回事件
  list({thread_id, after_seq, limit}) // → [{seq,ts,topic,sender,payload,thread_id}]
}
```

### `src/store.js`
```js
export class Store {
  constructor(dbPath)   // 建表 + 迁移
  close()
  // bots（JSON 仓储）
  listBots(), getBot(id), upsertBot(bot), deleteBot(id)
  // rooms
  listRooms(), getRoom(roomId), upsertRoom(room), setRoomStatus(roomId,status), deleteRoom(roomId)
  listRoomMembers(roomId), setRoomMembers(roomId, [{bot_id, permissions}]), setMemberPermissions(roomId,botId,permissions)
  appendRoomMessage(roomId, {speaker, content, kind}), listRoomMessages(roomId, limit=500)
  // files
  upsertRoomFile(roomId, file), getRoomFile(roomId, fileId), listRoomFiles(roomId), deleteRoomFile(roomId,fileId)
  addNotice({parent_room_id, child_room_id, kind, text}), drainNotices(roomId)  // 返回并标记 drained
  // kv
  getKV(key, fallback), setKV(key, value)
  // events
  appendEvent(e), listEvents({thread_id, after_seq, limit}), lastEventSeq()
  // usage
  addUsage({bot_id, room_id, model, input_tokens, output_tokens, ms}), usageSummary()
  // 工单
  createTicket(t), updateTicket(id, patch), listTickets(limit)
}
```

### `src/engine/runtime.js`
```js
export async function createEngine({store}) -> {
  pi, modelRuntime, models,            // models: 网关目录归一化数组
  getModel(id), defaultModel,
  gatewayStatus,                       // {ok, url, models: n, error?}
}
```

### `src/engine/archetypes.js`
```js
export const ARCHETYPES // { [id]: {id,name,emoji,color,badge,tagline,description,tools:[],readOnly,systemPrompt} }
export const DEFAULT_BOT_IDS = ["boss","coder","reviewer","librarian","explore","writer","analyst","planner"]
export function archetypeOf(id) // 未知 id 回退 general
export function buildBot(id)     // → bot 记录 {id,name,emoji,color,badge,tagline,archetype,tools,read_only,model}
```

### `src/engine/bot.js`
```js
export class BotRunner {
  constructor({bot, engine, store, events, hooks, skills, roomContext}) // roomContext: {roomId?}
  async run({prompt, signal, onToolEvent}) // → {text, usage, ms, toolsUsed}
  setActiveTools(names)
  dispose()
}
```
要求：懒创建 session；run 内订阅事件并转成 `worker.<botId>.turn_started|tool_invoked|tool_result|turn_completed` 与 `room.<roomId>.member_*`（后者由 Room 发，不在这里）；异常必须捕获并返回 `{text:"",error}`，不得让房间回合崩掉。

### `src/rooms/room.js`
```js
export class Room {
  constructor({record, store, events, engine, bots, hooks, skills})
  snapshot()                                  // API 房间对象
  async say({speaker, content})               // 落库 + turn_completed + 触发 runRound（不等待）
  async runRound({trigger})                   // 编排（见 §5）
  buildInstruction(botId, {task, userText})   // 上下文策略拼装
  async assignTask(botId, task)               // 落 pending assignment + 事件
  async grantPermission(botId, patch), async revokePermission(botId, key)
  async setContextPolicy(policy), async setTopic(topic)
  async createSubgroup({members, topic})
}
export class RoomManager {  // src/rooms/manager.js
  constructor({store, events, engine, hooks, skills})
  async restore()                              // 从库恢复房间
  async create({title, owner_id, members, context_policy, topic, include_librarian}) -> roomId
  get(roomId), list(), snapshotAll()
}
```

### `src/rooms/tools.js`
```js
export function createRoomTools({room, botId, permissions, fileSpace, skills}) -> ToolDefinition[]
```
工具名（模型可见）：`room_list_members`、`room_assign_task`、`room_grant_permission`、`room_revoke_permission`、`room_set_context_policy`、`room_set_topic`、`room_create_subgroup`、`room_file_save`、`room_file_read`、`room_file_list`、`room_file_move`、`skill_list`、`skill_invoke`。
仅当调用者是 owner 才挂载管理类工具；普通成员 `can_create_subgroup=true` 才有 `room_create_subgroup`；文件工具按 archetype/权限挂载。非授权调用返回 `isError:true` 的失败结果。

### `src/api/server.js`
```js
export async function startServer({port, host="127.0.0.1"}) -> {url, port, close(), app}
```
路由与响应形状严格对齐 `docs/CONTRACT_API.md`。

## 4. 数据模型（SQLite，`node:sqlite`）

```sql
CREATE TABLE IF NOT EXISTS rooms(
  room_id TEXT PRIMARY KEY, title TEXT, owner_id TEXT, parent_room_id TEXT,
  topic TEXT DEFAULT '', context_policy TEXT DEFAULT 'shared', status TEXT DEFAULT 'active',
  created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS room_members(
  room_id TEXT, bot_id TEXT, permissions_json TEXT, PRIMARY KEY(room_id,bot_id));
CREATE TABLE IF NOT EXISTS room_messages(
  room_id TEXT, seq INTEGER, speaker TEXT, content TEXT, kind TEXT DEFAULT 'message', ts TEXT,
  PRIMARY KEY(room_id,seq));
CREATE TABLE IF NOT EXISTS room_files(
  room_id TEXT, file_id TEXT, path TEXT, description TEXT, tags_json TEXT, updated_at TEXT,
  PRIMARY KEY(room_id,file_id));
CREATE TABLE IF NOT EXISTS pending_notices(
  id INTEGER PRIMARY KEY AUTOINCREMENT, parent_room_id TEXT, child_room_id TEXT,
  kind TEXT, text TEXT, created_at TEXT, drained_at TEXT);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, topic TEXT, sender TEXT, payload TEXT, thread_id TEXT);
CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, room_id TEXT,
  model TEXT, input_tokens INTEGER, output_tokens INTEGER, ms INTEGER, ts TEXT);
CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, seq);
```
权限对象：`{can_speak:boolean, context_access:"full"|"summary"|"none", can_create_subgroup:boolean, allowed_tool_overrides:null|string[]}`。

## 5. 回合编排（Room.runRound）——对齐 CONTRACT_ROOM.md

1. `round_started` → 判熔断（`max_speakers=8`），熔断则 `circuit_breaker_tripped` 并结束。
2. 发言队列：owner 优先（若 `can_speak`）→ owner 回合中产生的 `room_assign_task` 按顺序入队（owner 分派后**只跑被分派成员**）→ 无分派时：@提及成员 → 其余成员（按成员顺序，上限 8）。
3. 每个成员：`member_started` → `buildInstruction` → `BotRunner.run` → 落库 `room_messages` → `turn_completed{speaker,content,timestamp}` → `member_finished`。异常记 notice 并继续。
4. 结束：`round_completed {round_id, speakers, ms}`；清空本轮 assignments。
5. 上下文策略：
   - `shared`：全员看到近窗转录（尾部优先，预算 12000 字符，标题/文件索引/待办/系统通知/本轮要求分块）。
   - `summary`：头部摘要（更早消息压缩成“时间+发言人+首 80 字”列表，预算 4000）+ 尾部 6000。
   - `isolated`：仅本轮要求 + 分派任务 + 系统通知。
   - 成员 `context_access` 覆盖房间策略：`full`→shared，`summary`→summary，`none`→isolated。
6. 系统通知：每轮开始 `drainNotices(roomId)`，拼进所有成员指令（文件移动等）。
7. 群文件索引：拼进指令 `file_id → 文件名`，强调“用 file_id 取文件，不要硬编码路径”。

## 6. 群文件空间（files.js）

- 根：`<DATA>/rooms/<roomId>/files/`；`path` 存**相对根**的 posix 路径。
- `file_id` = `crypto.randomBytes(4).toString("hex")`。
- `save`：校验路径不出根；写盘；upsert；`file_saved {file_id,path,description}`。
- `move`：改盘上路径；更新行；`file_moved {file_id, old_path, new_path, name}`；`addNotice` 全房间；保证成员按 file_id 取值不受影响。
- `read`：按 file_id 返回 `{file_id,path,name,description,tags,content}`，>200KB 截断并标注。

## 7. 事件契约（必须完全一致）

房间：`room.<roomId>.round_started|round_completed|member_started|member_finished|turn_completed|task_assigned|file_saved|file_moved|permission_changed|context_policy_changed|subgroup_report|updated|circuit_breaker_tripped|circuit_breaker_reset`
Bot：`worker.<botId>.turn_started|turn_completed|tool_invoked|tool_result`
总控：`router.goal_received|synthesis_delta|synthesis_completed`，`harness.task.completed|failed`
（前端 `web/js/store.js` 已按这些 topic 归约，字段见该文件。）

## 8. 前端适配（web/）

- 由 `agentharness/frontend/web` 复制到 `fusion/web`，保持文件结构（index.html / app.css / js/*）。
- 必改：`js/api.js` 的 health 判定、品牌名/标题（AgentFusion）、设置页引擎信息（“内核：pi 1.3.0”）、模型下拉数据源 `/api/models`。
- 若后端缺少某些可选端点（如 threads/avatars 灰度），前端需 `Promise.allSettled` 容错（现有代码已如此）。
- 静态资源由 Node 服务器托管：`/` → index.html，`/static/*` → web 目录。

## 9. 桌面壳与交付（desktop/ + scripts/）

- `desktop/main.cjs`（CommonJS）：设置 `FUSION_DATA_ROOT` 默认 `D:\AgentFusion`；选空闲端口（8720 起）；**进程内** `import()` ESM `src/api/server.js` 启动服务（Electron 45 = Node 24.22，满足 pi 要求）；窗口加载 `http://127.0.0.1:<port>`；splash → 应用；关闭时 `app.quit()` + 清理；外部链接拦截。
- 打包脚本 `scripts/build_portable.mjs`：手工组装 portable 目录（不依赖 electron-builder）：
  1. 复制 `node_modules/electron/dist/*` → `dist/AgentFusion-win64/`
  2. `electron.exe` → `AgentFusion.exe`
  3. 生成 `resources/app/`：`package.json`、`desktop/*`、`src/**`、`web/**`、`node_modules/@earendil-works/pi-coding-agent/{package.json,dist,CHANGELOG.md}`（**bundle 入口**必需）
  4. 校验：`AgentFusion.exe` 启动、`/api/health` 200、无 C 盘新文件。
- 冒烟脚本 `scripts/smoke_desktop.mjs`：启动进程 → 轮询 health → 截图（可选）→ 关闭。

## 10. 验收

1. `node src/main.js` 起服务；`GET /api/health` 200；`/` 返回前端。
2. 建群（Boss+coder+librarian+reviewer）→ 发真实任务 → Boss 分派 → coder 出稿（真工具调用）→ librarian 落盘 file_id → reviewer 按 file_id 核验 → Boss 汇总。全程 SSE 事件与 DB 回放一致。
3. 文件 move 后其它成员下一轮指令中出现通知。
4. 小群：创建子群跑一轮 → 父群收到 `subgroup_report`。
5. 重启服务后房间/消息/文件恢复。
6. `dist/AgentFusion-win64/AgentFusion.exe` 双击可用（离屏启动验证），关闭无残留进程。
7. C 盘：`before/after` 快照对比 `%TEMP%`、`%LOCALAPPDATA%`、`%APPDATA%` 无新增 Fusion 文件。
8. `tests/` 下 node:test 单测全绿（store、files、room 编排、API 冒烟）。
