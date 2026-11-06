# Hermes Agent 架构解剖与吸收地图

> 分析对象：`NousResearch/hermes-agent`（**MIT**），本地只读副本
> `D:\能力测试\reference\hermes\hermes-agent`，commit `ca43606`（2026-11-05T23:01:15-05:00），
> 工作树 22,595 文件 / 232 MB；上游 260k+ stars，主分支当天仍在合入（`pushed_at 2026-11-06T04:17Z`）。
> 对照物：`rlaope/oh-my-hermes`（**MIT**），commit `1727425`，见 [OMH_AND_CONTEXT.md](OMH_AND_CONTEXT.md)。
> 本文件是**只读分析**；落地代码与取舍见同目录各模块文档，契约见 [CONTRACT.md](CONTRACT.md)。

---

## 0. 一句话结论

Hermes 的强项不是"更聪明的模型编排"，而是**把 agent 的长期运行做成了一套有边界、可审计、可裁剪的产品系统**：
工具用 registry + toolset 双层治理（`toolsets.py` 单字典、36 个工具集、末端减除），
危险操作用 **floor → 缓存 → 模式 → 人工审批** 四级闸门（`tools/approval*.py`，含 denial breaker 与来源留痕），
技能用 **guard 安装闸门 + usage 遥测 + curator 自动淘汰** 形成闭环（`tools/skills_guard.py`、`agent/curator.py`），
记忆用**写入闸门 + 破坏性操作审批 + FTS 检索**（`tools/memory_tool*.py`），
上下文压缩是**唯一允许改动历史前缀**的例外（`agent/context_compressor.py`）。
这些恰好是我们群聊工作台从"能跑"走向"敢交付"缺的那几层。

## 1. 仓库事实（可复现）

| 事实 | 证据 |
|---|---|
| 294 个 `tools/*.py`、356 个 `agent/*.py`、44 个内置 SKILL、142 个可选 SKILL、19 个插件目录、7,660 个测试文件 | `Get-ChildItem` 计数（同机实测） |
| 入口是 facade：`run_agent.py`(1375 行) 只做门面，回合循环在 `agent/turn_*.py` | `AGENTS.md` Project Structure；`run_agent.py:1` |
| 每个"上帝文件"拆成 `facade + <stem>_<topic>.py` 兄弟文件，兄弟文件**函数内**晚导入门面避免环 | `AGENTS.md` § Facade + siblings layout |
| 状态层同构：`hermes_state.py` 门面 + 100 余个 `hermes_state_*.py` 兄弟（sessions/messages/FTS/compaction/usage/…） | `hermes_state.py`、目录清单 |
| 工具通过 `registry.register()` 在 import 时自注册，`discover_builtin_tools()` 扫描发现，无需手工 import 列表 | `tools/registry.py:121` `discover_builtin_tools`；`tools/AGENTS.md` § Registry |
| 每个 tool 只有在**某个 toolset 里被点名**才会暴露给模型 | `tools/AGENTS.md`（"discovery registers the schema, but a tool is only exposed if a toolset names it"） |
| 两条设计不变量：**prompt 缓存神圣**（除压缩外不改历史）、**核心窄腰**（新能力优先 CLI+skill/插件，而非新核心工具） | `AGENTS.md` § What Hermes Is |

## 2. 工具治理：registry + toolset 双层

- `_HERMES_CORE_TOOLS`（`toolsets.py:11`）是跨平台共享工具面；`_bundle()`（`toolsets.py:52`）按"核心 + 平台附加"生成平台 bundle；`_core_without(...)`（`toolsets.py:57`）产出**姿态**（如 `_CODING_TOOLS`，`toolsets.py:64` 去掉 messaging/tts/image_gen/cron/kanban/computer_use）。
- `TOOLSETS` 是单字典（`toolsets.py:71` 起，36 个键），每项 `{description, tools[], includes[]}`，`_ts()` 工厂保证每次是新列表（`toolsets.py:47`）。
- `CLIENT_SURFACE_TOOLSETS = {"project","desktop_ui","catalog"}`（`toolsets.py:68`）：**"客户端能力"按会话来源注入，不写进配置文件**——同一条配置在远端后端上不会误开 GUI 工具。
- `disabled_toolsets` 是**管线末端严格减除**，所以 `web_search` 只归属 `web`/`search`，避免"禁用 browser 把 web_search 一起删掉"（`toolsets.py:105-113` 注释即事故复盘）。
- 可用性 `check_fn` 只回答"这个能力能不能到达/有没有开"，**不回答"谁在对面"**；结果按 profile TTL 缓存（`tools/registry.py`、`tools/AGENTS.md` § Surface capability）。
- 插件工具走 `~/.hermes/plugins/<name>/` + `ctx.register_tool(...)`，**不改核心**（`plugins/AGENTS.md` § Plugins never touch core）。

**对我们的启发**：群聊里 8 个 archetype 的工具面是写死的数组（`src/engine/archetypes.js`），既不能组合也不能按房间裁剪。Hermes 的"命名工具集 + includes + 末端减除 + 姿态"正好是我们缺的配置面。

## 3. 审批与安全：四级闸门

1. **硬地板（floor）先于一切**：`tools/approval_floors.py:1-8` 明确"unconditional blocks ... run BEFORE yolo / approvals.mode: off / cron approve-mode"；用户自定义 `approvals.deny` glob 也无条件拦截（`approval_floors.py:23-42`，注释写明"never let the agent run this, even under yolo"）。
2. **会话缓存**：`is_approved(session_key, pattern_key)`（`approval.py:410`）、`approve_session`（`approval.py:276`）、永久白名单 `load_permanent_allowlist`（`approval.py:491`）——一次/会话/永久三态。
3. **模式**：`yolo`（`enable_session_yolo` `approval.py:302`）、`smart`（`approval_smart.py` 启发式）、`ask`。注意 yolo **不豁免地板**。
4. **人工审批队列**：挂起/裁决/撤回/结算一整套（`approval.py:144` `resolve_gateway_approval`、`:192` `withdraw_gateway_approval`、`:209` `list_gateway_approvals`），支持跨网关（消息平台）审批。
5. **熔断**：同一会话连续拒绝达阈值（默认 3，`approval.py:74-77`）后不再弹审批，直接 deny 并附说明（`approval.py:99` `_denial_breaker_addendum`）。
6. **来源留痕**：`approval_provenance.py` 记录"谁批的、按什么范围批的"。

**对我们的启发**：我们只有 hooks 的静态 deny/allow + C 盘内置守卫（`src/hooks.js:224-280`），没有模式、没有缓存、没有审批队列、没有审计、没有熔断。群主"赋权"目前只是布尔权限位，缺少可审计的"谁批准了什么"。

## 4. 技能系统：闭环

| 层 | Hermes 做法 | 证据 |
|---|---|---|
| 文档规范 | `SKILL.md` + frontmatter（name/description/…），作者标准写死 | `skills/AGENTS.md` |
| 安装闸门 | 静态扫描：危险 shell、外泄、结构、隐藏字符 → `Finding/ScanResult/verdict`；`should_allow_install()` 决定能否装 | `tools/skills_guard.py:698` `scan_file`、`:746` `scan_skill`、`:822` `should_allow_install` |
| 用量遥测 | 每次 list/view/invoke 记事件，供策展判据 | `tools/skill_usage.py` |
| 策展 | 定时判定（`should_run_now` `agent/curator.py:160`）→ 自动流转（`apply_automatic_transitions` `:209`：stale/archive/consolidate）→ 生成 run report；`stale_after_days`/`archive_after_days` 可配 | `agent/curator.py` |
| 自我改进 | 从经验**创建**技能、使用中**改进**、主动沉淀记忆 | `README.zh-CN.md:16,23` |

**对我们的启发**：`src/skills.js` 有发现 + list/invoke，`src/rooms/tools.js:289` 有 `skill_list`/`skill_invoke`，但**没有使用统计、没有安装闸门、没有淘汰策略、没有"经验→技能"的闭环**——技能是静态资产而不是会进化的资产。

## 5. 记忆：写入闸门 + 检索 + 脱敏

- `MemoryManager`（`agent/memory_manager.py:199`）负责注入/截断/脱敏/去重，含 `_scrub`（`:89`）与 `_redact_messages_for_egress`（`:138`）。
- `memory` 工具（`tools/memory_tool.py:374` 起注册）动作是 `action/target/content/old_text/operations`（`:222` `memory_tool`），**写入前过闸门**（`_apply_write_gate` `:131`）、**破坏性操作单独判定**（`destructive_ops` `:173`、`_background_delete_gate` `:179`）、**待生效队列**（`apply_memory_pending` `:353`）。
- 存储与检索在 `tools/memory_tool_store.py`（44 KB）；跨会话回溯在 `tools/session_search_tool.py` + `hermes_state_fts.py`（FTS5）。

**对我们的启发**：群聊里"谁记得什么"完全没有建模。群聊 2.0 需要的正是"房间事实 + 成员画像 + 可检索的历史"，且必须可审计、可删除。

## 6. 上下文压缩：唯一允许动历史的例外

- `agent/context_compressor.py`（330 KB）与 `agent/conversation_compression.py`（249 KB）把压缩做成状态机：摘要前缀 `SUMMARY_PREFIX`（`:260`）、历史任务快照 `HISTORICAL_TASK_HEADING`（`:257`）、压缩尾标记 `_COMPACTION_TAIL_MARKER`（`:331`）、"结束摘要看下面"提示（`:510`）、最小摘要 token 下限 `_MIN_SUMMARY_TOKENS = 2000`（`:826`）、超时冷却阶梯 `_TIMEOUT_COOLDOWN_LADDER`（`:801`）、连续过载升级（`:813`）。
- `trajectory_compressor.py`（46 KB）是给训练数据的轨迹压缩，与运行时压缩分开。
- 不变量：压缩是**唯一**允许改写历史前缀的操作，其它任何"改历史"都会破坏 prompt 缓存（`AGENTS.md` 第一条不变量）。

**对我们的启发**：我们把上下文完全交给 pi 的自动压缩，房间层只有"shared/summary/isolated"三档粗粒度拼装（`src/rooms/room.js:398-428`）。缺"预算 + 保留区 + 结构化摘要 + 压缩后事件"的显式设计。

## 7. 委派与并行：子代理是产品能力

- `delegate_task`（`tools/delegate_tool.py:559`）支持单任务与批量（`tasks: [...]`），子代理**隔离上下文 + 独立终端会话**；`_build_child_agent`（`:203`）构造子代理；`_run_single_child`（`:370`）执行。
- 角色：`leaf`（默认，不能继续委派/不能 memory/不能 clarify）与 `orchestrator`（保留委派，受 `max_spawn_depth` 限制，默认 2）。
- 并发上限 `delegation.max_concurrent_children` 默认 3；后台委派返回 delegation id，结果经完成队列回灌（`tools/async_delegation.py`）。
- **失败契约**：`output_schema` 校验失败仍保留 `status: completed` + 原文 + `schema_valid: false`，"never discard a child's result"（`tools/AGENTS.md` § Delegation）。

**对我们的启发**：我们有"小群"（`room_create_subgroup`，`src/rooms/room.js:658`）但没有"委派契约"：没有依赖声明、没有冲突检测、没有并发上限、没有失败结果保全。omh 的 fanout_contract/v2 补的正是这一层。

## 8. 插件与 hook：fail-closed 分类

- 19 个插件目录按 kind 组织（memory/context_engine/model-providers/kanban/…），插件**不得改核心**。
- hook 分五类：`policy_gate / prompt_context_contributor / result_transformer / lifecycle_callback / observer`；`pre_tool_call` 是唯一被宿主当成策略门的 hook，**超时即阻断**（fail-closed）——omh `docs/PLUGIN-HOOK-CONTRACT.md:37,58` 引用并固定了这条语义。

**对我们的启发**：`src/hooks.js` 已有 pre/post tool 钩子且默认 deny（fail-closed），但缺"hook 分类"与"超时语义"，也缺"谁能写 hook"的边界。

## 9. 我们采纳 / 改写 / 不采纳（本轮排期）

| # | Hermes 机制 | 落地文件 | 取舍 |
|---|---|---|---|
| A1 | 审批四级闸门（floor→缓存→模式→人工）+ 熔断 + 审计 | `src/approval.js` | **采纳语义，重写实现**（Node/SQLite，无网关审批） |
| A2 | 命名工具集 + includes + 末端减除 + 姿态 | `src/toolsets.js` | **采纳**，工具面按本项目真实工具重列 |
| A3 | 技能 guard + usage 遥测 + curator 闭环 | `src/skills/{guard,telemetry,curator}.js` | **采纳**，安装闸门简化为静态规则 |
| A4 | 记忆写入闸门 + 破坏性审批 + FTS 检索 | `src/memory.js` | **采纳**，先做房间/成员/全局三级 scope |
| N1 | 多平台消息网关（20+ 平台） | — | 不采纳：渠道层会拆掉"群 = 房间"模型 |
| N2 | cron / kanban / voice / computer_use | — | 不采纳：与群聊主流程无关，先不背 |
| N3 | Python 契约层整体移植 | — | 不采纳：运行时是 Node + pi，第二语言 = 第二套权限语义 |
| N4 | 330 KB 压缩状态机整体移植 | — | 不采纳；只取"预算 + 保留区 + 结构化摘要"三条 |
| N5 | 训练用 trajectory 压缩 | — | 不采纳：不是产品路径 |

## 10. 证据索引

- 仓库与不变量：`AGENTS.md`（根）、`README.zh-CN.md:16,23-27`
- 工具：`toolsets.py:11,47,52,57,64,68,71`；`tools/registry.py:121`；`tools/AGENTS.md`
- 审批：`tools/approval_floors.py:1-8,23`；`tools/approval.py:74,276,302,410,491`；`tools/approval_smart.py`；`tools/approval_provenance.py`
- 技能：`tools/skills_guard.py:698,746,822`；`agent/curator.py:160,209`；`tools/skill_usage.py`；`skills/AGENTS.md`
- 记忆：`agent/memory_manager.py:89,138,199`；`tools/memory_tool.py:131,173,179,222,353,374`；`tools/memory_tool_store.py`；`hermes_state_fts.py`
- 压缩：`agent/context_compressor.py:257,260,331,510,801,813,826`
- 委派：`tools/delegate_tool.py:203,370,559`；`tools/async_delegation.py`；`tools/AGENTS.md` § Delegation
- 插件：`plugins/AGENTS.md:7,85`；omh `docs/PLUGIN-HOOK-CONTRACT.md:37,58`
