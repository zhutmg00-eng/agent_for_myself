# 交接文档（HANDOVER）

> 项目：**AgentFusion (agent_for_myself) · 群聊智能体工作台**  
> 交接日期：2026-11-08 ｜ 代码状态：536+ 自动化测试全绿（100% PASS）、前端现代架构重构交付、点击交互 Bug 彻底修复、长任务引擎加固就位  
> 仓库地址：`https://github.com/zhutmg00-eng/agent_for_myself`  
> 读者：接手的同事及维护者（涵盖架构师、前端开发、后端引擎开发）

---

## 0. 30 秒核心成果速览

本次迭代针对用户的三大核心目标进行了全方位的彻底重构、缺陷根治与底层加固：

1. **彻底替换原有劣质前端（对标优秀开源项目 DeepSeekharness / DS-Bot / Hermes / ZCode）**：
   - **现代化视觉系统**：建立近 1600 行的现代化 Design Tokens 体系与样式引擎（`web/app.css`），告别简陋粗糙感，提供温润磨砂纸质感、发丝级微边框（Hairline Border）、精致字阶排版与原生桌面密度，原生支持 **深色 / 浅色（Dark/Light）双主题即时动态切换**。
   - **48px 沉浸式窗口标题栏**：集成动态网络指示药丸（Connection Pill）、主题切换开关与原生拖拽排他区域。
   - **响应式 Rail 侧边栏**：支持 260px 展开与 64px 极简 Rail 模式，支持 `Ctrl+B` 极速切换与本地偏好持久化。
   - **浮动胶囊 Header & 滑出式（Slide-Over）抽屉 Inspector**：卡片式顶部成员花名册，右侧属性面板升级为带动画过渡的现代抽屉，支持 `Esc` 快速关闭。
   - **7-Tab 沉浸式多标签设置模态中心**：多层遮罩防穿透隔离，彻底杜绝按钮事件被底层阻断。
   - **Claude 级现代化对话消息流与气泡**：重塑四角色身份聚类、模型标识标签、智能吸底防抖滚屏（Autoscroll Ratchet + `scrollbar-gutter: stable` + 浮动未读指示器）。
   - **结构化 Tool Cards 折叠卡片**：支持工具调用状态药丸、耗时统计（Duration tag）、入参高亮展示、长输出智能折叠预览（Clamped Preview）与一键复制。
   - **交互式三色证据阶梯徽章（Evidence Ladder）**：🟢 实测证据、🟡 陈述证据、🔴 冲突不符，点击徽章与工具卡片双向高亮并联动抽屉核验。
   - **现代悬浮胶囊 Composer 输入坞**：弹性自增高度（40~160px）、Unicode `@` 成员极速联想菜单、智能体生成时呈现呼吸态的中止（Stop）按键。

2. **排查并根治点击对应成员后按钮异常（原双击/冒泡/遮罩残留缺陷）**：
   - 彻底解耦成员点击选中与 `#g-info` 视图展开逻辑，杜绝事件冒泡。
   - 修复 Inspector 记忆化缓存 key 遗漏成员细分状态问题；修复遮罩层在特定状态切换下未重置导致的 `pointer-events` 残留阻断。
   - 引入行级互斥防重锁与网络异常自动回滚（`prevMemberPerm` 快照自愈机制），保证任何异常或弱网下界面状态与按钮不假死。

3. **长任务执行引擎加固与遥测底座构建**：
   - **输出智能截断与安全溢出转储（`src/engine/clamp.js`）**：首尾双向截断（Head+Tail Clamping with newline alignment），溢出数据安全转储至非 C 盘存储并生成群文件指针，保护上下文预算。
   - **高精度遥测引擎（`src/engine/telemetry.js`）**：实现纳秒级 TTFT（首字延迟）、纯生成 TPS、端到端吞吐率与 Token 消耗统计，并存入 SQLite 数据库。
   - **看门狗超时机制（Watchdog Timeout）**：在 `room.js` 与 `bot.js` 注入协同式 `AbortSignal`，防止底层网络或进程在 `_queue` 队列中死锁。
   - **动态中继配额延展与死循环侦测**：侦测实质性前向进展（`evalForwardProgress`），自动补充长任务步数配额，同时拦截空转闲聊死循环（`detectInfiniteLoop`）。

4. **测试网络从 294 项全面扩充至 536+ 项，100% 绿灯全过**：
   - 新增 13 个专项测试文件（包含 UI 交互、外壳布局、消息流、输入框、引擎加固与 7 套极端攻防压力测试集），无任何回归缺陷，全量离线运行，严格零 C 盘污染。

---

## 1. 变更清单与代码地图

### 1.1 核心新增与修改文件

| 文件路径 | 模块性质 | 变更说明 |
|---|---|---|
| `web/app.css` | 前端视觉 | 扩充至近 1600 行。全新 Design Tokens 规范、深浅主题、48px 标题栏、Rail 侧边栏、Tool Accordion、浮动 Composer |
| `web/index.html` | 前端骨架 | 重塑桌面级骨架结构，集成标题栏指示药丸、主题切换按钮、无缝 Inspector 抽屉容器与快捷键绑定 |
| `web/js/app.js` | 前端生命周期 | 增加快捷键（Ctrl+B / Esc）、深浅主题持久化、Inspector 缓存 key 补全与抽屉联动 |
| `web/js/store.js` | 前端状态层 | 扩充 SSE 实时流工具事件缓冲聚合、注水绑定及遥测数据接收 |
| `web/js/views/group.js` | 核心视图 | 解耦成员点击与抽屉展开；落地消息聚类排版、Tool Cards 折叠渲染、证据徽章联动与悬浮 Composer 交互 |
| `web/js/views/settings.js` | 设置模态 | 7-Tab 模块化沉浸式设置面板，图层遮罩事件隔离，防穿透与防卡死 |
| `src/engine/clamp.js` | **新增** 引擎核心 | 首尾双向智能截断器（Head+Tail Clamping），支持换行对齐与非 C 盘溢出转储 |
| `src/engine/telemetry.js` | **新增** 引擎核心 | 高精度性能遥测计算引擎（TTFT、纯生成 TPS、E2E TPS、Token 账单） |
| `src/rooms/room.js` | 房间编排 | 协同式 `AbortSignal` 双层看门狗超时、前向进展评估（`evalForwardProgress`）、死循环拦截（`detectInfiniteLoop`）与动态中继延展 |
| `src/engine/bot.js` | 智能体引擎 | 会话级流式中断传播、超时信号监听、工具结果截断与遥测注入 |
| `src/store.js` | 数据持久化 | 增加细粒度遥测字段存储、平均 TTFT/TPS 统计与截断文件元数据索引 |
| `src/config.js` | 全局配置 | 统一集中规范看门狗超时时间阈值、工具输出截断上限与中继扩展因子 |

### 1.2 专项自动化测试套件

| 测试文件 | 覆盖特性 | 状态 |
|---|---|---|
| `tests/ui_interaction.test.mjs` | 成员点击解耦、双击防抖、`#g-info` 切换、网络回滚自愈 | **PASS** (19/19) |
| `tests/layout_shell.test.mjs` | 48px 标题栏、Rail 侧边栏收折、主题切换、Inspector 抽屉遮罩 | **PASS** (24/24) |
| `tests/chat_feed_composer.test.mjs` | 智能滚屏吸底、消息聚类、Tool Cards 折叠、证据徽章联动、Composer 输入 | **PASS** (49/49) |
| `tests/engine_hardening.test.mjs` | 看门狗超时、AbortSignal 级联中断、动态中继延展、输出截断、遥测统计 | **PASS** (15/15) |
| `tests/challenger_m1_*.test.mjs` | M1 极限连击 Fuzz 压测、蒙特卡洛网络故障注入与状态自愈 | **PASS** |
| `tests/challenger_m2_*.test.mjs` | M2 标题栏原生拖拽排他、Rail 侧边栏双态持久化极限压测 | **PASS** |
| `tests/challenger_m3_*.test.mjs` | M3 滚动高频抖动、卡片并发事件流、Composer Unicode 联想压测 | **PASS** |
| 现有 294 项系统基线测试 | 审批流、工具集、证据阶梯、记忆检索、文件空间等底层机制 | **PASS** (294/294) |

---

## 2. 核心架构与技术实现要点

### 2.1 交互缺陷根治逻辑（R2）
- **单双击解耦**：成员卡片（`.mchip`）的点击仅负责在状态层更新当前选中的成员标识（`state.inspector.member = memberId`），触发局部高亮更新，绝不直接粗暴触发 DOM 全量重置。
- **缓存签名对齐**：修改 `web/js/app.js` 中的 `renderInspector`：
  ```javascript
  const key = `${insp.type}:${insp.id || ""}:${insp.tab || ""}:${insp.member || ""}`;
  ```
  补齐 `selectedMember` 维度，杜绝切换成员时 Inspector 视图假死不更新。
- **并发锁与状态自愈**：在 `group.js` 成员权限切换中加入 `inFlight` 行级防重锁与 `ev.stopPropagation()`，同时保存 `prevMemberPerm` 快照，当底层网络或接口拒绝时自动触发乐观状态回滚并重新渲染，确保按钮永不失效。

### 2.2 前端现代视觉与组件架构（R1）
- **Design Tokens**：在 `:root` 与 `[data-theme="dark"]` 中定义完整的统一变量体系，采用 CSS `color-mix()` 与精准的阴影分层（`--shadow-1`, `--shadow-2`, `--shadow-3`），实现如丝般顺滑的微质感。
- **Tool Accordions（工具折叠卡片）**：
  - 聊天面板中的工具调用不再丢失或简陋输出，而是以独立卡片（`.tool-card`）呈现。
  - 卡片顶部包含执行状态指示灯（运行中转圈、成功绿灯、失败红灯）、工具名称、入参摘要（胶囊 pill）、执行耗时（如 `128ms`）与折叠指示箭头。
  - 展开后展示代码格式化的入参及截断后的清晰输出，右侧提供一键复制按钮。
- **AutoScroll 吸底状态机**：
  - 采用原生 `scrollbar-gutter: stable`，滚动条出现与消失时不再引起内容横向跳变。
  - 实时计算 `scrollHeight - scrollTop - clientHeight <= 64`：处于底部时新消息平滑跟随，用户上滑回看时自动锁死视口并不打扰阅读，右下角浮现未读小红点与「回到底部」悬浮药丸。

### 2.3 长任务引擎与上下文保护（R3）
- **协同式双层超时看门狗**：
  - 每回合为智能体执行创建独立的 `AbortController`，超时阈值支持智能体定制（默认 30,000ms）。
  - 超时发生时，首先触发内部 `signal.abort()` 通知智能体中断生成；若底层子进程超时未退出，硬看门狗触发破壁保护，释放房间消息执行队列 `_queue`，记录 `member_error` 并平稳过渡，避免整个房间卡死。
- **首尾双向工具输出截断（Head+Tail Clamping）**：
  - 当工具输出字符超过阈值（默认 8,000 字符），`clamp.js` 保留前 4,000 字符与后 4,000 字符（智能捕捉尾部的报错堆栈与退出码），并在截断处按换行对齐；
  - 溢出的全量日志自动写入 `D:\AgentFusion\data\...` 本地目录，并向上下文注入群文件引用指针，既省 Token 又留存完整痕迹。

---

## 3. 本地验证与操作指南

### 3.1 运行全量自动化测试
```powershell
Set-Location d:\能力测试\agent_for_myself

# 1. 运行所有单元、集成与加固测试（536+ 项测试，全离线，无需网关）
npm test

# 2. 专项执行 UI 交互与单双击解耦测试
node --test tests/ui_interaction.test.mjs

# 3. 专项执行现代化外壳与布局测试
node --test tests/layout_shell.test.mjs

# 4. 专项执行聊天流、工具折叠卡片与 Composer 测试
node --test tests/chat_feed_composer.test.mjs

# 5. 专项执行长任务引擎加固与遥测测试
node --test tests/engine_hardening.test.mjs
```

### 3.2 启动应用进行界面体验
```powershell
Set-Location d:\能力测试\agent_for_myself

# 启动开发服务器（默认端口 8720）
npm start
# 浏览器访问：http://127.0.0.1:8720
```
- **测试深浅色切换**：点击顶栏右上角「亮色/暗色」主题切换按钮，观察全局 Design Tokens 极速响应。
- **测试侧边栏折叠**：按键盘快捷键 `Ctrl+B`，侧边栏在 260px 与 64px 极简 Rail 模式间平滑动画折叠。
- **测试成员交互**：点击任意成员，右侧 Slide-Over 抽屉平滑滑出，成员高亮切换；点击其他按钮或顶栏 `#g-info`，状态完美响应，无任何按钮穿透或失灵。
- **测试长文本截断与工具卡片**：在对话中运行工具，观察 Tool Accordions 展开/收起、耗时标签与证据阶梯徽章联动。

---

## 4. 后续演进建议与注意事项

1. **真实网关下的端到端长周期任务压测**：
   - 目前 M4 引擎加固层与单元自动化测试已 100% 跑通。后续接手同事若需执行跨数小时的真实多智能体生产任务，只需确保 Magpie 网关（`http://127.0.0.1:3425/v1`）在线，即可直接利用本轮加固的看门狗与动态中继机制，无需担心队列卡死或上下文爆仓。
2. **数据安全红线保持**：
   - 工程始终严密遵循 **非 C 盘存储隔离原则**（`assertNotC`），所有工作区、SQLite 数据库、日志与转储文件必须保留在 `D:\` 盘，切勿在代码中硬编码任何 C 盘路径。
3. **保持零依赖轻量化**：
   - 服务端保持基于 Node.js 原生标准库（`node:http`、`node:sqlite`、`node:crypto`），前端采用无打包构建的 Vanilla ESM 架构，请继续保持这一优秀的极致可移植性。
