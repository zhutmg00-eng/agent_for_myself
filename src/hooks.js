/**
 * Hooks: a small policy layer in front of pi tool calls.
 *
 * `<DATA>/.fusion/hooks.json`:
 * ```json
 * {
 *   "hooks": [
 *     { "event": "tool_call", "tool": "write", "action": "deny", "reason": "群内禁止直接写盘" },
 *     { "event": "tool_call", "match": "bash|powershell", "arg": "command", "denyPattern": "rm -rf", "action": "deny" },
 *     { "event": "tool_call", "tool": "write", "arg": "path", "pattern": "^D:/AgentFusion", "action": "allow" }
 *   ]
 * }
 * ```
 *
 * Each rule:
 *   - `tool` / `match`: exact name, `|`-separated list, or glob (`*`).
 *   - `arg` + `pattern` / `denyPattern`: regex over one argument; `pattern` must
 *     match for the rule to fire, `denyPattern` must match too.
 *   - `action`: `deny`/`block` (default) or `allow` (explicitly let the call
 *     through; a later deny still wins because rules are evaluated in order and
 *     the first deny returns).
 *
 * A matching `deny` makes the pi extension return `{block: true, reason}`, so the
 * tool never executes and the model receives the reason as a failed tool result.
 *
 * The engine also enforces one built-in guard that is independent of the file:
 * writing to a `C:` path is refused (see FUSION_SPEC §0 铁律).
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, assertNotC, ensureDirs } from "./config.js";
import { createLogger } from "./log.js";

const log = createLogger("hooks");

export const HOOKS_FILE = DIRS.hooksFile;
export const DEFAULT_HOOKS = { hooks: [] };
const MAX_VIOLATIONS = 50;

/** Effective regex for the built-in C:-drive write guard. */
const C_DRIVE_RE = /^\s*[cC]:[\\/]?/;

/** Built-in rules that cannot be edited away from hooks.json. */
export const BUILTIN_RULES = [
  {
    id: "builtin.no-c-drive",
    event: "tool_call",
    match: "write|edit",
    arg: "path",
    denyPattern: "^\\s*[cC]:[\\\\/]?", // any C: drive path
    action: "deny",
    reason: "铁律：禁止写入 C 盘路径。请改用 D 盘工作区或群文件空间。",
    builtin: true,
  },
];

function escapeRegex(text) {
  return String(text).replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern) {
  return new RegExp(`^${String(pattern).split("*").map(escapeRegex).join(".*")}$`);
}

/** Match a tool name against a `tool`/`match` pattern. */
export function matchTool(pattern, toolName) {
  const name = String(toolName || "");
  if (pattern === undefined || pattern === null) return true;
  if (Array.isArray(pattern)) return pattern.some((p) => matchTool(p, name));
  const parts = String(pattern)
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return true;
  return parts.some((p) => {
    if (p === "*") return true;
    if (!p.includes("*")) return p === name;
    try {
      return globToRegex(p).test(name);
    } catch {
      return false;
    }
  });
}

function safeRegex(source) {
  if (!source) return null;
  try {
    return new RegExp(String(source));
  } catch (err) {
    log.warn("invalid hook regex ignored", source, err?.message || err);
    return null;
  }
}

/** Normalise one raw rule into the internal shape. */
export function normalizeRule(raw, index = 0, event = "tool_call") {
  if (!raw || typeof raw !== "object") return null;
  const action = String(raw.action || raw.decision || "deny").toLowerCase();
  return {
    id: String(raw.id || `${event}#${index}`),
    event: String(raw.event || event),
    match: raw.tool ?? raw.tools ?? raw.match ?? raw.toolName ?? "*",
    tool_name: raw.tool ?? raw.toolName ?? null,
    action: action === "block" || action === "deny" ? "deny" : action,
    reason: raw.reason || raw.message || null,
    arg: raw.arg || raw.field || null,
    pattern: raw.pattern || raw.matchArg || null,
    denyPattern: raw.denyPattern || raw.deny_pattern || null,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    builtin: Boolean(raw.builtin),
    raw,
  };
}

/** Module cache of the last loaded policy file. */
const state = {
  current: null,
  violations: [],
};

/** Read + normalise the hooks file, creating it when absent. */
export function loadHooks(opts = {}) {
  const file = opts.file || HOOKS_FILE;
  ensureDirs();
  let text = null;
  try {
    text = fs.readFileSync(assertNotC(file, "hooks.json"), "utf8");
  } catch {
    text = null;
  }
  if (text === null) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(DEFAULT_HOOKS, null, 2), "utf8");
      log.info(`created default hooks file ${file}`);
    } catch (err) {
      log.warn("cannot create hooks file", err?.message || err);
    }
    text = JSON.stringify(DEFAULT_HOOKS);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn("hooks.json is not valid JSON; policies disabled until fixed:", err?.message || err);
    parsed = { hooks: [] };
  }
  const rules = [];
  const pushAll = (list, event) => {
    if (!Array.isArray(list)) return;
    list.forEach((raw, i) => {
      const rule = normalizeRule(raw, rules.length + i, event);
      if (rule) rules.push(rule);
    });
  };
  if (Array.isArray(parsed?.hooks)) pushAll(parsed.hooks, "tool_call");
  if (Array.isArray(parsed?.preToolUse)) pushAll(parsed.preToolUse, "tool_call"); // legacy shape
  if (Array.isArray(parsed?.tool_call)) pushAll(parsed.tool_call, "tool_call");
  const post = [];
  if (Array.isArray(parsed?.postToolUse)) {
    post.push(...parsed.postToolUse.map((r, i) => normalizeRule(r, i, "tool_result")).filter(Boolean));
  }
  if (Array.isArray(parsed?.tool_result)) {
    post.push(...parsed.tool_result.map((r, i) => normalizeRule(r, i, "tool_result")).filter(Boolean));
  }
  const result = { file, raw: parsed, rules, preToolUse: rules, postToolUse: post };
  state.current = result;
  return result;
}

/** Normalised hook list (loads the file on first use). */
export function listHooks(opts = {}) {
  const loaded = opts.reload ? loadHooks(opts) : state.current || loadHooks(opts);
  return loaded.rules;
}

/** Re-read hooks.json from disk. Returns the normalised rules. */
export function reloadHooks(opts = {}) {
  log.info("reloading hooks");
  return loadHooks(opts).rules;
}

/** The policy document currently in effect (for /api/hooks and the UI). */
export function hooksDocument(opts = {}) {
  const loaded = opts.reload ? loadHooks(opts) : state.current || loadHooks(opts);
  return {
    file: loaded.file,
    enabled: loaded.rules.some((r) => r.enabled && r.action === "deny"),
    count: loaded.rules.length,
    rules: loaded.rules.map((r) => ({
      id: r.id,
      event: r.event,
      match: r.match,
      action: r.action,
      reason: r.reason,
      arg: r.arg,
      pattern: r.pattern,
      denyPattern: r.denyPattern,
      enabled: r.enabled,
      builtin: r.builtin,
    })),
    postToolUse: loaded.postToolUse.length,
  };
}

function argValue(input, arg) {
  if (!input || !arg) return "";
  if (Object.prototype.hasOwnProperty.call(input, arg)) return String(input[arg] ?? "");
  const aliases = { path: ["file_path", "filePath"], file_path: ["path"], command: ["cmd"] };
  for (const key of aliases[arg] || []) {
    if (Object.prototype.hasOwnProperty.call(input, key)) return String(input[key] ?? "");
  }
  return "";
}

/**
 * Evaluate the deny/allow rules for one tool call.
 * @param {{toolName:string, input:object}} event
 * @param {object[]|null} rules normalised rules
 * @param {{includeBuiltin?:boolean}} [opts]
 * @returns {{block:true, reason:string, rule:object}|null}
 */
export function checkToolCall(event, rules = null, opts = {}) {
  const toolName = String(event?.toolName || event?.tool || "");
  const input = event?.input || event?.args || {};
  const includeBuiltin = opts.includeBuiltin !== false;

  // Built-in C: write guard (always on)
  if (includeBuiltin && /^(write|edit)$/.test(toolName)) {
    const target = argValue(input, "path");
    if (target && C_DRIVE_RE.test(target)) {
      return {
        block: true,
        reason: `铁律：禁止写入 C 盘路径（${target}）。请改用 D 盘工作区或群文件空间 room_file_save。`,
        rule: { ...BUILTIN_RULES[0], id: "builtin.no-c-drive" },
      };
    }
  }

  // Built-in C: guard for shell tools: any absolute C: path in the command line.
  if (includeBuiltin && /^(bash|shell|command|exec|powershell|pwsh|terminal)$/i.test(toolName)) {
    const command = argValue(input, "command");
    if (command && /(^|[\s"'`;&|()=])[cC]:[\\/]/.test(command)) {
      return {
        block: true,
        reason: "铁律：命令里包含 C 盘绝对路径，禁止写入或改动 C 盘。请使用工作区相对路径（当前工作区已在 D 盘）。",
        rule: { ...BUILTIN_RULES[0], id: "builtin.no-c-drive-command", match: "bash|shell|command|exec|powershell|pwsh|terminal", arg: "command" },
      };
    }
  }

  const list = Array.isArray(rules) ? rules : listHooks();
  for (const rule of list) {
    if (!rule || rule.enabled === false) continue;
    if (rule.event && rule.event !== "tool_call") continue;
    if (rule.tool_name && rule.tool_name !== toolName) continue;
    if (!matchTool(rule.match, toolName)) continue;
    if (rule.arg) {
      const value = argValue(input, rule.arg);
      if (rule.pattern) {
        const rx = safeRegex(rule.pattern);
        if (!rx) {
          // 坏正则不能变成「这条规则不存在」：deny 规则按 fail-closed 拦下（Hermes 政策门语义）。
          if (rule.action === "deny") {
            return {
              block: true,
              reason: `hooks 规则 ${rule.id} 的 pattern 正则非法，已按 fail-closed 拦截（请修正 .fusion/hooks.json）`,
              rule: { ...rule, invalidPattern: true },
            };
          }
          continue;
        }
        if (!rx.test(value)) continue;
      }
      if (rule.denyPattern) {
        const rx = safeRegex(rule.denyPattern);
        if (!rx) {
          if (rule.action === "deny") {
            return {
              block: true,
              reason: `hooks 规则 ${rule.id} 的 denyPattern 正则非法，已按 fail-closed 拦截（请修正 .fusion/hooks.json）`,
              rule: { ...rule, invalidPattern: true },
            };
          }
          continue;
        }
        if (!rx.test(value)) continue;
      }
    }
    if (rule.action === "deny") {
      return {
        block: true,
        reason: rule.reason || `工具 ${toolName} 被 hooks 规则 ${rule.id} 拦截`,
        rule,
      };
    }
    if (rule.action === "allow") return null;
  }
  return null;
}

/** Post-tool rules matching a tool name (informational; no blocking). */
export function matchPostHooks(toolName) {
  const loaded = state.current || loadHooks();
  return loaded.postToolUse.filter((r) => r.enabled !== false && matchTool(r.match, toolName));
}

function recordViolation(entry) {
  state.violations.push(entry);
  if (state.violations.length > MAX_VIOLATIONS) {
    state.violations.splice(0, state.violations.length - MAX_VIOLATIONS);
  }
}

/** Recent blocked calls (for diagnostics / the settings page). */
export function getViolations(limit = MAX_VIOLATIONS) {
  return state.violations.slice(-Math.max(1, limit));
}

/**
 * Build the pi inline extension that enforces the hooks.
 * @param {object[]|null} hooks normalised rules; when omitted the file is read
 * @param {{
 *   includeBuiltin?:boolean,
 *   onViolation?:Function,
 *   onPostTool?:Function,
 *   approval?:object,                 // createApproval() 实例（src/approval.js）
 *   approvalContext?:{roomId?:string,botId?:string},
 *   approvalTimeoutMs?:number,
 *   onApprovalRequested?:Function,    // (request, {tool, input, verdict}) => void
 *   onApprovalResolved?:Function,     // ({requestId, outcome, reason}) => void
 * }} [opts]
 * @returns {(pi:any)=>void} InlineExtension factory for DefaultResourceLoader
 *
 * 判定顺序（对齐 Hermes：地板先于模式、模式先于人工，见 tools/approval_floors.py:1-8）：
 *   1. hooks.json 静态规则 + 内置 C 盘守卫（deny 立即阻断）
 *   2. approval.evaluate()：地板 / 三态缓存 / 模式 → allow | deny | ask
 *   3. ask → 落一条审批单 → **await waitFor()**（UI/API 裁决唤醒；超时或中止按 deny 处理）
 * 第 2/3 步任何异常都 **fail-closed**（拦截并说明原因），绝不因为审批层挂了就放行危险调用。
 */
export function createHooksExtension(hooks = null, opts = {}) {
  let rules = hooks;
  const includeBuiltin = opts.includeBuiltin !== false;
  const approval = opts.approval || null;
  const approvalContext = opts.approvalContext || {};
  const approvalTimeoutMs = Number(opts.approvalTimeoutMs) > 0 ? Number(opts.approvalTimeoutMs) : 10 * 60 * 1000;

  const block = (toolName, reason, ruleId = null) => {
    log.warn(`tool_call blocked: ${toolName} — ${reason}`);
    recordViolation({ ts: Date.now(), tool: toolName, reason, rule: ruleId });
    try {
      opts.onViolation?.({ tool: toolName, reason, rule: ruleId ? { id: ruleId } : null });
    } catch {
      /* listeners must not break the hook */
    }
    return { block: true, reason };
  };

  return (pi) => {
    if (!rules) rules = listHooks();
    pi.on("tool_call", async (event, ctx) => {
      const toolName = String(event?.toolName || "");
      const input = event?.input || event?.args || {};

      // 1) 静态策略：hooks.json + 内置 C 盘写入/命令守卫
      let hit;
      try {
        hit = checkToolCall(event, rules, { includeBuiltin });
      } catch (err) {
        log.warn("hook evaluation failed; allowing call", err?.message || err);
        hit = null;
      }
      if (hit) return block(toolName, hit.reason || "blocked by hook", hit.rule?.id || null);

      // 2) 审批层：地板 → 缓存 → 模式
      if (!approval) return undefined;
      let verdict;
      try {
        verdict = approval.evaluate({ tool: toolName, input, ctx: approvalContext });
      } catch (err) {
        return block(toolName, `审批判定失败，已按 fail-closed 拦截：${err?.message || err}`, "approval.error");
      }
      if (!verdict || verdict.decision === "allow") return undefined;
      if (verdict.decision === "deny") {
        return block(toolName, verdict.reason || "审批地板拒绝", verdict.rule?.id || verdict.patternKey || "approval.deny");
      }

      // 3) ask：落单 + 等待裁决
      let pending;
      try {
        pending = approval.request({
          tool: toolName,
          input,
          ctx: approvalContext,
          reason: verdict.reason,
          patternKey: verdict.patternKey,
        });
      } catch (err) {
        return block(toolName, `审批单创建失败，已按 fail-closed 拦截：${err?.message || err}`, "approval.error");
      }
      try {
        opts.onApprovalRequested?.(pending, { tool: toolName, input, verdict });
      } catch {
        /* listeners must not break the hook */
      }
      let outcome;
      try {
        outcome = await approval.waitFor(pending.id, { timeoutMs: approvalTimeoutMs, signal: ctx?.signal });
      } catch (err) {
        outcome = { outcome: "deny", reason: `审批等待失败：${err?.message || err}` };
      }
      try {
        opts.onApprovalResolved?.({ requestId: pending.id, outcome: outcome.outcome, reason: outcome.reason });
      } catch {
        /* ignore listener errors */
      }
      if (outcome?.outcome === "allow") return undefined;
      const why =
        outcome?.outcome === "timeout"
          ? `审批超时（${Math.round(approvalTimeoutMs / 1000)}s 内无人裁决）`
          : outcome?.outcome === "aborted"
            ? "调用方已中止，审批作废"
            : outcome?.reason || "人工拒绝";
      return block(toolName, `需要人工审批，未获批准：${why}`, "approval.ask");
    });
    // Keep post-tool hooks observable without changing results.
    pi.on("tool_result", async (event) => {
      const matched = matchPostHooks(String(event?.toolName || ""));
      if (matched.length && opts.onPostTool) {
        try {
          opts.onPostTool({ tool: event?.toolName, isError: Boolean(event?.isError), rules: matched });
        } catch {
          /* ignore listener errors */
        }
      }
      return undefined;
    });
  };
}

export default createHooksExtension;
