/**
 * 经验 → 技能：把"这一轮群聊真的做成了什么"压成一份确定性 playbook 草稿。
 *
 * 为什么需要：curator 已经有 propose → review → adopt 的闭环（`src/skills/curator.js`），但**没有触发源**——
 * 只能人肉调 `propose`。Hermes 的招牌恰恰是"从经验中创建技能、在使用中改进技能"
 * （`reference/hermes/hermes-agent/README.zh-CN.md:16`、`:23`）。这里补上触发源的两个纯函数：
 * 质量闸门 + 草稿生成，让 `Room.runRound` 末尾可以安全地"自动提案、人工采纳"。
 *
 * 与 Hermes 的分工差异：Hermes 让策展 LLM fork 自己写/合并 SKILL.md（`agent/curator.py:292`
 * CURATOR_REVIEW_PROMPT），我们用确定性模板生成——同样的回合永远得到同样的字节，不调 LLM、
 * 不读文件、不写库。也正因为确定，`signature` 才能当跨回合去重键（`sha1(title + "\n" + body)`）。
 *
 * 质量取舍（对齐 `agent/curator.py:296-304` 的"窄技能泛滥是失败"）：宁可不产出，也不要每回合塞
 * 一条一次性技能。闸门要求 ≥2 个成员回合、无证据不符、（有 reviewer 时）reviewer 通过，并按
 * `auto_propose_skills` 决定是否必须有 observed 证据。草稿正文不含 frontmatter——name/description/
 * version/source/created 由 `curator.adopt` 统一补（`src/skills/curator.js`）。
 *
 * 约束：纯函数、无 IO、无 LLM、确定性、不改入参。turns 形状固定为
 * `{ bot_id, text, evidence: "observed"|"prepared"|"mismatch"|null, ms }`；
 * `evidenceSummary` 形状同 `src/rooms/evidence.js#summary()`。
 */
import crypto from "node:crypto";

/** 标题上限（字符数，按 code point 计）。 */
export const TITLE_MAX_CHARS = 40;

/** `settings.auto_propose_skills` 的合法取值；未识别时按 `observed` 处理。 */
export const AUTO_PROPOSE_MODES = ["off", "observed", "always"];

const MIN_TURNS = 2;
const GOAL_MAX_CHARS = 160;
const STEP_MAX_CHARS = 140;
const MAX_STEPS = 12;
const MAX_FILE_IDS = 10;
const MAX_TAGS = 12;

/** 回合文本里的 file_id 声明（与 `src/rooms/evidence.js` 的两种写法兼容）。 */
const FILE_ID_RE = /file_id\s*[：:=]\s*`?([0-9a-f]{6,})`?/gi;

/* ------------------------------------------------------------------ 工具 */

/** 单行压缩：折叠空白、去首尾。 */
function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

const charsOf = (text) => [...String(text ?? "")];

/** 按 code point 硬截断（不破坏代理对；标题用，不补省略号）。 */
function clip(text, max) {
  const chars = charsOf(text);
  return chars.length > max ? chars.slice(0, max).join("") : String(text ?? "");
}

/** 按 code point 截断并补省略号（目标/步骤用）。 */
function ellipsize(text, max) {
  const chars = charsOf(text);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : String(text ?? "");
}

function normalizeEvidence(value) {
  const text = clean(value).toLowerCase();
  return text === "observed" || text === "prepared" || text === "mismatch" ? text : null;
}

/** 只保留有正文的成员回合，顺序不变（步骤要按回合顺序）。 */
function usableTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns
    .filter((turn) => turn && typeof turn === "object")
    .map((turn) => ({
      bot_id: clean(turn.bot_id ?? turn.botId ?? turn.member ?? "") || "member",
      text: String(turn.text ?? "").trim(),
      evidence: normalizeEvidence(turn.evidence),
    }))
    .filter((turn) => turn.text.length > 0);
}

/**
 * 证据计数：本回合逐条 evidence 与调用方传入的 summary 取并集（较大值）。
 * 为什么取并集：调用方可能传房间累计计数、也可能只传本轮；任一信号说"有 mismatch"都必须拦。
 */
function evidenceCounts(turns, evidenceSummary) {
  const counts = { observed: 0, prepared: 0, mismatch: 0 };
  for (const turn of turns) if (turn.evidence) counts[turn.evidence] += 1;
  const source = evidenceSummary && typeof evidenceSummary === "object" ? evidenceSummary : null;
  const given = (key) => {
    const value = Number(source?.[key]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  };
  return {
    observed: Math.max(counts.observed, given("observed")),
    prepared: Math.max(counts.prepared, given("prepared")),
    mismatch: Math.max(counts.mismatch, given("mismatch")),
    total: Math.max(turns.length, given("total")),
  };
}

/** 房间设置 → 模式。`false`/`"false"`/`"off"` 都算关闭；未识别按默认 `observed`。 */
function autoMode(settings) {
  const raw = settings && typeof settings === "object" ? settings.auto_propose_skills : undefined;
  if (raw === false) return "off";
  const value = clean(raw).toLowerCase();
  if (value === "off" || value === "false" || value === "0" || value === "none" || value === "disabled") return "off";
  if (value === "always") return "always";
  return "observed";
}

/** reviewer 结论归一：null/空 = 本轮没有 reviewer；无法识别按不通过处理（fail closed）。 */
function reviewerState(verdict) {
  if (verdict === null || verdict === undefined) return "none";
  const value = clean(verdict).toLowerCase();
  if (!value) return "none";
  if (value === "pass" || value === "passed" || value === "approved" || value === "ok" || value === "通过") return "pass";
  if (value === "reject" || value === "rejected" || value === "fail" || value === "failed" || value === "不通过") {
    return "reject";
  }
  return "unknown";
}

/* ------------------------------------------------------------------ 闸门 */

/**
 * 质量闸门（契约 §9.2）：是否值得把本轮沉淀成技能提案。
 * @param {{turns?:Array, evidenceSummary?:object|null, reviewerVerdict?:string|null,
 *          reviewerPresent?:boolean, settings?:object}} input
 *   `reviewerPresent` 是 §9.2 的超集：区分「本轮没有 reviewer」与「reviewer 在场但没表态」。
 *   后者一律不沉淀（沉默不是通过），前者按无 reviewer 处理。
 * @returns {{ok:boolean, reason:string}}
 */
export function evaluateLearningGate({
  turns = [],
  evidenceSummary = null,
  reviewerVerdict = null,
  reviewerPresent = undefined,
  settings = {},
} = {}) {
  if (autoMode(settings) === "off") {
    return { ok: false, reason: "房间设置已关闭自动提案（auto_propose_skills=off）" };
  }
  const usable = usableTurns(turns);
  if (usable.length < MIN_TURNS) {
    return { ok: false, reason: `只有 ${usable.length} 个成员回合（至少需要 ${MIN_TURNS} 个）` };
  }
  const counts = evidenceCounts(usable, evidenceSummary);
  if (counts.mismatch > 0) {
    return { ok: false, reason: `存在证据不符（mismatch=${counts.mismatch}），先修正再沉淀` };
  }
  const reviewer = reviewerState(reviewerVerdict);
  if (reviewer === "reject") {
    return { ok: false, reason: "reviewer 结论为不通过（reviewerVerdict=reject），不沉淀" };
  }
  if (reviewer === "unknown") {
    return { ok: false, reason: `reviewer 结论无法识别（${clean(reviewerVerdict)}），按不通过处理` };
  }
  if (reviewer === "none" && reviewerPresent === true) {
    return { ok: false, reason: "reviewer 在场但没有给出可识别的结论（未表态），不沉淀" };
  }
  const mode = autoMode(settings);
  if (mode === "observed" && counts.observed < 1) {
    return {
      ok: false,
      reason: `没有可观测证据（observed=0），auto_propose_skills=observed 下不产出；确认后可改为 always`,
    };
  }
  const reviewerNote = reviewer === "pass" ? "reviewer 通过" : "无 reviewer";
  const modeNote = mode === "always" ? "always 模式" : "observed 证据已满足";
  return { ok: true, reason: `通过：${usable.length} 个成员回合、无 mismatch、${modeNote}、${reviewerNote}` };
}

/* ------------------------------------------------------------------ 草稿 */

/** 标题提炼：去掉 @称呼、说话人前缀、Markdown 标记与多余标点，≤40 字。 */
function cleanTitleText(value) {
  return clean(
    String(value ?? "")
      .replace(/@[\w.-]+/g, " ")
      .replace(/^(?:群主|主持人|owner|lead|用户|user)\s*[:：]\s*/i, "")
      .replace(/[`*_>#]/g, "")
      .replace(/^[\s\-–—:：,，。.、!！?？'"“”‘’（）()\[\]【】「」『』…]+/, "")
      .replace(/[\s\-–—:：,，。.、!！?？'"“”‘’（）()\[\]【】「」『』…]+$/, ""),
  );
}

/** 目标句：只去称呼与说话人前缀，保留句读（读者需要完整的一句任务）。 */
function cleanGoalText(value) {
  return clean(
    String(value ?? "")
      .replace(/@[\w.-]+/g, " ")
      .replace(/^(?:群主|主持人|owner|lead|用户|user)\s*[:：]\s*/i, ""),
  );
}

/** 回合正文压成一行步骤：跳过标题/列表符号，取第一行够长的内容。 */
function condenseTurn(text) {
  const strip = (line) =>
    clean(
      String(line)
        .replace(/^#{1,6}\s*/, "")
        .replace(/^[>*+\-]\s+/, "")
        .replace(/^v?\d+[.)]\s+/i, ""),
    );
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const value = strip(line);
    if (value.length >= 8) return value;
  }
  return lines.length ? strip(lines[0]) : "";
}

/**
 * 去掉“指令外壳”：群聊里的任务常写成「请群主分派：让 coder 写一份 X」，
 * 直接拿来当技能标题会又长又不像技能名。这里只剥壳，不做语义改写。
 */
function stripDispatchShell(value) {
  let text = String(value ?? "").trim();
  text = text
    .replace(/^(?:请|麻烦)?\s*(?:群主|老板|主持人|lead|owner)?\s*(?:先)?\s*(?:分派|安排)(?:一下)?\s*[：:，,\s]*/i, "")
    .replace(/^(?:让|叫|请)\s*[a-z0-9_-]+\s*(?:来|去)?\s*/i, "")
    .trim();
  return text;
}

/** 标题候选顺序：去掉指令外壳的任务 → 话题 → 首个成员回合 → 房间名。 */
function makeTitle({ instruction, topic, turns, roomTitle }) {
  const candidates = [
    stripDispatchShell(instruction),
    stripDispatchShell(topic),
    turns.length ? condenseTurn(turns[0].text) : "",
    roomTitle,
  ];
  for (const candidate of candidates) {
    const title = clip(cleanTitleText(candidate), TITLE_MAX_CHARS);
    if (title) return title;
  }
  return "";
}

/** 成员显示名：members 里可能是 id 字符串或 `{id,name}`；都没有就回退 bot_id。 */
function memberLabel(botId, members) {
  const id = clean(botId) || "member";
  for (const member of Array.isArray(members) ? members : []) {
    if (!member) continue;
    if (typeof member === "string") {
      if (member === id) return member;
      continue;
    }
    if (typeof member === "object" && (member.id === id || member.bot_id === id || member.botId === id)) {
      return clean(member.name || member.title) || id;
    }
  }
  return id;
}

/** 证据段：files（群文件行）+ 回合文本里点名的 file_id，去重保序。 */
function collectFileLines({ files, turns }) {
  const out = [];
  const seen = new Set();
  const add = (id, description = "") => {
    const key = clean(id).toLowerCase();
    if (!key || seen.has(key) || out.length >= MAX_FILE_IDS) return;
    seen.add(key);
    const note = clean(description);
    out.push(note ? `- file_id：${key}（${note}）` : `- file_id：${key}`);
  };
  for (const file of Array.isArray(files) ? files : []) {
    if (!file) continue;
    if (typeof file === "string") add(file);
    else add(file.file_id ?? file.fileId ?? file.id, file.description ?? file.path ?? "");
  }
  for (const turn of turns) {
    for (const match of turn.text.matchAll(FILE_ID_RE)) add(match[1]);
  }
  return out;
}

/** tags：去空白、去重、限量；顺序保持调用方传入顺序。 */
function normalizeTags(tags) {
  const out = [];
  const seen = new Set();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = clean(tag);
    const key = value.toLowerCase();
    if (!value || seen.has(key) || out.length >= MAX_TAGS) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** signature 的归一化：标题折叠空白并小写；正文逐行 trim、折叠 3+ 空行。 */
function normalizeForSignature(title, body) {
  const normalizedTitle = clean(title).toLowerCase();
  const normalizedBody = String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${normalizedTitle}\n${normalizedBody}`;
}

/**
 * 生成技能草稿（契约 §9.2）。无可用材料时返回 null。
 * body 是 Markdown playbook（目标 / 步骤 / 验收标准 / 证据 / 适用场景），**不含 frontmatter**。
 * @param {{instruction?:string, roomId?:string, roomTitle?:string, topic?:string, members?:Array,
 *          turns?:Array, files?:Array, evidenceSummary?:object|null, reviewerVerdict?:string|null,
 *          tags?:string[]}} input
 * @returns {{title:string, body:string, tags:string[], signature:string}|null}
 */
export function buildSkillDraft({
  instruction,
  roomId,
  roomTitle,
  topic,
  members = [],
  turns = [],
  files = [],
  evidenceSummary = null,
  reviewerVerdict = null,
  tags = [],
} = {}) {
  const usable = usableTurns(turns);
  const instructionText = String(instruction ?? "").trim();
  if (!instructionText && !usable.length) return null;

  const title = makeTitle({ instruction: instructionText, topic, turns: usable, roomTitle });
  if (!title) return null;

  const counts = evidenceCounts(usable, evidenceSummary);
  const reviewer = reviewerState(reviewerVerdict);
  const goal = ellipsize(cleanGoalText(instructionText) || clean(topic) || title, GOAL_MAX_CHARS);
  const tagList = normalizeTags(tags);

  const steps = usable.slice(0, MAX_STEPS).map(
    (turn, index) => `${index + 1}. **${memberLabel(turn.bot_id, members)}**：${ellipsize(condenseTurn(turn.text), STEP_MAX_CHARS)}`,
  );
  if (usable.length > MAX_STEPS) steps.push(`（另有 ${usable.length - MAX_STEPS} 个回合未列出）`);

  const acceptance = [
    `- 至少 2 名成员按顺序产出，且证据阶梯里没有 mismatch（observed ${counts.observed} / prepared ${counts.prepared} / mismatch ${counts.mismatch}）。`,
  ];
  if (reviewer === "pass") acceptance.push("- reviewer 复核结论为通过。");
  if (reviewer === "reject") acceptance.push("- reviewer 复核结论为不通过：本稿仅供对照，禁止直接采纳。");

  const fileLines = collectFileLines({ files, turns: usable });
  const roomLabel = clean(roomTitle) || clean(roomId) || "本群";
  const topicLabel = clean(topic) || "同类任务";
  const keywordTags = tagList.filter((tag) => tag !== topicLabel);
  const scenario = [
    `房间「${roomLabel}」里的「${topicLabel}」`,
    keywordTags.length ? `关键词：${keywordTags.join("、")}` : "",
    "再次遇到同类需求时按上面步骤执行；环境变化时先修正步骤再采纳。",
  ]
    .filter(Boolean)
    .join("；");

  const body = [
    `# ${title}`,
    "",
    "## 目标",
    "",
    goal,
    "",
    "## 步骤",
    "",
    ...(steps.length ? steps : ["1. （本回合没有可复用的步骤）"]),
    "",
    "## 验收标准",
    "",
    ...acceptance,
    "",
    "## 证据",
    "",
    ...(fileLines.length ? fileLines : ["- 本回合没有 file_id 证据。"]),
    "",
    "## 适用场景",
    "",
    scenario,
    "",
  ].join("\n");

  const signature = crypto.createHash("sha1").update(normalizeForSignature(title, body), "utf8").digest("hex");
  return { title, body, tags: tagList, signature };
}

export default { evaluateLearningGate, buildSkillDraft, TITLE_MAX_CHARS, AUTO_PROPOSE_MODES };
