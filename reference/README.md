# 参考源码（Hermes / oh-my-hermes）

本工程吸收的设计来自下面两个 **MIT** 开源仓库。它们**不随本仓库分发**（体积 300+ MB），
需要时按下面的固定版本浅克隆到 `reference/hermes/` 即可（该目录已在 `.gitignore` 里）。

```bash
mkdir -p reference/hermes && cd reference/hermes

git clone --depth 1 https://github.com/NousResearch/hermes-agent.git hermes-agent
git -C hermes-agent fetch --depth 1 origin ca43606 && git -C hermes-agent checkout ca43606

git clone --depth 1 https://github.com/rlaope/oh-my-hermes.git oh-my-hermes
git -C oh-my-hermes fetch --depth 1 origin 1727425 && git -C oh-my-hermes checkout 1727425
```

| 仓库 | 固定提交 | 许可 | 我们参考的内容 |
|---|---|---|---|
| `NousResearch/hermes-agent` | `ca43606` | MIT | 审批地板/熔断/溯源、工具集、技能守卫与策展、记忆、上下文压缩、委派、review 三态模板 |
| `rlaope/oh-my-hermes` | `1727425` | MIT | 契约层：fanout 任务单元与依赖前沿、证据阶梯（observed/prepared/mismatch）、房间级工具面裁剪、插件 fail-closed |

> 我们的实现是**按语义重写**的 JS（不是复制源码），逐条对照证据见
> [`../docs/hermes/ADOPTION_MATRIX.md`](../docs/hermes/ADOPTION_MATRIX.md) 与
> [`../docs/hermes/HERMES_ARCH.md`](../docs/hermes/HERMES_ARCH.md)。
> 如果同事要做二次对照，请用上表里的**固定提交**，避免上游漂移导致行号对不上。
