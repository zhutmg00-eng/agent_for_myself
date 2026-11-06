/**
 * 技能安装闸门：Hermes `tools/skills_guard.py` 的"扫描 → 判定 → 安装决策"内核，压成不联网、不调 LLM、
 * 可测试的纯函数。
 *
 * 为什么需要：群里的 bot 会自己沉淀 SKILL.md（curator.propose），也会导入别人写的技能；一条
 * `curl … | sh` 或一句 "ignore previous instructions" 混进正文，就等于把未审计的指令注入下一轮
 * 所有成员的上下文。安装前必须有一道确定性闸门。
 *
 * 采纳 Hermes 的：block/warn 分级与"最严重 finding 决定 verdict"（skills_guard.py:953）、
 * 安装策略表 + force 例外（:822）、可读报告（:838）、零宽/双向字符清单（:603-610）、结构检查里的
 * 体积上限（:592）。改写：400 条威胁正则（:154）→ 21 条群聊高价值规则。不采纳：信任仓库白名单
 * （:24）、docstring/代码块掩码、`.skillignore`、内容哈希缓存 —— 都依赖完整包目录与 hub 集成，
 * 本轮只对单份 SKILL.md 文本做闸门。
 *
 * 约定：`RULES[i].test(text, lines)` 返回 `[{ line, excerpt }]`，空数组表示无命中，不允许抛错；
 * scanSkillText 会把单条规则的异常降级成一条 warn 发现，保证闸门本身不会成为故障点。
 */
import { parseFrontmatter } from "../skills.js";
import { createLogger } from "../log.js";

const log = createLogger("skills:guard");

/** 严重度，从轻到重。 */
export const SEVERITIES = ["info", "warn", "block"];

/** 体积/描述上限（字符数，不是字节）。 */
export const LIMITS = {
  description: 200, // 中文信息密度低于英文，Hermes 的 60 字符窗口（skills/AGENTS.md:28）不能直接用
  bodyWarn: 24_000, // 超 ~24k 字符的 SKILL.md 是整合目标（agent/curator.py:313-316）
  bodyBlock: 128_000,
};

const ORDER = { block: 0, warn: 1, info: 2 };

/* ------------------------------------------------------------------ 工具 */

const stripBom = (text) => String(text ?? "").replace(/^\uFEFF/, "");

/** 字符索引 → 1 基行号。 */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** 摘录：压平换行、限长，报告里不出现整段正文。 */
function excerpt(raw, max = 90) {
  const flat = String(raw ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 整篇正则扫描（matchAll 会克隆正则，不会污染规则里的 lastIndex）。 */
function scan(text, patterns) {
  const out = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) out.push({ line: lineOf(text, m.index ?? 0), excerpt: excerpt(m[0]) });
  }
  return out;
}

/** 逐行扫描：只对单行有意义的规则（chmod、sudo 等）用。 */
function scanLines(lines, patterns) {
  const out = [];
  lines.forEach((line, idx) => {
    for (const re of patterns) {
      const m = line.match(re);
      if (m) out.push({ line: idx + 1, excerpt: excerpt(m[0]) });
    }
  });
  return out;
}

/** 写入动词 + 敏感目标（可跨行 120 字符）。 */
function writeInto(text, target) {
  const verb =
    "(?:>>?|\\btee\\s+(?:-a\\s+)?|writeFileSync|writeFile|appendFileSync|write_text|write_bytes|" +
    "Copy-Item|\\bcp\\b|Move-Item|\\bmv\\b|Out-File|Set-Content|Add-Content|New-Item|shutil\\.copy|" +
    "os\\.(?:remove|unlink|rmdir)|\\bmkdir\\s+-p\\b)";
  return scan(text, [new RegExp(`${verb}[^\\n]{0,120}?${target}`, "gi")]);
}

const INVISIBLE = new Map([
  ["\u200b", "零宽空格"], ["\u200c", "零宽不连字"], ["\u200d", "零宽连接符"], ["\u2060", "词连接符"],
  ["\u202a", "LTR 嵌入符"], ["\u202b", "RTL 嵌入符"], ["\u202c", "方向弹出符"], ["\u202d", "LTR 覆盖符"],
  ["\u202e", "RTL 覆盖符（可让字符串反向显示）"], ["\u2066", "LTR 隔离符"], ["\u2067", "RTL 隔离符"],
  ["\u2068", "首强隔离符"], ["\u2069", "方向隔离弹出符"], ["\ufeff", "BOM/零宽不换行空格"],
]);

const CRED_FILE = String.raw`(?:\.ssh[\\/]id_(?:rsa|ed25519|ecdsa|dsa)|\.aws[\\/]credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc|(?:^|[\\/\s"'\x60])\.env\b)`;
const NET_OR_PRINT = String.raw`(?:\bcurl\b|\bwget\b|Invoke-WebRequest|Invoke-RestMethod|\bnc\b|\bncat\b|\bscp\b|\brsync\b|requests\.(?:post|put|get)|\baxios\b|\bfetch\s*\(|\bhttp\.request\b)`;

/* ------------------------------------------------------------------ 规则集 */

const rule = (id, severity, category, why, test) => ({ id, severity, category, why, test });
const byPattern = (patterns) => (text) => scan(text, patterns);
const byLine = (patterns) => (_text, lines) => scanLines(lines, patterns);
const size = (limit) => (text) => {
  const n = String(text || "").length;
  return n > limit ? [{ line: 1, excerpt: `${n} 字符（上限 ${limit}）` }] : [];
};

/**
 * 每条规则：`{ id, severity, category, why, test(text, lines) -> [{line, excerpt}] }`。
 * `why` 是给人看的一句话，会原样出现在 formatScanReport 里。
 */
export const RULES = [
  rule("frontmatter-missing", "block", "structure",
    "SKILL.md 必须以 --- 包裹的 frontmatter 开头，否则 loader 读不到 name/description，装了也不可见",
    (text) => {
      const src = stripBom(text);
      if (/^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(src)) return [];
      return [{ line: 1, excerpt: excerpt(src.split(/\r?\n/)[0] || "（空文件）") }];
    }),
  rule("frontmatter-required", "block", "structure",
    "缺 name 或 description 的技能会被 src/skills.js 的 loader 直接跳过（skills.js:68）",
    (text) => {
      const { meta } = parseFrontmatter(text);
      const missing = [];
      if (!String(meta.name || "").trim()) missing.push("name");
      if (!String(meta.description || "").trim()) missing.push("description");
      return missing.length ? [{ line: 1, excerpt: `缺少必填字段：${missing.join("、")}` }] : [];
    }),
  rule("frontmatter-name-slug", "warn", "structure",
    "name 会变成技能目录名与工具参数值，非 ASCII slug 在 Windows 路径与斜杠命令里容易出问题",
    (text) => {
      const name = String(parseFrontmatter(text).meta.name || "").trim();
      if (!name || /^[a-z0-9][a-z0-9._-]*$/.test(name)) return [];
      return [{ line: 1, excerpt: `name=${name}` }];
    }),
  rule("description-too-long", "warn", "structure",
    `description 会整段进技能索引，超过 ${LIMITS.description} 字符会挤占其它技能的注意力窗口`,
    (text) => {
      const desc = String(parseFrontmatter(text).meta.description || "").trim();
      return desc.length > LIMITS.description ? [{ line: 1, excerpt: `${desc.length} 字符` }] : [];
    }),
  rule("missing-body", "warn", "structure",
    "只有 frontmatter 没有正文的技能加载后什么也指导不了",
    (text) => {
      const body = String(parseFrontmatter(text).body || "").trim();
      return body.length < 20 ? [{ line: 1, excerpt: `正文仅 ${body.length} 字符` }] : [];
    }),
  rule("body-too-large", "warn", "structure",
    "SKILL.md 全文会进上下文，超过 ~24k 字符应先整合再沉淀（agent/curator.py:313）", size(LIMITS.bodyWarn)),
  rule("skill-too-large", "block", "structure",
    "病态体积（>128k 字符）既没法通读也没法审，直接拒装", size(LIMITS.bodyBlock)),
  rule("rm-rf-root", "block", "destructive",
    "rm -rf 指向根/家目录/整盘会一次抹掉数据根，任何技能都不该带这种命令",
    (text) => {
      const out = [];
      for (const m of text.matchAll(/\brm\s+((?:-[A-Za-z]+\s+)*)([^\s;&|)]+)/gi)) {
        const flags = String(m[1] || "").toLowerCase();
        if (!(flags.includes("r") && flags.includes("f"))) continue;
        const target = String(m[2] || "").replace(/["'`]/g, "");
        if (/^(?:\/(?:\*)?|~\/*|\$HOME\/*|[A-Za-z]:[\\/]?\*?)$/.test(target)) {
          out.push({ line: lineOf(text, m.index ?? 0), excerpt: excerpt(m[0]) });
        }
      }
      return out.concat(scan(text, [
        /\bRemove-Item\b[^\n]{0,60}-(?:Recurse|Force)\b[^\n]{0,60}[A-Za-z]:[\\/](?:\s|$|\*)/gi,
        /\bdel\s+\/[fsq]\b[^\n]{0,40}[A-Za-z]:[\\/](?:\s|$|\*)/gi,
        /\bformat\s+[A-Za-z]:/gi,
      ]));
    }),
  rule("curl-pipe-shell", "block", "network",
    "curl/wget 直接管道给 shell 等于执行远端未审内容，安装期无法复核", byPattern([
      /\b(?:curl|wget)\b[^\n|;&]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/gi,
      /\b(?:curl|wget)\b[^\n|;&]{0,200}\|\s*(?:sudo\s+)?(?:pwsh|powershell)\b/gi,
      /\b(?:sh|bash|zsh)\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/gi,
      /\b(?:iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|;&]{0,200}\|\s*(?:iex|Invoke-Expression)\b/gi,
    ])),
  rule("base64-decode-exec", "block", "obfuscation",
    "base64 解码后直接执行是隐藏 payload 的标准动作，正文里不该出现", byPattern([
      /\bbase64\s+(?:-d|--decode|-D)\b[^\n|]{0,160}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/gi,
      /\bbase64\s+(?:-d|--decode|-D)\b[^\n]{0,160}>\s*[^\s]+\.(?:sh|ps1|bash)[^\n]{0,80}(?:&&|;)[^\n]{0,40}\b(?:ba|z|da)?sh\b/gi,
      /\bFromBase64String\s*\([^\n]{0,200}(?:iex|Invoke-Expression)\b/gi,
    ])),
  rule("encoded-payload", "warn", "obfuscation",
    "≥200 字符的 base64 长串通常是内嵌 payload，人读不出来", byPattern([/[A-Za-z0-9+/]{200,}={0,2}/g])),
  rule("chmod-777", "warn", "permissions",
    "chmod 777 把文件对所有用户开放读写执行，属于过宽权限", byLine([
      /\bchmod\s+(?:-[A-Za-z]+\s+)*(?:0?777|a\+rwx)\b/i,
    ])),
  rule("credential-exfiltration", "block", "exfiltration",
    "读取 .ssh/.env/云凭据并外发或打印，是这个群里最不可接受的技能行为", (text) => scan(text, [
      new RegExp(`(?:${CRED_FILE}[^\\n]{0,160}${NET_OR_PRINT}|${NET_OR_PRINT}[^\\n]{0,160}${CRED_FILE})`, "gi"),
      new RegExp(`(?:cat|type|Get-Content)[^\\n]{0,80}${CRED_FILE}[^\\n]{0,80}\\|`, "gi"),
    ])),
  rule("hardcoded-secret", "warn", "credentials",
    "正文里硬编码真实 key/token 会随技能复制到每个机器人和每条消息里", byLine([
      /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/,
      /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    ])),
  rule("prompt-injection", "block", "injection",
    "「忽略之前的指令」这类话术会覆盖群成员的既有约束，属于提示注入", byPattern([
      /\bignore\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|context|directions?)\b/gi,
      /\bdisregard\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|context)\b/gi,
      /\b(?:override|bypass)\s+(?:the\s+)?(?:system\s+prompt|safety|guardrails?|approvals?)\b/gi,
      /\b(?:forget|discard)\s+(?:everything|all)\s+(?:above|before|previously)\b/gi,
      /忽略(?:掉)?(?:之前|上面|以上|先前|前面)的?(?:所有)?(?:指令|提示|规则|要求|约束)/g,
      /(?:新的?系统提示|你现在是(?:一个)?(?:不受限|无限制|没有限制)|解除(?:所有)?限制)/g,
    ])),
  rule("approval-bypass", "block", "injection",
    "教模型绕过审批/沙箱，等于拆掉人机之间唯一的确认点", byLine([
      /\b(?:bypass|skip|disable|turn\s+off|circumvent)\s+(?:the\s+)?(?:approval|approvals|approval\s+gate|guard|guardrails?|sandbox|safety)\b/i,
      /--dangerously-skip-permissions/i,
      /(?:绕过|跳过|关闭|禁用)(?:审批|审核|守卫|沙箱|安全策略)/,
    ])),
  rule("hidden-unicode", "block", "obfuscation",
    "零宽/双向控制字符能把指令藏进肉眼看不见的地方（skills_guard.py:603-610 的同一类威胁）",
    (text) => {
      const out = [];
      for (let i = 0; i < text.length; i += 1) {
        const label = INVISIBLE.get(text[i]);
        if (!label) continue;
        if (i === 0 && text[i] === "\uFEFF") continue; // 文件头 BOM 是正常编码残留
        const cp = text.codePointAt(i).toString(16).toUpperCase().padStart(4, "0");
        out.push({ line: lineOf(text, i), excerpt: `${label} U+${cp}` });
        if (out.length >= 5) break;
      }
      return out;
    }),
  rule("system-path-write", "block", "destructive",
    "往 C 盘或 /etc、/usr、Windows 目录写文件，越过本项目「零 C 盘写入」的铁律",
    (text) => writeInto(text,
      String.raw`(?:[Cc]:[\\/]|%SystemRoot%|%ProgramData%|\/etc\/(?:passwd|shadow|sudoers|hosts)|\/usr\/(?:local\/)?(?:bin|sbin)\b|\/System\/|\/Library\/Launch(?:Daemons|Agents))`)),
  rule("path-traversal", "warn", "traversal",
    "三级以上 ../ 跳出技能目录，读写都可能落到别人家里", byPattern([/(?:\.\.[\\/]){3,}/g])),
  rule("reverse-shell", "block", "network",
    "反弹 shell 把机器控制权交给远端，任何技能正文都不该出现", byLine([
      /\/dev\/tcp\//i,
      /\b(?:nc|ncat)\b[^\n]{0,40}\s-[a-z]*e?\s+(?:\/bin\/)?(?:ba|z)?sh\b/i,
      /\bncat\b[^\n]{0,40}--exec/i,
      /\bbash\s+-i\b[^\n]{0,40}>&/i,
    ])),
  rule("sudo-usage", "warn", "permissions",
    "技能里出现 sudo / 以管理员身份运行，说明它需要超出 bot 权限的动作", byLine([
      /\bsudo\s+(?:-[A-Za-z]+\s+)*[a-z]/i, /以管理员身份运行/, /\bRun\s+as\s+Administrator\b/i,
    ])),
];

/* ------------------------------------------------------------------ 判定 */

/**
 * 扫描一份技能的完整文本。
 * @param {string} text SKILL.md 全文
 * @param {{name?: string}} [opts]
 * @returns {{name:string, verdict:"allow"|"review"|"block", findings:Array, bytes:number, scannedAt:string}}
 */
export function scanSkillText(text, { name = "skill" } = {}) {
  const src = String(text ?? "");
  const lines = src.split(/\r?\n/);
  const findings = [];
  const seen = new Set();

  for (const item of RULES) {
    let hits = [];
    try {
      hits = item.test(src, lines) || [];
    } catch (err) {
      // 规则自身出错不能变成"静默放行"，也不能让闸门崩：降级成一条 warn。
      log.warn(`rule ${item.id} failed:`, err?.message || err);
      hits = [{ line: 0, excerpt: `规则执行失败：${err?.message || err}` }];
    }
    let kept = 0;
    for (const hit of Array.isArray(hits) ? hits : [hits]) {
      if (!hit || kept >= 5) continue; // 单条规则最多 5 条发现，避免同一模式刷屏
      const line = Number(hit.line) || 0;
      const text90 = excerpt(hit.excerpt, 90);
      const key = `${item.id}:${line}:${text90}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept += 1;
      findings.push({ rule: item.id, severity: item.severity, category: item.category, line, excerpt: text90, why: item.why });
    }
  }

  findings.sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9) || a.line - b.line);
  const verdict = findings.some((f) => f.severity === "block")
    ? "block"
    : findings.some((f) => f.severity === "warn")
      ? "review"
      : "allow";
  return {
    name: String(name || "skill").trim() || "skill",
    verdict,
    findings,
    bytes: Buffer.byteLength(src, "utf8"),
    scannedAt: new Date().toISOString(),
  };
}

/**
 * 安装决策：block 拒装（force 可越过但留痕），review 放行但要求人工确认。
 * 对齐 skills_guard.py:822 的 `(allowed, reason)`，把 "ask" 表达成 `allow + requiresConfirm`。
 * @param {{verdict:string, findings?:Array}} result scanSkillText 的返回值
 * @param {{force?: boolean}} [opts]
 */
export function shouldInstall(result, { force = false } = {}) {
  const verdict = String(result?.verdict || "allow");
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const blocks = findings.filter((f) => f.severity === "block").length;
  const n = findings.length;
  if (verdict === "block") {
    if (!force) {
      return {
        allow: false, forced: false, requiresConfirm: false, verdict,
        reason: `拒绝安装：命中 ${blocks} 条阻断项（共 ${n} 条发现），需先删除或改写成安全写法`,
      };
    }
    return {
      allow: true, forced: true, requiresConfirm: true, verdict,
      reason: `强制放行：扫描结论为 block（${blocks} 条阻断项），风险已验证并留痕`,
    };
  }
  if (verdict === "review") {
    return {
      allow: true, forced: false, requiresConfirm: true, verdict,
      reason: `需人工确认：命中 ${n} 条警告项，无阻断项`,
    };
  }
  return { allow: true, forced: false, requiresConfirm: false, verdict, reason: "通过：无阻断项与警告项" };
}

const VERDICT_LABEL = { allow: "通过", review: "需人工复核", block: "阻断" };
const SEVERITY_LABEL = { block: "阻断", warn: "警告", info: "提示" };

/**
 * 中文可读报告：结论在前，逐条带行号、原文摘录与原因。
 * @param {{name?:string, verdict:string, findings?:Array}} result
 */
export function formatScanReport(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const verdict = String(result?.verdict || "allow");
  const blocks = findings.filter((f) => f.severity === "block").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  const lines = [`技能扫描：${String(result?.name || "skill")}`, `结论：${VERDICT_LABEL[verdict] || verdict}`];
  if (findings.length) {
    lines.push(`发现 ${findings.length} 条（${blocks} 阻断 / ${warns} 警告）`);
    for (const f of findings) {
      lines.push(`  ${SEVERITY_LABEL[f.severity] || f.severity} ${f.rule} @ ${f.line ? `第 ${f.line} 行` : "整篇"}`);
      if (f.excerpt) lines.push(`      原文：${f.excerpt}`);
      if (f.why) lines.push(`      原因：${f.why}`);
    }
  } else {
    lines.push("发现 0 条：未命中任何已知威胁模式");
  }
  const decision = shouldInstall({ verdict, findings });
  lines.push(
    `安装判定：${decision.allow ? (decision.requiresConfirm ? "可安装（需人工确认）" : "可安装") : "不可安装"}`,
    `说明：${decision.reason}`,
  );
  return lines.join("\n");
}

export default { SEVERITIES, RULES, LIMITS, scanSkillText, shouldInstall, formatScanReport };
