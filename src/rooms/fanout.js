/**
 * Fanout：把群主的一串任务声明（写域 + 依赖）校验成可并行的 DAG，并给出执行顺序。
 *
 * 为什么：`Room.assignTask` 只按插入顺序塞任务（`src/rooms/room.js:269-276`），`runRound`
 * 也按插入序点名（`:699-708`）——两个成员同时改同一片工作区没有任何检测。omh 的纪律是
 * 「写域重叠且没有依赖边就是硬错」（`FANOUT.md:14-16`），admission 按依赖前沿而不是波次
 * （`:313-320`）。我们只取最小内核：校验 + 拓扑排序；不做 worktree / 进程隔离（所有 bot
 * 都是同进程 session）。
 *
 * 边界：纯函数、无 IO、无 LLM、确定性；只回答「能不能并行、按什么顺序、哪里会打架」。
 */

/** 硬上限（与契约 §8.1 逐字一致）。 */
export const FANOUT_LIMITS = Object.freeze({ maxTasks: 12, maxScope: 8, maxIdLength: 40 });

/** 全部机器可读错误码（UI/工具层按 code 转述，不要解析 message）。 */
export const FANOUT_ERROR_CODES = Object.freeze([
  "duplicate_id", "empty_id", "id_too_long", "unknown_member", "unknown_dependency", "self_dependency",
  "cycle", "write_conflict", "too_many_tasks", "scope_too_large", "invalid_task",
]);

/** 视为「已完成」的状态词（`frontier` 用；大小写不敏感）。 */
const DONE_STATES = new Set(["done", "completed", "complete", "ok", "success", "succeeded", "passed"]);

/** 统一成数组：`undefined`/`null` → `[]`，单值 → 单元素数组。 */
function toList(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/** 去首尾空白的字符串；其它类型一律返回 ""（配置来自模型/API，宁可判错不要猜）。 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 纯对象（排除 null 与数组）。 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按顺序去重。 */
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 单条写域归一：小写、`\`→`/`、折叠重复斜杠、去尾斜杠；结尾 `*`/`**` 表示「整个目录」，
 * 归一成目录本身（`src/**` → `src`），中间通配（`src/*.md`）按字面保留（契约只定义了结尾通配）。
 * 空串、`"."`、纯空白 → `""`（由 `normalizeScope` 丢弃）。
 */
function normalizeEntry(raw) {
  if (typeof raw !== "string") return "";
  let value = raw.trim().toLowerCase().replace(/\\/g, "/");
  if (!value) return "";
  const rooted = value.startsWith("/");
  value = value.replace(/\/{2,}/g, "/");
  value = value.replace(/\/?(\*\*|\*)$/, "");
  if (value === "/") return "/";
  value = value.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!value) return rooted ? "/" : "";
  return value;
}

/**
 * 归一化写域声明：接受字符串或字符串数组，逐条 `normalizeEntry` 后去空、去重。
 * 返回 `string[]`，可直接放进 `units[].write_scope`，也是 `scopesOverlap` 的入参形态。
 * @param {string|string[]} scope
 * @returns {string[]}
 */
export function normalizeScope(scope) {
  return dedupe(toList(scope).map(normalizeEntry).filter(Boolean));
}

/** 按路径段切分：`d:/ws/a.md` → `["d:","ws","a.md"]`；前导 `/` 保留为根段，避免和相对路径混同。 */
function pathSegments(entry) {
  const parts = entry.split("/").filter(Boolean);
  return entry.startsWith("/") ? ["/", ...parts] : parts;
}

/** 段前缀判定：相等，或一方是另一方的前缀（`src` 覆盖 `src/a.md`，但 `src` 不覆盖 `src2`）。 */
function isSegmentPrefix(shortSegments, longSegments) {
  if (shortSegments.length > longSegments.length) return false;
  for (let index = 0; index < shortSegments.length; index += 1) {
    if (shortSegments[index] !== longSegments[index]) return false;
  }
  return true;
}

/** 两条写域的所有重叠条目对（`[entryA, entryB]`），空表示不重叠。 */
function overlapPairs(first, second) {
  const left = normalizeScope(first);
  const right = normalizeScope(second);
  const pairs = [];
  for (const leftEntry of left) {
    const leftSegments = pathSegments(leftEntry);
    for (const rightEntry of right) {
      const rightSegments = pathSegments(rightEntry);
      if (isSegmentPrefix(leftSegments, rightSegments) || isSegmentPrefix(rightSegments, leftSegments)) {
        pairs.push([leftEntry, rightEntry]);
      }
    }
  }
  return pairs;
}

/**
 * 两个写域是否重叠：大小写不敏感、`\` 与 `/` 等价、按路径段判前缀；相等或一方是另一方
 * 前缀即重叠（`d:/ws` 覆盖 `d:/ws/a.md`），结尾 `*`/`**` 已在归一化时折成目录。
 * @param {string|string[]} a @param {string|string[]} b @returns {boolean}
 */
export function scopesOverlap(a, b) {
  return overlapPairs(a, b).length > 0;
}

/** 把重叠条目描述成一句人话（最多举 3 条，避免错误信息爆炸）。 */
function describeOverlap(pairs) {
  const shown = pairs.slice(0, 3).map(([left, right]) => (left === right ? left : `${left} ↔ ${right}`));
  const suffix = pairs.length > shown.length ? ` 等 ${pairs.length} 条` : "";
  return shown.join("、") + suffix;
}

/**
 * 校验并排序一份任务声明。
 * `tasks[]`：`{ id, bot_id, write_scope?, depends_on? }`，多写的字段忽略；`members[]`：
 * 群成员 id 数组，或成员记录（取 `bot_id` / `id` / `name`）。`units` 按声明顺序；`depth`
 * 是拓扑层号（从 0 起，有环时 -1）；`conflicts` 只放未串行化的冲突对（有依赖边的重叠进 warnings）。
 * @param {{tasks?: object[], members?: (string|object)[]}} [input]
 * @returns {{ok: boolean, errors: object[], warnings: string[], order: string[], units: object[], conflicts: string[][]}}
 */
export function planTasks({ tasks = [], members = [] } = {}) {
  const errors = [];
  const warnings = [];
  const conflicts = [];

  const taskList = Array.isArray(tasks) ? tasks : [];
  if (!Array.isArray(tasks)) {
    errors.push({ code: "invalid_task", message: "tasks 必须是数组" });
  }
  if (taskList.length > FANOUT_LIMITS.maxTasks) {
    errors.push({
      code: "too_many_tasks",
      message: `任务数 ${taskList.length} 超过上限 ${FANOUT_LIMITS.maxTasks}：请合并任务，或分轮分派`,
    });
  }

  const memberIds = new Set();
  for (const member of toList(members)) {
    const id = typeof member === "string" ? member.trim() : isObject(member) ? text(member.bot_id ?? member.id ?? member.name) : "";
    if (id) memberIds.add(id);
  }

  // 第一遍：逐任务校验结构，收集合法声明（声明顺序即同层顺序的唯一来源）。
  const declared = [];
  const usedIds = new Set();
  for (let index = 0; index < taskList.length; index += 1) {
    const raw = taskList[index];
    const where = `第 ${index + 1} 个任务`;
    if (!isObject(raw)) {
      errors.push({ code: "invalid_task", message: `${where}不是对象` });
      continue;
    }
    if (raw.id === undefined || raw.id === null) {
      errors.push({ code: "empty_id", message: `${where}缺少 id` });
      continue;
    }
    if (typeof raw.id !== "string") {
      errors.push({ code: "invalid_task", message: `${where}的 id 必须是字符串` });
      continue;
    }
    const id = raw.id.trim();
    if (!id) {
      errors.push({ code: "empty_id", message: `${where}的 id 为空` });
      continue;
    }
    if (id.length > FANOUT_LIMITS.maxIdLength) {
      errors.push({
        code: "id_too_long",
        task_id: id,
        message: `任务 id 超过 ${FANOUT_LIMITS.maxIdLength} 字符：${id}`,
      });
      continue;
    }
    if (usedIds.has(id)) {
      errors.push({ code: "duplicate_id", task_id: id, message: `任务 id 重复：${id}` });
      continue;
    }

    const botId = text(raw.bot_id);
    if (!botId) {
      errors.push({ code: "invalid_task", task_id: id, message: `任务 ${id} 缺少 bot_id` });
      continue;
    }
    if (!memberIds.has(botId)) {
      errors.push({
        code: "unknown_member",
        task_id: id,
        other_id: botId,
        message: `任务 ${id} 的 bot_id 不是群成员：${botId}`,
      });
      continue;
    }

    if (raw.write_scope !== undefined && !Array.isArray(raw.write_scope)) {
      errors.push({ code: "invalid_task", task_id: id, message: `任务 ${id} 的 write_scope 必须是字符串数组` });
      continue;
    }
    const rawScope = toList(raw.write_scope);
    if (rawScope.some((entry) => typeof entry !== "string")) {
      errors.push({ code: "invalid_task", task_id: id, message: `任务 ${id} 的 write_scope 只能放字符串` });
      continue;
    }
    const writeScope = normalizeScope(rawScope);
    if (writeScope.length > FANOUT_LIMITS.maxScope) {
      errors.push({
        code: "scope_too_large",
        task_id: id,
        message: `任务 ${id} 的写域有 ${writeScope.length} 条，超过上限 ${FANOUT_LIMITS.maxScope}`,
      });
      continue;
    }

    if (raw.depends_on !== undefined && !Array.isArray(raw.depends_on)) {
      errors.push({ code: "invalid_task", task_id: id, message: `任务 ${id} 的 depends_on 必须是字符串数组` });
      continue;
    }
    const rawDeps = toList(raw.depends_on);
    if (rawDeps.some((entry) => typeof entry !== "string")) {
      errors.push({ code: "invalid_task", task_id: id, message: `任务 ${id} 的 depends_on 只能放字符串` });
      continue;
    }
    if (rawDeps.some((entry) => !entry.trim())) {
      errors.push({ code: "invalid_task", task_id: id, message: `任务 ${id} 的 depends_on 里有空项` });
      continue;
    }

    usedIds.add(id);
    declared.push({
      id,
      bot_id: botId,
      write_scope: writeScope,
      depends_on: dedupe(rawDeps.map((entry) => entry.trim())),
    });
  }

  const depsById = new Map(declared.map((unit) => [unit.id, unit.depends_on]));
  const declaredIds = new Set(declared.map((unit) => unit.id));

  // 第二遍：引用校验（自依赖、未知依赖），按声明顺序出错误。
  for (const unit of declared) {
    for (const dep of unit.depends_on) {
      if (dep === unit.id) {
        errors.push({
          code: "self_dependency",
          task_id: unit.id,
          other_id: dep,
          message: `任务 ${unit.id} 依赖了自己`,
        });
        continue;
      }
      if (!declaredIds.has(dep)) {
        errors.push({
          code: "unknown_dependency",
          task_id: unit.id,
          other_id: dep,
          message: `任务 ${unit.id} 依赖了未声明的任务：${dep}`,
        });
      }
    }
  }

  // 拓扑分层（Kahn 同层声明序）：depth 取「它最深的依赖 + 1」。
  const knownDeps = new Map(
    declared.map((unit) => [unit.id, unit.depends_on.filter((dep) => dep !== unit.id && declaredIds.has(dep))]),
  );
  const placed = new Map();
  let remaining = declared.map((unit) => unit.id);
  let depth = 0;
  while (remaining.length) {
    const ready = remaining.filter((id) => knownDeps.get(id).every((dep) => placed.has(dep)));
    if (!ready.length) break;
    for (const id of ready) placed.set(id, depth);
    remaining = remaining.filter((id) => !placed.has(id));
    depth += 1;
  }
  const order = [...placed.keys()];
  if (remaining.length) {
    errors.push({
      code: "cycle",
      task_id: remaining[0],
      message: `依赖存在环，无法排序：${remaining.join("、")}`,
    });
  }

  // 写域冲突：重叠且互不在对方依赖闭包里 = 硬报错；有依赖关系（直接或传递）则串行化。
  const closures = new Map();
  const closureOf = (id) => {
    if (closures.has(id)) return closures.get(id);
    const reached = new Set();
    const stack = [...(depsById.get(id) || [])];
    while (stack.length) {
      const dep = stack.pop();
      if (reached.has(dep)) continue;
      reached.add(dep);
      stack.push(...(depsById.get(dep) || []));
    }
    closures.set(id, reached);
    return reached;
  };
  for (let first = 0; first < declared.length; first += 1) {
    for (let second = first + 1; second < declared.length; second += 1) {
      const left = declared[first];
      const right = declared[second];
      const pairs = overlapPairs(left.write_scope, right.write_scope);
      if (!pairs.length) continue;
      const serialized = closureOf(left.id).has(right.id) || closureOf(right.id).has(left.id);
      if (serialized) {
        warnings.push(`任务 ${left.id} 与 ${right.id} 的写域重叠，已由依赖关系串行化（${describeOverlap(pairs)}）`);
        continue;
      }
      conflicts.push([left.id, right.id]);
      errors.push({
        code: "write_conflict",
        task_id: left.id,
        other_id: right.id,
        message: `任务 ${left.id} 与 ${right.id} 的写域重叠且没有依赖关系（${describeOverlap(pairs)}）：请加 depends_on 串行化，或拆开写域`,
      });
    }
  }

  const units = declared.map((unit) => ({
    id: unit.id,
    bot_id: unit.bot_id,
    write_scope: [...unit.write_scope],
    depends_on: [...unit.depends_on],
    depth: placed.has(unit.id) ? placed.get(unit.id) : -1,
  }));

  return { ok: errors.length === 0, errors, warnings, order, units, conflicts };
}

/** 单元是否已被标记完成（`done: true`，或 `status` 命中完成态）。 */
function isSatisfied(unit) {
  if (unit.done === true) return true;
  return DONE_STATES.has(text(unit.status).toLowerCase());
}

/**
 * 依赖前沿：返回 `order` 里依赖已满足、现在就能执行的 id。
 *
 * 「已满足」= 该单元已被标记完成（`done: true` / `status: "done"|"completed"|...`）。
 * 没有任何完成标记时，返回的就是 depth 0 的起点集合；把返回的 id 标记完成再调一次，
 * 就逐层推进。纯函数：不修改 `units`，也不假设调用顺序。
 *
 * @param {string[]} order 拓扑序（`planTasks().order`）
 * @param {object[]} units 单元列表（`planTasks().units`，可带 `done`/`status`）
 * @returns {string[]}
 */
export function frontier(order, units = []) {
  const byId = new Map();
  for (const unit of toList(units)) {
    if (!isObject(unit)) continue;
    const id = text(unit.id ?? unit.unit_id);
    if (id && !byId.has(id)) byId.set(id, unit);
  }
  const done = new Set();
  for (const [id, unit] of byId) if (isSatisfied(unit)) done.add(id);

  const result = [];
  const seen = new Set();
  for (const rawId of toList(order)) {
    const id = text(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const unit = byId.get(id);
    if (!unit || done.has(id)) continue;
    const deps = toList(unit.depends_on).map(text).filter(Boolean);
    if (deps.every((dep) => done.has(dep))) result.push(id);
  }
  return result;
}

export default planTasks;
