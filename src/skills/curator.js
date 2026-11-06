/**
 * 技能策展闭环：用量驱动的 stale/archive 打标 + 群聊经验沉淀成提案 + 人工 review + guard 通过后落盘。
 *
 * 为什么需要：群里最有价值的资产是"这个群怎么把某类活干成"的经验，但直接把 bot 总结写成 SKILL.md
 * 等于让模型给自己装后门。Hermes 把这件事拆成三件：遥测（谁在用）、自动状态转换（长期没用只打标、
 * 永不删）、人工 review（经验变提案再由人拍板）。我们照抄这个**人机分工**，不抄它的 LLM 策展 fork。
 *
 * 采纳：只打标不删除（agent/curator.py:209，archive 是上限）、首次见到先锚定时钟（:234-238）、
 * "从未使用"不等于"过期"（:250-255）、pinned 豁免（skills/AGENTS.md:79）、运行状态落库（:40）。
 * 改写：state 从 JSON 侧车换成 `skill_curator_state` 表；review 从 LLM 提示词（CURATOR_REVIEW_PROMPT
 * :292）换成人拍板 + guard 闸门；新增提案表 `skill_proposals`。不采纳：LLM 策展 fork、consolidation、
 * cron 引用重写、tar.gz 备份 —— 依赖运行时与外部调度，本轮只做确定性闭环。
 *
 * 铁律：本模块只写 `skillsDir`（D 盘）与三张 `skill_*` 表；被 guard 判 block 的提案绝不落盘。
 */
import fs from "node:fs";
import path from "node:path";
import { assertNotC } from "../config.js";
import { createLogger } from "../log.js";
import { parseFrontmatter } from "../skills.js";
import { makeId } from "../store.js";
import { LIMITS, scanSkillText, shouldInstall } from "./guard.js";

const log = createLogger("skills:curator");

/** 技能生命周期状态。`archive` 只是打标，文件仍在磁盘上。 */
export const STATES = ["active", "stale", "archive"];

/** review 的三种裁决。adopt 只是"批准"，真正落盘在 adopt()。 */
export const REVIEW_DECISIONS = ["adopt", "reject", "defer"];

const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_curator_state(
  skill TEXT PRIMARY KEY, state TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  last_used TEXT, anchor TEXT, reason TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_curator_state_state ON skill_curator_state(state);
CREATE TABLE IF NOT EXISTS skill_proposals(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, evidence TEXT,
  room_id TEXT, bot_id TEXT, tags TEXT, status TEXT NOT NULL, reason TEXT, reviewed_by TEXT,
  skill TEXT, guard_verdict TEXT, created_at TEXT, updated_at TEXT, reviewed_at TEXT, adopted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_proposals_status ON skill_proposals(status, created_at DESC);
`;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function dateMs(value, fallback = null) {
  if (!value) return fallback;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : fallback;
}

/** 标题 → 目录名。中文标题 slug 为空时回落到 `skill-<id>`，保证路径永远是 ASCII。 */
function slugify(title, id) {
  const slug = String(title || "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || `skill-${id}`;
}

/** 扫 `skillsDir` 下带 SKILL.md 的技能目录（跳过点目录，命中后不再往下递归）。 */
function listSkillDirs(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      let text = null;
      try {
        text = fs.readFileSync(path.join(full, "SKILL.md"), "utf8");
      } catch {
        text = null; // 这一层不是技能目录，继续往深走
      }
      if (text === null) {
        walk(full, depth + 1);
        continue;
      }
      const { meta } = parseFrontmatter(text);
      found.push({
        name: String(meta.name || entry.name).trim() || entry.name,
        dir: full,
        path: path.join(full, "SKILL.md"),
        description: String(meta.description || ""),
      });
    }
  };
  walk(assertNotC(root, "skills dir"), 0);
  return found;
}

function toProposal(row) {
  if (!row) return null;
  return {
    id: row.id, title: row.title, body: row.body,
    evidence: parseJson(row.evidence, []), roomId: row.room_id, botId: row.bot_id,
    tags: parseJson(row.tags, []), status: row.status, reason: row.reason,
    reviewedBy: row.reviewed_by, skill: row.skill, guardVerdict: row.guard_verdict,
    createdAt: row.created_at, updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at, adoptedAt: row.adopted_at,
  };
}

/**
 * @param {{store:object, telemetry?:object, skillsDir:string, now?:() => number}} opts
 */
export function createCurator({ store, telemetry, skillsDir, now = () => Date.now() } = {}) {
  if (!store || !store.db) throw new Error("createCurator 需要 store");
  if (!skillsDir) throw new Error("createCurator 需要 skillsDir");
  const base = assertNotC(skillsDir, "skills dir");
  store.db.exec(SCHEMA);

  /* ------------------------------------------------------- 状态表 */

  const getStateStmt = store.prepare("SELECT * FROM skill_curator_state WHERE skill = ?");
  const upsertStateStmt = store.prepare(
    `INSERT INTO skill_curator_state(skill, state, pinned, last_used, anchor, reason, updated_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(skill) DO UPDATE SET state = excluded.state, pinned = excluded.pinned,
       last_used = excluded.last_used, anchor = excluded.anchor,
       reason = excluded.reason, updated_at = excluded.updated_at`,
  );

  function stateRow(skill) {
    const row = getStateStmt.get(String(skill));
    if (!row) return null;
    return {
      skill: row.skill, state: row.state, pinned: Number(row.pinned) === 1,
      lastUsed: row.last_used, anchor: row.anchor, reason: row.reason, updatedAt: row.updated_at,
    };
  }

  function setState(skill, state, { pinned = false, lastUsed = null, anchor = null, reason = null } = {}) {
    upsertStateStmt.run(
      String(skill), String(state), pinned ? 1 : 0,
      lastUsed ? String(lastUsed) : null, anchor ? String(anchor) : null,
      reason ? String(reason) : null, new Date(now()).toISOString(),
    );
    return stateRow(skill);
  }

  /* ------------------------------------------------------- 状态转换 */

  /**
   * 按"最近一次真实活动"在 active/stale/archive 之间打标，永不删文件。
   * - 首次见到的技能：归类时钟锚定到"现在"并跳过（否则新技能一落地就被判过期）。
   * - 从未使用但有锚点的技能：沿用锚点，到点后照样过期（Hermes 对 bundled 技能同样处理）。
   * @param {{staleDays?: number, archiveDays?: number}} [opts]
   * @returns {{stale:Array, archive:Array, revived:Array, checked:number, seeded:number}}
   */
  function transitions({ staleDays = 30, archiveDays = 90 } = {}) {
    const nowMs = now();
    const staleCut = nowMs - Math.max(0, Number(staleDays) || 0) * DAY_MS;
    const archiveCut = nowMs - Math.max(0, Number(archiveDays) || 0) * DAY_MS;
    const out = { stale: [], archive: [], revived: [], checked: 0, seeded: 0 };

    for (const skill of listSkillDirs(base)) {
      out.checked += 1;
      const prev = stateRow(skill.name);
      if (prev?.pinned) continue;

      const tel = telemetry && typeof telemetry.of === "function" ? telemetry.of(skill.name) : null;
      const lastMs = dateMs(tel?.lastUsed, null);
      const anchorMs = dateMs(prev?.anchor, null);
      const prevState = prev?.state || "active";

      if (lastMs === null && anchorMs === null) {
        setState(skill.name, "active", {
          anchor: new Date(nowMs).toISOString(),
          reason: "首次纳入策展，过期时钟从今天起算",
        });
        out.seeded += 1;
        continue;
      }

      const clock = lastMs !== null ? lastMs : anchorMs;
      const ageDays = Math.max(0, Math.round(((nowMs - clock) / DAY_MS) * 10) / 10);
      const lastUsedIso = lastMs !== null ? new Date(lastMs).toISOString() : prev?.lastUsed || null;
      let next = "active";
      if (clock <= archiveCut) next = "archive";
      else if (clock <= staleCut) next = "stale";

      if (prev && next === prevState) {
        // 状态不变时也刷新 last_used，便于 UI 直接读表。
        if (lastUsedIso && lastUsedIso !== prev.lastUsed) {
          setState(skill.name, next, { pinned: prev.pinned, lastUsed: lastUsedIso, anchor: prev.anchor, reason: prev.reason });
        }
        continue;
      }

      const reason =
        next === "archive" ? `超过 ${archiveDays} 天没有使用（${ageDays} 天），打标归档（文件保留）`
          : next === "stale" ? `超过 ${staleDays} 天没有使用（${ageDays} 天），打标待整理`
            : "重新被使用，恢复为活跃";
      const entry = {
        skill: skill.name, state: next, from: prevState, ageDays,
        lastUsed: lastUsedIso, reason, path: skill.path,
      };
      setState(skill.name, next, {
        lastUsed: lastUsedIso,
        anchor: prev?.anchor || new Date(clock).toISOString(),
        reason,
      });
      if (next === "archive") out.archive.push(entry);
      else if (next === "stale") out.stale.push(entry);
      else if (prevState === "stale" || prevState === "archive") out.revived.push(entry);
    }
    return out;
  }

  /* ------------------------------------------------------- 提案 */

  const insertProposal = store.prepare(
    `INSERT INTO skill_proposals(id, title, body, evidence, room_id, bot_id, tags, status,
       reason, reviewed_by, skill, guard_verdict, created_at, updated_at, reviewed_at, adopted_at)
     VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,NULL,NULL)`,
  );
  const getProposalStmt = store.prepare("SELECT * FROM skill_proposals WHERE id = ?");
  const updateProposalStmt = store.prepare(
    `UPDATE skill_proposals SET status = ?, reason = ?, reviewed_by = ?, skill = ?, guard_verdict = ?,
       updated_at = ?, reviewed_at = ?, adopted_at = ? WHERE id = ?`,
  );

  function getProposal(id) {
    return toProposal(getProposalStmt.get(String(id)));
  }

  /**
   * 把一次群聊回合的经验沉淀成提案（不落盘、不装技能，等 review）。
   * @param {{title:string, body:string, evidence?:Array, roomId?:string|null, botId?:string|null, tags?:string[]}} input
   */
  function propose({ title, body, evidence = [], roomId = null, botId = null, tags = [] } = {}) {
    const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
    const cleanBody = String(body || "").trim();
    if (!cleanTitle) throw new Error("propose 需要 title");
    if (!cleanBody) throw new Error("propose 需要 body");
    const id = makeId(6);
    const iso = new Date(now()).toISOString();
    insertProposal.run(
      id, cleanTitle, cleanBody,
      JSON.stringify(Array.isArray(evidence) ? evidence : [evidence].filter(Boolean)),
      roomId ? String(roomId) : null, botId ? String(botId) : null,
      JSON.stringify(Array.isArray(tags) ? tags.map(String) : []), "proposed", iso, iso,
    );
    log.info(`proposal ${id} created: ${cleanTitle}`);
    return { id, status: "proposed", proposal: getProposal(id) };
  }

  /** @param {{status?:string|null, limit?:number}} [opts] */
  function listProposals({ status = null, limit = 50 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 50, 500));
    const rows = status
      ? store.prepare("SELECT * FROM skill_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(String(status), max)
      : store.prepare("SELECT * FROM skill_proposals ORDER BY created_at DESC LIMIT ?").all(max);
    return rows.map(toProposal);
  }

  /**
   * 人工/群主裁决。decision=adopt 只把提案置为 approved，真正写盘走 adopt()。
   * @param {string} id
   * @param {{decision:string, reason?:string|null, by?:string}} opts
   */
  function review(id, { decision, reason = null, by = "user" } = {}) {
    const proposal = getProposal(id);
    if (!proposal) return { ok: false, error: `提案不存在：${id}` };
    const choice = String(decision || "").trim();
    if (!REVIEW_DECISIONS.includes(choice)) {
      return { ok: false, error: `未知裁决：${choice}（允许：${REVIEW_DECISIONS.join(", ")}）` };
    }
    if (proposal.status === "adopted") return { ok: false, error: `提案 ${id} 已落盘，不能重复裁决` };
    const status = choice === "adopt" ? "approved" : choice === "reject" ? "rejected" : "deferred";
    const iso = new Date(now()).toISOString();
    updateProposalStmt.run(
      status, reason ? String(reason) : null, String(by || "user"),
      proposal.skill, proposal.guardVerdict, iso, iso, proposal.adoptedAt, String(id),
    );
    return { ok: true, proposal: getProposal(id) };
  }

  /**
   * 落盘：**先 guard 扫描合成后的 SKILL.md，block 直接拒绝写盘**；通过后写
   * `skillsDir/<slug>/SKILL.md`（frontmatter: name/description/version/source/created）。
   * 只接受 `approved`（人工/群主 review 过）的提案，杜绝"propose 完自己 adopt"。
   * @returns {{ok:true, skill:object, guard:object} | {ok:false, error:string, guard?:object}}
   */
  function adopt(id, { by = "system" } = {}) {
    const proposal = getProposal(id);
    if (!proposal) return { ok: false, error: `提案不存在：${id}` };
    if (proposal.status !== "approved") {
      return { ok: false, error: `提案状态为 ${proposal.status}，需先 review(adopt) 批准后再落盘` };
    }

    const slug = slugify(proposal.title, proposal.id);
    // 同名目录已被占用时用提案 id 后缀，绝不覆盖别人的技能；frontmatter 的 name 跟目录名一致。
    const leaf = fs.existsSync(path.join(base, slug, "SKILL.md")) ? `${slug}-${proposal.id}` : slug;
    const dir = assertNotC(path.join(base, leaf), "skill dir");
    const description = proposal.title.slice(0, LIMITS.description);
    const created = new Date(now()).toISOString();
    const text = `---\nname: ${leaf}\ndescription: ${description}\nversion: 1.0.0\n` +
      `source: curator-proposal\ncreated: ${created}\n---\n\n${proposal.body.trim()}\n`;

    const guard = scanSkillText(text, { name: leaf });
    const decision = shouldInstall(guard);
    if (!decision.allow) {
      updateProposalStmt.run(
        proposal.status, `guard 阻断：${decision.reason}`, by, proposal.skill, guard.verdict,
        new Date(now()).toISOString(), proposal.reviewedAt, proposal.adoptedAt, String(id),
      );
      log.warn(`adopt ${id} blocked by guard: ${guard.findings.map((f) => f.rule).join(",")}`);
      return { ok: false, error: `guard 阻断：${decision.reason}`, guard };
    }

    const file = path.join(dir, "SKILL.md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text, "utf8");
    const iso = new Date(now()).toISOString();
    updateProposalStmt.run(
      "adopted", proposal.reason, by, leaf, guard.verdict,
      iso, proposal.reviewedAt || iso, iso, String(id),
    );
    setState(leaf, "active", { lastUsed: created, anchor: created, reason: `由提案 ${proposal.id} 采纳落盘` });
    log.info(`adopted proposal ${id} -> ${file}`);
    return {
      ok: true,
      skill: { name: leaf, slug: leaf, dir, path: file, description, version: "1.0.0", source: "curator-proposal" },
      guard,
    };
  }

  /* ------------------------------------------------------- 报表 */

  /** 提案与状态计数：proposed/adopted/rejected/archived/stale（另附 approved/deferred/total）。 */
  function report() {
    const byStatus = {};
    for (const row of store.prepare("SELECT status, COUNT(*) AS n FROM skill_proposals GROUP BY status").all()) {
      byStatus[String(row.status)] = Number(row.n || 0);
    }
    const byState = {};
    for (const row of store.prepare("SELECT state, COUNT(*) AS n FROM skill_curator_state GROUP BY state").all()) {
      byState[String(row.state)] = Number(row.n || 0);
    }
    return {
      proposed: byStatus.proposed || 0,
      approved: byStatus.approved || 0,
      adopted: byStatus.adopted || 0,
      rejected: byStatus.rejected || 0,
      deferred: byStatus.deferred || 0,
      archived: byState.archive || 0,
      stale: byState.stale || 0,
      active: byState.active || 0,
      proposals: Object.values(byStatus).reduce((a, b) => a + b, 0),
      states: { ...byState },
    };
  }

  /** 当前所有打标记录（UI 列表用）。 */
  function listStates() {
    return store.prepare("SELECT skill FROM skill_curator_state ORDER BY updated_at DESC").all().map((row) => stateRow(row.skill));
  }

  /**
   * 置顶/取消置顶：pinned 技能豁免一切自动转换（Hermes pinned 语义，skills/AGENTS.md:79）。
   * @param {string} skill
   * @param {boolean} [pinned]
   */
  function pin(skill, pinned = true) {
    const name = String(skill || "").trim();
    if (!name) throw new Error("pin 需要 skill 名称");
    const prev = stateRow(name);
    return setState(name, prev?.state || "active", {
      pinned: Boolean(pinned),
      lastUsed: prev?.lastUsed || null,
      anchor: prev?.anchor || new Date(now()).toISOString(),
      reason: pinned ? "人工置顶，豁免自动归档" : "取消置顶",
    });
  }

  return { transitions, propose, listProposals, getProposal, review, adopt, report, listStates, pin };
}

export default createCurator;
