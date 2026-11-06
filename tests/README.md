# fusion/tests — 验收测试（node:test，无需网络/LLM）

| 文件 | 覆盖 |
|---|---|
| `store.test.mjs` | SQLite 仓储全表往返：bots / rooms / members / messages / files / notices / kv / events / usage / tickets，含 `close() → reopen()` 持久化 |
| `files.test.mjs` | 群文件空间：save / list / read / move / remove、`file_id` 稳定性、`file_saved` / `file_moved` 事件、移动后的 pending notice、200KB 截断、路径收敛（禁穿越/禁 C 盘） |
| `room.test.mjs` | 回合编排（假 BotRunner 桩）：owner 先发言 → `room_assign_task` 分派后只跑被分派成员、事件序列（round_started / member_started / turn_completed / member_finished / round_completed）、三种 context_policy 与成员 `context_access` 覆盖、@提及、静音、异常成员、熔断、notices/文件索引注入 |
| `manager.test.mjs` | RoomManager：`create`（include_roles / 最小响应 / 去重 / 校验）→ 落库 + `harness.room.created`；`get/list/snapshotAll`；`restore` 重启恢复；`delete` |
| `e2e_*.mjs` | 真实链路冒烟（需要网关/LLM），**不属于** `node --test` 默认用例集 |

## 运行

在本目录的上一级（`fusion/`）执行：

```powershell
$env:TEMP='D:\能力测试\temp'; $env:TMP='D:\能力测试\temp'
node --test                                  # 递归发现 **/*.test.mjs（自动跳过 node_modules）
node --test "tests/**/*.test.mjs"            # 等价写法
node --test tests/store.test.mjs tests/room.test.mjs   # 指定文件
```

> 本机 Node 24.21 的 `node --test` **不接受目录参数**（`node --test tests/` 会把 `tests`
> 当成模块路径报 `MODULE_NOT_FOUND`），因此请用上面三种写法之一。

## 隔离约定（`_helpers/env.mjs`）

- 每个测试文件（`node --test` 为每个文件起独立子进程）在**导入任何 `src/` 模块之前**把
  `FUSION_DATA_ROOT` / `TEMP` / `TMP` 指向 `D:\能力测试\temp\fusion-tests\<文件>-<pid>-<随机>`，
  所以 `src/config.js` 的 `DIRS`、SQLite、群文件、日志、pi 的 agentDir 全部落在该临时目录。
- 辅助模块断言数据根不在 C 盘；文件级 `after()` 钩子先关闭所有 Store（倒序）再删除临时根。
- 任何真实报错仍会让测试失败；只有 teardown 期间 logger 追加写入的 `ENOENT app.log` 竞态被忽略。
