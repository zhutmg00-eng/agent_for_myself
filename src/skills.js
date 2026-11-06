/**
 * Skills: discover `SKILL.md` packages and expose them as (a) pi skills mounted
 * through the resource loader and (b) room tools (`skill_list` / `skill_invoke`).
 *
 * Scanned locations (first hit wins for a duplicate name):
 *   1. `<DATA>/.fusion/skills`          — user/room skills (also seeded here)
 *   2. `<DATA>/agents/_shared/skills`   — pi agentDir skills
 *   3. `<repo>/.pi-agent/skills`        — packaged default skills
 *
 * A skill is a directory containing `SKILL.md` with YAML-ish frontmatter
 * (`name`, `description`, optional `license`/`allowed-tools`) and a Markdown body.
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, ROOT, assertNotC, ensureDirs } from "./config.js";
import { createLogger } from "./log.js";

const log = createLogger("skills");

/** Directories searched for skills, in priority order. */
export function skillDirs() {
  return [DIRS.skills, path.join(DIRS.sharedAgent, "skills"), path.join(ROOT, ".pi-agent", "skills")];
}

/** Directories that should exist even when empty. */
export function ensureSkillDirs() {
  ensureDirs();
  for (const dir of [DIRS.skills, path.join(DIRS.sharedAgent, "skills")]) {
    try {
      fs.mkdirSync(assertNotC(dir, "skills dir"), { recursive: true });
    } catch (err) {
      log.warn("cannot create skills dir", dir, err?.message || err);
    }
  }
}

/** Minimal frontmatter parser (`---\nkey: value\n---`). */
export function parseFrontmatter(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: src.slice(m[0].length) };
}

function readSkillFile(skillFile, sourceDir) {
  try {
    if (!fs.existsSync(skillFile)) return null;
    const text = fs.readFileSync(skillFile, "utf8");
    const { meta, body } = parseFrontmatter(text);
    const name = String(meta.name || path.basename(path.dirname(skillFile))).trim();
    const description = String(meta.description || "").trim();
    if (!name || !description) return null; // pi ignores undescribed skills too
    return {
      name,
      description,
      body,
      path: skillFile,
      dir: path.dirname(skillFile),
      source: sourceDir,
      license: meta.license || null,
      allowed_tools: meta["allowed-tools"]
        ? String(meta["allowed-tools"])
            .split(/[,\s]+/)
            .filter(Boolean)
        : [],
      disable_model_invocation: String(meta["disable-model-invocation"] || "") === "true",
    };
  } catch (err) {
    log.warn("failed to read skill", skillFile, err?.message || err);
    return null;
  }
}

/** Recursively collect `SKILL.md` files under a directory (max depth 3). */
function findSkillFiles(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findSkillFiles(full, depth + 1, out);
    } else if (entry.isFile() && /^SKILL\.md$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Discover every skill (metadata + body). Duplicate names: first dir wins. */
export function loadSkills() {
  ensureSkillDirs();
  const byName = new Map();
  for (const dir of skillDirs()) {
    for (const file of findSkillFiles(dir)) {
      const skill = readSkillFile(file, dir);
      if (!skill) continue;
      if (byName.has(skill.name)) continue;
      byName.set(skill.name, skill);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Default sample skills written into `<DATA>/.fusion/skills` on first run. */
export const SAMPLE_SKILLS = {
  "code-review": {
    description:
      "审查代码或补丁时使用：按验收标准、正确性、边界条件、错误处理、可验证性逐项检查，只给通过或具体修改点。",
    body: `# Code review

## 何时使用
需要审查一段代码、补丁、脚本或他人产出时。

## 步骤
1. 先确认验收标准（群主任务或需求原文）；没有标准时先写出你采用的标准。
2. 读实际代码（read/grep），必要时跑命令验证（bash），不要只读汇报。
3. 逐项检查：
   - 正确性：主路径是否真的满足需求？
   - 边界：空值、超长输入、并发、路径不存在、编码（中文路径）。
   - 错误处理：失败是否被捕获并向上报告？是否静默吞掉？
   - 资源与安全：是否越界写盘、是否硬编码绝对路径/C 盘路径。
   - 可验证性：是否给出可复现的验证命令与真实输出。
4. 结论只有两种：「通过」或「需修改」。需修改时每条写：问题 → 证据（文件:行号/命令输出）→ 修改建议。

## 禁止
- 不要替实现者重写代码（除非被要求）。
- 不要挑不影响验收的风格问题。
- 不要把「看起来可以」当证据。`,
  },
  "write-report": {
    description:
      "需要写汇报、总结、说明文档时使用：结论先行、证据可追溯、长度受控，适合群聊里快速阅读。",
    body: `# Write report

## 何时使用
需要向群内汇报工作、写总结、写说明文档或公告时。

## 结构（结论先行）
1. 一句话结论：做成了什么 / 没做成什么。
2. 依据：关键证据（文件、file_id、命令与真实输出）。
3. 细节：只写必要的实现要点与取舍。
4. 下一步：未完成项、风险、需要谁配合。

## 规则
- 中文短句，避免形容词堆砌与空话（「赋能」「闭环」这类词不要用）。
- 每个数字都要有来源；没有数据的判断明确标注为「判断」。
- 长文档写入工作区文件或 room_file_save 落盘，群里只报 file_id + 一句话描述。
- 群内汇报控制在 15 行内。`,
  },
  "task-planning": {
    description: "把一个模糊目标拆成可执行步骤时使用：里程碑、依赖、风险、验收点与最短验证路径。",
    body: `# Task planning

## 步骤
1. 复述目标与约束（时间、人力、技术栈、不能碰的东西）。
2. 拆成 3–8 个步骤，每步写：做什么 / 谁做（@成员）/ 产出物 / 验收点。
3. 标出依赖（谁阻塞谁）与风险（最可能失败的点及缓解）。
4. 给出「最短可行路径」：先做什么能最快验证方向是否正确。
5. 用编号列表输出，控制在 12 行内。`,
  },
  "research-brief": {
    description: "做调研或信息收集时使用：定位证据、压缩结论、明确不确定性，输出要点加证据路径。",
    body: `# Research brief

## 步骤
1. 定位：用 ls/find/grep 找到相关文件与位置。
2. 阅读：只读关键片段，记录文件:行号作为证据。
3. 交叉验证：同一事实至少两个来源，冲突时说明冲突。
4. 输出：结论（3–7 条要点）+ 证据路径 + 不确定项。

## 规则
- 不猜：信息不足就写「未知，需要 X 才能确认」。
- 不越界：只陈述事实与现状，不替别人做实现决策。`,
  },
};

/** Write the built-in sample skills when their directory does not exist yet. */
export function ensureSampleSkills({ force = false } = {}) {
  ensureSkillDirs();
  const written = [];
  for (const [name, def] of Object.entries(SAMPLE_SKILLS)) {
    const dir = assertNotC(path.join(DIRS.skills, name), "skill dir");
    const file = path.join(dir, "SKILL.md");
    if (!force && fs.existsSync(file)) continue;
    fs.mkdirSync(dir, { recursive: true });
    const content = `---\nname: ${name}\ndescription: ${def.description}\n---\n\n${def.body}\n`;
    fs.writeFileSync(file, content, "utf8");
    written.push(name);
  }
  if (written.length) log.info(`seeded sample skills: ${written.join(", ")}`);
  return written;
}

/**
 * Skill registry bound to the current data root.
 * Used by the room tools (`skill_list` / `skill_invoke`) and the API.
 */
export class SkillRegistry {
  constructor(opts = {}) {
    this.seed = opts.seed !== false;
    this.skills = [];
    if (this.seed) ensureSampleSkills();
    this.reload();
  }

  reload() {
    this.skills = loadSkills();
    return this;
  }

  /** Public metadata list (no bodies — cheap for the API/UI). */
  list() {
    return this.skills.map((s) => ({
      name: s.name,
      description: s.description,
      path: s.path,
      source: s.source,
      allowed_tools: s.allowed_tools,
    }));
  }

  has(name) {
    return this.skills.some((s) => s.name === name);
  }

  /** Full skill (with body). */
  get(name) {
    const key = String(name || "").trim();
    return this.skills.find((s) => s.name === key) || null;
  }

  /**
   * Render a skill as an instruction block for a model turn.
   * @param {string} name
   * @param {string} [args] optional user request appended to the instructions
   * @returns {string}
   */
  invoke(name, args = "") {
    const skill = this.get(name);
    if (!skill) {
      throw new Error(`unknown skill: ${name}（可用：${this.skills.map((s) => s.name).join(", ") || "无"}）`);
    }
    const lines = [`# 技能：${skill.name}`, skill.description, "", skill.body.trim()];
    if (skill.dir) lines.push("", `> 技能目录（引用相对路径时以此为准）：${skill.dir}`);
    const extra = String(args || "").trim();
    if (extra) lines.push("", "## 本次请求", extra);
    return lines.join("\n");
  }
}

/** Create a registry (seeds sample skills on first use). */
export function createSkills(opts = {}) {
  return new SkillRegistry(opts);
}

let singleton = null;
/** Shared default registry (lazy). */
export function skills() {
  if (!singleton) singleton = new SkillRegistry();
  return singleton;
}

export function list() {
  return skills().list();
}
export function get(name) {
  return skills().get(name);
}
export function invoke(name, args) {
  return skills().invoke(name, args);
}
export function reload() {
  return skills().reload();
}

export default skills;
