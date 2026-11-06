# 推送到 GitHub（PUSH）

目标仓库：`https://github.com/zhutmg00-eng/agent_for_myself`

本目录已经是**完整的 git 仓库**（已初始化、已提交），只差推送。当前网络无法访问 GitHub，
所以下面给出三条路，任选其一。

## 方式 A：直接推（网络可用时）

```powershell
cd D:\能力测试\agent_for_myself

git remote -v                       # 应看到 origin 指向上面的仓库
git push -u origin main
```

认证二选一：
- **HTTPS + PAT**：`git remote set-url origin https://<你的用户名>:<个人访问令牌>@github.com/zhutmg00-eng/agent_for_myself.git`
  （令牌需要 `repo` 权限；用完记得 `git remote set-url` 去掉令牌）
- **SSH**：`git remote set-url origin git@github.com:zhutmg00-eng/agent_for_myself.git`，并确认 `ssh -T git@github.com` 通。

## 方式 B：离线 bundle（已有产物）

同目录外有 `agent_for_myself.bundle`（完整历史）。在任意联网机器：

```powershell
git clone agent_for_myself.bundle agent_for_myself
cd agent_for_myself
git remote set-url origin https://github.com/zhutmg00-eng/agent_for_myself.git
git push -u origin main
```

## 方式 C：换台机器再推

把整个 `agent_for_myself` 目录（含 `.git`）拷走，在联网机器上执行 `git push -u origin main`。

## 推送前检查

```powershell
git status --short          # 应为空（或只有你新加的文件）
git log --oneline -5
git ls-files | Select-String -Pattern 'node_modules|dist/|\.db$|\.log$|temp/'   # 应无输出
```

仓库里**不应有**：`node_modules/`、`dist/`、`data/`、`*.db`、`*.log`、`.pi-agent/`、参考源码、任何密钥。
`.gitignore` 已经覆盖这些；如新增文件类型，先确认不会泄露本机路径/令牌。
