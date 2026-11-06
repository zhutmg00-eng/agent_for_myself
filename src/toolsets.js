/**
 * Toolset：把「一个 bot 这一轮该看到哪些工具」从散落的静态数组收敛成可组合、可减除、可断言的声明。
 *
 * 为什么要这一层（语义照抄 Hermes `toolsets.py`，规模不照抄）：
 * - 群聊里 8 个 archetype × 只读/可写 × 群主/成员 × 房间级开关，若每个 bot 手写一份数组，
 *   改一处要改 N 处，还容易把只读约束写漏（`bot.js` 只能在构造时用 MUTATING_TOOLS 事后过滤）。
 * - Hermes 的答案是单一 `TOOLSETS` 字典（toolsets.py:71）+ `includes` 递归复用（:363）+
 *   `disabled_toolsets` 末端严格减除（model_tools.py:349-354）。我们只取这三条内核语义。
 * - `posture` 对应 `_CODING_TOOLS`（toolsets.py:64）：同一批工具按「此刻在干什么」裁剪；
 *   `role` 是群聊特有的身份层（群主/成员/审查员…）。
 *
 * 边界：不 import pi、不读盘、不联网、无副作用；只描述工具名，不创建实现（内置工具由 pi 提供，
 * 群工具由 `src/rooms/tools.js` 挂载）；空工具集合法（`web`/`memory` 是占位）。
 */

/** 本项目群的 pi 内置工具全集（顺序对齐 `bot.js:28` ALL_TOOL_NAMES；覆盖 READ_ONLY_TOOLS 与 8 个 archetype 的并集）。 */
export const CORE_TOOLS = Object.freeze(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);

/** 只读工具（与 `src/engine/archetypes.js:40` 的 READ_ONLY_TOOLS 保持一致）。 */
export const READ_ONLY_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);

/** 会改状态或执行命令的工具（与 `src/engine/bot.js:25` 的 MUTATING_TOOLS 一致）。 */
export const MUTATING_TOOLS = Object.freeze(["write", "edit", "bash", "powershell"]);

/**
 * 一条工具集声明（等价 Hermes `_ts()`，toolsets.py:47）。
 * 每次新建数组，避免不同条目共享同一个可变数组。
 */
function ts(description, tools = [], includes = []) {
  return { description, tools: [...tools], includes: [...includes] };
}

/**
 * 命名工具集。
 *
 * 声明顺序就是「输出顺序」的兜底依据（见文件底的排序说明）：`read/write/edit…`
 * 等 pi 内置工具由 CORE_TOOLS 定序，群工具由这里首次出现的顺序定序。所以
 * `room` 必须排在 `room_files_*` 之前，输出才会是「成员 → 文件」的自然分组。
 *
 * 命名约定：工具集名不得与任何工具名重名——`disabled` 同时接受两者，重名会让
 * 减除语义二义（见 tests/toolsets.test.mjs 的不重名用例）。
 */
export const TOOLSETS = deepFreeze({
  // 检索定位：只看结构，不读全文、不改盘。
  search: ts("检索定位：按内容/文件名找东西（grep/find/ls），只读无副作用", ["grep", "find", "ls"]),

  // 文件面：拆成读/写两块，审查员与文案只拿其中一块。
  file_read: ts("只读文件面：看内容与目录结构，不改盘", ["read"], ["search"]),
  file_write: ts("写文件面：局部替换（edit）与整文件重写（write）", ["write", "edit"]),
  file: ts("文件全套：读 + 写 + 检索（写码、写文档的默认面）", [], ["file_read", "file_write"]),

  // 执行面：Windows 上 bash 走 Git Bash、powershell 走 PowerShell。
  exec: ts("执行面：跑命令与脚本（bash / powershell）", ["bash", "powershell"]),

  // 技能面：列出并加载 SKILL.md 指令包（rooms/tools.js 的 skill_* 工具）。
  skills: ts("技能面：列出技能并按其指令工作（skill_list / skill_invoke）", ["skill_list", "skill_invoke"]),

  // 群管理面：群主专属（rooms/tools.js 的 adminTools + subgroupTool）。
  room: ts(
    "群管理面：看成员、分派任务、授予/收回权限、改上下文策略与主题、拉小群（群主专属）",
    [
      "room_list_members",
      "room_assign_task",
      "room_grant_permission",
      "room_revoke_permission",
      "room_set_context_policy",
      "room_set_topic",
      "room_create_subgroup",
    ],
  ),

  // 群文件面：同样拆读/写，文件管家拿全套，其他成员只拿只读部分。
  room_files_read: ts("群文件只读面：按 file_id 浏览与读取群文件", ["room_file_list", "room_file_read"]),
  room_files_write: ts("群文件写入面：落盘产出、移动/重命名（移动会通知全员）", ["room_file_save", "room_file_move"]),
  room_files: ts("群文件全套：浏览/读取/落盘/移动（文件管家的默认面）", [], ["room_files_read", "room_files_write"]),

  // 委派面：群聊里的「分派」不是子代理，而是指派成员或拉小群闭门讨论。
  delegate: ts("委派面：把任务分派给成员，或拉小群闭门讨论后回收结论", ["room_assign_task", "room_create_subgroup"]),

  // 证据面：查成员回合的证据判定（observed / prepared / mismatch）。
  evidence: ts("证据面：查询本群每个成员回合的证据判定（只读）", ["room_evidence_status"]),

  // 只读审查合集：工作区只读 + 群文件只读 + 证据查询，故意不含任何写/执行工具。
  review: ts("只读审查合集：工作区只读 + 群文件只读 + 证据查询（审查员默认面）", [], ["file_read", "room_files_read", "evidence"]),

  // 记忆面：跨回合读写持久记忆（rooms/tools.js 的 memory 工具，src/memory.js 提供存储）。
  memory: ts("记忆面：跨回合读写持久记忆（room / bot / global 三级 scope，可检索、可审计）", ["memory"]),

  // 占位：pi 侧暂无内置联网工具；接入搜索/MCP 后把名字补进这里。
  web: ts("联网面：pi 侧暂无内置联网工具，预留占位（接入搜索/MCP 后填充）"),
});

/**
 * 会话姿态（对齐 Hermes：`_CODING_TOOLS` toolsets.py:64 就是「核心工具减掉一批」）。
 * `toolsets` 与 `tools` 会一起并入，`tools` 用来写「不属于任何工具集的零散工具」。
 */
export const POSTURES = deepFreeze({
  // 写码姿态：文件读写 + 执行 + 群文件落盘 + 技能
  coding: {
    description: "写码姿态：文件读写 + 执行 + 群文件落盘 + 技能（对齐 Hermes 的 coding posture）",
    toolsets: ["file", "exec", "room_files", "skills"],
    tools: [],
  },
  // 只读审查姿态：天然不含 write/edit/bash/powershell
  review: {
    description: "只读审查姿态：只有「只看不改」的面，天然不含 write/edit/bash/powershell",
    toolsets: ["review", "skills"],
    tools: [],
  },
  // 最小姿态：只想清楚或只看结构时用
  minimal: { description: "最小姿态：只想清楚或只看结构时用，只给 read + ls", toolsets: [], tools: ["read", "ls"] },
});

/**
 * 群内身份 → 默认面。`posture` 为 null 表示这个身份由 `toolsets` 精确拼装，
 * 不吃姿态预设。`readOnly` 是硬约束：命中后 `toolsForRole` 会再减一次
 * MUTATING_TOOLS，即使调用方显式传了 extraTools 也拿不到写/执行工具
 * （与 bot.js 的只读护栏同向，属于纵深防御）。
 */
export const ROLES = deepFreeze({
  // 群主：群管理 + 只读文件/群文件 + 技能
  owner: {
    description: "群主：群管理面 + 只读文件/群文件 + 技能，不碰执行与写盘",
    posture: null, toolsets: ["room", "file_read", "room_files_read", "skills"], readOnly: true,
  },
  // 执行型成员：写码全套
  worker: {
    description: "执行型成员：写码全套（文件 + 执行 + 群文件 + 技能）",
    posture: "coding", toolsets: [], readOnly: false,
  },
  // 普通成员（默认）：只读协作面
  member: {
    description: "普通成员（默认）：只读协作面，能看能说不能改",
    posture: null, toolsets: ["file_read", "room_files_read", "skills"], readOnly: false,
  },
  // 审查员：只读审查面
  reviewer: {
    description: "审查员：只读审查面，不能改文件也不能跑命令",
    posture: "review", toolsets: [], readOnly: true,
  },
  // 文件管家：群文件读写 + 只读工作区
  librarian: {
    description: "文件管家：群文件读写 + 只读工作区 + 技能",
    posture: null, toolsets: ["room_files", "file_read", "skills"], readOnly: false,
  },
  // 文案：工作区读写，但不跑命令
  writer: {
    description: "文案：工作区读写（不跑命令）+ 群文件落盘",
    posture: null, toolsets: ["file", "room_files", "skills"], readOnly: false,
  },
  // 最小面：只给 read + ls
  guest: {
    description: "最小面：只给 read + ls",
    posture: "minimal", toolsets: [], readOnly: true,
  },
});

/* --------------------------------------------------------------- 内部工具 */

/** 深冻结（常量对外只读；`defs` 注入口仍接受普通对象）。 */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** 统一成数组：`undefined`/`null` → `[]`，单值 → 单元素数组。 */
function toList(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/** 只接受非空字符串，并去掉首尾空白（工具名/工具集名都是标识符）。 */
function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 按输入顺序去重（保留第一次出现），用于工具集名这类无全局序的列表。 */
function dedupeNames(names) {
  const seen = new Set();
  const out = [];
  for (const item of toList(names)) {
    const name = clean(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 全局工具声明序：CORE_TOOLS 先定序，随后按 TOOLSETS 声明顺序补齐群工具。
 * 未登记的工具（`extra` 里的新名字）排名相同，靠稳定排序保持「先出现先输出」。
 */
const TOOL_ORDER = (() => {
  const order = new Map();
  const rank = (name) => {
    if (!order.has(name)) order.set(name, order.size);
  };
  CORE_TOOLS.forEach(rank);
  for (const def of Object.values(TOOLSETS)) def.tools.forEach(rank);
  return order;
})();

/** 某个工具在声明序里的位置；未登记的排到最后。 */
function rankOf(name) {
  const index = TOOL_ORDER.get(name);
  return index === undefined ? Number.MAX_SAFE_INTEGER : index;
}

/** 去重 + 按全局声明序排序（与传入顺序无关，便于断言和 diff）。 */
function orderedUnique(tools) {
  const seen = new Set();
  const out = [];
  for (const item of toList(tools)) {
    const name = clean(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.sort((a, b) => rankOf(a) - rankOf(b));
}

/**
 * 安全查表：只用自有属性，避免 `constructor` / `toString` 这类原型链名字穿透。
 * 名字可能来自房间设置或 API 入参，拼错时应当回落而不是命中 Object.prototype。
 */
function lookup(table, name) {
  const key = clean(name);
  if (!key || !Object.hasOwn(table, key)) return null;
  return table[key];
}

/** 名字是否是已定义的工具集（含 Hermes 的 `all` / `*` 通配，toolsets.py:382、:494）。 */
function isKnownIn(defs, name) {
  const key = clean(name);
  if (!key) return false;
  return key === "all" || key === "*" || Boolean(lookup(defs, key));
}

/**
 * 原始展开：一个工具集 + 其 includes 的全部工具名（未去重、未减除）。
 * `seen` 共享给整棵树：环与钻石 include 都静默返回空——工具已经由另一条路径
 * 收齐了（Hermes toolsets.py:389-392 同款处理）。
 */
function rawExpand(defs, name, seen) {
  const key = clean(name);
  if (!key) return [];
  if (key === "all" || key === "*") {
    const all = [];
    for (const toolsetName of Object.keys(defs)) all.push(...rawExpand(defs, toolsetName, seen));
    return all;
  }
  if (seen.has(key)) return [];
  const def = lookup(defs, key);
  if (!def) return [];
  seen.add(key);
  const tools = [...(def.tools || [])];
  for (const included of toList(def.includes)) tools.push(...rawExpand(defs, included, seen));
  return tools;
}

/**
 * disabled 的减除集合：条目既可以是工具名，也可以是工具集名（含 `all`）。
 * 工具集名展开成「该集合当前能解析出的全部工具」；其余按工具名处理，未知名字
 * 也照减（严格减除，不会因为写错名字就把工具留下）。
 */
function disabledSet(entries, defs) {
  const removed = new Set();
  for (const entry of dedupeNames(entries)) {
    if (isKnownIn(defs, entry)) {
      for (const tool of rawExpand(defs, entry, new Set())) removed.add(tool);
    } else {
      removed.add(entry);
    }
  }
  return removed;
}

/* --------------------------------------------------------------- 对外接口 */

/**
 * 列出全部命名工具集（声明顺序）。
 * `size` = 展开 includes、去重后的工具数；复合工具集（`includes` 非空）的 size
 * 会大于 `tools.length`（Hermes `get_toolset_info` 的 tool_count，toolsets.py:504）。
 */
export function listToolsets() {
  return Object.keys(TOOLSETS).map((name) => {
    const def = TOOLSETS[name];
    const resolved = new Set(rawExpand(TOOLSETS, name, new Set()));
    return {
      name,
      description: def.description,
      tools: [...def.tools],
      includes: [...def.includes],
      size: resolved.size,
    };
  });
}

/**
 * 展开单个工具集（含 includes），并在末端减去 `disabled`。
 * @param {string} name 工具集名（`all` / `*` 表示全部）
 * @param {{disabled?: string[], seen?: Set<string>, defs?: object}} [options]
 *   `seen` 供递归/多次调用复用；`defs` 是纯注入点，生产默认用 TOOLSETS
 *   （测试用它造环，避免改动被冻结的常量）。
 * @returns {string[]} 去重、按声明序排列的工具名
 */
export function expandToolset(name, { disabled = [], seen = new Set(), defs = TOOLSETS } = {}) {
  if (!clean(name)) return [];
  const tools = rawExpand(defs, name, seen);
  const removed = disabledSet(disabled, defs);
  return orderedUnique(tools.filter((tool) => !removed.has(tool)));
}

/**
 * 解析多个工具集：按声明序合并、去重，再追加 `extra`，最后末端严格减除
 * `disabled`（工具名或工具集名都可）。未知工具集名静默忽略，用
 * `unknownToolsets()` 事前校验并提示。
 * @param {string[]} names 工具集名列表（顺序不影响输出）
 * @param {{disabled?: string[], extra?: string[], defs?: object}} [options]
 * @returns {string[]}
 */
export function resolveToolsets(names, { disabled = [], extra = [], defs = TOOLSETS } = {}) {
  const seen = new Set();
  const tools = [];
  for (const name of dedupeNames(names)) tools.push(...rawExpand(defs, name, seen));
  tools.push(...toList(extra));
  const removed = disabledSet(disabled, defs);
  return orderedUnique(tools.filter((tool) => !removed.has(tool)));
}

/**
 * 解析一个姿态（coding / review / minimal）。
 * 姿态是「预设的工具集 + 零散工具」，同样走末端减除。
 * @param {string} name 姿态名
 * @param {{disabled?: string[], extra?: string[]}} [options]
 * @returns {string[]} 未知姿态返回 []
 */
export function resolvePosture(name, { disabled = [], extra = [] } = {}) {
  const posture = lookup(POSTURES, name);
  if (!posture) return [];
  return resolveToolsets(posture.toolsets, {
    disabled,
    extra: [...posture.tools, ...toList(extra)],
  });
}

/**
 * 按身份取工具面：身份默认面 + 显式工具集 + 姿态预设 + 额外工具，末端减除。
 * @param {{
 *   role?: string, toolsets?: string[], disabledToolsets?: string[],
 *   extraTools?: string[], posture?: string|null
 * }} [options]
 *   - `role` 未知时回落 member（群成员永远有得用，不会因为拼错身份变成哑巴）；
 *   - `posture` 是契约之外的附加可选覆盖：不传时吃 ROLES[role].posture，传 `null`
 *     表示不用姿态，传未知名字回落身份默认（契约签名的调用行为不变）；
 *   - `disabledToolsets` 与 resolveToolsets 的 `disabled` 同义：工具名也能减。
 * @returns {string[]}
 */
export function toolsForRole({
  role = "member",
  toolsets = [],
  disabledToolsets = [],
  extraTools = [],
  posture = undefined,
} = {}) {
  const def = lookup(ROLES, role) || ROLES.member;
  // 姿态解析：undefined = 吃身份默认；null = 明确不用姿态；名字未知 = 回落身份默认，
  // 宁可多给默认面，也不要因为拼错一个词让成员突然没有工具。
  const explicit = posture === null ? null : posture === undefined ? undefined : clean(posture);
  let preset = def.posture ? lookup(POSTURES, def.posture) : null;
  if (explicit === null) preset = null;
  else if (explicit) preset = lookup(POSTURES, explicit) || preset;
  const names = dedupeNames([...(def.toolsets || []), ...toList(toolsets), ...(preset ? preset.toolsets : [])]);
  const resolved = resolveToolsets(names, {
    disabled: disabledToolsets,
    extra: [...(preset ? preset.tools : []), ...toList(extraTools)],
  });
  return def.readOnly ? resolved.filter((tool) => !MUTATING_TOOLS.includes(tool)) : resolved;
}

/** 是否是已知工具集名（`all` / `*` 也算已知，对齐 Hermes validate_toolset）。 */
export function isKnownToolset(name) {
  return isKnownIn(TOOLSETS, name);
}

/**
 * 名字列表里未知的工具集（保持输入顺序、去重；空/非字符串忽略）。
 * 用来在配置加载时一次性报错，而不是让某个成员的工具面静默变窄。
 */
export function unknownToolsets(names) {
  return dedupeNames(names).filter((name) => !isKnownIn(TOOLSETS, name));
}

export default TOOLSETS;
