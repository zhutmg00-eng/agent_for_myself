# 文档索引（docs/INDEX）

> 先读 [`../HANDOVER.md`](../HANDOVER.md)（交接总览）；想直接跑起来看 [`../README.md`](../README.md) 与 [`../交付说明.md`](../交付说明.md)。
> 本页按「读它的目的」组织，不按写作时间。

## 1. 项目规格与契约（先读）

| 文档 | 内容 |
|---|---|
| [`FUSION_SPEC.md`](FUSION_SPEC.md) | 产品规格：群主分派/权限/群文件/小群/标识的原始构想与实现映射、里程碑 |
| [`CONTRACT_ROOM.md`](CONTRACT_ROOM.md) | 房间/回合/消息/事件的接口契约（状态机与字段） |
| [`CONTRACT_API.md`](CONTRACT_API.md) | HTTP API 契约（路由、请求/响应、错误码） |
| [`BORROWED.md`](BORROWED.md) | 全量借鉴清单：pi / omp / Hermes 的机制、来源、落地与差异（七节） |

## 2. Hermes 吸收（设计与证据）

| 文档 | 内容 |
|---|---|
| [`hermes/ADOPTION_MATRIX.md`](hermes/ADOPTION_MATRIX.md) | **总表**：18 项采纳/改写/部分 + 4 项不采纳 + 1 项未做，逐项带证据与验证 |
| [`hermes/HERMES_ARCH.md`](hermes/HERMES_ARCH.md) | Hermes 架构解剖：工具/审批/技能/记忆/压缩/委派；我们抄什么、不抄什么 |
| [`hermes/OMH_AND_CONTEXT.md`](hermes/OMH_AND_CONTEXT.md) | oh-my-hermes 契约层（fanout/证据阶梯/记忆审查/hook 分类）与 Hermes 压缩、委派 |
| [`hermes/CONTRACT.md`](hermes/CONTRACT.md) | 六轮吸收的**代码契约**（§3/§7/§8/§9/§10）：模块签名与语义 |
| [`hermes/APPROVAL.md`](hermes/APPROVAL.md) | 审批：8 条地板、三态缓存、熔断、审计、等待与失败语义 |
| [`hermes/TOOLSETS.md`](hermes/TOOLSETS.md) | 命名工具集、includes、末端减除、角色裁剪、姿态 |
| [`hermes/SKILLS.md`](hermes/SKILLS.md) | 技能守卫 21 条规则、用量遥测、策展流转 |
| [`hermes/LEARN.md`](hermes/LEARN.md) | 学习闭环：质量闸门 → 五段 playbook → signature 去重 → 提案 |
| [`hermes/JUDGE.md`](hermes/JUDGE.md) | reviewer 三态裁决解析：未表态 ≠ 通过、否定语境、中英混合、多 reviewer |
| [`hermes/MEMORY.md`](hermes/MEMORY.md) | 记忆：三级 scope、FTS5、去重、审计、注入方式 |
| [`hermes/CONTEXT.md`](hermes/CONTEXT.md) | 上下文：水位/增量/确定性摘要/预算裁剪（−62.6% 实测） |
| [`hermes/EVIDENCE.md`](hermes/EVIDENCE.md) | 证据阶梯 observed/prepared/mismatch 判定表、工具化与级联 |
| [`hermes/FANOUT.md`](hermes/FANOUT.md) | 任务单元契约：写域冲突、依赖拓扑序、错误码 |
| [`hermes/EXECUTOR.md`](hermes/EXECUTOR.md) | 执行短路：6 状态机、失败传播、终态先到先得 |
| [`hermes/APPROVALS_UI.md`](hermes/APPROVALS_UI.md) | 审批面板：模式/待裁决/审计/徽标（前端） |
| [`hermes/EVIDENCE_UI.md`](hermes/EVIDENCE_UI.md) | 证据徽标：消息三态、群头汇总、检查器面板（前端） |
| [`hermes/SKILL_PROPOSALS_UI.md`](hermes/SKILL_PROPOSALS_UI.md) | 技能提案面板：筛选/卡片/两段式采纳/拒绝延后（前端） |
| [`hermes/README.md`](hermes/README.md) | 上述文档的目录与阅读顺序（写作时索引） |

## 3. 验收记录（时间序，含失败与修复）

| 记录 | 内容 |
|---|---|
| [`verification/HERMES_ROUND2.md`](verification/HERMES_ROUND2.md) | 审批/工具集/技能/记忆落地验收 |
| [`verification/HERMES_ROUND3.md`](verification/HERMES_ROUND3.md) | 上下文水位/证据阶梯/压缩策略验收 |
| [`verification/HERMES_ROUND4.md`](verification/HERMES_ROUND4.md) | 小群回收/fanout 契约/证据工具/徽标 |
| [`verification/HERMES_ROUND5.md`](verification/HERMES_ROUND5.md) | 执行短路/学习闭环/手动 learn |
| [`verification/HERMES_ROUND6.md`](verification/HERMES_ROUND6.md) | judge 三态/提案面板 |
| [`verification/HERMES_FINAL.md`](verification/HERMES_FINAL.md) | **最终总记录**：294 测试 / 源码 e2e / 打包 e2e / 冒烟 / C 盘 |

## 4. 面向用户

| 文档 | 内容 |
|---|---|
| [`../交付说明.md`](../交付说明.md) | 打开软件、建群、分派、群文件、小群、设置项（最终用户视角） |
| [`../README.md`](../README.md) | 工程视角的快速开始与构想对照 |

## 5. 建议阅读顺序（新同事）

1. `HANDOVER.md`（尤其 §5.2 一条消息的生命周期）
2. `README.md` + `交付说明.md`
3. `FUSION_SPEC.md` → `CONTRACT_ROOM.md` / `CONTRACT_API.md`
4. 按工作方向挑 `docs/hermes/` 里的对应机制
5. `docs/verification/HERMES_FINAL.md` 了解当前基线，再看 `BORROWED.md` 的取舍
