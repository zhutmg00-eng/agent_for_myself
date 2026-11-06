# Toolset（工具集）吸收说明

> 交付物：`src/toolsets.js`（395 行，纯常量 + 纯函数）、`tests/toolsets.test.mjs`（19 用例）。
> Hermes 证据基于 `reference/hermes/hermes-agent`（commit `ca43606`）；Fusion 证据基于本仓库当前文件。

## 1. Hermes 里是什么

1. **单一字典描述全部工具分组**：`TOOLSETS = {`（`hermes-agent/toolsets.py:71`），条目形如
   `"file": _ts("File manipulation tools: ...", ["read_file","write_file","patch","search_files"])`（`:119-123`）、
   `"web"`（`:73`）、`"search"`（`:74`）、`"skills"`（`:100`）、`"memory"`（`:126`）、`"delegation"`（`:153`）。
2. **共享核心工具集**：`_HERMES_CORE_TOOLS`（`toolsets.py:11-36`）是 CLI 与所有消息平台共用的那一份；
   平台 bundle 用 `_bundle()` 在它之上追加平台专属工具（`:52-54`），`_core_without()` 则做「核心减一批、顺序保持」
   （`:57-59`）。
3. **declaration 只用两种成分**：`_ts(description, tools=(), includes=(), **extra)`（`toolsets.py:47-49`），
   即「直接工具名」+「引用别的工具集」；`debugging` 就是 `includes=["web","file"]`（`:171`），`safe` 是
   `includes=["web","vision","image_gen"]`（`:172`）。
4. **includes 递归 + 环检测 + 通配**：`resolve_toolset()`（`toolsets.py:363-407`）用共享 `visited` 处理钻石 include
   与环——重复进入直接返回 `[]`（`:389-392`）；`"all"`/`"*"` 展开成除平台门控外的全部工具集（`:382-387`）；
   末端 `sorted(tools)` 输出（`:402`）。`validate_toolset()` 把 `all`/`*` 也算合法（`:494-496`）。
5. **coding 是一个 posture 条目，不是另一份手工清单**：`_CODING_TOOLS = _core_without("image_generate",
   "text_to_speech", "cronjob_manage", "computer_use", kanban=False)`（`toolsets.py:64`），再作为一个
   `posture=True` 的工具集登记（`:178-183`）。
6. **disabled 是管线末端严格减除**：`_select_tool_names()` 先并入 enabled，再统一减 disabled
   （`model_tools.py:333-355`，注释 `:349-354`「Disabled toolsets are always subtracted LAST」）；
   `get_tool_definitions()` 的 docstring 也写明「enabled_toolsets None = all; disabled_toolsets are subtracted after
   enabling」（`model_tools.py:231`）。因此一个工具被哪个工具集「拥有」必须唯一——`web_search` 只留在 `web`/`search`，
   否则 `disabled_toolsets:[browser]` 会把它从所有会话里剥掉（`toolsets.py:105-108`，issues #17309/#64503）。
7. **禁 posture/bundle 时的特殊减法**：disable 一个 posture 或平台 bundle 时，只减「非核心 delta」，不整包减
   （`model_tools.py:307-319`，`bundle_non_core_tools()` `toolsets.py:318-333`），避免把共享核心工具一起清空。
8. **工具集是「会话面」的闸门，`check_fn` 只回答可达性**：`tools/AGENTS.md:185-196`「Surface capability is a
   property of the SESSION, never of the process env」「The toolset is the surface gate」；`check_fn` 只答「bridge 通了没 /
   有没有 key」（`:198-200`），不答「谁在用」。
9. **概率分布只在数据生成用**：`toolset_distributions.py:18-46` 用 30%/50%/97% 采样工具集组合，
   `sample_toolsets_from_distribution()`（`:67-93`）支持 `"browser+search"` 一次掷骰保证共现。

## 2. 为什么值得抄（对应我们群聊产品的缺口）

- **工具面手写且分散**：8 个 archetype 各写一份 `tools`（`src/engine/archetypes.js:108`、`:195`、`:216`），
  群工具又另有一份 `ROOM_TOOL_NAMES`（`archetypes.js:46-62`）；改一个工具要改 5 处，容易漏。
- **只读约束是「事后过滤」**：`bot.js:25` 定义 `MUTATING_TOOLS`，`:106` 与 `:481-484` 在构造/热更新时再过滤，
  `:255-269` 还加了一层运行时 block。三层防线说明「只读」没有在工具面定义处表达清楚。
- **没有声明式裁剪**：房间/成员想少给几个工具，只能改代码或整包换 `tools` 数组，无法「保留 coding 面但禁执行」。
- **工具面不可审计**：没有一个函数能回答「coder 现在到底有哪些工具、为什么少了 bash」。
- **权限与工具面耦合**：`rooms/tools.js:184` 用 archetype 名硬编码 `canWrite`，`:331-360` 按 owner/perms 拼装；
  新增身份就要改这里。

## 3. 我们落地成什么（`src/toolsets.js`）

**接口（与契约 §3.2 一致；表格末尾几行是附加导出，不影响契约签名）**

| 导出 | 位置 | 说明 |
|---|---|---|
| `CORE_TOOLS` | `src/toolsets.js:17` | pi 内置工具全集：read/write/edit/bash/powershell/grep/find/ls（顺序对齐 `bot.js:28` ALL_TOOL_NAMES） |
| `TOOLSETS` | `:43` | 14 个命名工具集：`search/file_read/file_write/file/exec/skills/room/room_files_read/room_files_write/room_files/delegate/review/memory/web` |
| `POSTURES` | `:94` | `coding`（file+exec+room_files+skills）/ `review`（review+skills，只读）/ `minimal`（read+ls） |
| `listToolsets()` | `:286` | `[{name, description, tools, includes, size}]`，`size` = 展开 includes 去重后的数量 |
| `expandToolset(name, {disabled, seen})` | `:308` | 递归展开 + 末端减除；`seen` 供环检测复用 |
| `resolveToolsets(names, {disabled, extra})` | `:323` | 多集合合并 → 去重 → 排序 → 减除 |
| `toolsForRole({role, toolsets, disabledToolsets, extraTools})` | `:360` | 身份默认面 + 显式集合 + 姿态 + 额外工具 → 减除 → 只读硬过滤 |
| `isKnownToolset(name)` | `:383` | `all`/`*` 也算已知（对齐 Hermes `validate_toolset`） |
| `unknownToolsets(names)` | `:391` | 去重保序返回未知名字，供配置加载时报错 |
| `resolvePosture(name, opts)`（附加） | `:339` | 姿态解析，`toolsForRole` 内部复用 |
| `ROLES`（附加） | `:117` | owner/worker/member/reviewer/librarian/writer/guest 七个身份 → 默认面 |
| `READ_ONLY_TOOLS`/`MUTATING_TOOLS`（附加） | `:20`/`:23` | 与 archetypes.js/bot.js 现有名单同源，便于 Lead 收敛常量 |

**关键语义**

- **includes 深度优先、共享 `seen`**（`:245-266`）：环与钻石 include 静默返回 `[]`（Hermes `toolsets.py:389-392` 同款）。
- **disabled 末端严格减除**（`:267-284`）：条目可以是工具名，也可以是工具集名（含 `all`）；即使工具是通过 includes
  间接带进来的，也照减（对应 Hermes #17309 语义）。减除集合先算好，再一次性从结果里过滤（`:308-337`）。
- **输出按全局声明序，且与传入顺序无关**（`:194-225`）：`CORE_TOOLS` 先定序，群工具按 `TOOLSETS` 声明顺序补；
  未登记的工具（`extra`）排在最后、保持「先出现先输出」。这样 `resolveToolsets(["file","exec"])` 与
  `resolveToolsets(["exec","file"])` 逐字相同，便于断言与 diff。
- **role 只读是硬约束**（`:360-381`）：`ROLES[role].readOnly` 命中后还会再减一次 `MUTATING_TOOLS`，即使调用方传了
  `extraTools:["bash"]` 也拿不到——与 `bot.js` 的只读护栏同向，属于纵深防御。
- **查表只认自有属性**（`:227-243`）：`role: "constructor"`、`posture: "toString"` 这类名字来自房间设置/API 入参，
  拼错时回落（角色回落 member、姿态回落身份默认），不会命中 `Object.prototype`，也不会抛错。
- **常量深冻结、函数纯**（`:158-164`）：不 import pi、不读盘、不联网；`defs` 是唯一的测试注入口（默认 `TOOLSETS`）。

**没有表结构**：本模块不落库（契约 §2 的表前缀约定不适用），也不判断工具是否真的挂载——「可允许面」与
`rooms/tools.js` 的「已挂载面」是两个概念。

**采纳 / 改写 / 不采纳**

- 采纳：单一 `TOOLSETS` 字典、`includes` 递归复用、共享 `visited` 环检测、`all`/`*`、disabled 末端严格减除、
  posture 作为独立预设（而非第二份清单）、`validate_toolset` 式查询。
- 改写：① 输出用**声明序**而不是 Hermes 的 `sorted()`（`:402`），因为我们靠顺序做人工审查，且声明序断言更稳；
  ② `disabled` 同时接受**工具名**（Hermes 只接受工具集名，`model_tools.py:300-330`）；③ 增加 `role` 层（群聊特有，
  Hermes 没有）；④ `readOnly` 硬过滤，对应我们的只读 archetype。
- 不采纳：registry / MCP 动态合并与别名（`toolsets.py:274-315`，我们无插件注册表）、平台 bundle 与
  `CLIENT_SURFACE_TOOLSETS`/session-platform 门控（`:68`、`:449-466`，我们只有一个 pi 宿主）、
  `bundle_non_core_tools` 特殊减法（`:318-333`，我们不用 bundle 禁用法）、概率分布采样
  （`toolset_distributions.py:67-93`，那是一次性数据生成的用法，群聊不需要随机工具面）。

## 4. 与 Hermes 的差异与取舍

- **规模**：Hermes `toolsets.py` 515 行 / 近 60 个工具集 / 注册表合并；我们 395 行、14 个集合，符合契约
  「只取内核语义、≤400 行/模块」（CONTRACT.md §0.6）。
- **工具名不同源**：Hermes 是 `read_file/write_file/patch/terminal`，我们是 pi 的 `read/write/edit/bash/powershell`。
  因此不能照搬 Hermes 的集合名（`file` 同名但内容不同），doc 里也不做名字对齐，只对语义。
- **没有 `check_fn`**：Hermes 用 `check_fn` 回答「有没有 key / bridge 通没通」（`tools/AGENTS.md:198-200`）；
  pi 的工具要么在、要么不在，`web`/`memory` 直接留空占位，等接入后再填工具名。
- **没有 `hermes-*` 平台 bundle**：我们只有一个宿主（pi），平台差异体现为「房间设置里的 disabledToolsets」，
  而不是平台 bundle。
- **顺序策略**：Hermes 排序输出是为了让缓存 key 稳定（`_tool_defs_cache_key` 用 frozenset，`model_tools.py:292-297`）；
  我们排序是为了可断言。两者都稳定，动机不同。
- **role 层是我们新增的**：Hermes 的身份由平台 bundle 决定；群聊里「群主/审查员/文件管家」是产品概念，
  所以做成 `ROLES` 数据表，而不是散落在各调用点。

## 5. 验证证据

```text
$ cd D:\能力测试\fusion; node --test tests/toolsets.test.mjs
ℹ tests 19   ℹ pass 19   ℹ fail 0   ℹ duration_ms 370.97
```

覆盖：`CORE_TOOLS` 与 archetype 并集对齐、≥10 个工具集与中文描述/形状、`listToolsets` 声明序与 `size`、
includes 展开（file/review/room_files）、disabled 减工具名、disabled 减工具集名（含间接 include、`all` 自减）、
三种 posture、七个 role 的工具面差异、未知 role 回落、只读角色对 `extraTools` 的硬过滤、
去重与顺序稳定（正反序相同）、extra 追加与落位、未知名字（`unknownToolsets`/`isKnownToolset`）、`all`/`*`、
循环 includes（环/自环/钻石注入 `defs`）、原型链名字不穿透、空输入、深冻结与入参不可变。

```text
$ cd D:\能力测试\fusion; node --test
ℹ tests 118   ℹ pass 118   ℹ fail 0
```

全量全绿（本次交付时 118 个用例，含 store/room/manager/files/approval/skills 套件；数字会随并行模块增加）。
未新增依赖、未写 C 盘、未改任何共享文件。

## 6. Lead 接入清单

1. **archetype 增加可选 `toolsets` 字段（向后兼容）**
   - `src/engine/archetypes.js` 的 `archetype()` 加默认 `toolsets: null`、`toolsetsRole: null`；
     `buildBot()` 里仅当 `(overrides.toolsetsRole || archetype.toolsetsRole)` 非空时才走
     `toolsForRole({ role, toolsets: archetype.toolsets || [], disabledToolsets: overrides.disabledToolsets })`，
     否则继续用 `[...archetype.tools]`。`overrides.tools` 仍然最高优先——**现有 bot 记录一个字节都不变**。
   - 建议映射：`boss→owner`、`coder→worker`、`reviewer→reviewer`、`librarian→librarian`、
     `writer→writer`、`analyst→worker`、`explore/planner/general→member`。其中 boss/reviewer/explore/planner/general
     当前 `readOnly:true`，与 owner/member/reviewer 的默认面（均不含 MUTATING_TOOLS）一致，切换是等价替换。
2. **bot.js 用 `toolsForRole` 生成白名单**
   - `BotRunner` 构造参数加 `toolsetOptions = { role, toolsets, disabledToolsets }`；`this.tools` 的兜底
     `["read","grep","find","ls"]`（`bot.js:105`）改成 `toolsForRole({ role: "member" })`。
   - 热更新沿用 `setActiveTools()`（`bot.js:481-494`）：房间设置变化时由 Room 调
     `setActiveTools(toolsForRole({ role, toolsets, disabledToolsets }))`，`session.setActiveToolsByName` 不动。
   - 可选：`MUTATING_TOOLS` 改成 `import { MUTATING_TOOLS } from "../toolsets.js"`，两处名单从此同源。
   - 注意：`activeToolNames()` 会把 `customTools`（群工具）并进去；工具集减除只作用于 pi 白名单，
     群工具该不该挂载由 `createRoomTools` 决定（见下条）。
3. **rooms/tools.js 用工具集名单做一致性校验**
   - `createRoomTools`（`rooms/tools.js:331-360`）的 owner 分支可用 `expandToolset("room")`、文件分支可用
     `expandToolset("room_files_write")` 作为 permit 名单，替代手写清单。
   - 房间级禁用 `room_files_write` 时：先算 `toolsForRole({ role:"librarian", disabledToolsets })`，
     用它决定 `canWrite`（`rooms/tools.js:184`），不要再用 archetype 名硬编码。
4. **房间设置（需要 Lead 拍字段名）**
   - 建议键：`room.settings.disabled_toolsets: string[]`（默认 `[]`）。写入前调用 `unknownToolsets(list)`，
     非空则拒绝并返回 `{ ok:false, error: "unknown toolsets: ..." }`（不要静默忽略，否则工具面会莫名收窄）。
   - 优先级建议：`bot 级 toolsets` > `room.settings.disabled_toolsets` > 全局默认（`config.js` 或 kv）。
5. **api/server.js（可选，只读）**
   - 新增 `GET /api/toolsets` → `listToolsets()`，设置页直接渲染分组与 `size`；保存接口复用第 4 条的校验。
6. **需要 Lead 决策的问题**
   - `memory`/`web` 两个占位集合的最终工具名（`src/memory.js` 落地后要补哪些；是否接 MCP 搜索）。
   - `toolsForRole` 的可选 `posture` 覆盖参数要不要写进契约 §3.2（不传 = 契约行为；`null` = 明确不用姿态；
     未知名字 = 回落身份默认。若不需要，删掉这个参数不影响契约签名与现有调用）。
   - 房间级禁用的存储位置（`room.settings` vs `store.getKv`）与默认值。
   - 是否把 `roomTools`（可允许面）与 `tools`（pi 白名单）合并成单一来源；我的建议是保留两个概念，
     由工具集作为两者的公共词汇表。
