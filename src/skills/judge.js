/**
 * reviewer 裁决解析：把"复核者这一轮到底表没表态"从自由文本里判出来，三态：pass / reject / 无法判定。
 *
 * 为什么需要：学习闭环（`src/skills/learn.js`）的质量闸门要求"有 reviewer 时必须通过"。旧实现是
 * `Room._reviewerVerdict`（`src/rooms/room.js:1012-1017`）的一句正则：命中「需修改/不通过…」就 reject，
 * **其余一律 pass**。后果是：reviewer 只说"我稍后复核"也会被当成通过，把没复核过的经验写进提案队列；
 * 反过来「不用修改」会被「需修改」误判成 reject。群聊里这两种话术都极常见，必须按显式语义判。
 *
 * 与 Hermes / omh 的对齐：
 *   - Hermes 的 review 产物是**三态**：`Approved ✅ | Changes Requested 🔴 | Reviewed 💬`
 *     （`skills/software-development/github/references/review-output-template.md:10`），第三态就是
 *     "只审不裁决"，等价于我们的 `null`；且只有 Critical 才阻断合并、nits/suggestions 不阻断
 *     （同文件 `:38-40`），所以 nits 记 pass。
 *   - 状态流转靠**事件种类**而不是散文推断：kanban 的 `changes_requested` 是事件/状态
 *     （`hermes_cli/kanban_db.py:2255`、`:2281-2287`）。
 *   - 结构化产物优于散文猜测：curator 强制要求机器可读的 structured summary，下游工具不靠散文分辨
 *     合并与剪枝（`agent/curator.py:448-469`）。我们没有结构化评审块，只能解析散文，于是把
 *     "没表态"单独拿出来，绝不默认通过。
 *   - omh 的 reviewer 角色边界："Review findings are not fix evidence; merge-ready is not merged"
 *     （`oh-my-hermes/docs/ROLES.md:191`），角色存在本身不是 review evidence（`:21`）；verdict 只允许
 *     PASS/FAIL/PARTIAL 且必须附证据位置（`omh-agent-ops-review/SKILL.md:73`）。
 *
 * 约束：纯函数、无 IO、无 LLM、确定性、不改入参。turns 形状固定为
 * `{ bot_id, text, evidence, ms }`（与 `Room._round_turns` 一致）。
 */

/** 三态；`"null"` 是字符串形式（契约 §10.1），实际返回值为 `null`。 */
export const VERDICTS = ["pass", "reject", "null"];

const MAX_MATCH_CHARS = 80;

/* ------------------------------------------------------------------ 文本 */

/** 单行压缩。 */
function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 去掉 markdown 强调/引用/标题符号，避免 `**通过**`、`> LGTM` 匹配不到。 */
function normalizeText(text) {
  return clean(
    String(text ?? "")
      .replace(/[*_`~]/g, "")
      .replace(/^[ \t]*[>#]+[ \t]*/gm, ""),
  );
}

/** 摘录：以命中片段为中心左右取上下文，总长 ≤80 字（含省略号）。 */
function excerptAt(text, index, length) {
  const pad = Math.max(0, Math.floor((MAX_MATCH_CHARS - length) / 2));
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + length + pad);
  let piece = text.slice(start, end);
  if (start > 0) piece = `…${piece}`;
  if (end < text.length) piece = `${piece}…`;
  const chars = [...piece];
  return chars.length > MAX_MATCH_CHARS ? `${chars.slice(0, MAX_MATCH_CHARS - 1).join("")}…` : piece;
}

/** 最早命中的一条（多模式取位置最靠前的，便于给人看上下文）。 */
function firstMatch(text, patterns) {
  let best = null;
  for (const re of patterns) {
    re.lastIndex = 0;
    const match = re.exec(text);
    re.lastIndex = 0;
    if (match && (!best || match.index < best.index)) {
      best = { index: match.index, text: match[0], length: match[0].length };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ 模式表 */

/**
 * 「否定式修改」必须先从文本里抹掉，否则 `无需修改` 会被 `需修改` 命中（契约点名的陷阱）。
 * 英文同理：`no changes needed` 不能命中 `changes needed`。抹掉后仍保留原文本做通过判定。
 */
const NEGATED_FIX = [
  /(?:不|无需|毋需|不需|不用|不必|没必要|没有|没|未|无)(?:建议|推荐|主张|打算|发现|看到|找到|存在|有|想)?(?:任何|什么)?(?:需要|需|要|用|必)?(?:做|再|重新)?(?:任何)?(?:修改|调整|改动|返工|重做|重来|退回|打回|驳回|否决)/g,
  /\bno\s+changes?\s+(?:needed|required)\b/gi,
  /\bnothing\s+to\s+(?:fix|change)\b/gi,
  /\bno\s+blocking\s+(?:issues?|problems?)\b/gi,
  /\b(?:doesn'?t|does\s+not|didn'?t|did\s+not|needn'?t|no)\s+need\s+(?:any\s+)?(?:work|fixes?|fixing|changes?)\b/gi,
];

/** 拒绝：先否掉「不许出现」的形态，再列显式 reject 表述（顺序 = 优先级）。 */
const REJECT_PATTERNS = [
  /未通过(?!率|数)/, // 「未通过率 0.3%」不是裁决，见 PASS 的「通过率」
  /不通过(?!率|数)/,
  /(?:没有|未能|未获)通过/,
  /需要(?:做|再)?(?:修改|调整|返工|重做)/,
  /(?:还需|仍需|尚需|必须)(?:修改|调整|返工|重做)/,
  /需要(?:补充|增加|添加|补上|补齐|补测试|补用例)/,
  /(?:打回|退回|驳回|否决)/,
  /拒(?:绝|批|不批准|不予批准)/,
  /changes?\s+requested/i,
  /requests?\s+changes/i,
  /(?:needs?|requires?|require)\s+(?:some\s+)?changes?/i,
  /changes?\s+(?:needed|required)/i,
  /(?:not|isn'?t|aren'?t)\s+approved/i,
  /(?:not|didn'?t|doesn'?t)\s+pass/i,
  /\brejected\b/i,
  /needs?\s+(?:fix|fixes|fixing|work)\b/i,
  /must\s+(?:be\s+)?(?:fixed|changed|reworked)/i,
  /blocking\s+(?:issue|problem|bug)/i,
];

/** 通过：显式肯定，或"否定式修改"（无需修改 = 通过）。「通过率」不算裁决。 */
const PASS_PATTERNS = [
  /通过(?!率|数|标准)/,
  /(?:同意|认可|批准|准予)/,
  /没有问题[，,]?\s*(?:不用|无需|不必)?(?:改|修改|调整)?/,
  /没有问题[，,]?\s*(?:结论)?(?:是)?(?:通过|可以)/,
  /可以(?:通过|采纳|合并|发布|上线|继续)/,
  /无需(?:再)?(?:修改|调整|改动)/,
  /(?:不用|不需|不必)(?:再)?(?:修改|调整|改动)/,
  /(?:不|无|毋|免)需(?:要|必)?(?:再)?(?:修改|调整|改动)/,
  /\bLGTM\b/i,
  /\bapproved\b/i,
  /\bapprove\b(?!\s+of\b)/i,
  /\bpass(?:ed)?\b/i,
  /\bship\s+it\b/i,
  /\blooks?\s+good\b/i,
  /\ball\s+good\b/i,
  /\bno\s+changes?\s+(?:needed|required)\b/i,
  /\bnothing\s+to\s+(?:fix|change)\b/i,
  /\bno\s+blocking\s+(?:issues?|problems?)\b/i,
  /\b(?:doesn'?t|does\s+not|didn'?t|did\s+not|needn'?t|no)\s+need\s+(?:any\s+)?(?:work|fixes?|fixing|changes?)\b/i,
  /\bnits?\b/i,
];

/** 未表态：明确说"还没看/稍后看/待定"，与"没给结论"共用 null 结论，但原因不同。 */
const PENDING_PATTERNS = [
  /稍后|稍候|待会|待我|等我/,
  /还没(?:看|看完|复核|审|审阅|读|检查)/,
  /尚未(?:复核|审阅|评审|查看|看)/,
  /(?:之后|回头|晚点|改天)(?:再)?(?:看|复核|确认)/,
  /待(?:确认|复核|定|我看完)/,
  /暂不(?:表态|下结论|给出结论)|先不(?:表态|下结论|通过|拒绝)/,
  /\b(?:tbd|pending|hold\s+on|wip)\b/i,
  /\bto\s+be\s+(?:reviewed|confirmed|determined)\b/i,
  /\bwill\s+(?:review|check|look|revisit|later)\b/i,
  /\bhaven'?t\s+(?:reviewed|looked|checked)\b/i,
  /\bnot\s+yet\s+reviewed\b/i,
];

const EMOJI_REJECT = /[🔴❌👎🚫⛔]/u;
const EMOJI_PASS = /[✅✔👍🟢]/u;

/* ------------------------------------------------------------------ 单条判定 */

/**
 * 判一条 reviewer 文本。
 * 优先级：显式 reject → 显式 pass → emoji reject → emoji pass → 未表态 → 无结论。
 * @returns {{verdict:"pass"|"reject"|null, matched:string|null, reason:string}}
 */
function judgeText(raw) {
  const text = normalizeText(raw);
  if (!text) return { verdict: null, matched: null, reason: "reviewer 文本为空，未表态" };

  // 否定式修改先抹掉，避免「无需修改」被「需修改」、「no changes needed」被「changes needed」命中。
  const scannable = NEGATED_FIX.reduce((acc, pattern) => acc.replace(pattern, " "), text);

  const reject = firstMatch(scannable, REJECT_PATTERNS);
  if (reject) {
    return {
      verdict: "reject",
      matched: excerptAt(scannable, reject.index, reject.length),
      reason: `命中拒绝表述「${clean(reject.text)}」`,
    };
  }
  const pass = firstMatch(text, PASS_PATTERNS);
  if (pass) {
    return {
      verdict: "pass",
      matched: excerptAt(text, pass.index, pass.length),
      reason: `命中通过表述「${clean(pass.text)}」`,
    };
  }
  if (EMOJI_REJECT.test(text)) {
    return { verdict: "reject", matched: "🔴", reason: "命中拒绝标记（🔴/❌）" };
  }
  if (EMOJI_PASS.test(text)) {
    return { verdict: "pass", matched: excerptAt(text, text.search(EMOJI_PASS), 2), reason: "命中通过标记（✅/👍）" };
  }
  const pending = firstMatch(text, PENDING_PATTERNS);
  if (pending) {
    return {
      verdict: null,
      matched: excerptAt(text, pending.index, pending.length),
      reason: `命中未表态表述「${clean(pending.text)}」，不按通过处理`,
    };
  }
  return { verdict: null, matched: null, reason: "没有明确结论（没表态 ≠ 通过）" };
}

/* ------------------------------------------------------------------ 工厂 */

const LABELS = { pass: "通过", reject: "不通过", null: "无法判定" };

/** reviewerId：字符串/数组；空值或空数组都视为"未指定"（走 bot_id 推断）。 */
function reviewerIds(value) {
  if (value === null || value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((item) => clean(item)).filter(Boolean);
}

const sameId = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * 解析 reviewer 裁决（契约 §10.1）。纯函数、确定性、不改入参。
 * @param {{turns?:Array<{bot_id?:string, text?:string, evidence?:string|null, ms?:number}>,
 *          reviewerId?:string|string[]|null}} [input]
 * @returns {{verdict:"pass"|"reject"|null, reviewer:string|null, matched:string|null, reasons:string[]}}
 */
export function judgeReviewer({ turns = [], reviewerId = null } = {}) {
  const reasons = [];
  const list = Array.isArray(turns) ? turns.filter((turn) => turn && typeof turn === "object") : [];
  const ids = reviewerIds(reviewerId);

  const selected = [];
  for (const turn of list) {
    const botId = clean(turn.bot_id ?? turn.botId ?? "");
    if (!botId) continue;
    const wanted = ids.length ? ids.some((id) => sameId(id, botId)) : /review/i.test(botId);
    if (wanted) selected.push({ botId, text: String(turn.text ?? "") });
  }

  if (!selected.length) {
    reasons.push(
      ids.length
        ? `指定 reviewer（${ids.join("、")}）本轮没有回合，无法判定`
        : "没有 reviewer 回合（reviewerId 未传，且没有 bot_id 含 review 的回合）",
    );
    return { verdict: null, reviewer: null, matched: null, reasons };
  }

  // 同一个 reviewer 多回合：最后一次有效表态说了算；未表态不覆盖之前已有的结论。
  const byReviewer = new Map();
  for (const turn of selected) {
    const key = turn.botId.toLowerCase();
    const judged = judgeText(turn.text);
    const entry = byReviewer.get(key) || { botId: turn.botId, verdict: null, matched: null, last: null };
    entry.botId = turn.botId;
    if (judged.verdict) {
      entry.verdict = judged.verdict;
      entry.matched = judged.matched;
      entry.last = judged;
    } else if (!entry.last) {
      entry.last = judged;
      if (!entry.matched) entry.matched = judged.matched;
    }
    byReviewer.set(key, entry);
  }

  const entries = [...byReviewer.values()];
  for (const entry of entries) {
    reasons.push(`${entry.botId}：${entry.last.reason}（${LABELS[entry.verdict]}）`);
  }

  const rejecting = entries.find((entry) => entry.verdict === "reject");
  if (rejecting) {
    if (entries.length > 1) reasons.push(`多 reviewer 取最严格结论：${rejecting.botId} 判不通过`);
    return { verdict: "reject", reviewer: rejecting.botId, matched: rejecting.matched, reasons };
  }

  const passing = entries.filter((entry) => entry.verdict === "pass");
  if (passing.length === entries.length) {
    return { verdict: "pass", reviewer: passing[0].botId, matched: passing[0].matched, reasons };
  }

  if (entries.length === 1) {
    return { verdict: null, reviewer: entries[0].botId, matched: entries[0].matched, reasons };
  }

  reasons.push(`多 reviewer 未全部表态（${passing.length}/${entries.length} 通过），按无法判定处理`);
  return {
    verdict: null,
    reviewer: passing.length ? passing[0].botId : entries[0].botId,
    matched: passing.length ? passing[0].matched : null,
    reasons,
  };
}

export default judgeReviewer;
