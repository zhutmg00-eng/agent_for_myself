# 验收总记录：Hermes 吸收全流程（最终）

> 工程：`D:\能力测试\fusion`。参考源码：`reference/hermes/{hermes-agent@ca43606, oh-my-hermes@1727425}`（MIT，浅克隆，只读）。
> 运行数据全部在 `D:\能力测试\temp\*`；C 盘零新增（见 §5）。
> 本文是六轮吸收 + 最终全量验收的收口记录；逐轮细节见 `HERMES_ROUND{2,3,4,5,6}.md`，机制总表见 [ADOPTION_MATRIX.md](../hermes/ADOPTION_MATRIX.md)。

## 1. 最终验收结果（2026-11-06）

| 项 | 结果 |
|---|---|
| 单元/接口测试 | **294 / 294 pass**（`node --test`，无网络、无 LLM、数据根隔离） |
| 真实群聊（源码版） | **PASS**，107s：5 条消息、1 个群文件、75 个事件，含 `skill_proposed` |
| 真实群聊（**打包版 exe**） | **PASS**，52s：5 条消息、`note.md` file_id `7fbce062`；**打包版内部自己生成了学习提案** `8f359ba47afe` |
| 桌面冒烟 | **PASS**（health 200、窗口正常、退出 0、无残留进程、C 盘零新增） |
| C 盘污染 | `C:\AgentFusion`、`C:\能力测试`、`~/.fusion`、`AppData\{Roaming,Local}\AgentFusion` 全部 absent |

源码版 e2e 关键输出：

```text
round finished=true in 107s
messages: 5
files: 1  (808bc823 intro.md)
replay events: 75  (含 room.39be96.skill_proposed)
RESULT: PASS
[room] learning proposal created: 31c3658ada01   ← 标题已剥掉「请群主分派：」外壳
```

打包版 e2e 关键输出：

```text
[e2e-packaged] round_completed: true elapsed 52s
[e2e-packaged] messages: 5
[e2e-packaged] files: [{"id":"7fbce062","path":"note.md"}]
[e2e-packaged] RESULT: PASS
2026-11-06T09:48:28Z INFO [skills:curator] proposal 8f359ba47afe created: 写一句话介绍打包版 AgentFusion（30 字内）…
2026-11-06T09:48:28Z INFO [room] learning proposal created: 8f359ba47afe
```

> 结论：**打包后的桌面版在真实回合里跑通了「分派 → 执行 → 证据 → 学习」全链路**，不只是源码测试。

## 2. 本轮收尾修复（真实 e2e 发现的判定缺陷）

打包版 e2e 连续暴露了 reviewer 裁决的否定语境盲区（都是真实模型会说的话）：

| 真实表述 | 旧行为 | 修复 |
|---|---|---|
| 「本环节无需退回」 | `退回` 命中 reject | 否定预处理覆盖 `退回/打回/驳回/否决` |
| 「我没有发现需要退回修改的点」 | `退回` 命中 reject | 否定前缀扩展 `没有/没/未/无 + 发现/看到…` |
| 「两点备注不影响验收，不建议退回」 | `退回` 命中 reject | 否定前缀扩展 `不建议/不推荐/不主张` |

修复后对同一段真实 reviewer 文本直接验证：`verdict=pass, matched="核验结论：四项全部通过…"`。
新增回归用例 3 条（`tests/judge.test.mjs` 共 25 条）。

另：产物 `写一份 100 字以内…` 的提案标题已剥离「请群主分派：让 coder …」指令外壳（`learn.stripDispatchShell`，含回归用例）。

## 3. 工程侧交付（六轮汇总）

- **审批**：8 条硬地板、三态缓存、拒绝熔断、审计溯源、阻塞式等待（`src/{approval,hooks}.js`）
- **工具面**：15 个命名工具集、includes/末端减除、姿态、7 种角色裁剪（`src/toolsets.js`）
- **技能**：21 条安装守卫、用量遥测/衰减评分、策展 stale/archive、**学习闭环**（经验→五步 playbook→提案）、**提案面板**（两段式采纳）（`src/skills/*`、`web/js/views/settings.js`）
- **记忆**：三级 scope、FTS5 检索、去重、审计（`src/memory.js`）
- **上下文**：水位/增量/确定性摘要/预算裁剪（实测 6 轮注入 97,002 → 36,288 字符，**-62.6%**），pi 压缩策略项目级覆盖
- **证据阶梯**：observed/prepared/mismatch + `room_evidence_status` 工具 + 审查员硬约束 + 消息徽标
- **委派**：小群生命周期回收（结论回传即释放会话、父房级联删子房）、fanout 契约（写域冲突硬报错 + 依赖拓扑序）、**执行短路**（失败沿依赖边传播跳过下游）
- **裁决**：reviewer 三态纯函数（可解释），学习闸门识别「在场未表态」
- **文档与验证**：`docs/hermes/` 15 篇 + 5 份验收记录 + 采纳矩阵；真实 e2e 6 次（源码/打包），全部证据在 `D:\能力测试\temp\hermes-e2e*` 与 `pkgdata*`

## 4. 已知边界（明确不做的部分）

多平台网关、cron/kanban/语音、Python 契约层整体移植、训练轨迹与评测集：不采纳（理由见 `ADOPTION_MATRIX.md` §1 与 `HERMES_ARCH.md` §9）。
结构化 pending 落库 + 失败跨轮重试、单聊 Chief 接证据/压缩：留待后续，不影响当前闭环。

## 5. 复现命令

```powershell
cd D:\能力测试\fusion
node --test                                    # 294 tests / 294 pass
node tests/e2e_room.mjs --port 8803            # 源码版真实回合
node scripts/build_portable.mjs --app-only
node tests/e2e_packaged.mjs --port 8814 --data-root D:\能力测试\temp\pkgdata3
node scripts/smoke_desktop.mjs --isolated
# 注意：打包版 e2e 与桌面冒烟不要并发跑（两个 Electron 实例会互相干扰退出）
```
