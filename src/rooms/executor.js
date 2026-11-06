/**
 * 执行期 fanout：状态机 + 依赖前沿 + 失败短路。
 *
 * 为什么要有这一层：`planTasks` 只回答「能不能并行、按什么顺序」，`Room.runRound` 真要跑的时候
 * 仍然会把依赖失败的成员照常点名——上游没产出、下游拿着旧上下文继续干，群里还都以为在推进。
 * omh 的纪律是「依赖前沿 + 失败短路」：admission 按依赖前沿（`FANOUT.md:313-320`），
 * 「Failed units block their dependents, never their independents」（`:636-638`），被挡住的
 * Plan row 记 `skipped`、从不运行（`:536-538`、`:589-590`）。Hermes 的 delegate 同理：子任务
 * 失败也是结构化返回 `status: "failed"`（`tools/delegate_tool.py:376-383`），失败条目照样回传
 * （`:407-408`、`:423-432`），不会让父级裸等。
 *
 * 边界：纯函数、无 IO、无 LLM、确定性；只维护「谁可以跑、谁已经跑完、谁被短路」，不执行任务、
 * 不落库、不改入参。计划本身应由 `src/rooms/fanout.js` 的 `planTasks` 先校验过。
 */

/** 单元状态（单向流转，终态不可逆）。 */
export const UNIT_STATES = Object.freeze(["pending", "ready", "running", "done", "failed", "skipped"]);

/** 还能被调度的状态（running 已经交给执行器了，不重复返回）。 */
const RUNNABLE = new Set(["pending", "ready"]);
/** 终态：不可再改。 */
const TERMINAL = new Set(["done", "failed", "skipped"]);

/** 统一成数组：`undefined`/`null` → `[]`，单值 → 单元素数组。 */
function toList(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/** 去首尾空白的字符串；其它类型返回 ""。 */
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

/** 统一读取 plan 里的字段（plan 可能来自调用方手搓对象，先兜底）。 */
function statesOf(plan) {
  return isObject(plan?.states) ? plan.states : {};
}
function unitsOf(plan) {
  return isObject(plan?.units) ? plan.units : {};
}
function stateOf(plan, id) {
  const states = statesOf(plan);
  return Object.hasOwn(states, id) ? states[id] : null;
}
function unitOf(plan, id) {
  const units = unitsOf(plan);
  return Object.hasOwn(units, id) ? units[id] : null;
}

/** 深一层复制 plan（改返回值不影响入参，也不让两次调用共享单元对象）。 */
function clonePlan(plan) {
  const unitPairs = Object.entries(unitsOf(plan)).map(([id, unit]) => [
    id,
    { ...unit, depends_on: [...toList(unit?.depends_on).map(text).filter(Boolean)] },
  ]);
  return {
    order: [...toList(plan?.order).map(text).filter(Boolean)],
    units: Object.fromEntries(unitPairs),
    states: { ...statesOf(plan) },
    skippedReason: { ...(isObject(plan?.skippedReason) ? plan.skippedReason : {}) },
  };
}

/** `units` 支持数组（`planTasks().units`）或 `Record<id, unit>`；返回 `[[id, unit]]`，按声明序、去重。 */
function unitEntries(units) {
  const entries = [];
  const seen = new Set();
  const push = (rawId, rawUnit) => {
    const id = text(rawId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    entries.push([id, isObject(rawUnit) ? { ...rawUnit, id } : { id }]);
  };
  if (Array.isArray(units)) {
    for (const unit of units) {
      if (!isObject(unit)) continue;
      push(unit.id ?? unit.unit_id, unit);
    }
  } else if (isObject(units)) {
    for (const [id, unit] of Object.entries(units)) push(id, unit);
  }
  return entries;
}

/**
 * 建执行计划：把 `planTasks` 的单元/顺序变成可推进的状态机。
 *
 * - 无依赖的 roots 初始就是 `ready`，其余 `pending`；
 * - `order` 缺省用声明序；传入的 `order` 先按原序保留已知 id，再把漏掉的单元按声明序补到末尾
 *   （不静默丢单元，未知 id 直接忽略）；
 * - 依赖里出现未声明的 id 时不会报错，但该单元永远等不到（`isComplete` 会一直 false）——
 *   调用方应先用 `planTasks()` 校验。
 * @param {{units?: object[]|Record<string, object>, order?: string[]}} [input]
 * @returns {{order: string[], units: Record<string, object>, states: Record<string, string>, skippedReason: Record<string, string>}}
 */
export function createExecutionPlan({ units = [], order = [] } = {}) {
  const entries = unitEntries(units);
  const unitPairs = entries.map(([id, unit]) => [
    id,
    {
      id,
      bot_id: text(unit.bot_id),
      depends_on: dedupe(toList(unit.depends_on).map(text).filter(Boolean)),
    },
  ]);
  const unitMap = Object.fromEntries(unitPairs);

  const requested = [];
  const seen = new Set();
  for (const rawId of toList(order)) {
    const id = text(rawId);
    if (!id || seen.has(id) || !Object.hasOwn(unitMap, id)) continue;
    seen.add(id);
    requested.push(id);
  }
  for (const [id] of unitPairs) {
    if (seen.has(id)) continue;
    seen.add(id);
    requested.push(id);
  }

  const statePairs = requested.map((id) => [id, unitMap[id].depends_on.length === 0 ? "ready" : "pending"]);
  return {
    order: requested,
    units: unitMap,
    states: Object.fromEntries(statePairs),
    skippedReason: {},
  };
}

/**
 * 依赖前沿：按 `order` 返回「现在就能跑」的 id。
 * 条件 = 状态是 `ready` 或 `pending`，且 `depends_on` 里的每个 id 都是 `done`；
 * 无依赖的 roots 一开始就满足（空集合对 `every` 为真）。
 * @param {object} plan
 * @returns {string[]}
 */
export function nextReady(plan) {
  const result = [];
  for (const id of toList(plan?.order).map(text).filter(Boolean)) {
    if (!RUNNABLE.has(stateOf(plan, id))) continue;
    const unit = unitOf(plan, id);
    if (!unit) continue;
    const deps = toList(unit.depends_on).map(text).filter(Boolean);
    if (deps.every((dep) => stateOf(plan, dep) === "done")) result.push(id);
  }
  return result;
}

/**
 * 标记为运行中。只允许 `ready` 或「依赖已全部 done 的 pending」→ `running`；
 * 其它状态（终态、依赖未满足）返回原 plan（幂等、不回退）。
 * @param {object} plan
 * @param {string} id
 * @returns {object} 新 plan
 */
export function markRunning(plan, id) {
  const key = text(id);
  if (!key || !unitOf(plan, key) || !RUNNABLE.has(stateOf(plan, key))) return plan;
  const deps = toList(unitOf(plan, key).depends_on).map(text).filter(Boolean);
  if (deps.some((dep) => stateOf(plan, dep) !== "done")) return plan;
  const next = clonePlan(plan);
  next.states = { ...next.states, [key]: "running" };
  return next;
}

/**
 * 写入一次执行结果；失败会沿依赖边把**传递下游**标成 `skipped`（兄弟分支不动）。
 *
 * - `ok === true` 才算成功，其它值一律按失败处理（fail closed：没拿到肯定结果就别当成功）；
 * - 终态不可覆盖（先到先得），重复标记返回空改动；
 * - `changed` = 本次改动的 id（结果单元 + 新 skip 的下游），`skipped` = 新 skip 的下游；
 * - 下游已经跑过（done/running）的不回退；`skippedReason` 记「上游 <id> 失败」，带 reason 时附在括号里。
 * @param {object} plan
 * @param {string} id
 * @param {{ok?: boolean, reason?: string|null}} [result]
 * @returns {{plan: object, changed: string[], skipped: string[]}}
 */
export function markResult(plan, id, { ok, reason = null } = {}) {
  const key = text(id);
  if (!key || !unitOf(plan, key)) return { plan, changed: [], skipped: [] };
  const current = stateOf(plan, key);
  if (TERMINAL.has(current)) return { plan, changed: [], skipped: [] };

  const next = clonePlan(plan);
  next.states = { ...next.states, [key]: ok === true ? "done" : "failed" };
  const changed = [key];
  const skipped = [];

  if (ok !== true) {
    // 反向依赖表：谁直接依赖了谁；再沿边做一次传递闭包。
    const dependents = new Map();
    for (const [unitId, unit] of Object.entries(next.units)) {
      for (const dep of unit.depends_on) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep).push(unitId);
      }
    }
    const downstream = new Set();
    const stack = [...(dependents.get(key) || [])];
    while (stack.length) {
      const currentId = stack.pop();
      if (downstream.has(currentId)) continue;
      downstream.add(currentId);
      stack.push(...(dependents.get(currentId) || []));
    }

    const suffix = text(reason);
    const skipReason = suffix ? `上游 ${key} 失败（${suffix}）` : `上游 ${key} 失败`;
    for (const candidate of next.order) {
      if (!downstream.has(candidate) || !RUNNABLE.has(next.states[candidate])) continue;
      next.states = { ...next.states, [candidate]: "skipped" };
      next.skippedReason = { ...next.skippedReason, [candidate]: skipReason };
      skipped.push(candidate);
      changed.push(candidate);
    }
  }

  return { plan: next, changed, skipped };
}

/** 是否已经没有可推进的单元（没有 pending/ready/running；空计划算完成）。 */
export function isComplete(plan) {
  for (const state of Object.values(statesOf(plan))) {
    if (!TERMINAL.has(state)) return false;
  }
  return true;
}

/**
 * 状态计数。`ready` 归入 `pending`（还没开始跑），保证五项之和等于单元数；
 * 未知状态忽略。
 * @param {object} plan
 * @returns {{done: number, failed: number, skipped: number, pending: number, running: number}}
 */
export function summarize(plan) {
  const counts = { done: 0, failed: 0, skipped: 0, pending: 0, running: 0 };
  for (const state of Object.values(statesOf(plan))) {
    if (state === "ready") counts.pending += 1;
    else if (Object.hasOwn(counts, state)) counts[state] += 1;
  }
  return counts;
}

export default createExecutionPlan;
