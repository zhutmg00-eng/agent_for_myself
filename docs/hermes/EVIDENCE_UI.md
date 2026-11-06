# 证据徽标（observed / prepared / mismatch）前端吸收说明

> 目标工程：`D:\能力测试\fusion`（纯静态 ESM，无构建、无框架、无 CDN）。
> 后端判定与存储见 `src/rooms/evidence.js` + `docs/hermes/EVIDENCE.md`；本文只覆盖**消息界面上的呈现**。
> 契约：`docs/hermes/CONTRACT.md` §8.2。

## 1. 缺口：消息看不出"做过"还是"说过"

后端已经有证据阶梯（E29）：每个成员回合落一条 `ev_records`，判定
`observed`（至少一次工具成功）/ `prepared`（没有成功的工具调用）/ `mismatch`（声明与工具记录冲突）。
但群聊消息长得完全一样 ——「已保存到群文件：file_id: 9f3c2a1b」和真的 `room_file_save` 成功，
在界面上同形。结果是：**群主宣称交付，用户无法在不看日志的前提下分辨真假**。

本轮把这个判定搬到消息元信息上：三态徽标 + hover 口径 + 群头/检查器汇总。

## 2. 交互与渲染

```
群聊（进入房间）
 ├─ 群聊头 view-sub          "4 位成员 · 群主 老板 · 共享全文  [1 已观测] [1 仅声明] [1 证据不符]"
 │     └─ hover：本群证据汇总（E29）：1 条已观测 · 1 条仅声明 · 1 条证据不符
 ├─ 成员消息 msg-head        名字 · 角色 · [证据徽标] · 时间 · 复制
 │     ├─ observed  绿底绿字「已观测」  hover：至少一次工具调用成功（ok:true），有执行结果佐证
 │     ├─ prepared  灰底灰字「仅声明」  hover：没有成功的工具调用，只是成员的说法
 │     ├─ mismatch  红底红字「证据不符」 hover：声明与记录冲突；mismatch 还会带本回合原因码
 │     └─ null / 未知 → 不渲染徽标（"没判定" ≠ "仅声明"）
 └─ 群信息检查器（右侧）
       └─ 证据阶梯 · N 条判定
            ├─ 已观测 / 仅声明 / 证据不符 三行计数
            ├─ 最近的不符判定（最多 3 条：成员 · #消息序号 · 中文原因）
            └─ 判定口径说明
       全 0 / 端点不可用 / 还没拉到 → 整段不渲染，也不报错
```

三态颜色复用现有色板：`--green` / `--tag-bg` + `--tag-text` / `--red`（深浅主题自动跟随）。

## 3. 数据来源与端点映射（全部复用现有端点，未改后端）

| 用途 | 端点 | 字段 | 前端落点 |
|---|---|---|---|
| 历史消息三态 | `GET /api/rooms/{id}/messages`（E21） | `messages[].evidence`：`observed\|prepared\|mismatch\|null` | `store.js:402` 历史 normalize |
| 实时三态 | SSE `room.<id>.turn_completed` | payload `seq` + `evidence` | `store.js:681` 新消息带上；`:689` 触发汇总刷新 |
| 事件回放三态 | `GET /api/thread/room:{id}/events` | 同一 payload（`room.js:791` 发出时已带） | `store.js:334` `mapRoomEvents` |
| 群汇总 + 明细 | `GET /api/rooms/{id}/evidence`（E29） | `summary{observed,prepared,mismatch,total}`、`records[]` | `api.js:285` `fetchRoomEvidence` → `store.js:260` `refreshEvidence` |

刷新时机（没有轮询）：
- 进房：`loadRoom()` 末尾 `refreshEvidence(roomId, {force:true})`（`store.js:403` 附近）；
- 视图挂载：`GroupView.mount` 再补一次（有 15s TTL 缓存，`group.js:149`）；
- 检查器首次渲染：`bindGroupInspector` 补一次（`group.js:692`）；
- SSE 成员回合：`scheduleEvidenceRefresh` 350ms 防抖后强刷（`store.js:294`）；
- 失败静默：保留上一次汇总，只记 `state.evidence[room].error`，绝不 toast（`store.js:260-289`）。

## 4. 截图

`D:\能力测试\temp\evidence-ui.png`（1440×900，隔离实例 `127.0.0.1:8785`）：
左侧群列表含对照组「无判定演示群」；中间三条成员消息分别带红/绿/灰徽标；右侧检查器显示
「证据阶梯 · 3 条判定」与「最近的不符判定」（工程师 #1 · 声明了不存在的 file_id 9f3c2a1b）。

![证据徽标](../../../temp/evidence-ui.png)

## 5. 验证证据（2026-11-06，Playwright MCP 实测）

隔离实例（先造库再起服 —— `rooms` 是启动时 `manager.restore()` 从 SQLite 恢复的）：

```powershell
node D:\能力测试\temp\seed-evidence.mjs          # 1 个房间 + 3 条消息 + 3 条 ev_records + 1 个对照组房间
cd D:\能力测试\fusion
$env:FUSION_DATA_ROOT='D:\能力测试\temp\evidence-ui'
node src/main.js --port 8785
```

| 检查点 | 实测结果 |
|---|---|
| 三态徽标 | 3 条消息 3 个徽标：`ev-badge is-mismatch`「证据不符」/ `is-observed`「已观测」/ `is-prepared`「仅声明」 |
| 颜色 | mismatch `rgb(217,58,48)` on `rgba(217,58,48,.10)`；observed `rgb(0,168,107)` on `rgba(0,168,107,.11)`；prepared `rgba(28,27,24,.58)` on `rgba(28,27,24,.06)` |
| hover 口径 | title 带完整解释；mismatch 额外带「本回合判定：声明了不存在的 file_id 9f3c2a1b」 |
| 群头汇总 | 三个 chip：`1 已观测` / `1 仅声明` / `1 证据不符`；`.ev-summary` title 为完整汇总 |
| 检查器 | 3 行计数（各 1）+「最近的不符判定」1 条 + 口径说明 |
| null 不渲染 | 对照组「无判定演示群」：1 条消息、**0** 个 `.ev-badge`、**0** 个 `.ev-chip`、无 `.ev-panel`，消息照常显示 |
| 控制台 | 两个房间均 **0 error / 0 warning** |
| 后端回归 | `node --test` **229 pass / 0 fail**（本轮只改 `web/**` + 本文档，未碰 `src/`、`tests/`、`package.json`） |

## 6. 已知限制

1. **没有轮询**：可见性依赖进房/挂载/检查器打开/SSE 四个时机。SSE 断线期间新回合的徽标要等下次进房
   （`/messages` 会带上最新三态），汇总数字同理；断线重连没有单独补拉。
2. **TTL 缓存 15s**：`refreshEvidence` 在 15 秒内复用缓存；刚裁决/刚记录的汇总最多滞后 15 秒
   （SSE 触发的刷新是 `force:true`，不受此限）。
3. **`null` 与 `prepared` 语义不同**：前者是"没判定"（不渲染），后者是"判过、只有声明"，UI 不混用。
4. **汇总口径是 `ev_records` 计数**，不是"当前屏幕上的消息数"：消息被截断/未加载时，汇总可能大于可见徽标数。
5. **event 回放可能没有 evidence**：证据功能上线前写入的 `turn_completed` 事件不带该字段；
   `loadRoom` 优先用 thread events（有空才回退 `/messages`），这类老数据不会显示徽标。
6. **明细只在检查器**：消息 hover 只给一条原因码；完整 `claims`（file_id/工具名/ok 计数）没有展开 UI，
   mismatch 明细也只列最近 3 条。
7. **E29 404 静默**：旧版后端没有该端点时，`fetchRoomEvidence` 抛错被 `refreshEvidence` 吞掉，
   界面退化为"没有汇总"（这是有意的降级，不是 bug）。
8. **用户消息永远没有徽标**：证据只对成员回合记录（`room.js` 只在成员 `turn_completed` 时 `record`）。

## 7. Lead 接入清单

本 UI 不需要 Lead 改后端。可选后续：

1. 若希望徽标在**子群**页面同样生效：子群走同一个 `GroupView`，已自动生效，无需改动。
2. 若要把 `claims` 展开成详情弹窗：数据已在 `state.evidence[roomId].records[].claims`，可以做一个只读弹窗，
   但要注意 `records` 只拉最近 50 条（E29 默认 limit）。
3. 若后续给群聊加"刷新/重连按钮"，顺手调用 `refreshEvidence(roomId, { force: true })` 即可。
