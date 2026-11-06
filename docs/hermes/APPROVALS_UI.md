# 审批 UI（Hermes 吸收 · 第三轮 §7.3 / E26 前端）

> 目标工程：`D:\能力测试\fusion`（纯静态 ESM，无构建、无框架、无 CDN）。
> 后端审批层已由 approval 模块完成（`src/approval.js`，语义见 `docs/hermes/APPROVAL.md`）；
> 本文只覆盖**前端入口**：设置面板「审批」分区 + 待裁决徽标 + SSE 刷新。
>
> 说明：任务书里写的 `web/css/app.css`、`web/js/main.js` 在本仓库实际是
> `web/app.css` 与 `web/js/app.js`（`web/index.html` 引 `/static/app.css`），改的是真实文件。

## 1. 缺口（为什么需要这层 UI）

后端 `smart`/`ask` 模式把工具调用挂起成 `appr_requests` 行并**阻塞等待**裁决
（`src/approval.js:687` 的 `resolve` / `:507` 的 `waitFor`），但原来只有 HTTP 端点，
产品里没有任何入口 —— 用户只能 curl。结果是：审批挂到 TTL 超时（默认 10 分钟）自动 deny，
群聊看起来"卡住"，且裁决来源（谁、什么范围、什么模式）无法留痕给用户看。

本 UI 把四件事搬进设置面板：**看挂起、批量裁决（带 scope）、切模式、看审计**。

## 2. 交付内容

| 文件 | 改动 | 关键位置 |
|---|---|---|
| `web/js/api.js` | 新增 4 个审批端点封装 + 2 个 normalize | `normalizeApproval:104`、`fetchApprovals:218`、`resolveApproval:238`、`setApprovalMode:251`、`fetchApprovalAudit:258` |
| `web/js/store.js` | `state.approvals`、`refreshApprovals()`、`pendingApprovalCount()`、SSE 防抖刷新 | `state.approvals:40`、`refreshApprovals:221`、`scheduleApprovalsRefresh:538`、`applyEvent` 审批分支 `:726` |
| `web/js/views/settings.js` | 新「审批」分区（模式/待裁决/审计/空态）与事件绑定 | NAV `:17`、`approvalsTab:312`、`approvalRowHTML:367`、`auditRowHTML:410`、绑定 `:582` |
| `web/js/app.js` | 设置入口 pending 徽标 | `:40`（缓存元素）、`:118`（渲染） |
| `web/index.html` | 徽标占位节点 | `:82` |
| `web/app.css` | 审批样式（复用现有变量色板） | `:1053` 起 `.foot-badge` / `.appr-*` / `.tag.red` |

## 3. 交互路径

```
顶栏/侧栏
 └─ 设置（Ctrl+, 或点左下角「设置」）         ← 有 pending 时按钮右侧红色徽标「N」
     └─ 左栏「审批」（有待裁决时也带 N 计数）
         ├─ 审批模式： [yolo] [smart] [ask]      ← 当前档位高亮；点击 → PUT → toast → 重拉
         ├─ 请求统计： N 待裁决 · N 已批准 · N 已拒绝 [· N 已过期]
         ├─ 刷新： 手动重拉列表 + 审计（裁决后也会自动重拉）
         ├─ 待裁决 · N
         │    └─ 行：tool / reason / input 预览 / 群聊·成员·相对时间·过期倒计时
         │         [一次] [本会话] [永久]   [批准] [拒绝]
         │           └─ 选 scope 再点批准/拒绝 → POST /api/approvals/{id} → toast → 重拉
         │    └─ 空态： 「当前没有待裁决请求」
         └─ 最近裁决 · N（最多 10 条）
              └─ 行： 批准/拒绝 tag · tool · scope · reason · by · mode · 相对时间
```

## 4. 端点映射（全部复用 E26，未新增后端）

| UI 动作 | 请求 | 响应/用法 |
|---|---|---|
| 打开面板 / 刷新 / SSE 命中 | `GET /api/approvals?limit=50` | `{approvals[], mode, stats}` → 列表 + 当前档位 + 徽标数 |
| （可选过滤） | `GET /api/approvals?room_id=&bot_id=&status=all` | `fetchApprovals({roomId,botId,status})` 已支持，面板默认全局 |
| 切换模式 | `PUT /api/approval/mode` `{mode, by:"user"}` | `{ok:true, mode}`；失败非 200 时 toast |
| 批准 / 拒绝 | `POST /api/approvals/{id}` `{decision, scope, by:"user"}` | `{ok:true, approval}`；已裁决/已过期 → **409** `{ok:false,error:"already_resolved"}` |
| 最近裁决 | `GET /api/approvals/audit?limit=10` | `{audit[]}`：decision/scope/by/mode/ts/reason |

SSE：`worker.<bot>.approval_requested` / `worker.<bot>.approval_resolved`
（发布点在 `src/engine/bot.js:263`、`:278`，topic 前缀 `worker.<botId>.<kind>` `bot.js:366`）。
`applyEvent` 命中后**防抖**（requested 250ms / resolved 120ms）只拉一次列表，数字与行以服务端为准。

## 5. 截图

面板（含 1 条 pending + 审计区，隔离实例 `127.0.0.1:8781`）：

![审批面板](../../../temp/approval-ui.png)

原图：`D:\能力测试\temp\approval-ui.png`（1020×720）。
设置入口徽标（左侧栏底部「设置」右侧红点「1」）：`D:\能力测试\temp\approval-badge.png`（1280×800）。

## 6. 验证证据（2026-11-06，Playwright MCP 实测）

隔离实例：

```powershell
cd D:\能力测试\fusion
$env:FUSION_DATA_ROOT='D:\能力测试\temp\ui-approval'
node src/main.js --port 8781
```

| 步骤 | 结果 |
|---|---|
| 打开 `http://127.0.0.1:8781` → 设置 → 审批 | 面板渲染；空态「当前没有待裁决请求」；无 JS 报错（0 error） |
| 点 `ask` | `PUT /api/approval/mode` **200**，请求体 `{"mode":"ask","by":"user"}`，响应 `{"ok":true,"mode":"ask"}`，高亮随之后移 |
| 直接往 `appr_requests` 插 pending 行 → 点「刷新」 | 行渲染：`bash`、reason、input 预览、`群聊 · 未绑定群聊 · 成员 coder · 刚刚 · 10 分钟后过期`；侧栏「审批」出现计数 1 |
| 点「批准」 | `POST /api/approvals/testappr2` **200**，请求体 `{"decision":"allow","scope":"once","by":"user"}`；行消失 → 空态；审计新增「批准 · bash 一次 · 人工批准（once） · user · ask 模式」；统计变 `0 待裁决 · 1 已批准` |
| 再插一条 → 选「永久」→ 点「拒绝」 | `POST` **200**；审计新增「拒绝 · write 永久 · 人工拒绝 · user · ask 模式」；统计 `1 已拒绝` |
| 过期后裁决 | 后端 409 `already_resolved` → 前端按"已被处理过"toast + 刷新，不弹错误对话框（浏览器控制台仍会记一条 network 409，属正常） |
| 设置入口徽标 | pending=1 时显示「1」，pending=0 时 `hidden` |
| 截图 | `D:\能力测试\temp\approval-ui.png`、`D:\能力测试\temp\approval-badge.png` |

后端回归（本轮未改 `src/`，跑一遍确认）：

```powershell
cd D:\能力测试\fusion; node --test
# ℹ tests 197 / pass 197 / fail 0
```

## 7. 已知限制

1. **没有轮询**：徽标与列表的更新时机只有三处 —— 启动时 `boot()` 拉一次、SSE 命中时防抖刷新、
   面板打开/手动「刷新」时各拉一次。SSE 断开期间新产生的审批不会自己出现；断线重连成功时
   `connectEvents().onOpen` 会补拉一次（`store.js:556`，仅重连，首连由 boot 负责）。
2. **SSE 是"通知"不是"数据"**：payload 只用于触发刷新，不在前端合并行状态；所以终态（谁裁决、
   什么 scope）永远以 `GET /api/approvals` + `/audit` 为准，多端同时开着也不会漂移。
3. **过期/重复裁决是 409**：`resolve` 对非 pending 行回 `already_resolved`。前端捕获后提示并刷新，
   但浏览器 DevTools 会记一条 409 resource error（fetch 层无法屏蔽），不是 JS 异常。
4. **拒绝也带 scope 文案**：后端 `resolve` 对 deny 同样把请求里的 scope 写进 `appr_requests`/`appr_audit`，
   所以审计里可能出现「拒绝 · 永久」。这不是 UI 越权（deny 不写 `appr_cache`），但文案上易被误读；
   若要更严谨，应由后端在 deny 时把 scope 置空。
5. **未接 `/api/approvals/clear`**：本轮不做「清理会话」按钮，避免误点把别人的挂起请求清掉；
   端点仍在，需要时可从 CLI 或后续加个二次确认。
6. **列表默认全局口径**：面板展示所有房间的 pending；`fetchApprovals({roomId})` 已支持按房间过滤，
   但 UI 暂未提供筛选项（房间上下文里还没有审批入口）。
7. **只做了"批准/拒绝 + scope"**：没有做 reason 输入框（POST body 的 `reason` 保留给后续），
   审计里显示的是后端默认文案（`人工批准（once）` / `人工拒绝`）。
8. **样式**：`.appr-*` 是新增类，复用了 `settings-section / set-row / set-card / btn / seg / tag`
   与既有 CSS 变量；深色主题未单独适配（沿用变量，自动跟随）。

## 8. Lead 接入清单

本 UI 不需要 Lead 改任何后端文件。可选后续（按优先级）：

1. **确认 SSE 事件确实到达浏览器**：`worker.<bot>.approval_requested|resolved` 由 `bot.js` 发布，
   需要 Lead 确认 E26 的 server SSE 广播没有在白名单里把它过滤掉（本次验证用的是"插库 + 手动刷新"，
   SSE 分支只做了代码级防抖单测思路，没有真实 tool_call 触发）。
2. 若希望面板进入房间上下文：在群聊顶栏加一个「待裁决 N」入口，调用 `openSettings({ tab: "approvals" })`
   （`settings.js` 已支持 `opts.tab`），并给 `refreshApprovals(roomId)` 传当前 `room_id`。
3. 若要「清理会话」：接 `POST /api/approvals/clear`，务必二次确认。
