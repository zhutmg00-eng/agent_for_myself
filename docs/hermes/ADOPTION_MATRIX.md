# Hermes 采纳矩阵（总表）

> 参考源码：`reference/hermes/hermes-agent@ca43606`（22,595 文件 / 232 MB）、
> `reference/hermes/oh-my-hermes@1727425`（3,827 文件 / 105 MB），均 MIT。
> 落地工程：`D:\能力测试\fusion`。状态口径：
> **采纳**＝语义原样落地；**改写**＝保留语义但按 Node/pi/单进程约束重写；**部分**＝只取内核子集；
> **不采纳**＝与本项目模型冲突或超出范围（理由见 `HERMES_ARCH.md` §9）。

## 1. 机制总表

| # | Hermes 机制 | Hermes/omh 证据 | 状态 | 落地 | 验证 |
|---|---|---|---|---|---|
| 1 | 审批硬地板（hardline/floor 先于一切模式） | `tools/approval_floors.py:1-8,23-42`；omh `HARNESS_QUALITY` 相关段 | **采纳** | `src/approval.js#FLOORS` | `tests/approval.test.mjs`（8 条地板，yolo 下仍拦） |
| 2 | 审批三态缓存 once/session/always + patternKey | `tools/approval.py:276,410,491` | **采纳** | `src/approval.js#appr_cache` | `tests/approval.test.mjs`（once 一次性 / session 作用域 / always 跨重启） |
| 3 | 拒绝熔断（连续拒绝后不再问） | `tools/approval.py:74-117` | **改写**（达阈值直接 deny，不再 ask） | `src/approval.js#denialTally` | `tests/approval.test.mjs` |
| 4 | 裁决来源留痕（provenance） | `tools/approval_provenance.py` | **采纳** | `src/approval.js#appr_audit` | `tests/approval.test.mjs`（decision/scope/by/mode/reason/ts） |
| 5 | 阻塞式人工裁决 / 撤回 / 超时 | `tools/approval.py:144-258,802-804` | **改写**（单进程 `waitFor` + AbortSignal） | `src/approval.js#waitFor` + `src/hooks.js` | `tests/hooks_gate.test.mjs`（allow/deny/timeout/abort） |
| 6 | 命名工具集 + includes + 末端减除 + 姿态 | `toolsets.py:11,47,52,57,64,68,71` | **采纳** | `src/toolsets.js` + `engine/archetypes.js#ARCHETYPE_TOOLSETS` | `tests/toolsets.test.mjs` 19 例 |
| 7 | 客户端表面工具集（按会话来源注入） | `toolsets.py:68`、`tools/AGENTS.md` §Surface | **部分**（房间级 `disabled_toolsets` + 身份面；无多客户端） | `Room#setSettings` + `bot.js#hasToolsetPlan` | `tests/room.test.mjs`、`tests/store.test.mjs` |
| 8 | 技能安装闸门（静态扫描） | `tools/skills_guard.py:698,746,822` | **改写**（21 条规则，无信任等级/哈希缓存） | `src/skills/guard.js` | `tests/skills_guard.test.mjs` 20 例 |
| 9 | 技能用量遥测 + 策展流转 | `tools/skill_usage.py`；`agent/curator.py:160,209` | **改写**（14 天半衰期评分、stale/archive，无 LLM 策展） | `src/skills/{telemetry,curator}.js` | `tests/skills_curator.test.mjs` 14 例 |
| 10 | 从经验生成技能（学习闭环） | `README.zh-CN.md:16,23`；`agent/curator.py` 审查流程 | **改写**（确定性 playbook + 质量闸门 + signature 去重） | `src/skills/learn.js` + `Room.proposeLearningSkill` | `tests/learn.test.mjs` 15 例 + 真实 e2e `skill_proposed` |
| 11 | reviewer 三态裁决（Approved/Changes/Reviewed） | `skills/.../review-output-template.md:10,45-49` | **改写**（纯函数 + 可解释 matched/reasons） | `src/skills/judge.js` | `tests/judge.test.mjs` 22 例 |
| 12 | reviewer 是角色不是证据（prepared ≠ observed） | omh `HARNESS_QUALITY.md:757-781`、`ROLES.md:13` | **采纳** | `src/rooms/evidence.js` + `rooms/tools.js#room_evidence_status` + `archetypes.js` 审查员硬约束 | `tests/evidence.test.mjs` 24 例 + e2e（reviewer 实际调用证据工具） |
| 13 | 记忆写入闸门 / 破坏性操作 / 审计 | `tools/memory_tool.py:131,173,179,353` | **改写**（三级 scope + FTS5 + 去重 + 审计；无 pending 队列） | `src/memory.js` | `tests/memory.test.mjs` 21 例 |
| 14 | 上下文压缩（摘要结构 / 最小 token / 冷却阶梯） | `agent/context_compressor.py:257,260,331,510,801,813,826` | **改写**（pi 自带压缩 + 项目级策略覆盖 + 房间水位/预算） | `config.js#COMPACTION` + `engine/bot.js` + `rooms/context.js` | `tests/context.test.mjs` 20 例 + 成本探针 37.4% |
| 15 | 委派/子代理隔离 | `tools/delegate_tool.py:203,370,559` | **部分**（小群 + 生命周期回收；无独立终端/worktree） | `rooms/room.js#createSubgroup/retireSubgroup` + `executor.js` | `tests/room.test.mjs`、`tests/executor.test.mjs` 19 例 |
| 16 | 任务单元契约（写域冲突 / 依赖前沿 / 失败短路） | omh `FANOUT.md:14-20,313-320`；`delegate_tool.py:376-383` | **采纳**（无 worktree） | `src/rooms/fanout.js` + `src/rooms/executor.js` + `room_assign_task` | `tests/fanout.test.mjs` 24 例 + `tests/executor.test.mjs` 19 例 |
| 17 | fail-closed 策略门（pre_tool_call 超时即阻断） | omh `PLUGIN-HOOK-CONTRACT.md:37,58`；`plugins/AGENTS.md` | **采纳** | `src/hooks.js`（静态 deny → 审批 → fail-closed） | `tests/hooks_gate.test.mjs` 8 例 |
| 18 | prompt 前缀缓存神圣（除压缩外不改历史） | `AGENTS.md` 第一条不变量 | **采纳（设计约束）** | 记忆注入走回合提示词、不塞 system prompt；工具面热更新不重建会话 | `docs/hermes/MEMORY.md`、`APPROVALS_UI.md` |
| 19 | 多平台消息网关（Telegram/Discord/…） | `gateway/`、`README.zh-CN.md:22` | **不采纳** | — | 与「群 = 房间」模型冲突 |
| 20 | cron / kanban / 语音 / computer_use | `cron/`、`tools/kanban_tools.py`、`voice_mode.py` | **不采纳** | — | 不属于群聊主流程 |
| 21 | Python 契约层整体移植 | 全仓 | **不采纳** | — | 第二语言 = 第二套权限/工具语义 |
| 22 | 训练轨迹压缩 / 评测集 | `trajectory_compressor.py`、`evals/` | **不采纳** | — | 非产品路径 |
| 23 | 完整记忆审查（采纳/拒绝/延后都写理由） | omh `docs/MEMORY.md` | **未做**（下一轮候选） | — | 当前只有写/删审计 |

## 2. 量化结果

| 指标 | 第一轮前 | 现在 |
|---|---|---|
| 单测 | 41 | **294** |
| 真实群聊 e2e | 83s 级 | 77–198s（模型波动），含证据/学习/执行短路 |
| 打包冒烟 | PASS | PASS（C 盘零新增） |
| 上下文注入成本（6 轮 × 3 成员） | 97,002 字符 | **36,288（37.4%）** |
| Hermes 机制覆盖 | 0 | 采纳/改写/部分 **18 项**，明确不采纳 4 项，未做 1 项 |

## 3. 证据索引

- 架构解剖与取舍：`HERMES_ARCH.md`、`OMH_AND_CONTEXT.md`
- 逐机制：`APPROVAL.md`、`TOOLSETS.md`、`SKILLS.md`、`MEMORY.md`、`CONTEXT.md`、`EVIDENCE.md`、`EVIDENCE_UI.md`、`FANOUT.md`、`EXECUTOR.md`、`LEARN.md`、`JUDGE.md`、`APPROVALS_UI.md`、`SKILL_PROPOSALS_UI.md`
- 验收记录：`docs/verification/HERMES_ROUND{2,3,4,5,6}.md` + **最终总记录 `HERMES_FINAL.md`**（294 测试 / 源码 e2e / 打包 e2e / 冒烟）
- 代码契约：`docs/hermes/CONTRACT.md`（§3、§7、§8、§9、§10）
