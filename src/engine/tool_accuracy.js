/**
 * Tool Calling Accuracy & Recovery Engine — inspired by OpenCode & dsh.
 *
 * Solves the 4 biggest real-world sources of agent tool-calling failures:
 *   1. Tool Name & Argument Drift (`resolveToolName`, `repairToolArguments`):
 *      Models trained across different harnesses frequently emit alias tool names
 *      (`read_file` -> `read`, `edit_file` -> `edit`, `run_command` -> `bash`) or
 *      alias parameter keys (`file_path` -> `path`, `old_string` -> `oldText`,
 *      `cmd` -> `command`) or stringified numbers/booleans (`"42"` -> `42`).
 *      We repair them deterministically BEFORE pi's JSON Schema validation rejects them!
 *   2. Brittle Exact-String `edit` Matching (`smartEditReplace`, `applySmartEdits`):
 *      Implements OpenCode's 6-strategy safe fuzzy-replacement cascade:
 *        (1) exact -> (2) line_trimmed -> (3) indent_flexible ->
 *        (4) block_anchor -> (5) whitespace_normalized -> (6) escape_normalized
 *      Strictly requires an unambiguous single match (unless `replaceAll: true`),
 *      preserves original CRLF/LF endings and target indentation, and returns
 *      top near-miss line ranges + file snippets when no match exists.
 *   3. Read-Before-Edit & External File Staleness Guard (`FileReadTracker`):
 *      Tracks file mtime/size observed via `read`/`write`/`edit` so edits never
 *      silently clobber externally modified files.
 *   4. In-Turn Doom-Loop Guard & Actionable Error Recovery (`ToolLoopGuard`, `enrichToolError`):
 *      Intercepts 3x repeated identical tool calls (or repeated identical failures)
 *      with structured `<tool_recovery_hint>` guidance, and enriches ENOENT /
 *      schema / edit errors with sibling directory hints or canonical tool suggestions.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createLogger } from "../log.js";
import { stableStringify } from "./cache_optimizer.js";

const log = createLogger("engine.tool_accuracy");

/* ========================================================================= *
 * 1. Tool Name Alias & Typo Resolution
 * ========================================================================= */

/** Common cross-harness tool name aliases -> AgentFusion/pi canonical tool name. */
export const TOOL_NAME_ALIASES = Object.freeze({
  // read
  read_file: "read",
  view_file: "read",
  open_file: "read",
  get_file: "read",
  cat: "read",
  readfile: "read",
  // write
  write_file: "write",
  write_to_file: "write",
  create_file: "write",
  save_file: "write",
  writefile: "write",
  // edit
  edit_file: "edit",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  str_replace: "edit",
  str_replace_editor: "edit",
  str_replace_based_edit_tool: "edit",
  patch_file: "edit",
  apply_patch: "edit",
  editfile: "edit",
  // bash / shell
  run_command: "bash",
  execute_command: "bash",
  execute_bash: "bash",
  run_bash: "bash",
  shell: "bash",
  sh: "bash",
  terminal: "bash",
  exec: "bash",
  // powershell
  run_powershell: "powershell",
  pwsh: "powershell",
  // grep
  grep_search: "grep",
  search_files: "grep",
  search_content: "grep",
  ripgrep: "grep",
  rg: "grep",
  text_search: "grep",
  // find
  find_files: "find",
  find_by_name: "find",
  glob: "find",
  glob_files: "find",
  search_glob: "find",
  // ls
  list_dir: "ls",
  list_directory: "ls",
  list_files: "ls",
  listdir: "ls",
  dir: "ls",
  // room files
  save_room_file: "room_file_save",
  read_room_file: "room_file_read",
  list_room_files: "room_file_list",
  move_room_file: "room_file_move",
});

/** Bounded Levenshtein edit distance for safe typo recovery. */
export function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const prev = new Array(t.length + 1);
  const curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j += 1) prev[j] = curr[j];
  }
  return prev[t.length];
}

/**
 * Resolve a model-emitted tool name against the session's active tool list.
 *
 * @param {string} rawName
 * @param {string[]} activeToolNames
 * @returns {{ name: string, repaired: boolean, originalName: string, strategy: string|null, suggestion?: string|null }}
 */
export function resolveToolName(rawName, activeToolNames = []) {
  const originalName = String(rawName || "").trim();
  const active = Array.isArray(activeToolNames) ? activeToolNames.map((n) => String(n || "").trim()).filter(Boolean) : [];
  const activeSet = new Set(active);

  if (!originalName || activeSet.has(originalName)) {
    return { name: originalName, repaired: false, originalName, strategy: null };
  }

  // Strip accidental namespace prefix (e.g. `functions.read`, `default_api:read`, `tools/read`)
  const stripped = originalName.replace(/^(?:functions|default_api|tools|tool)[:./]/i, "");
  if (stripped !== originalName && activeSet.has(stripped)) {
    return { name: stripped, repaired: true, originalName, strategy: "namespace_strip" };
  }

  // Case-insensitive & delimiter-normalized match (`browser.open` / `browser-open` -> `browser_open`)
  const normalized = stripped.toLowerCase().replace(/[\s.-]+/g, "_");
  for (const candidate of active) {
    if (candidate.toLowerCase() === normalized || candidate.toLowerCase().replace(/[\s.-]+/g, "_") === normalized) {
      return { name: candidate, repaired: true, originalName, strategy: "case_delimiter" };
    }
  }

  // Explicit cross-harness alias map
  const aliased = TOOL_NAME_ALIASES[normalized];
  if (aliased && activeSet.has(aliased)) {
    return { name: aliased, repaired: true, originalName, strategy: "alias" };
  }

  // Safe Levenshtein typo match (distance <= 1, or <= 2 for longer names >= 8 chars), must be unique
  const maxDist = normalized.length >= 8 ? 2 : 1;
  let best = null;
  let bestDist = maxDist + 1;
  let tie = false;
  for (const candidate of active) {
    const d = levenshtein(normalized, candidate.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
      tie = false;
    } else if (d === bestDist) {
      tie = true;
    }
  }
  if (best && !tie && bestDist <= maxDist) {
    return { name: best, repaired: true, originalName, strategy: "levenshtein" };
  }

  return {
    name: originalName,
    repaired: false,
    originalName,
    strategy: null,
    suggestion: best || null,
  };
}

/* ========================================================================= *
 * 2. Parameter Alias Normalization & Schema-Guided Type Coercion
 * ========================================================================= */

const PER_TOOL_PARAM_ALIASES = Object.freeze({
  read: {
    path: ["file_path", "filePath", "filepath", "filename", "file", "target_file", "target"],
    offset: ["start_line", "startLine", "from_line", "fromLine", "line_start", "start"],
    limit: ["line_count", "lineCount", "max_lines", "maxLines", "num_lines", "lines", "count"],
  },
  write: {
    path: ["file_path", "filePath", "filepath", "filename", "file", "target_file", "target"],
    content: ["text", "code", "body", "data", "file_content", "fileContent"],
  },
  edit: {
    path: ["file_path", "filePath", "filepath", "filename", "file", "target_file", "target"],
    oldText: ["old_text", "old_string", "oldString", "search", "find", "target_content", "targetContent", "original"],
    newText: ["new_text", "new_string", "newString", "replace", "replacement", "replacement_content", "replacementContent", "updated"],
    edits: ["changes", "replacements", "hunks", "patches"],
  },
  bash: {
    command: ["cmd", "script", "shell_command", "shellCommand", "code"],
    timeout: ["timeout_ms", "timeoutMs", "timeout_seconds", "timeoutSeconds"],
  },
  powershell: {
    command: ["cmd", "script", "shell_command", "shellCommand", "code"],
    timeout: ["timeout_ms", "timeoutMs", "timeout_seconds", "timeoutSeconds"],
  },
  grep: {
    pattern: ["query", "regex", "search", "text", "keyword", "term"],
    path: ["dir", "directory", "folder", "root", "file_path", "filePath", "target"],
    glob: ["include", "file_pattern", "filePattern", "filter"],
    limit: ["max_results", "maxResults", "count"],
  },
  find: {
    pattern: ["glob", "query", "name", "file_pattern", "filePattern", "search"],
    path: ["dir", "directory", "folder", "root", "target"],
    limit: ["max_results", "maxResults", "count"],
  },
  ls: {
    path: ["dir", "directory", "folder", "root", "target", "file_path", "filePath"],
    limit: ["max_results", "maxResults", "count"],
  },
});

const GENERIC_PARAM_ALIASES = Object.freeze({
  path: ["file_path", "filePath", "filepath", "filename"],
  command: ["cmd"],
  query: ["q", "keyword"],
  url: ["href", "uri", "link"],
  selector: ["css", "css_selector", "element"],
});

/** Normalize one `edits[]` item inside the `edit` tool. */
function normalizeEditItem(item, repairs) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const out = { ...item };
  const oldAliases = ["old_text", "old_string", "oldString", "search", "find", "target_content", "targetContent", "original"];
  const newAliases = ["new_text", "new_string", "newString", "replace", "replacement", "replacement_content", "replacementContent", "updated"];

  if (out.oldText === undefined) {
    for (const k of oldAliases) {
      if (out[k] !== undefined) {
        out.oldText = String(out[k]);
        delete out[k];
        repairs.push(`edit.${k}->oldText`);
        break;
      }
    }
  }
  if (out.newText === undefined) {
    for (const k of newAliases) {
      if (out[k] !== undefined) {
        out.newText = String(out[k]);
        delete out[k];
        repairs.push(`edit.${k}->newText`);
        break;
      }
    }
  }
  return out;
}

/** Coerce primitive argument types safely based on JSON Schema property definitions. */
function coerceBySchema(obj, schema, repairs) {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return obj;

  for (const [key, propSchema] of Object.entries(props)) {
    if (!(key in obj)) continue;
    const val = obj[key];
    const targetType = Array.isArray(propSchema?.type) ? propSchema.type[0] : propSchema?.type;

    if (val === null && !(Array.isArray(propSchema?.type) && propSchema.type.includes("null"))) {
      // Remove optional explicit null that trips strict JSON Schema validators
      const required = Array.isArray(schema.required) && schema.required.includes(key);
      if (!required) {
        delete obj[key];
        repairs.push(`drop_null:${key}`);
      }
      continue;
    }

    if ((targetType === "number" || targetType === "integer") && typeof val === "string" && val.trim() !== "") {
      const parsed = Number(val.trim());
      if (Number.isFinite(parsed)) {
        obj[key] = targetType === "integer" ? Math.trunc(parsed) : parsed;
        repairs.push(`coerce_num:${key}`);
      }
    } else if (targetType === "boolean" && typeof val === "string") {
      const lower = val.trim().toLowerCase();
      if (lower === "true" || lower === "1") {
        obj[key] = true;
        repairs.push(`coerce_bool:${key}`);
      } else if (lower === "false" || lower === "0") {
        obj[key] = false;
        repairs.push(`coerce_bool:${key}`);
      }
    } else if (targetType === "array" && typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            obj[key] = parsed;
            repairs.push(`parse_array:${key}`);
          }
        } catch {
          /* ignore invalid JSON */
        }
      }
    } else if (targetType === "string" && typeof val === "number") {
      obj[key] = String(val);
      repairs.push(`coerce_str:${key}`);
    }
  }
  return obj;
}

/**
 * Deterministically repair common LLM tool-argument errors before schema validation.
 *
 * @param {string} toolName
 * @param {any} rawArgs
 * @param {object} [schema]
 * @returns {{ args: object, repaired: boolean, repairs: string[] }}
 */
export function repairToolArguments(toolName, rawArgs, schema = null) {
  const repairs = [];
  let args = rawArgs;

  // 1. Unwrap stringified JSON arguments
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed;
          repairs.push("parse_json_args");
        }
      } catch {
        /* fall through */
      }
    }
  }

  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { args: args && typeof args === "object" ? args : {}, repaired: repairs.length > 0, repairs };
  }

  const out = { ...args };
  const aliasMap = PER_TOOL_PARAM_ALIASES[toolName] || null;
  const schemaProps = schema?.properties && typeof schema.properties === "object" ? schema.properties : null;

  const applyAliases = (map, requireInSchema) => {
    for (const [canonical, aliases] of Object.entries(map)) {
      if (requireInSchema && schemaProps && !(canonical in schemaProps)) continue;
      if (out[canonical] !== undefined) continue;
      for (const alias of aliases) {
        if (out[alias] !== undefined) {
          out[canonical] = out[alias];
          delete out[alias];
          repairs.push(`${alias}->${canonical}`);
          break;
        }
      }
    }
  };

  if (aliasMap) applyAliases(aliasMap, false);
  applyAliases(GENERIC_PARAM_ALIASES, true);

  // 2. Special handling for `edit`: normalize nested edits[] and single-edit legacy form
  if (toolName === "edit") {
    if (Array.isArray(out.edits)) {
      out.edits = out.edits.map((item) => normalizeEditItem(item, repairs));
    } else if (out.oldText !== undefined && out.newText !== undefined) {
      out.edits = [{ oldText: String(out.oldText), newText: String(out.newText) }];
      delete out.oldText;
      delete out.newText;
      repairs.push("single_edit->edits[]");
    }
  }

  // 3. Special handling for `bash`/`powershell`: convert ms timeout to seconds if huge (> 3600)
  if ((toolName === "bash" || toolName === "powershell") && typeof out.timeout === "number" && out.timeout > 3600) {
    out.timeout = Math.max(1, Math.round(out.timeout / 1000));
    repairs.push("timeout_ms->sec");
  }

  // 4. Trim stray leading/trailing whitespace on file paths
  if (typeof out.path === "string" && out.path !== out.path.trim()) {
    out.path = out.path.trim();
    repairs.push("trim:path");
  }

  // 5. Schema-guided type coercion
  if (schemaProps) {
    coerceBySchema(out, schema, repairs);
  }

  return { args: out, repaired: repairs.length > 0, repairs };
}

/* ========================================================================= *
 * 3. OpenCode 6-Strategy Multi-Pass Fuzzy Edit Replacer + Near-Miss Diagnostics
 * ========================================================================= */

function detectLineEnding(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function toLF(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

function restoreLineEnding(text, eol) {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function leadingIndent(line) {
  const m = String(line || "").match(/^[ \t]*/);
  return m ? m[0] : "";
}

function minCommonIndent(lines) {
  let min = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = leadingIndent(line).length;
    if (min === null || indent < min) min = indent;
  }
  return min ?? 0;
}

function stripIndent(lines) {
  const min = minCommonIndent(lines);
  if (min === 0) return lines.slice();
  return lines.map((l) => (l.trim() ? l.slice(Math.min(min, leadingIndent(l).length)) : ""));
}

function detectIndentStep(lines) {
  const base = minCommonIndent(lines);
  let step = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const delta = leadingIndent(line).length - base;
    if (delta > 0 && (step === null || delta < step)) step = delta;
  }
  return step || 0;
}

function reindentBlock(newText, targetBaseIndent, { targetStep = 0, oldStep = 0 } = {}) {
  const newLines = newText.split("\n");
  const stripped = stripIndent(newLines);
  const scaleInner = targetStep > 0 && oldStep > 0 && targetStep !== oldStep && targetStep % oldStep === 0;
  const factor = scaleInner ? targetStep / oldStep : 1;
  return stripped
    .map((l) => {
      if (!l.trim()) return "";
      if (factor > 1) {
        const inner = leadingIndent(l);
        if (inner.length > 0 && /^[ ]+$/.test(inner)) {
          return `${targetBaseIndent}${" ".repeat(inner.length * factor)}${l.slice(inner.length)}`;
        }
      }
      return `${targetBaseIndent}${l}`;
    })
    .join("\n");
}

function lineOffsetToLineNumber(text, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Token-level Jaccard/overlap similarity for line comparison (0..1). */
function lineSimilarity(a, b) {
  const s1 = String(a || "").trim();
  const s2 = String(b || "").trim();
  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen <= 120) {
    const dist = levenshtein(s1, s2);
    return Math.max(0, 1 - dist / maxLen);
  }
  const t1 = new Set(s1.split(/\W+/).filter(Boolean));
  const t2 = new Set(s2.split(/\W+/).filter(Boolean));
  if (!t1.size || !t2.size) return 0;
  let inter = 0;
  for (const tok of t1) if (t2.has(tok)) inter += 1;
  return inter / (t1.size + t2.size - inter);
}

/** Find all exact substring start indices. */
function findAllExact(haystack, needle) {
  const hits = [];
  if (!needle) return hits;
  let pos = 0;
  while (pos <= haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    hits.push(idx);
    pos = idx + needle.length;
  }
  return hits;
}

/** Compute start/end character offsets for a line range `[startLineIdx, endLineIdxExclusive)` in LF text. */
function lineRangeOffsets(lines, startLine, lineCount) {
  let startOffset = 0;
  for (let i = 0; i < startLine; i += 1) startOffset += lines[i].length + 1;
  let matchLen = 0;
  for (let i = 0; i < lineCount; i += 1) {
    matchLen += lines[startLine + i].length;
    if (i < lineCount - 1) matchLen += 1;
  }
  return { startOffset, matchLen };
}

/**
 * Find top near-miss candidate line ranges in `content` for actionable error diagnostics.
 */
export function findNearMisses(content, oldText, maxCandidates = 2) {
  const contentLines = toLF(content).split("\n");
  const needleLines = toLF(oldText).split("\n");
  if (!contentLines.length || !needleLines.length) return [];

  const nonEmptyNeedles = needleLines.filter((l) => l.trim().length > 0);
  if (!nonEmptyNeedles.length) return [];

  const windowSize = Math.min(contentLines.length, Math.max(1, needleLines.length));
  const scored = [];

  for (let i = 0; i <= contentLines.length - windowSize; i += 1) {
    let scoreSum = 0;
    let maxLineSim = 0;
    let compared = 0;
    for (let j = 0; j < windowSize; j += 1) {
      const a = contentLines[i + j];
      const b = needleLines[j] ?? "";
      if (!a.trim() && !b.trim()) continue;
      const sim = lineSimilarity(a, b);
      if (sim > maxLineSim) maxLineSim = sim;
      scoreSum += sim;
      compared += 1;
    }
    const avgScore = compared > 0 ? scoreSum / compared : 0;
    // Surface candidate if overall window matches OR anchor line has strong similarity
    const score = Math.max(avgScore, maxLineSim * 0.65);
    if (score >= 0.3) {
      scored.push({ startLine: i + 1, endLine: i + windowSize, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const cand of scored) {
    if (picked.length >= maxCandidates) break;
    const overlaps = picked.some((p) => !(cand.endLine < p.startLine || cand.startLine > p.endLine));
    if (overlaps) continue;
    const snippetLines = contentLines
      .slice(Math.max(0, cand.startLine - 1), Math.min(contentLines.length, cand.endLine))
      .slice(0, 8)
      .map((line, idx) => `${cand.startLine + idx}| ${line}`);
    picked.push({
      startLine: cand.startLine,
      endLine: cand.endLine,
      similarity: Math.round(cand.score * 100),
      snippet: snippetLines.join("\n"),
    });
  }
  return picked;
}

/**
 * OpenCode 6-strategy safe fuzzy-replacement engine.
 *
 * Strategies tried in strict order (stops at the first strategy that finds match(es)):
 *   1. `exact`: verbatim match
 *   2. `line_trimmed`: line-by-line trim match (re-indents `newText` to matched block's base indent)
 *   3. `indent_flexible`: common-indent-stripped match (re-indents `newText` to target indent)
 *   4. `block_anchor`: multi-line (>= 3 lines) first+last line trimmed anchor + interior similarity >= 0.65
 *   5. `whitespace_normalized`: collapses internal horizontal whitespace runs for matching
 *   6. `escape_normalized`: unescapes double-escaped `\n`, `\t`, `\"`, `\'` in `oldText`
 *
 * @param {string} rawContent
 * @param {string} rawOldText
 * @param {string} rawNewText
 * @param {{ replaceAll?: boolean }} [opts]
 * @returns {{
 *   ok: boolean,
 *   content?: string,
 *   strategy?: string,
 *   usedFuzzy?: boolean,
 *   replacements?: number,
 *   matchLine?: number,
 *   errorCode?: "EMPTY_OLD"|"NOOP"|"MULTIPLE_MATCHES"|"NOT_FOUND",
 *   matchCount?: number,
 *   matchLines?: number[],
 *   nearMisses?: object[],
 *   message?: string,
 * }}
 */
export function smartEditReplace(rawContent, rawOldText, rawNewText, opts = {}) {
  const eol = detectLineEnding(String(rawContent ?? ""));
  const content = toLF(rawContent);
  const oldText = toLF(rawOldText);
  const newText = toLF(rawNewText);
  const replaceAll = Boolean(opts.replaceAll);

  if (!oldText) {
    return { ok: false, errorCode: "EMPTY_OLD", message: "edit 失败：oldText 不能为空。" };
  }
  if (oldText === newText) {
    return { ok: false, errorCode: "NOOP", message: "edit 失败：oldText 与 newText 完全相同，未产生修改。" };
  }

  // --- Strategy 1: Exact match ---
  const exactHits = findAllExact(content, oldText);
  if (exactHits.length === 1 || (exactHits.length > 1 && replaceAll)) {
    const updated = replaceAll
      ? content.split(oldText).join(newText)
      : content.slice(0, exactHits[0]) + newText + content.slice(exactHits[0] + oldText.length);
    return {
      ok: true,
      content: restoreLineEnding(updated, eol),
      strategy: "exact",
      usedFuzzy: false,
      replacements: replaceAll ? exactHits.length : 1,
      matchLine: lineOffsetToLineNumber(content, exactHits[0]),
    };
  }
  if (exactHits.length > 1) {
    const matchLines = exactHits.map((idx) => lineOffsetToLineNumber(content, idx));
    return {
      ok: false,
      errorCode: "MULTIPLE_MATCHES",
      matchCount: exactHits.length,
      matchLines,
      message: `edit 失败：oldText 在文件中精确匹配了 ${exactHits.length} 处（行 ${matchLines.join(", ")}）。请在 oldText 中补充前后 1–2 行上下文以唯一确定位置。`,
    };
  }

  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  const windowLen = oldLines.length;

  /** Helper to apply matched line ranges safely (single match or replaceAll). */
  const finalizeLineMatches = (matches, strategy, preserveBaseIndent = true) => {
    if (matches.length === 0) return null;
    if (matches.length > 1 && !replaceAll) {
      const matchLines = matches.map((m) => m.startLine + 1);
      return {
        ok: false,
        errorCode: "MULTIPLE_MATCHES",
        matchCount: matches.length,
        matchLines,
        message: `edit 失败（${strategy}）：匹配到 ${matches.length} 处候选（行 ${matchLines.join(", ")}）。请补充前后上下文以唯一确定位置。`,
      };
    }

    // Apply from bottom to top so offsets stay valid
    let updated = content;
    const sorted = [...matches].sort((a, b) => b.startLine - a.startLine);
    for (const m of sorted) {
      const { startOffset, matchLen } = lineRangeOffsets(contentLines, m.startLine, m.lineCount);
      let replacement = newText;
      if (preserveBaseIndent) {
        const matchedSlice = contentLines.slice(m.startLine, m.startLine + m.lineCount);
        const targetFirstNonEmpty = matchedSlice.find((l) => l.trim().length > 0);
        const oldFirstNonEmpty = oldLines.find((l) => l.trim().length > 0);
        const targetIndent = targetFirstNonEmpty ? leadingIndent(targetFirstNonEmpty) : "";
        const oldIndent = oldFirstNonEmpty ? leadingIndent(oldFirstNonEmpty) : "";
        const targetStep = detectIndentStep(matchedSlice);
        const oldStep = detectIndentStep(oldLines);
        if (targetIndent !== oldIndent || (targetStep && oldStep && targetStep !== oldStep)) {
          replacement = reindentBlock(newText, targetIndent, { targetStep, oldStep });
        }
      }
      updated = updated.slice(0, startOffset) + replacement + updated.slice(startOffset + matchLen);
    }

    return {
      ok: true,
      content: restoreLineEnding(updated, eol),
      strategy,
      usedFuzzy: true,
      replacements: sorted.length,
      matchLine: matches[0].startLine + 1,
    };
  };

  // --- Strategy 2: Line-trimmed match ---
  if (windowLen <= contentLines.length) {
    const trimmedOld = oldLines.map((l) => l.trim());
    const matches = [];
    for (let i = 0; i <= contentLines.length - windowLen; i += 1) {
      let allMatch = true;
      for (let j = 0; j < windowLen; j += 1) {
        if (contentLines[i + j].trim() !== trimmedOld[j]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) matches.push({ startLine: i, lineCount: windowLen });
    }
    const res = finalizeLineMatches(matches, "line_trimmed", true);
    if (res) return res;
  }

  // --- Strategy 3: Indentation-flexible match (relative indentation preserved) ---
  if (windowLen <= contentLines.length) {
    const strippedOld = stripIndent(oldLines).join("\n");
    const matches = [];
    for (let i = 0; i <= contentLines.length - windowLen; i += 1) {
      const slice = contentLines.slice(i, i + windowLen);
      if (stripIndent(slice).join("\n") === strippedOld) {
        matches.push({ startLine: i, lineCount: windowLen });
      }
    }
    const res = finalizeLineMatches(matches, "indent_flexible", true);
    if (res) return res;
  }

  // --- Strategy 4: Block-anchor match (multi-line >= 3 lines: exact trimmed first & last line + high interior similarity) ---
  if (windowLen >= 3 && windowLen <= contentLines.length) {
    const firstAnchor = oldLines[0].trim();
    const lastAnchor = oldLines[windowLen - 1].trim();
    if (firstAnchor && lastAnchor) {
      const oldFirstIndent = leadingIndent(oldLines[0]).length;
      const oldLastIndent = leadingIndent(oldLines[windowLen - 1]).length;
      const expectedEndIndentDelta = oldLastIndent - oldFirstIndent;
      const candidates = [];
      for (let i = 0; i < contentLines.length; i += 1) {
        if (contentLines[i].trim() !== firstAnchor) continue;
        // Search end anchor within +/- 2 lines of expected block size; keep best end for this start line
        const minEnd = Math.max(i + 2, i + windowLen - 3);
        const maxEnd = Math.min(contentLines.length - 1, i + windowLen + 2);
        const startIndent = leadingIndent(contentLines[i]).length;
        let bestForStart = null;
        for (let end = minEnd; end <= maxEnd; end += 1) {
          if (contentLines[end].trim() !== lastAnchor) continue;
          const blockLen = end - i + 1;
          const minInterior = Math.min(windowLen - 2, blockLen - 2);
          const maxInterior = Math.max(windowLen - 2, blockLen - 2);
          let simSum = 0;
          for (let k = 1; k <= minInterior; k += 1) {
            simSum += lineSimilarity(contentLines[i + k], oldLines[k]);
          }
          // Penalize missing/extra interior lines by normalizing against maxInterior
          const rawSim = maxInterior > 0 ? simSum / maxInterior : 1;
          const endIndentDelta = leadingIndent(contentLines[end]).length - startIndent;
          const indentBonus = endIndentDelta === expectedEndIndentDelta ? 0.05 : 0;
          const score = Math.min(1, rawSim + indentBonus);
          if (rawSim >= 0.65 && (!bestForStart || score > bestForStart.score)) {
            bestForStart = { startLine: i, lineCount: blockLen, score };
          }
        }
        if (bestForStart) candidates.push(bestForStart);
      }
      if (candidates.length === 1) {
        const res = finalizeLineMatches(candidates, "block_anchor", true);
        if (res) return res;
      } else if (candidates.length > 1) {
        candidates.sort((a, b) => b.score - a.score);
        if (candidates[0].score - candidates[1].score >= 0.15 && candidates[0].score >= 0.8) {
          const res = finalizeLineMatches([candidates[0]], "block_anchor", true);
          if (res) return res;
        }
      }
    }
  }

  // --- Strategy 5: Whitespace-normalized match ---
  const collapseWs = (s) => String(s || "").trim().replace(/[ \t]+/g, " ");
  if (windowLen <= contentLines.length) {
    const wsOld = oldLines.map(collapseWs);
    const matches = [];
    for (let i = 0; i <= contentLines.length - windowLen; i += 1) {
      let ok = true;
      for (let j = 0; j < windowLen; j += 1) {
        if (collapseWs(contentLines[i + j]) !== wsOld[j]) {
          ok = false;
          break;
        }
      }
      if (ok) matches.push({ startLine: i, lineCount: windowLen });
    }
    const res = finalizeLineMatches(matches, "whitespace_normalized", true);
    if (res) return res;
  }

  // --- Strategy 6: Escape-normalized match (handles over-escaped \\n / \\t / \\" / \\') ---
  if (/\\[nt"']/.test(oldText)) {
    const unescape = (s) =>
      s
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'");
    const unescapedOld = unescape(oldText);
    const unescapedNew = unescape(newText);
    if (unescapedOld !== oldText) {
      const hits = findAllExact(content, unescapedOld);
      if (hits.length === 1 || (hits.length > 1 && replaceAll)) {
        const updated = replaceAll
          ? content.split(unescapedOld).join(unescapedNew)
          : content.slice(0, hits[0]) + unescapedNew + content.slice(hits[0] + unescapedOld.length);
        return {
          ok: true,
          content: restoreLineEnding(updated, eol),
          strategy: "escape_normalized",
          usedFuzzy: true,
          replacements: replaceAll ? hits.length : 1,
          matchLine: lineOffsetToLineNumber(content, hits[0]),
        };
      }
    }
  }

  // --- Not found: compute actionable near-miss diagnostics ---
  const nearMisses = findNearMisses(content, oldText, 2);
  let diag = "edit 失败：在文件中未找到匹配的 oldText（已依次尝试精确匹配、缩进兼容、块锚点与空白规范化匹配）。";
  if (nearMisses.length) {
    const formatted = nearMisses
      .map((m) => `候选 L${m.startLine}-L${m.endLine}（相似度 ${m.similarity}%）：\n${m.snippet}`)
      .join("\n\n");
    diag += `\n最接近的候选片段：\n${formatted}\n请先用 read 确认精确行内容后再调用 edit。`;
  } else {
    diag += " 请先用 read 查看目标文件当前内容后再调用 edit。";
  }
  return {
    ok: false,
    errorCode: "NOT_FOUND",
    nearMisses,
    message: diag,
  };
}

/**
 * Transactionally apply a batch of `{ oldText, newText }` edits using `smartEditReplace`.
 */
export function applySmartEdits(content, edits = []) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, message: "edit 失败：edits 列表不能为空。" };
  }
  let current = String(content ?? "");
  const strategies = [];
  let fuzzyCount = 0;
  let firstChangedLine = null;

  for (let i = 0; i < edits.length; i += 1) {
    const item = edits[i];
    const res = smartEditReplace(current, item?.oldText ?? "", item?.newText ?? "", {
      replaceAll: Boolean(item?.replaceAll),
    });
    if (!res.ok) {
      const prefix = edits.length > 1 ? `edits[${i}] ` : "";
      return {
        ok: false,
        failedIndex: i,
        errorCode: res.errorCode,
        nearMisses: res.nearMisses,
        message: `${prefix}${res.message}`,
      };
    }
    current = res.content;
    strategies.push(res.strategy);
    if (res.usedFuzzy) fuzzyCount += 1;
    if (firstChangedLine === null && res.matchLine) firstChangedLine = res.matchLine;
  }

  return {
    ok: true,
    content: current,
    strategies,
    fuzzyCount,
    firstChangedLine,
  };
}

/* ========================================================================= *
 * 4. Read-Before-Edit File Staleness Tracker & In-Turn Doom-Loop Guard
 * ========================================================================= */

/** Tracks files read/written within one agent session to prevent stale overwrites. */
export class FileReadTracker {
  constructor() {
    /** @type {Map<string, { mtimeMs: number, size: number, seenAt: number }>} */
    this._files = new Map();
  }

  record(absPath) {
    if (!absPath) return;
    const key = path.resolve(String(absPath));
    try {
      const st = fs.statSync(key);
      if (st.isFile()) {
        this._files.set(key, { mtimeMs: st.mtimeMs, size: st.size, seenAt: Date.now() });
      }
    } catch {
      /* file may not exist yet */
    }
  }

  /**
   * Check whether `absPath` was read previously and whether it changed on disk since.
   * Returns `{ known, stale, reason }`.
   */
  checkBeforeEdit(absPath) {
    if (!absPath) return { known: false, stale: false, reason: null };
    const key = path.resolve(String(absPath));
    const prev = this._files.get(key);
    if (!prev) return { known: false, stale: false, reason: null };
    try {
      const st = fs.statSync(key);
      // Allow 50ms mtime tolerance for filesystem timestamp granularity
      if (Math.abs(st.mtimeMs - prev.mtimeMs) > 50 || st.size !== prev.size) {
        return {
          known: true,
          stale: true,
          reason: `文件 ${path.basename(key)} 自上次 read 后已在外部被修改（大小 ${prev.size} -> ${st.size} 字节）。请先调用 read 读取最新版本再执行 edit，避免覆盖外部改动。`,
        };
      }
      return { known: true, stale: false, reason: null };
    } catch {
      return { known: true, stale: false, reason: null };
    }
  }

  clear() {
    this._files.clear();
  }
}

/**
 * In-turn / per-session Doom-Loop Guard (OpenCode pattern).
 * Intercepts 3 consecutive identical tool calls OR 3 identical failures within
 * the recent window so the model doesn't waste tokens looping forever.
 */
export class ToolLoopGuard {
  constructor({ maxConsecutive = 3, maxRepeatedFailures = 2, windowSize = 12 } = {}) {
    this.maxConsecutive = Math.max(2, Number(maxConsecutive) || 3);
    this.maxRepeatedFailures = Math.max(2, Number(maxRepeatedFailures) || 2);
    this.windowSize = Math.max(6, Number(windowSize) || 12);
    /** @type {Array<{ tool: string, sig: string, ok: boolean|null, ts: number }>} */
    this._history = [];
  }

  signature(toolName, args) {
    const raw = `${String(toolName || "")}:${stableStringify(args ?? {})}`;
    return crypto.createHash("sha1").update(raw, "utf8").digest("hex").slice(0, 16);
  }

  /**
   * Check before executing a tool call.
   * @returns {{ blocked: boolean, reason?: string, count?: number }}
   */
  check(toolName, args) {
    const name = String(toolName || "");
    const sig = this.signature(name, args);

    // 1. Consecutive identical calls (even if previous ones succeeded — e.g. re-reading same slice forever)
    let consecutive = 0;
    for (let i = this._history.length - 1; i >= 0; i -= 1) {
      if (this._history[i].sig === sig) consecutive += 1;
      else break;
    }
    if (consecutive >= this.maxConsecutive - 1) {
      return {
        blocked: true,
        count: consecutive + 1,
        reason: `<tool_recovery_hint>检测到重复调用循环：工具 ${name} 已使用完全相同的参数连续调用 ${consecutive + 1} 次。请停止重复相同调用，改用其他工具（如 ls/find/grep 定位，或 read 查看最新上下文）或调整参数后再试。</tool_recovery_hint>`,
      };
    }

    // 2. Repeated identical failures in recent window
    const failedSame = this._history.filter((h) => h.sig === sig && h.ok === false).length;
    if (failedSame >= this.maxRepeatedFailures) {
      return {
        blocked: true,
        count: failedSame + 1,
        reason: `<tool_recovery_hint>检测到失败重试循环：工具 ${name} 使用相同参数已连续失败 ${failedSame} 次。请先分析上次报错原因并修改参数或切换方案，不要原样重试。</tool_recovery_hint>`,
      };
    }

    this._history.push({ tool: name, sig, ok: null, ts: Date.now() });
    if (this._history.length > this.windowSize) {
      this._history.splice(0, this._history.length - this.windowSize);
    }
    return { blocked: false };
  }

  recordOutcome(toolName, args, ok) {
    const sig = this.signature(toolName, args);
    for (let i = this._history.length - 1; i >= 0; i -= 1) {
      if (this._history[i].sig === sig && this._history[i].ok === null) {
        this._history[i].ok = Boolean(ok);
        return;
      }
    }
  }

  reset() {
    this._history = [];
  }
}

/* ========================================================================= *
 * 5. Actionable Error Enricher
 * ========================================================================= */

/** Safely list up to 15 sibling entries of a missing path inside `cwd`. */
function siblingHint(targetPath, cwd) {
  if (!targetPath || !cwd) return "";
  try {
    const root = path.resolve(cwd);
    const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
    const parent = path.dirname(resolved);
    // Security: never probe outside cwd
    if (!parent.startsWith(root)) return "";
    if (!fs.existsSync(parent)) return "";
    const entries = fs.readdirSync(parent, { withFileTypes: true }).slice(0, 15);
    if (!entries.length) return "";
    const wanted = path.basename(resolved).toLowerCase();
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    const closest = entries
      .map((e) => ({ name: e.name, dist: levenshtein(wanted, e.name.toLowerCase()) }))
      .sort((a, b) => a.dist - b.dist)[0];
    const relParent = path.relative(root, parent) || ".";
    const suggest = closest && closest.dist <= 3 ? `（最接近的名称：${closest.name}）` : "";
    return `目录 "${relParent}" 下现有条目${suggest}：${names.join(", ")}`;
  } catch {
    return "";
  }
}

/**
 * Enrich an opaque tool error message with concise, structured recovery hints.
 */
export function enrichToolError({ toolName, args, errorText, cwd, activeTools = [], fileTracker = null } = {}) {
  const raw = String(errorText || "");
  if (!raw || raw.includes("<tool_recovery_hint>")) return raw;

  const hints = [];

  // 1. Unknown tool error -> suggest canonical name
  const notFoundTool = raw.match(/Tool\s+([^\s]+)\s+not found/i);
  if (notFoundTool && activeTools.length) {
    const resolved = resolveToolName(notFoundTool[1], activeTools);
    if (resolved.repaired || resolved.suggestion) {
      hints.push(`建议改用已注册工具 "${resolved.repaired ? resolved.name : resolved.suggestion}"。当前可用工具：${activeTools.join(", ")}。`);
    }
  }

  // 2. ENOENT / file not found -> show sibling entries inside cwd
  if (/ENOENT|no such file|not found|does not exist/i.test(raw) && args?.path) {
    const sib = siblingHint(args.path, cwd);
    if (sib) hints.push(sib);
    else hints.push("请先调用 find 或 ls 确认目标文件的准确路径。");
  }

  // 3. Edit failure on unread file
  if (toolName === "edit" && /Could not find|未找到匹配/i.test(raw) && args?.path && fileTracker && cwd) {
    const abs = path.isAbsolute(args.path) ? path.resolve(args.path) : path.resolve(cwd, args.path);
    const check = fileTracker.checkBeforeEdit(abs);
    if (!check.known) {
      hints.push("提示：本会话尚未 read 过该文件，请先调用 read 读取目标行后再执行 edit。");
    }
  }

  // 4. Schema validation error -> remind canonical keys
  if (/validation|required|invalid arguments|must have required property/i.test(raw)) {
    const known = PER_TOOL_PARAM_ALIASES[toolName];
    if (known) {
      hints.push(`工具 ${toolName} 标准参数键：${Object.keys(known).join(", ")}。`);
    }
  }

  if (!hints.length) return raw;
  return `${raw}\n\n<tool_recovery_hint>${hints.join(" ")}</tool_recovery_hint>`;
}

/* ========================================================================= *
 * 6. Pi Session Instrumentation & Extension
 * ========================================================================= */

/**
 * Extract plain text from a pi tool result content array.
 */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Wrap registered tools & stream function on a live pi `AgentSession` so:
 *  - Hallucinated tool name aliases are transparently repaired before `prepareToolCall`
 *  - Parameter aliases & type drift are repaired in `tool.prepareArguments` BEFORE pi schema validation
 *  - Built-in `edit` gets OpenCode 6-strategy fuzzy fallback + near-miss line diagnostics + staleness guard
 *
 * @param {object} session pi AgentSession
 * @param {{
 *   cwd: string,
 *   fileTracker?: FileReadTracker,
 *   onMetric?: (metric: object) => void,
 * }} opts
 */
export function enhanceSessionToolAccuracy(session, opts = {}) {
  if (!session?.agent) return { enhancedTools: 0 };
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const fileTracker = opts.fileTracker || new FileReadTracker();
  const report = (metric) => {
    try {
      opts.onMetric?.(metric);
    } catch {
      /* ignore */
    }
  };

  const tools = session.agent?.state?.tools || session.agent?._state?.tools || [];
  let enhancedTools = 0;

  // 1. Wrap `prepareArguments` on every registered tool + upgrade `edit.execute`
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || tool.__afAccuracyWrapped) continue;
    const origPrepare = typeof tool.prepareArguments === "function" ? tool.prepareArguments.bind(tool) : null;
    const toolName = String(tool.name || "");
    const schema = tool.parameters || null;

    tool.prepareArguments = (rawArgs) => {
      const repaired = repairToolArguments(toolName, rawArgs, schema);
      if (repaired.repaired) {
        log.debug(`[tool-repair] ${toolName} args repaired: ${repaired.repairs.join(", ")}`);
        report({ type: "arg_repaired", tool: toolName, repairs: repaired.repairs });
      }
      return origPrepare ? origPrepare(repaired.args) : repaired.args;
    };

    // Upgrade built-in `edit` with staleness guard + 6-strategy OpenCode fuzzy fallback + near-miss diagnostics
    if (toolName === "edit" && typeof tool.execute === "function") {
      const origExecute = tool.execute.bind(tool);
      tool.execute = async (toolCallId, input, signal, onUpdate, ctx) => {
        const relPath = String(input?.path || "").trim();
        const absPath = relPath ? (path.isAbsolute(relPath) ? path.resolve(relPath) : path.resolve(cwd, relPath)) : "";

        // Staleness guard: block silent overwrite if file changed externally since last read
        if (absPath) {
          const check = fileTracker.checkBeforeEdit(absPath);
          if (check.stale) {
            throw new Error(check.reason);
          }
        }

        try {
          const res = await origExecute(toolCallId, input, signal, onUpdate, ctx);
          if (absPath) fileTracker.record(absPath);
          return res;
        } catch (err) {
          const msg = String(err?.message || err || "");
          // Only trigger fuzzy fallback when exact match failed and target file is readable
          if (!/Could not find/i.test(msg) || !absPath || !fs.existsSync(absPath)) {
            throw err;
          }
          const edits = Array.isArray(input?.edits)
            ? input.edits
            : (input?.oldText !== undefined && input?.newText !== undefined
              ? [{ oldText: input.oldText, newText: input.newText }]
              : []);
          if (!edits.length) throw err;

          const currentContent = fs.readFileSync(absPath, "utf8");
          const smart = applySmartEdits(currentContent, edits);
          if (!smart.ok) {
            // Throw our rich near-miss diagnostic error instead of pi's terse error
            throw new Error(smart.message || msg);
          }

          fs.writeFileSync(absPath, smart.content, "utf8");
          fileTracker.record(absPath);
          log.info(`[fuzzy-edit] recovered edit on ${relPath} via ${smart.strategies.join(",")}`);
          report({
            type: "fuzzy_edit",
            tool: "edit",
            path: relPath,
            strategies: smart.strategies,
            fuzzyCount: smart.fuzzyCount,
          });
          return {
            content: [
              {
                type: "text",
                text: `Successfully edited ${relPath} (applied ${edits.length} edit${edits.length > 1 ? "s" : ""} via ${smart.strategies.join(", ")}${smart.firstChangedLine ? ` starting near line ${smart.firstChangedLine}` : ""}).`,
              },
            ],
            details: {
              path: relPath,
              fuzzy_strategies: smart.strategies,
              firstChangedLine: smart.firstChangedLine,
            },
          };
        }
      };
    }

    tool.__afAccuracyWrapped = true;
    enhancedTools += 1;
  }

  // 2. Wrap `agent.streamFunction` to transparently repair hallucinated tool names
  //    on assistant messages BEFORE `prepareToolCall` throws "Tool X not found"
  const agent = session.agent;
  if (typeof agent.streamFunction === "function" && !agent.__afNameRepairWrapped) {
    const origStreamFn = agent.streamFunction;
    agent.streamFunction = (model, context, streamOpts) => {
      const stream = origStreamFn(model, context, streamOpts);
      if (!stream || typeof stream !== "object") return stream;

      const repairAssistantMessage = (msg) => {
        if (!msg || !Array.isArray(msg.content)) return msg;
        const activeNames = (agent?.state?.tools || agent?._state?.tools || []).map((t) => t?.name).filter(Boolean);
        if (!activeNames.length) return msg;
        for (const block of msg.content) {
          if (block && block.type === "toolCall" && typeof block.name === "string") {
            const resolved = resolveToolName(block.name, activeNames);
            if (resolved.repaired) {
              log.info(`[tool-name-repair] ${block.name} -> ${resolved.name} (${resolved.strategy})`);
              block.name = resolved.name;
              report({
                type: "name_repaired",
                originalName: resolved.originalName,
                tool: resolved.name,
                strategy: resolved.strategy,
              });
            }
          }
        }
        return msg;
      };

      if (typeof stream.result === "function") {
        const origResult = stream.result.bind(stream);
        stream.result = async () => repairAssistantMessage(await origResult());
      }
      if (typeof stream[Symbol.asyncIterator] === "function") {
        const origIter = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = async function* () {
          for await (const ev of { [Symbol.asyncIterator]: origIter }) {
            if (ev && ev.type === "done" && ev.message) {
              repairAssistantMessage(ev.message);
            }
            yield ev;
          }
        };
      }
      return stream;
    };
    agent.__afNameRepairWrapped = true;
  }

  return { enhancedTools, fileTracker };
}

/**
 * Create the pi inline extension providing:
 *  - In-turn Doom-Loop Guard (`tool_call`)
 *  - Read-Before-Edit File Tracker updates (`tool_result`)
 *  - Actionable Error Recovery Hints (`tool_result`)
 *  - Live tool-accuracy telemetry reporting
 *
 * @param {{
 *   cwd: string,
 *   fileTracker?: FileReadTracker,
 *   loopGuard?: ToolLoopGuard,
 *   getActiveTools?: () => string[],
 *   onMetric?: (metric: object) => void,
 * }} [options]
 */
export function createToolAccuracyExtension(options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const fileTracker = options.fileTracker || new FileReadTracker();
  const loopGuard = options.loopGuard || new ToolLoopGuard();
  const report = (metric) => {
    try {
      options.onMetric?.(metric);
    } catch {
      /* ignore */
    }
  };

  return (pi) => {
    pi.on("tool_call", async (event) => {
      const toolName = String(event?.toolName || "");
      const input = event?.input || event?.args || {};
      const verdict = loopGuard.check(toolName, input);
      if (verdict.blocked) {
        log.warn(`[doom-loop] blocked repeated call to ${toolName} (count=${verdict.count})`);
        report({ type: "loop_prevented", tool: toolName, count: verdict.count });
        return { block: true, reason: verdict.reason };
      }
      return undefined;
    });

    pi.on("tool_result", async (event) => {
      const toolName = String(event?.toolName || "");
      const input = event?.input || event?.args || {};
      const isError = Boolean(event?.isError);

      loopGuard.recordOutcome(toolName, input, !isError);
      report({ type: "tool_result", tool: toolName, ok: !isError });

      // Update Read-Before-Edit tracker when read/write/edit succeeds
      if (!isError && (toolName === "read" || toolName === "write" || toolName === "edit") && input?.path) {
        const abs = path.isAbsolute(input.path) ? path.resolve(input.path) : path.resolve(cwd, input.path);
        fileTracker.record(abs);
      }

      if (!isError) return undefined;

      // Enrich error result text with structured recovery hints
      const activeTools = typeof options.getActiveTools === "function" ? options.getActiveTools() : [];
      const currentText = toolResultText(event.content);
      const enriched = enrichToolError({
        toolName,
        args: input,
        errorText: currentText,
        cwd,
        activeTools,
        fileTracker,
      });
      if (enriched && enriched !== currentText) {
        const content = Array.isArray(event.content) ? [...event.content] : [];
        const textIdx = content.findIndex((b) => b && b.type === "text");
        if (textIdx >= 0) {
          content[textIdx] = { ...content[textIdx], text: enriched };
        } else {
          content.push({ type: "text", text: enriched });
        }
        return { content };
      }
      return undefined;
    });
  };
}

export default createToolAccuracyExtension;
