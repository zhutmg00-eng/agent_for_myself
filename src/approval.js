/**
 * 审批分层：把 Hermes 的「地板 → 缓存 → 模式 → 挂起 → 裁决」语义落成纯确定性模块，
 * 接在 pi 的 tool_call 之前。
 *
 * 为什么独立成模块：
 *  - hooks.js 只有静态 deny/allow，没有「问人」这一步；群聊里多个 bot 并发调工具，需要一个
 *    可持久化、可审计、可熔断、可阻塞等待的审批队列（Hermes tools/approval.py 的内核）。
 *  - 地板（FLOORS）先于模式与缓存：yolo 也不能放行（Hermes approval.py:1151 的 _floor_block
 *    在 yolo / mode=off 之前跑）；fusion 的「零 C 盘写入」铁律就是其中一条地板。
 *  - 不调 LLM、不联网：Hermes 的 smart 守卫会调辅助模型（approval_smart.py:88），这里换成
 *    确定性启发式，测试才能完全复现。
 *
 * 判定顺序（evaluate）：FLOORS → 缓存（always/session/once）→ 拒绝熔断 → 模式。
 * 表（全部 appr_ 前缀，本模块自建，不改 store.js）：
 *   appr_settings  模式（scope_key = "global" | roomId）
 *   appr_requests  挂起 / 已裁决审批单
 *   appr_cache     三态授权 once / session / always
 *   appr_audit     裁决留痕 decision / scope / by / mode / reason / ts
 * 本模块不写文件：持久化只经 Store（store.js 已对 dbPath 做 assertNotC），构造时再兜一次底。
 */
import crypto from "node:crypto";
import path from "node:path";
import { assertNotC, DIRS } from "./config.js";
import { makeId } from "./store.js";
import { createLogger } from "./log.js";

const log = createLogger("approval");

/**
 * 「工作区内写入」视为低危（smart 放行），工作区外仍要问。
 *
 * 为什么需要：群聊里每轮都在写文件/落群文件/分派任务；如果 smart 把每次 write 都挂起
 * 等人工，整个产品会卡死（实测 e2e：boss 的 room_assign_task 挂起 240s）。Hermes 的
 * smart 靠辅助模型判断「这个写入危不危险」，我们用「路径是否落在自己的工作区/群文件空间」
 * 这个确定性判据替代，语义更窄也更可审计。
 */
const WORKSPACE_ROOTS = [DIRS.workspace, DIRS.rooms]
  .map((p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase())
  .filter(Boolean);

/** 路径是否落在本进程的工作区 / 群文件空间内（相对路径视为相对 bot cwd = 工作区内）。 */
export function isInsideWorkspace(raw) {
  const value = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!value) return false;
  const isAbsolute = /^[a-zA-Z]:\//.test(value) || value.startsWith("/");
  if (!isAbsolute) {
    // 相对路径可能用 `..` 逃逸：规范化后还带 `..` 前缀的，一律不算工作区内。
    const normalized = path.posix.normalize(value.replace(/\/+$/, ""));
    if (normalized === ".." || normalized.startsWith("../")) return false;
    return true;
  }
  const lower = path.posix.normalize(value).toLowerCase();
  return WORKSPACE_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`));
}

export const APPROVAL_MODES = ["yolo", "smart", "ask"]; // 宽松 -> 严格
export const DECISIONS = ["allow", "deny", "ask"];
export const SCOPES = ["once", "session", "always"];

// 默认 yolo：地板（C 盘 / rm -rf / / 格式化 / 关机 / 凭据外泄）仍然生效，但不再逐条问人。
// 为什么不是 smart：群聊里的成员每轮都要跑复合 shell（`ls; find … | head`）和写文件，
// 没有人在键盘前逐条批准；默认 smart 会把整轮挂起到超时（实测 e2e 两次卡在 coder 的
// 只读探索命令上）。smart / ask 是**显式开启的监督模式**，通过 UI 或 PUT /api/approval/mode 设置。
const DEFAULT_MODE = "yolo";
const GLOBAL_SCOPE = "global";
const CACHE_ALL = "*";
const DEFAULT_TTL_MS = 10 * 60_000;
const ONCE_TTL_MS = 10 * 60_000;
const DEFAULT_DENIAL_THRESHOLD = 3;
const KEY_MAX = 160;

/* ------------------------------------------------------------------ 工具分组 */
const SHELL_TOOLS = "bash|shell|sh|zsh|powershell|pwsh|cmd|command|exec|terminal|run_command|shell_command";
const WRITE_TOOLS = "write|write_file|create_file|edit|patch|apply_patch|multiedit|multi_edit|notebook_edit";

const SHELL_TOOL_RE = new RegExp(`^(?:${SHELL_TOOLS})$`, "i");
const WRITE_TOOL_RE = new RegExp(`^(?:${WRITE_TOOLS})$`, "i");
const MOVE_TOOL_RE = /^(?:move|rename|copy|mkdir|create_directory|touch|room_file_move)$/i;
const DELETE_TOOL_RE = /^(?:delete|delete_file|remove|remove_file|rm|rmdir|unlink|trash)$/i;
const READONLY_TOOL_RE = /^(?:read|read_file|readfile|view|glob|list|list_dir|ls|stat|grep|search|search_files|find|head|tail)$/i;
const NETWORK_TOOL_RE = /^(?:web_fetch|webfetch|fetch|http|http_request|web_search|curl|wget|browser_\w+)$/i;
const ROOM_READONLY_TOOL_RE = /^(?:room_list_members|room_file_list|room_file_read|skill_list)$/;
const ROOM_PRIVILEGED_TOOL_RE = /^(?:room_grant_permission|room_revoke_permission)$/;
const ROOM_TOOL_RE = /^room_/;
// 只读 shell 命令白名单：smart 放行，ask 仍要问（ask 把一切「执行」交给人）。
const SHELL_READONLY_RE = /^(?:ls|dir|pwd|cd|cat|type|head|tail|echo|where|which|whoami|hostname|date|tree|wc|findstr|rg)\b|^git\s+(?:status|diff|log|show|branch|remote|rev-parse)\b|^node\s+(?:--version|-v)\b|^npm\s+--version\b/;
// 构建 / 测试类命令白名单（Hermes smart 由辅助模型判定，我们只能用白名单 + 危险符过滤）：
// 只认标准动作，不接受 -e/-c 这类把代码内联进参数的形式，也不接受任何串联/重定向（前面已拦）。
const SHELL_DEV_SAFE_RE = /^(?:node\s+--test\b|node\s+(?:--version|-v)\b|npm\s+(?:test|--version)\b|npm\s+run\s+[a-z0-9:_.-]+\b|npx\s+--version\b|pnpm\s+(?:test|run\s+[a-z0-9:_.-]+)\b|yarn\s+(?:test|run\s+[a-z0-9:_.-]+)\b|python\s+-m\s+(?:pytest|unittest)\b|python3?\s+--version\b|git\s+(?:status|diff|log|show|branch|remote|rev-parse|ls-files|blame)\b)/;
const SHELL_UNSAFE_RE = /[;&|><\n`]|\$\(/;
// 顶层命令切分（`;` `&&` `||` `|`）：只有**每一段**都安全，复合命令才算安全。
// 对齐 Hermes 的「复合命令不给 allowlist 捷径」（approval_floors.py:140-181）。
const SHELL_SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||;|\|)\s*/;
/** find 的破坏性动作：带这些 flag 就不算只读。 */
const FIND_UNSAFE_RE = /\s-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/;
const SHELL_SEGMENT_SAFE_RE = new RegExp(
  `^(?:${[
    "ls", "dir", "pwd", "cd", "cat", "type", "head", "tail", "echo", "where", "which",
    "whoami", "hostname", "date", "tree", "wc", "findstr", "rg", "grep", "sort", "uniq",
  ].join("|")})\\b|^git\\s+(?:status|diff|log|show|branch|remote|rev-parse|ls-files|blame)\\b|^node\\s+(?:--test|--version|-v)\\b|^npm\\s+(?:test|--version)\\b|^npm\\s+run\\s+[a-z0-9:_.-]+\\b|^pnpm\\s+(?:test|run\\s+[a-z0-9:_.-]+)\\b|^yarn\\s+(?:test|run\\s+[a-z0-9:_.-]+)\\b|^python3?\\s+-m\\s+(?:pytest|unittest)\\b`,
);
/** 一条 shell 命令是否「每段都只读/构建测试」。 */
function isSafeCompoundCommand(command) {
  const text = String(command ?? "").trim().toLowerCase();
  if (!text) return false;
  if (/[<>`]|\$\(/.test(text)) return false; // 重定向 / 命令替换一律不放行
  const segments = text.split(SHELL_SEGMENT_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every((segment) => {
    if (FIND_UNSAFE_RE.test(segment)) return false;
    if (segment.startsWith("find ")) return true;
    return SHELL_SEGMENT_SAFE_RE.test(segment);
  });
}
const SHELL_DESTRUCTIVE_RE = /\b(?:rm|rmdir|del|erase|rd|remove-item|ri|unlink|shred|truncate|drop\s+(?:table|database))\b/;
const SHELL_NETWORK_RE = /\b(?:curl|wget|ssh|scp|sftp|ftp|nc|ncat|telnet|invoke-webrequest|invoke-restmethod|iwr|irm|start-bitstransfer)\b/;

/* ---------------------------------------------------------------------- 地板 */
/** 命令位置前缀（对齐 Hermes _CMDPOS，approval_detection.py:99）：行首或 `; & | (` 之后，
 *  允许 sudo/env 包装。这样 `git commit -m "rm -rf /"` 的引号数据不会误伤地板。 */
const CMD_POS = String.raw`(?:^|[;&|(\n])\s*(?:(?:sudo|doas|env|exec|nohup|setsid|time)\s+)*`;

/**
 * 不可绕过的硬地板：命中即 deny，模式 / 缓存 / 人工审批都不能放行。
 * 结构严格按契约 §3.1：{ id, match: { tool, arg, pattern }, reason }。
 * 对齐 Hermes hardline（approval_detection.py:124-157）与 fusion 铁律（hooks.js:44-55）。
 */
export const FLOORS = [
  {
    id: "floor.c-drive-write",
    match: { tool: WRITE_TOOLS, arg: "path", pattern: String.raw`^\s*(?:\\\\\?\\[cC]:|[cC]:)[\\/]` },
    reason: "铁律地板：禁止写入 C 盘路径。请改用 D 盘工作区或群文件空间（room_file_save）。",
  },
  {
    id: "floor.c-drive-command",
    match: { tool: SHELL_TOOLS, arg: "command", pattern: String.raw`(?:^|[\s"';&|(),=])[cC]:[\\/]` },
    reason: "铁律地板：命令里出现 C 盘绝对路径，禁止在 C 盘写入或改动；请使用 D 盘路径。",
  },
  {
    id: "floor.rm-rf-root",
    // rm 的 flag 组 + 根路径：/、//、/.、/..、/*、"/"；/tmp 之类普通目录不在此列。
    match: { tool: SHELL_TOOLS, arg: "command", pattern: String.raw`${CMD_POS}rm\s+(?:-[^\s]+\s+)*["']?/[./]*\**["']?(?:\s|$|[);|&])` },
    reason: "地板：递归删除根文件系统（rm -rf /）不可恢复，任何模式都不能放行。",
  },
  {
    id: "floor.disk-format",
    match: {
      tool: SHELL_TOOLS,
      arg: "command",
      pattern: String.raw`${CMD_POS}(?:format(?:\.com)?\s+[a-z]:|mkfs(?:\.[a-z0-9]+)?\b|diskpart(?:\.exe)?\b|wipefs\b|clear-disk\b|initialize-disk\b|format-volume\b|dd\b[^\n]*\bof=/dev/)`,
    },
    reason: "地板：格式化 / 分区 / 覆写磁盘（format、diskpart、mkfs、dd of=/dev/…）不可恢复。",
  },
  {
    id: "floor.system-power",
    match: {
      tool: SHELL_TOOLS,
      arg: "command",
      pattern: String.raw`${CMD_POS}(?:shutdown(?:\.exe)?\b|(?:reboot|halt|poweroff|logoff)\b|stop-computer\b|restart-computer\b|init\s+[06]\b|systemctl\s+(?:poweroff|reboot|halt)\b)`,
    },
    reason: "地板：关机 / 重启会中断群里所有正在跑的回合（shutdown、reboot、poweroff）。",
  },
  {
    id: "floor.system-dir-write",
    match: {
      tool: WRITE_TOOLS,
      arg: "path",
      pattern: String.raw`(?:^|[\\/])(?:windows[\\/]+(?:system32|syswow64)|program files(?: \(x86\))?|programdata)(?:[\\/]|$)`,
    },
    reason: "地板：禁止写系统目录（Windows\\System32、Program Files、ProgramData）。",
  },
  {
    id: "floor.system-dir-command",
    match: {
      tool: SHELL_TOOLS,
      arg: "command",
      pattern: String.raw`(?:^|[\s"'\\/=])(?:%systemroot%|%windir%|%programfiles%)(?:[\\/]|$)|(?:^|[\s"'\\/=])windows[\\/]+(?:system32|syswow64)(?:[\\/]|$)|program files(?: \(x86\))?[\\/]`,
    },
    reason: "地板：命令要改系统目录（System32 / Program Files / %SystemRoot%）。",
  },
  {
    id: "floor.credential-exfil",
    // 必须同时出现「网络工具」与「凭据来源」，避免把普通 `cat .env` 当外泄。
    match: {
      tool: SHELL_TOOLS,
      arg: "command",
      pattern: String.raw`(?=[\s\S]*(?:curl|wget|nc|ncat|netcat|scp|sftp|ftp|invoke-webrequest|invoke-restmethod|iwr|irm)\b)(?=[\s\S]*(?:\.env\b|\.npmrc\b|\.pypirc\b|\.netrc\b|id_rsa\b|id_ed25519\b|\.ssh[\\/]|secrets?\.(?:json|ya?ml)|credentials?\.(?:json|ya?ml)|api[_-]?key|access[_-]?token|password|passwd|secret))`,
    },
    reason: "地板：疑似把 .env / 密钥 / 凭据外传（curl、wget 等网络工具与凭据来源同时出现）。",
  },
];

const floorRegexes = new Map();
function floorRegex(floor) {
  let rx = floorRegexes.get(floor.id);
  if (!rx) {
    rx = new RegExp(floor.match.pattern, "i");
    floorRegexes.set(floor.id, rx);
  }
  return rx;
}

const globRegexes = new Map();
/** 工具名语义与 hooks.matchTool 一致：精确、`|` 列表或 `*` glob。 */
function matchToolName(pattern, toolName) {
  const name = String(toolName || "");
  if (!pattern) return true;
  return String(pattern)
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => {
      if (p === "*") return true;
      if (!p.includes("*")) return p === name;
      let rx = globRegexes.get(p);
      if (!rx) {
        const escaped = p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
        rx = new RegExp(`^${escaped}$`);
        globRegexes.set(p, rx);
      }
      return rx.test(name);
    });
}

/** 取参数值，兼容 pi 的 path / file_path、command / cmd 别名（与 hooks.argValue 一致）。 */
function argValue(input, arg) {
  if (!input || !arg) return "";
  if (Object.prototype.hasOwnProperty.call(input, arg)) return String(input[arg] ?? "");
  const aliases = { path: ["file_path", "filePath"], file_path: ["path"], command: ["cmd"] };
  for (const key of aliases[arg] || []) {
    if (Object.prototype.hasOwnProperty.call(input, key)) return String(input[key] ?? "");
  }
  return "";
}

function matchFloor(toolName, input) {
  for (const floor of FLOORS) {
    if (!matchToolName(floor.match.tool, toolName)) continue;
    const value = argValue(input, floor.match.arg);
    if (value && floorRegex(floor).test(value)) return floor;
  }
  return null;
}

/* ---------------------------------------------------------------- patternKey */
const normalizeSpace = (text) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** 路径折叠到父目录：`D:/ws/a.md` 与 `D:/ws/b.md` 视为同一类写操作。 */
function foldPath(value) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!raw) return "";
  const slash = raw.lastIndexOf("/");
  return (slash > 0 ? raw.slice(0, slash) : slash === 0 ? "/" : raw).toLowerCase();
}

function clip(text) {
  const value = String(text ?? "");
  if (value.length <= KEY_MAX) return value;
  return `${value.slice(0, 120)}#${crypto.createHash("sha1").update(value).digest("hex").slice(0, 8)}`;
}

function stableInput(input) {
  if (!input || typeof input !== "object") return "{}";
  const sorted = {};
  for (const key of Object.keys(input).sort()) sorted[key] = input[key];
  try {
    return JSON.stringify(sorted);
  } catch {
    return "{}";
  }
}

/** 规范化出「同类操作」的键：命令折叠空白 + 大小写；路径折叠父目录；键里永远带工具名。 */
function computePatternKey(toolName, input) {
  const tool = toolName.toLowerCase();
  if (SHELL_TOOL_RE.test(toolName)) return `${tool}:cmd:${clip(normalizeSpace(argValue(input, "command")))}`;
  if (WRITE_TOOL_RE.test(toolName) || MOVE_TOOL_RE.test(toolName) || DELETE_TOOL_RE.test(toolName)) {
    const target = argValue(input, "path");
    if (target) return `${tool}:dir:${clip(foldPath(target))}`;
  }
  if (ROOM_TOOL_RE.test(toolName)) {
    const subject =
      argValue(input, "name") || argValue(input, "file_id") || argValue(input, "bot_id") || argValue(input, "topic");
    if (subject) return `${tool}:room:${clip(normalizeSpace(subject))}`;
  }
  return `${tool}:arg:${clip(normalizeSpace(stableInput(input)))}`;
}

/* -------------------------------------------------------------------- 分类器 */
function classify(toolName, input) {
  if (ROOM_PRIVILEGED_TOOL_RE.test(toolName)) {
    // 群内授权变更由「群主身份」在工具内部把关（room.isOwner），不是磁盘危险操作；
    // smart 放行，否则群主每轮分派/授权都会挂起等人工。
    return { kind: "privilege", readOnly: false, passive: false, smartAllow: true, why: "群内授权变更（群主身份把关）" };
  }
  if (ROOM_READONLY_TOOL_RE.test(toolName) || READONLY_TOOL_RE.test(toolName)) {
    return { kind: "read", readOnly: true, passive: true, why: "只读操作" };
  }
  if (/^skill_(?:list|invoke)$/i.test(toolName)) {
    return { kind: "read", readOnly: true, passive: true, why: "读取技能指令" };
  }
  if (SHELL_TOOL_RE.test(toolName)) {
    const lower = String(argValue(input, "command") || "").trim().toLowerCase();
    if (!lower) return { kind: "shell", readOnly: false, passive: false, why: "空命令" };
    if (SHELL_NETWORK_RE.test(lower)) return { kind: "network", readOnly: false, passive: false, why: "网络命令" };
    if (SHELL_DESTRUCTIVE_RE.test(lower)) return { kind: "delete", readOnly: false, passive: false, why: "删除类命令" };
    // 复合命令逐段判定：`ls; find … | head` 全段只读 → 放行；含未知段/重定向 → 继续往下问。
    if (isSafeCompoundCommand(lower)) {
      return { kind: "read", readOnly: true, passive: false, why: "只读/构建测试命令" };
    }
    if (SHELL_UNSAFE_RE.test(lower)) return { kind: "shell", readOnly: false, passive: false, why: "命令包含串联 / 重定向" };
    if (SHELL_DEV_SAFE_RE.test(lower)) return { kind: "read", readOnly: true, passive: false, why: "构建/测试命令" };
    if (SHELL_READONLY_RE.test(lower)) return { kind: "read", readOnly: true, passive: false, why: "只读命令" };
    return { kind: "exec", readOnly: false, passive: false, why: "执行命令" };
  }
  if (NETWORK_TOOL_RE.test(toolName)) return { kind: "network", readOnly: false, passive: false, why: "网络访问" };
  if (DELETE_TOOL_RE.test(toolName)) return { kind: "delete", readOnly: false, passive: false, why: "删除操作" };
  if (ROOM_TOOL_RE.test(toolName)) {
    // 群文件落盘/移动等：写的是**本群自己的**文件空间，属于产品主流程（文件管家 per-round 都要做）。
    return { kind: "write", readOnly: false, passive: false, smartAllow: true, why: "群文件 / 群状态变更（房间内）" };
  }
  if (MOVE_TOOL_RE.test(toolName)) {
    const target = argValue(input, "path") || argValue(input, "to") || "";
    return { kind: "write", readOnly: false, passive: false, smartAllow: isInsideWorkspace(target), why: "移动/重命名" };
  }
  if (WRITE_TOOL_RE.test(toolName)) {
    const target = argValue(input, "path");
    return {
      kind: "write",
      readOnly: false,
      passive: false,
      smartAllow: isInsideWorkspace(target),
      why: isInsideWorkspace(target) ? "工作区内写文件" : "写工作区外的路径",
    };
  }
  return { kind: "unknown", readOnly: false, passive: false, why: "未知工具" };
}

/** 模式 → 决策：yolo 仍受地板约束；ask 只放行被动只读；smart 额外放行只读/构建测试/工作区内写入。 */
function decideByMode(mode, toolName, input) {
  const cls = classify(toolName, input);
  if (mode === "yolo") return { decision: "allow", reason: `yolo 模式：${toolName} 直接放行（地板仍然生效）` };
  if (mode === "ask") {
    return cls.passive
      ? { decision: "allow", reason: `ask 模式：${cls.why}自动放行` }
      : { decision: "ask", reason: `ask 模式：${cls.why}，需要人工审批` };
  }
  return cls.readOnly || cls.smartAllow
    ? { decision: "allow", reason: `smart 模式：${cls.why}自动放行` }
    : { decision: "ask", reason: `smart 模式：${cls.why}，需要人工审批` };
}

/* ----------------------------------------------------------------------- SQL */
const DDL = `
CREATE TABLE IF NOT EXISTS appr_settings(scope_key TEXT PRIMARY KEY, mode TEXT NOT NULL, "by" TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS appr_requests(
  id TEXT PRIMARY KEY, tool TEXT, input_json TEXT, room_id TEXT NOT NULL DEFAULT '', bot_id TEXT NOT NULL DEFAULT '',
  pattern_key TEXT, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', decision TEXT, scope TEXT, "by" TEXT,
  created_at TEXT, decided_at TEXT, expires_at TEXT, ttl_ms INTEGER);
CREATE INDEX IF NOT EXISTS idx_appr_requests_pending ON appr_requests(status, room_id, bot_id);
CREATE INDEX IF NOT EXISTS idx_appr_requests_key ON appr_requests(pattern_key, status);
CREATE INDEX IF NOT EXISTS idx_appr_requests_room ON appr_requests(room_id, created_at);
CREATE TABLE IF NOT EXISTS appr_cache(
  pattern_key TEXT NOT NULL, scope TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '*', bot_id TEXT NOT NULL DEFAULT '*',
  uses_left INTEGER NOT NULL DEFAULT 1, created_at TEXT, expires_at TEXT, "by" TEXT,
  PRIMARY KEY(pattern_key, scope, room_id, bot_id));
CREATE INDEX IF NOT EXISTS idx_appr_cache_party ON appr_cache(room_id, bot_id, scope);
CREATE TABLE IF NOT EXISTS appr_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, decision TEXT, tool TEXT, scope TEXT, "by" TEXT, mode TEXT,
  reason TEXT, pattern_key TEXT, room_id TEXT, bot_id TEXT, request_id TEXT);
CREATE INDEX IF NOT EXISTS idx_appr_audit_ts ON appr_audit(ts);
CREATE INDEX IF NOT EXISTS idx_appr_audit_room ON appr_audit(room_id, ts);
`;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const isoOf = (ms) => new Date(Number(ms) || 0).toISOString();

function mapRequest(row) {
  if (!row) return null;
  const out = { ...row };
  out.input = parseJson(out.input_json, {});
  delete out.input_json;
  out.ttl_ms = Number(out.ttl_ms || 0);
  return out;
}

/* ------------------------------------------------------------------ 工厂函数 */
/**
 * @param {{store:object, now?:() => number, log?:object, denialThreshold?: number}} [options]
 * @returns {object} Approval（接口见 docs/hermes/CONTRACT.md §3.1 + waitFor 扩展）
 */
export function createApproval({ store, now = () => Date.now(), log: loggerOverride = null, denialThreshold = DEFAULT_DENIAL_THRESHOLD } = {}) {
  if (!store || !store.db) throw new Error("createApproval 需要 { store }（打开状态下的 Store 实例）");
  if (store.dbPath) assertNotC(store.dbPath, "approval db"); // 兜底：持久化只经 Store
  const logger = loggerOverride || log;
  const db = store.db;
  const prepare = (sql) => (typeof store.prepare === "function" ? store.prepare(sql) : db.prepare(sql));
  db.exec(DDL);

  /**
   * session 授权与连续拒绝计数都不跨进程（对齐 Hermes _session_approved / _denial_tally，
   * approval.py:55/70）；进程启动时清掉 session 行，只有 always 跨重启生效。
   */
  prepare("DELETE FROM appr_cache WHERE scope = 'session'").run();
  const denialTally = new Map();
  const breakerNotified = new Set();
  /** id -> { resolve, timer, onAbort, signal }：resolve() 同进程直接唤醒，绝不轮询数据库。 */
  const waiters = new Map();

  const threshold = Number.isFinite(Number(denialThreshold)) ? Number(denialThreshold) : DEFAULT_DENIAL_THRESHOLD;
  const nowMs = () => {
    const value = Number(typeof now === "function" ? now() : Date.now());
    return Number.isFinite(value) ? value : Date.now();
  };
  const nowIso = () => isoOf(nowMs());

  const S = {
    getSetting: prepare('SELECT scope_key, mode, "by", updated_at FROM appr_settings WHERE scope_key = ?'),
    putSetting: prepare(`INSERT INTO appr_settings(scope_key, mode, "by", updated_at) VALUES(?,?,?,?)
      ON CONFLICT(scope_key) DO UPDATE SET mode = excluded.mode, "by" = excluded."by", updated_at = excluded.updated_at`),
    expire: prepare("UPDATE appr_requests SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?"),
    expireOne: prepare("UPDATE appr_requests SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'"),
    cancelOne: prepare("UPDATE appr_requests SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'"),
    findPending: prepare(`SELECT * FROM appr_requests
      WHERE pattern_key = ? AND room_id = ? AND bot_id = ? AND status = 'pending' AND expires_at > ? ORDER BY rowid ASC LIMIT 1`),
    insertRequest: prepare(`INSERT INTO appr_requests
      (id, tool, input_json, room_id, bot_id, pattern_key, reason, status, decision, scope, "by", created_at, decided_at, expires_at, ttl_ms)
      VALUES(?,?,?,?,?,?,?, 'pending', NULL, NULL, NULL, ?, NULL, ?, ?)`),
    getRequest: prepare("SELECT * FROM appr_requests WHERE id = ?"),
    decide: prepare(`UPDATE appr_requests SET status = ?, decision = ?, scope = ?, "by" = ?, reason = COALESCE(?, reason), decided_at = ?
      WHERE id = ? AND status = 'pending'`),
    pendingIds: prepare(`SELECT id FROM appr_requests WHERE status = 'pending' AND (? IS NULL OR room_id = ?) AND (? IS NULL OR bot_id = ?)`),
    listPending: prepare(`SELECT * FROM appr_requests
      WHERE status = 'pending' AND (? IS NULL OR room_id = ?) AND (? IS NULL OR bot_id = ?)
      ORDER BY created_at ASC, rowid ASC LIMIT ?`),
    listRequests: prepare("SELECT * FROM appr_requests WHERE (? IS NULL OR room_id = ?) ORDER BY rowid DESC LIMIT ?"),
    listAudit: prepare("SELECT * FROM appr_audit WHERE (? IS NULL OR room_id = ?) ORDER BY id DESC LIMIT ?"),
    getAlways: prepare("SELECT * FROM appr_cache WHERE pattern_key = ? AND scope = 'always' AND (expires_at IS NULL OR expires_at > ?)"),
    getScoped: prepare("SELECT * FROM appr_cache WHERE pattern_key = ? AND scope = ? AND room_id = ? AND bot_id = ? AND (expires_at IS NULL OR expires_at > ?)"),
    putCache: prepare(`INSERT INTO appr_cache(pattern_key, scope, room_id, bot_id, uses_left, created_at, expires_at, "by")
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(pattern_key, scope, room_id, bot_id) DO UPDATE SET uses_left = excluded.uses_left,
        created_at = excluded.created_at, expires_at = excluded.expires_at, "by" = excluded."by"`),
    consumeOnce: prepare("UPDATE appr_cache SET uses_left = uses_left - 1 WHERE pattern_key = ? AND scope = ? AND room_id = ? AND bot_id = ?"),
    dropCache: prepare("DELETE FROM appr_cache WHERE pattern_key = ? AND scope = ? AND room_id = ? AND bot_id = ?"),
    dropSession: prepare(`DELETE FROM appr_cache WHERE scope IN ('session','once')
      AND (? IS NULL OR room_id = ?) AND (? IS NULL OR bot_id = ?)`),
    cancelPending: prepare(`UPDATE appr_requests SET status = 'cancelled', decided_at = ?
      WHERE status = 'pending' AND (? IS NULL OR room_id = ?) AND (? IS NULL OR bot_id = ?)`),
    countStatus: prepare("SELECT status, COUNT(*) AS n FROM appr_requests GROUP BY status"),
    countMode: prepare("SELECT mode, COUNT(*) AS n FROM appr_audit GROUP BY mode"),
    insertAudit: prepare(`INSERT INTO appr_audit(ts, decision, tool, scope, "by", mode, reason, pattern_key, room_id, bot_id, request_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`),
  };

  function expireStale() {
    try {
      S.expire.run(nowIso(), nowIso());
    } catch (err) {
      logger.warn("过期扫描失败", err?.message || err);
    }
  }

  const party = (roomId, botId) => ({ room: roomId ? String(roomId) : CACHE_ALL, bot: botId ? String(botId) : CACHE_ALL });
  const sessionKeyOf = (roomId, botId) => `${roomId || ""}|${botId || ""}`;

  function recordAudit({ decision, tool, scope, by, mode, reason, patternKey, roomId, botId, requestId = null }) {
    try {
      S.insertAudit.run(nowIso(), decision, tool || null, scope || null, by || null, mode || null, reason || null,
        patternKey || null, roomId || null, botId || null, requestId || null);
    } catch (err) {
      logger.warn("审计写入失败", err?.message || err);
    }
  }

  /** 唤醒（或丢弃）某条审批的等待者；返回是否真的有等待者被唤醒。 */
  function settleWaiter(id, outcome, extra = {}) {
    const waiter = waiters.get(id);
    if (!waiter) return false;
    waiters.delete(id);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      try {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      } catch {
        /* AbortSignal 实现差异，忽略 */
      }
    }
    waiter.resolve({ outcome, id, ...extra });
    return true;
  }

  /**
   * 阻塞等待一条挂起审批被 resolve（供 pi 的 tool_call 钩子 await）。
   * timeout / aborted 都按 deny 处理，但文案不同；timeout 会把请求落库为 expired，
   * 避免 pending() 继续返回僵尸请求。
   * @returns {Promise<{outcome:"allow"|"deny"|"timeout"|"aborted", id:string, reason?:string}>}
   */
  function waitFor(id, { timeoutMs = DEFAULT_TTL_MS, signal } = {}) {
    const requestId = String(id ?? "").trim();
    if (!requestId) throw new Error("waitFor 需要审批 id");
    expireStale();
    const row = S.getRequest.get(requestId);
    if (!row) return Promise.resolve({ outcome: "deny", id: requestId, reason: "审批不存在" });
    if (row.status !== "pending") {
      // 响应可能比 waitFor 先到，直接给出已落库的结局。
      return Promise.resolve({
        outcome: row.decision === "allow" ? "allow" : "deny",
        id: requestId,
        reason: `审批已是 ${row.status} 状态`,
      });
    }
    if (signal && signal.aborted) {
      S.cancelOne.run(nowIso(), requestId);
      return Promise.resolve({ outcome: "aborted", id: requestId, reason: "调用方已中止等待" });
    }

    return new Promise((resolveWait) => {
      const waiter = { resolve: resolveWait, timer: null, onAbort: null, signal };
      waiters.set(requestId, waiter);
      waiter.timer = setTimeout(() => {
        if (!waiters.has(requestId)) return; // 已被 resolve / abort 抢先
        try {
          S.expireOne.run(nowIso(), requestId);
        } catch (err) {
          logger.warn("标记审批超时失败", err?.message || err);
        }
        recordAudit({
          decision: "deny", tool: row.tool, scope: "timeout", by: "timeout",
          mode: getMode(row.room_id || GLOBAL_SCOPE), reason: "审批超时无人裁决",
          patternKey: row.pattern_key, roomId: row.room_id, botId: row.bot_id, requestId,
        });
        settleWaiter(requestId, "timeout", { reason: "等待人工审批超时" });
      }, Math.max(50, Number(timeoutMs) || DEFAULT_TTL_MS));
      if (signal && typeof signal.addEventListener === "function") {
        waiter.onAbort = () => {
          if (!waiters.has(requestId)) return;
          try {
            S.cancelOne.run(nowIso(), requestId);
          } catch (err) {
            logger.warn("撤回审批失败", err?.message || err);
          }
          settleWaiter(requestId, "aborted", { reason: "调用方中止了等待" });
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  function getMode(scopeKey = GLOBAL_SCOPE) {
    const key = String(scopeKey || GLOBAL_SCOPE);
    if (key !== GLOBAL_SCOPE) {
      const row = S.getSetting.get(key);
      if (row && APPROVAL_MODES.includes(row.mode)) return row.mode;
    }
    const global = S.getSetting.get(GLOBAL_SCOPE);
    return global && APPROVAL_MODES.includes(global.mode) ? global.mode : DEFAULT_MODE;
  }

  function setMode(mode, { scopeKey = GLOBAL_SCOPE, by = "system" } = {}) {
    const value = String(mode ?? "").trim().toLowerCase();
    if (!APPROVAL_MODES.includes(value)) {
      return { ok: false, error: `未知审批模式：${mode}（可选 ${APPROVAL_MODES.join(" / ")}）` };
    }
    S.putSetting.run(String(scopeKey || GLOBAL_SCOPE), value, String(by || "system"), nowIso());
    logger.info(`审批模式 ${scopeKey || GLOBAL_SCOPE} -> ${value}（by ${by}）`);
    return { ok: true, mode: value };
  }

  function lookupCache(patternKey, roomId, botId) {
    const stamp = nowIso();
    const p = party(roomId, botId);
    const always = S.getAlways.get(patternKey, stamp);
    if (always) return { scope: "always", by: always["by"] || "user" };
    const session = S.getScoped.get(patternKey, "session", p.room, p.bot, stamp);
    if (session) return { scope: "session", by: session["by"] || "user" };
    const once = S.getScoped.get(patternKey, "once", p.room, p.bot, stamp);
    if (once) {
      if (Number(once.uses_left) > 1) S.consumeOnce.run(patternKey, "once", p.room, p.bot);
      else S.dropCache.run(patternKey, "once", p.room, p.bot);
      return { scope: "once", by: once["by"] || "user" };
    }
    return null;
  }

  function grantCache({ patternKey, scope, roomId, botId, by }) {
    const stamp = nowIso();
    const p = party(roomId, botId);
    if (scope === "always") {
      // always 是跨房间、跨重启的永久白名单（对齐 Hermes 永久 allowlist，approval.py:422）。
      return S.putCache.run(patternKey, "always", CACHE_ALL, CACHE_ALL, -1, stamp, null, String(by || "user"));
    }
    if (scope === "session") {
      return S.putCache.run(patternKey, "session", p.room, p.bot, -1, stamp, null, String(by || "user"));
    }
    S.putCache.run(patternKey, "once", p.room, p.bot, 1, stamp, isoOf(nowMs() + ONCE_TTL_MS), String(by || "user"));
  }

  function evaluate({ tool, input, ctx = {} } = {}) {
    const toolName = String(tool ?? "").trim();
    if (!toolName) throw new Error("evaluate 需要 { tool }");
    const args = input && typeof input === "object" ? input : {};
    const context = ctx && typeof ctx === "object" ? ctx : {};
    const roomId = context.roomId ? String(context.roomId) : "";
    const botId = context.botId ? String(context.botId) : "";
    const patternKey = computePatternKey(toolName, args);
    const mode = getMode(roomId || GLOBAL_SCOPE);
    const base = { tool: toolName, patternKey, roomId, botId, mode };

    // 1) 地板：先于缓存与模式，任何人都不能放行。
    const floor = matchFloor(toolName, args);
    if (floor) {
      logger.warn(`地板拦截 ${toolName}：${floor.id}`);
      recordAudit({ ...base, decision: "deny", scope: "floor", by: "floor", reason: floor.reason });
      return { decision: "deny", reason: floor.reason, patternKey, rule: floor };
    }

    // 2) 缓存三态：always（跨重启）> session（roomId+botId）> once（消费即失效）。
    const hit = lookupCache(patternKey, roomId, botId);
    if (hit) {
      const label = hit.scope === "always" ? "永久批准" : hit.scope === "session" ? "本会话批准" : "一次性批准";
      recordAudit({ ...base, decision: "allow", scope: hit.scope, by: hit.by, reason: `${label}自动放行` });
      return {
        decision: "allow",
        reason: `已由${label}自动放行（${patternKey}）`,
        patternKey,
        rule: { id: "appr.cache", scope: hit.scope },
      };
    }

    // 3) 拒绝熔断：同会话连续拒绝达阈值后不再问，直接 deny（契约要求；Hermes 只加严文案）。
    const key = sessionKeyOf(roomId, botId);
    const denials = denialTally.get(key) || 0;
    if (threshold > 0 && denials >= threshold) {
      const reason = `拒绝熔断：本会话连续拒绝了 ${denials} 次（阈值 ${threshold}），不再弹出审批。`
        + `请换思路或请群主用 clearSession 重置后人工放行。`;
      if (!breakerNotified.has(key)) {
        breakerNotified.add(key);
        logger.warn(`拒绝熔断触发（${key}，${denials} 次）`);
        recordAudit({ ...base, decision: "deny", scope: "breaker", by: "breaker", reason });
      }
      return { decision: "deny", reason, patternKey, rule: { id: "appr.denial-breaker", denials, threshold } };
    }

    // 4) 模式判定。
    const decided = decideByMode(mode, toolName, args);
    return { decision: decided.decision, reason: decided.reason, patternKey };
  }

  function request({ tool, input, ctx = {}, reason = null, patternKey, ttlMs = DEFAULT_TTL_MS } = {}) {
    const toolName = String(tool ?? "").trim();
    if (!toolName) throw new Error("request 需要 { tool }");
    const args = input && typeof input === "object" ? input : {};
    const context = ctx && typeof ctx === "object" ? ctx : {};
    const roomId = context.roomId ? String(context.roomId) : "";
    const botId = context.botId ? String(context.botId) : "";
    const key = patternKey || computePatternKey(toolName, args);

    const floor = matchFloor(toolName, args);
    if (floor) throw new Error(`[approval] 地板不可审批（${floor.id}）：${floor.reason}`);
    const sessionKey = sessionKeyOf(roomId, botId);
    if (threshold > 0 && (denialTally.get(sessionKey) || 0) >= threshold) {
      throw new Error("[approval] 拒绝熔断已触发：本会话不再接受新的审批单，请先 clearSession。");
    }

    expireStale();
    const stamp = nowMs();
    const ttl = Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS);
    const existing = S.findPending.get(key, roomId, botId, isoOf(stamp));
    if (existing) return { id: existing.id, status: "already_pending", approval: mapRequest(existing) };

    const id = makeId();
    S.insertRequest.run(id, toolName, JSON.stringify(args), roomId, botId, key, reason ? String(reason) : "",
      isoOf(stamp), isoOf(stamp + ttl), ttl);
    logger.info(`挂起审批 ${id}：${toolName} / ${key}`);
    return { id, status: "pending", approval: mapRequest(S.getRequest.get(id)) };
  }

  function resolve(id, { decision, scope = "once", by = "user", reason = null } = {}) {
    const requestId = String(id ?? "").trim();
    if (!requestId) return { ok: false, error: "resolve 需要审批 id" };
    if (decision !== "allow" && decision !== "deny") return { ok: false, error: `无效裁决：${decision}（只能 allow / deny）` };
    if (!SCOPES.includes(scope)) return { ok: false, error: `无效范围：${scope}（可选 ${SCOPES.join(" / ")}）` };
    expireStale();
    const row = S.getRequest.get(requestId);
    if (!row) return { ok: false, error: `审批不存在：${requestId}` };
    // 幂等契约（Lead）：重复裁决 / 过期后裁决统一返回 already_resolved。
    if (row.status !== "pending") return { ok: false, error: "already_resolved", status: row.status };

    const actor = String(by || "user");
    const sessionKey = sessionKeyOf(row.room_id, row.bot_id);
    const mode = getMode(row.room_id || GLOBAL_SCOPE);
    const stamp = nowIso();

    if (decision === "allow") {
      S.decide.run("approved", "allow", scope, actor, reason ? String(reason) : null, stamp, requestId);
      grantCache({ patternKey: row.pattern_key, scope, roomId: row.room_id, botId: row.bot_id, by: actor });
      // 一次人工批准就清零熔断计数（Hermes _user_approved -> _reset_denials，approval.py:590-593）。
      denialTally.delete(sessionKey);
      breakerNotified.delete(sessionKey);
      recordAudit({
        decision: "allow", tool: row.tool, scope, by: actor, mode,
        reason: reason || `人工批准（${scope}）`, patternKey: row.pattern_key,
        roomId: row.room_id, botId: row.bot_id, requestId,
      });
      logger.info(`批准 ${requestId}（${scope}，by ${actor}）`);
    } else {
      S.decide.run("denied", "deny", scope, actor, reason ? String(reason) : null, stamp, requestId);
      const count = (denialTally.get(sessionKey) || 0) + 1;
      denialTally.set(sessionKey, count);
      const tripped = threshold > 0 && count >= threshold;
      recordAudit({
        decision: "deny", tool: row.tool, scope, by: actor, mode,
        reason: tripped ? `${reason || "人工拒绝"}（连续拒绝 ${count} 次，已触发熔断）` : reason || "人工拒绝",
        patternKey: row.pattern_key, roomId: row.room_id, botId: row.bot_id, requestId,
      });
      logger.warn(`拒绝 ${requestId}（连续 ${count} 次）`);
    }
    // 唤醒 waitFor 的钩子（若还没人在等，waitFor 会从库里的 status 读到结局）。
    settleWaiter(requestId, decision === "allow" ? "allow" : "deny", {
      reason: reason || (decision === "allow" ? "人工批准" : "人工拒绝"),
    });
    return { ok: true, approval: mapRequest(S.getRequest.get(requestId)) };
  }

  function pending({ roomId, botId, limit = 50 } = {}) {
    expireStale();
    const room = roomId ? String(roomId) : null;
    const bot = botId ? String(botId) : null;
    const max = Math.max(1, Math.min(Number(limit) || 50, 500));
    return S.listPending.all(room, room, bot, bot, max).map(mapRequest);
  }

  function list({ limit = 50, roomId } = {}) {
    const room = roomId ? String(roomId) : null;
    return S.listRequests.all(room, room, Math.max(1, Math.min(Number(limit) || 50, 500))).map(mapRequest);
  }

  function audit({ limit = 100, roomId } = {}) {
    const room = roomId ? String(roomId) : null;
    return S.listAudit.all(room, room, Math.max(1, Math.min(Number(limit) || 100, 1000)));
  }

  function clearSession({ roomId, botId } = {}) {
    if (!roomId && !botId) return { ok: false, error: "clearSession 需要 roomId 或 botId" };
    const room = roomId ? String(roomId) : null;
    const bot = botId ? String(botId) : null;
    const waitingIds = S.pendingIds.all(room, room, bot, bot).map((r) => r.id);
    let cleared = Number(S.dropSession.run(room, room, bot, bot)?.changes || 0);
    cleared += Number(S.cancelPending.run(nowIso(), room, room, bot, bot)?.changes || 0);
    // 会话结束时撤回等待者，别让 tool_call 钩子干等到超时（对齐 Hermes clear_session，approval.py:312）。
    for (const pendingId of waitingIds) settleWaiter(pendingId, "deny", { reason: "会话已清理，审批撤回" });
    for (const key of [...denialTally.keys()]) {
      const [keyRoom, keyBot] = key.split("|");
      if ((room === null || keyRoom === room) && (bot === null || keyBot === bot)) {
        denialTally.delete(key);
        breakerNotified.delete(key);
      }
    }
    logger.info(`清理会话审批状态 room=${room ?? "*"} bot=${bot ?? "*"}，清除 ${cleared} 条`);
    return { ok: true, cleared };
  }

  function stats() {
    expireStale();
    const byStatus = {};
    for (const row of S.countStatus.all()) byStatus[row.status] = Number(row.n || 0);
    const byMode = {};
    for (const row of S.countMode.all()) if (row.mode) byMode[row.mode] = Number(row.n || 0);
    return {
      pending: byStatus.pending || 0,
      approved: byStatus.approved || 0,
      denied: byStatus.denied || 0,
      expired: byStatus.expired || 0,
      byMode,
    };
  }

  logger.info(`审批层就绪（默认模式 ${getMode(GLOBAL_SCOPE)}，熔断阈值 ${threshold <= 0 ? "关闭" : threshold}）`);
  return { getMode, setMode, evaluate, request, resolve, waitFor, pending, list, audit, clearSession, stats };
}
