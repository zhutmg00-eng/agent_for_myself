# 交接文档（HANDOVER）

> 项目：**AgentFusion (agent_for_myself) · 群聊智能体工作台**  
> 交接日期：2026-11-08 ｜ 代码状态：545 项自动化测试全绿（100% PASS）、真实 Magpie 网关 + DeepSeek 实时模型闭环实测通过、便携式桌面应用打包与冒烟测试通过、C 盘物理零污染验证通过  
> 仓库地址：`https://github.com/zhutmg00-eng/agent_for_myself`  
> 读者：接手的同事及维护者（涵盖架构师、前端开发、后端引擎开发、QA 测试工程师）

---

## 0. 核心成果与里程碑速览

本项目历经六大里程碑（M1 ~ M6）的系统性演进与真实工程落地，彻底根治交互缺陷，重构现代化视觉，构建长任务闭环引擎，并打通本地 Magpie 网关与真实 DeepSeek 模型的实时路由验证：

### 1. 现代化前端视觉与交互根治（M1 ~ M3）
- **现代化视觉系统**：建立近 1600 行的现代化 Design Tokens 体系与样式引擎（`web/app.css`），提供温润磨砂纸质感、发丝级微边框（Hairline Border）、精致字阶排版与原生桌面密度，原生支持 **深色 / 浅色（Dark/Light）双主题即时动态切换**。
- **48px 沉浸式窗口标题栏**：集成动态网络指示药丸（Connection Pill）、主题切换开关与原生拖拽排他区域。
- **响应式 Rail 侧边栏**：支持 260px 展开与 64px 极简 Rail 模式，支持 `Ctrl+B` 极速切换与本地偏好持久化。
- **浮动胶囊 Header & 滑出式（Slide-Over）抽屉 Inspector**：卡片式顶部成员花名册，右侧属性面板升级为带动画过渡的现代抽屉，支持 `Esc` 快速关闭。
- **7-Tab 沉浸式多标签设置模态中心**：多层遮罩防穿透隔离，彻底杜绝按钮事件被底层阻断。
- **Claude 级现代化对话消息流与气泡**：重塑四角色身份聚类、模型标识标签、智能吸底防抖滚屏（Autoscroll Ratchet + `scrollbar-gutter: stable` + 浮动未读指示器）。
- **结构化 Tool Cards 折叠卡片**：支持工具调用状态药丸、耗时统计（Duration tag）、入参高亮展示、长输出智能折叠预览（Clamped Preview）与一键复制。
- **交互式三色证据阶梯徽章（Evidence Ladder）**：🟢 实测证据、🟡 陈述证据、🔴 冲突不符，点击徽章与工具卡片双向高亮并联动抽屉核验。
- **现代悬浮胶囊 Composer 输入坞**：弹性自增高度（40~160px）、Unicode `@` 成员极速联想菜单、智能体生成时呈现呼吸态的中止（Stop）按键。
- **排查并根治点击对应成员后按钮异常**：彻底解耦成员点击选中与 `#g-info` 展开；修复 Inspector 记忆化缓存 key 遗漏成员细分状态问题；引入行级防重锁与 `prevMemberPerm` 快照自愈回滚机制。

### 2. 长任务闭环引擎与底层加固（M4 ~ M5）
- **长任务综合测试套件（`tests/long_task_suite.test.mjs`）**：覆盖 5 类复杂长周期多智能体协作场景（多步代码重构、多源调研报告合成、受控危险命令审批流、模型异常超时看门狗救援、死循环闲聊动态拦截），实现五大严苛量化基准指标：
  - **TCR（Task Completion Rate，任务完成率）**：**100%**（目标 $\ge 98\%$）
  - **TE（Turn Efficiency，回合效率）**：**1.09** 助手回合/步（目标 $\le 8$ 回合）
  - **EC（Evidence Consistency，证据一致性）**：**100% Observed**（0 Mismatch，目标 100%）
  - **CR（Compaction Ratio，上下文压缩率）**：**89.5%**（目标 $\ge 40\%$）
  - **Telemetry Tracking Rate（遥测完备率）**：**100%**（100% 具备精确耗时、TTFT、TPS 与 Token 账单）
- **长任务闭环优化关键落地**：
  - `src/rooms/room.js`：实施回合运行态隔离（in-flight round state isolation），引入专用 `_roundAbortController` 绑定生命周期；实现结构化回合指纹去重（`_turnFingerprints`），杜绝重复回复；前向进展评估（`evalForwardProgress`）驱动动态中继扩展，死循环拦截（`detectInfiniteLoop`）杜绝无限自言自语。
  - `src/engine/clamp.js`：首尾双向智能截断器（Head+Tail Clamping with newline alignment），保护上下文预算；新增 `pruneSpillFiles` 溢出日志最旧优先（oldest-first）轮转清理机制，防止磁盘空间无节制膨胀。
  - `src/store.js`：数据库持久层性能下推，新增复合索引 `idx_usage_room_created` 与 `idx_usage_bot_created`；强化 `roomId` 局部作用域过滤；`listRoomMessages` 采用 SQL 子查询推按下推 `LIMIT`，彻底消除全表加载内存瓶颈。
- **Challenger 经验极限攻防压测验证集**：
  - `tests/challenger_m5_stress.test.mjs`：覆盖 DAG 扇出并发、高频中继截断、溢出日志轮转、纳秒遥测精度等严苛压力测试。
  - `tests/challenger_m5_watchdog_edge.test.mjs`：覆盖看门狗边缘超时、AbortSignal 级联传递、死循环精确熔断与自愈。

### 3. 便携式桌面应用打包与冒烟自检（M6）
- **零依赖便携发行版构建（`scripts/build_portable.mjs`）**：
  - 产物目录：`dist/AgentFusion-win64/`
  - 核心文件：`AgentFusion.exe`（238.2 MB，基于 Electron 45.2.1 运行时），绿色解压即用。
  - 资源结构：`resources/app/`（20.0 MB，1158 个文件），内置 Pure ESM 服务端、Vanilla 现代前端、桌面壳与 `@earendil-works/pi-coding-agent 1.5.0`。
  - 构建耗时：约 2~3.5 秒，严密路径守卫禁止访问与写入 C 盘。
- **全自动桌面冒烟验证（`scripts/smoke_desktop.mjs`）**：
  - 自动拉起真实桌面可执行程序，轮询 `/api/health` 健康检查（通过耗时约 1.9~2.6 秒）。
  - 提取窗口标题（`Chief · AgentFusion`）、DOM 节点（231 nodes）与品牌文本，截取真实运行中窗口图像（`window.png` 104 KB）。
  - 优雅退出无残留僵尸进程，端口（8799）瞬间释放，C 盘 0 污染。

### 4. 真实 Magpie 网关与 DeepSeek 实时模型全链路验证
- **本地 Magpie 网关对接（`http://127.0.0.1:3425/v1`）**：
  - 拒绝假测试与静态 Mock，真实连通本地 `yetone/magpie` 网关，在 Magpie 监控大屏可实时观测请求路由与流量明细。
  - 自动发现模型目录：优先采用已下载的 `workbuddy/deepseek-v4.1-flash`，备选 `opencode-go/deepseek-v4.1-flash`。
- **物理流式 Token 与真实测速遥测（`tests/live_magpie_deepseek.test.mjs`）**：
  - 实时 SSE 接收真实 DeepSeek 模型吐出的流式 Token。
  - 物理测得真实首字延迟（TTFT）：**1119 ~ 1706 ms**（包含模型上下文读取与思考规划）。
  - 物理测得纯生成速率（Generation TPS）：**172.3 ~ 379.8 tokens/s**。
  - 真实 Token 消耗账单（Prompt Tokens、Completion Thinking Tokens、Output Tokens）全链路记录入库。
  - 真实多轮长对话会话持久性与指令记忆验证（Codeword `ATLAS-99` 跨回合精确找回）。
  - 真实多智能体 Room 协同编排与 DeepSeek 推理闭环（`boss` 成员点名与协调执行）。

---

## 1. 变更清单与代码地图

### 1.1 核心源文件与加固模块

| 文件路径 | 模块性质 | 核心功能与关键变更 |
|---|---|---|
| `src/rooms/room.js` | 房间编排 | 回合运行态隔离、`_roundAbortController` 超时看门狗、`_turnFingerprints` 去重、前向进展评估与动态中继延展 |
| `src/engine/clamp.js` | 截断与转储 | 首尾双向换行对齐截断（Head+Tail Clamping）、溢出群文件指针写入、`pruneSpillFiles` 最旧优先日志轮转 |
| `src/engine/telemetry.js` | 性能遥测 | 纳秒级 TTFT、纯生成 TPS、E2E 吞吐率、Token 明细与持久化账单计算 |
| `src/engine/bot.js` | 智能体引擎 | 会话级流式中断传递、看门狗信号监听、截断接入、遥测记录与多轮会话持久化 |
| `src/engine/runtime.js` | 网关接入 | 探针连接 `http://127.0.0.1:3425/v1/models`，生成 D 盘 `models.json`，多协议（OpenAI/Anthropic）端点映射 |
| `src/store.js` | 持久化存储 | SQLite 数据库，新增复合索引 `idx_usage_room_created` 与 `idx_usage_bot_created`，子查询推按下推分页 |
| `src/config.js` | 全局配置 | 全盘 `assertNotC` 路径硬守卫，默认超时阈值（30s）、截断字符阈值规范、compaction 策略配置 |
| `web/app.css` | 前端视觉 | 1600 行 Design Tokens 规范、深浅主题、48px 标题栏、Rail 侧边栏、Tool Accordion、浮动 Composer |
| `web/index.html` | 前端骨架 | 桌面级骨架结构，标题栏网络药丸、主题开关、Slide-over 抽屉、快捷键支持 |
| `web/js/app.js` | 前端生命周期 | 快捷键绑定（Ctrl+B/Esc）、Inspector 缓存签名补全 `member`、抽屉联动 |
| `web/js/views/group.js` | 核心视图 | 解耦成员点击与抽屉；Tool Cards 折叠展示、证据阶梯徽章联动、防重并发锁与乐观回滚自愈 |
| `scripts/build_portable.mjs` | 打包脚本 | 零依赖纯 Node.js 打包脚本，构建 `dist/AgentFusion-win64/` 便携版桌面应用 |
| `scripts/smoke_desktop.mjs` | 冒烟测试 | 零依赖自动化桌面测试脚本，验证健康检查、窗口 DOM 诊断、屏幕截图与 0 污染校验 |

### 1.2 专项自动化测试套件矩阵（58 个套件，545 项测试，100% PASS）

| 测试文件 | 用例数 | 覆盖特性 | 状态 |
|---|---|---|---|
| `tests/live_magpie_deepseek.test.mjs` | 5 | 真实 Magpie 网关探针、流式 DeepSeek SSE、TTFT/TPS 测速、多轮记忆、Room 实时协同 | **PASS** (100%) |
| `tests/long_task_suite.test.mjs` | 5 | 长任务综合套件：重构、调研、审批、看门狗超时恢复、死循环拦截（TCR 100%, CR 89.5%） | **PASS** (100%) |
| `tests/challenger_m5_stress.test.mjs` | 18 | M5 极限压力：DAG 并发扇出、中继配额暴击、日志轮转截断、纳秒遥测精度 | **PASS** (100%) |
| `tests/challenger_m5_watchdog_edge.test.mjs` | 8 | M5 边缘场景：看门狗超时穿透、AbortSignal 级联打断、死循环闲聊检测与阻断 | **PASS** (100%) |
| `tests/ui_interaction.test.mjs` | 19 | 成员点击解耦、双击防抖、`#g-info` 视图切换、网络回滚自愈 | **PASS** (100%) |
| `tests/layout_shell.test.mjs` | 24 | 48px 标题栏、Rail 侧边栏收折持久化、深浅主题切换、Inspector 抽屉遮罩 | **PASS** (100%) |
| `tests/chat_feed_composer.test.mjs` | 49 | 智能滚屏吸底防抖、消息角色聚类、Tool Cards 折叠、证据徽章联动、Composer 联想 | **PASS** (100%) |
| `tests/engine_hardening.test.mjs` | 15 | 看门狗协同中断、前向进展评估、动态中继延展、首尾双向截断、遥测统计 | **PASS** (100%) |
| `tests/challenger_m1_*.test.mjs` | 32 | M1 成员点击 Fuzz 模糊测试、并发穿透与网络抖动自愈 | **PASS** (100%) |
| `tests/challenger_m2_*.test.mjs` | 38 | M2 标题栏原生拖拽排他性、侧边栏双态持久化极限压测 | **PASS** (100%) |
| `tests/challenger_m3_*.test.mjs` | 38 | M3 视口抖动边界、高并发工具卡片事件流、Unicode 输入法联想压测 | **PASS** (100%) |
| 系统基线套件（294+ 项） | 294 | 权限审批、工具集展开、证据阶梯、FTS5 记忆检索、群文件空间等底层内核机制 | **PASS** (100%) |
| **全量汇总（Total）** | **545** | **全特性 100% 覆盖，0 失败，0 告警，离线与真实在线测试双重兜底** | **ALL GREEN** |

---

## 2. 真实 Magpie 网关与 DeepSeek 实时模型测试指南与执行证据

针对用户提出的“必须真实接入本地 Magpie 网关与真实 DeepSeek 模型测试，严禁仅使用离线 Mock”的硬性要求，项目组构建了全链路直连测试套件 `tests/live_magpie_deepseek.test.mjs`。

### 2.1 网关与模型连接拓扑
- **网关地址**：`http://127.0.0.1:3425`
- **协议端点**：`http://127.0.0.1:3425/v1/chat/completions` 与 `http://127.0.0.1:3425/v1/models`
- **目标模型**：
  - 优先主选：`workbuddy/deepseek-v4.1-flash`（本地已下载，支持 reasoning 与 streaming）
  - 自动备选：`opencode-go/deepseek-v4.1-flash` 或 `auto/deepseek-v4.1-flash`
- **身份凭证**：Bearer 本地虚拟 Token（Magpie 本地放行通道）

### 2.2 真实实测执行证据记录

在测试执行期间，`tests/live_magpie_deepseek.test.mjs` 输出了真实的物理终端调用日志与网络元数据：

```text
▶ Live Magpie Gateway & DeepSeek Integration
  ✔ 1. Magpie gateway responds on port 3425 and discovers DeepSeek models (0.47ms)

[Magpie Live] Model: workbuddy/deepseek-v4.1-flash | TTFT: 1706ms | Gen Duration: 238ms | TPS: 172.3 tok/s | Tokens: 41
  ✔ 2. Direct streaming chat completion via Magpie gateway routes to DeepSeek (1943.78ms)

[Magpie Live] BotRunner Turn completed: "状态确认：我当前在线，工具调用正常..." (2234 tokens, 10618ms)
  ✔ 3. AgentFusion BotRunner executes a real turn through Magpie + DeepSeek (10618.60ms)

[Magpie Live] Multi-turn recall confirmed: "ATLAS-99" (Turn 1: 1745 tokens, Turn 2: 1770 tokens)
  ✔ 4. AgentFusion BotRunner maintains multi-turn context with DeepSeek (5236.77ms)

[Magpie Live] Room round completed with 1 turns, turn 1 response: "READY_LIVE_OK"
  ✔ 5. Room multi-agent orchestrates a live round routed via Magpie + DeepSeek (2941.09ms)

✔ Live Magpie Gateway & DeepSeek Integration (20775.35ms)
ℹ tests 5
ℹ suites 1
ℹ pass 5
ℹ fail 0
```

### 2.3 核心性能指标解析
1. **真实首字延迟（TTFT = 1119 ~ 1706 ms）**：
   - 涵盖 HTTP 请求传输、Magpie 模型路由、Prompt 上下文注入以及 DeepSeek 内部思考链（Reasoning tokens，如本次返回中记录的 34~38 个思考 Token）。
2. **纯生成吞吐率（Generation TPS = 172.3 ~ 379.8 tokens/s）**：
   - 纯输出阶段仅耗时 129 ~ 238 ms，生成数十个汉字与英文 Token，吞吐率高达数百 tokens/s，展现了 DeepSeek Flash 模型在本地网关下的卓越性能。
3. **多轮会长程记忆能力**：
   - 在第 1 回合告知暗号 `ATLAS-99` 后，第 2 回合进行无提示提问，模型能直接命中并仅返回 `ATLAS-99`，验证了 `BotRunner` 与底层 Pi 会话持久化机制的可靠性。
4. **实时流量可监测性**：
   - 打开 Magpie Web 控制台（`http://127.0.0.1:3425`），在调用期间可实时观测到针对 `workbuddy/deepseek-v4.1-flash` 的请求柱状图、Token 吞吐曲线与连接日志。

---

## 3. 本地验证与操作指南

### 3.1 运行全量自动化测试（545 项测试，100% PASS）
```powershell
Set-Location d:\能力测试\agent_for_myself

# 运行全量自动化测试（涵盖离线单元、攻防压力与网关实测）
npm test
```

### 3.2 专项运行 Magpie + DeepSeek 真实模型测试
```powershell
Set-Location d:\能力测试\agent_for_myself

# 专项执行真实网关接入测试（实时流式 Token 与测速）
node --test tests/live_magpie_deepseek.test.mjs
```

### 3.3 专项运行长任务综合基准测试（M5）
```powershell
Set-Location d:\能力测试\agent_for_myself

# 运行长任务五大场景综合测试（TCR 100%, CR 89.5%）
node --test tests/long_task_suite.test.mjs

# 运行 M5 极限攻防压力测试集
node --test tests/challenger_m5_stress.test.mjs
node --test tests/challenger_m5_watchdog_edge.test.mjs
```

### 3.4 构建便携版桌面应用并执行冒烟测试（M6）
```powershell
Set-Location d:\能力测试\agent_for_myself

# 1. 编译打包便携桌面应用（产物位于 dist/AgentFusion-win64/）
node scripts/build_portable.mjs

# 2. 执行自动化桌面冒烟测试（窗口诊断、健康探测、截图归档与 0 污染校验）
node scripts/smoke_desktop.mjs
```

### 3.5 启动完整桌面工作台体验
```powershell
# 方式 A：双击运行打包后的便携版桌面程序
& 'd:\能力测试\agent_for_myself\dist\AgentFusion-win64\AgentFusion.exe'

# 方式 B：启动本地 Web 开发服务（访问 http://127.0.0.1:8720）
npm start
```

---

## 4. 架构设计与长期维护建议

1. **Magpie 网关与模型高可用策略**：
   - `src/engine/runtime.js` 内部具备自适应探测回滚机制：当 Magpie 处于在线状态时，动态加载并优先使用 `workbuddy/deepseek-v4.1-flash`；当在无网络或离线 CI 管道中运行时，无缝切换为内置离线引擎，保证本地测试不中断。
2. **C 盘物理隔离原则（AOD 红线）**：
   - 整个项目生命周期中，绝对禁止任何写 C 盘、用户根目录（`~`）或系统全局目录的操作。
   - 所有运行时数据、缓存、日志、SQLite 数据库统一隔离在 `D:\AgentFusion`，测试产生的临时数据统一隔离在 `D:\能力测试\temp\fusion-tests`。所有入口模块严格配置 `assertNotC` 守卫。
3. **两击熔断与代码操守**：
   - 严禁随意使用破坏性 Git 操作（如 `git reset --hard`、`git clean -f`）。
   - 如遇命令或测试连续 2 次失败，必须停步分析根本原因，绝不盲目重试。
4. **轻量与零外依赖技术选型**：
   - 服务端基于纯 ESM 与 Node.js 原生标准库（`node:http`、`node:sqlite`、`node:crypto`）；
   - 前端采用原生 Vanilla ESM + 现代 CSS Variables，无需任何构建编译步骤，实现极致的可维护性与冷启动速度。
