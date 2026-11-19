/* Geometric SVG role emblem avatar system — zero OS emojis, unified stroke language. */

const ROLE_GLYPHS = {
  chief: `
    <path d="M12 4.5 5.4 16.5h13.2L12 4.5Z" opacity="0.28"/>
    <circle cx="12" cy="5.2" r="2.1" fill="currentColor" stroke="none"/>
    <circle cx="6.2" cy="16.4" r="1.8" fill="currentColor" stroke="none"/>
    <circle cx="17.8" cy="16.4" r="1.8" fill="currentColor" stroke="none"/>
    <circle cx="12" cy="12.5" r="2.1"/>`,
  boss: `
    <path d="M4.5 15.2h15l-1.4-8.2-3.7 3.2L12 5.4l-2.4 4.8L5.9 7l-1.4 8.2Z"/>
    <path d="M5.4 18h13.2"/>`,
  coder: `
    <path d="m8.4 7.6-4.2 4.4 4.2 4.4M15.6 7.6l4.2 4.4-4.2 4.4M13.4 5.8 10.6 18.2"/>`,
  reviewer: `
    <path d="M12 3.8 5.2 6.4v5c0 4.4 2.9 7.5 6.8 8.8 3.9-1.3 6.8-4.4 6.8-8.8v-5L12 3.8Z"/>
    <path d="m8.9 12.1 2.2 2.2 4.2-4.4"/>`,
  librarian: `
    <path d="M12 4.2 4.2 8.2 12 12.2l7.8-4L12 4.2Z"/>
    <path d="m4.2 12.2 7.8 4 7.8-4M4.2 16l7.8 4 7.8-4"/>`,
  explore: `
    <circle cx="12" cy="12" r="7.8"/>
    <path d="m15.3 8.7-1.9 4.9-4.7 1.7 1.9-4.9 4.7-1.7Z"/>`,
  plan: `
    <rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/>
    <path d="M4.5 9.5h15M9.5 9.5v10"/>`,
  writer: `
    <path d="M16.8 4.8a2.2 2.2 0 0 1 3.1 3.1L9.6 18.2 5 19.2l1-4.6L16.8 4.8Z"/>
    <path d="m14.2 7.4 3.1 3.1"/>`,
  analyst: `
    <path d="M5.2 18.5V12m4.5 6.5V7.5m4.6 11v-8m4.5 8V5.5"/>`,
  general: `
    <rect x="6.5" y="6.5" width="11" height="11" rx="2"/>
    <path d="M9.5 3.5v3m5-3v3m-5 11v3m5-3v3M3.5 9.5h3m-3 5h3m11-5h3m-3 5h3"/>`,
  teammate: `
    <circle cx="9.2" cy="8.6" r="3"/>
    <path d="M4.2 18.2c.6-3 2.5-4.6 5-4.6s4.4 1.6 5 4.6"/>
    <circle cx="16.4" cy="9.6" r="2.2"/>
    <path d="M16.2 14.2c1.7.4 3 1.7 3.4 3.8"/>`,
};

export const PROFILES = {
  ChiefRouter: {
    name: "Chief", role: "总管", tagline: "拆解目标 · 调度团队 · 汇总结果",
    badge: "chief", glyph: "chief",
    color: "#2563eb", darkColor: "#60a5fa", tone: "blue",
  },
  chief: {
    name: "Chief", role: "总管", tagline: "拆解目标 · 调度团队 · 汇总结果",
    badge: "chief", glyph: "chief",
    color: "#2563eb", darkColor: "#60a5fa", tone: "blue",
  },
  boss: {
    name: "Boss", role: "群主", tagline: "分派任务 · 授权 · 决定共享范围",
    badge: "群主", glyph: "boss",
    color: "#b45309", darkColor: "#fbbf24", tone: "amber",
  },
  coder: {
    name: "Coder", role: "工程师", tagline: "写代码 · 改文件 · 跑命令",
    badge: "coder", glyph: "coder",
    color: "#c2410c", darkColor: "#fb923c", tone: "orange",
  },
  reviewer: {
    name: "Reviewer", role: "审查员", tagline: "验收 · 查漏 · 复核产出",
    badge: "review", glyph: "reviewer",
    color: "#6d28d9", darkColor: "#a78bfa", tone: "violet",
  },
  librarian: {
    name: "Librarian", role: "文件管家", tagline: "群文件空间 · 归档 · 同步路径",
    badge: "files", glyph: "librarian",
    color: "#0f766e", darkColor: "#2dd4bf", tone: "teal",
  },
  explore: {
    name: "Explore", role: "侦察员", tagline: "只读搜索 · 快速定位",
    badge: "explore", glyph: "explore",
    color: "#0369a1", darkColor: "#38bdf8", tone: "sky",
  },
  plan: {
    name: "Plan", role: "架构师", tagline: "方案设计 · 文件清单",
    badge: "plan", glyph: "plan",
    color: "#4338ca", darkColor: "#818cf8", tone: "indigo",
  },
  planner: {
    name: "Planner", role: "规划师", tagline: "拆解 · 排期 · 依赖与风险",
    badge: "plan", glyph: "plan",
    color: "#4338ca", darkColor: "#818cf8", tone: "indigo",
  },
  writer: {
    name: "Writer", role: "文案", tagline: "文档 · 文案 · 结构化表达",
    badge: "writer", glyph: "writer",
    color: "#be185d", darkColor: "#f472b6", tone: "rose",
  },
  analyst: {
    name: "Analyst", role: "分析师", tagline: "数据 · 指标 · 可验证的结论",
    badge: "analyst", glyph: "analyst",
    color: "#0e7490", darkColor: "#22d3ee", tone: "cyan",
  },
  general: {
    name: "General", role: "执行者", tagline: "通用任务 · 工具执行",
    badge: "general", glyph: "general",
    color: "#475569", darkColor: "#94a3b8", tone: "slate",
  },
  "general-purpose": {
    name: "General", role: "执行者", tagline: "通用任务 · 工具执行",
    badge: "general", glyph: "general",
    color: "#475569", darkColor: "#94a3b8", tone: "slate",
  },
  teammate: {
    name: "Teammate", role: "协作者", tagline: "群内讨论 · 接力执行",
    badge: "teammate", glyph: "teammate",
    color: "#047857", darkColor: "#34d399", tone: "emerald",
  },
};

const BACKEND_DEFAULT_TAGLINES = new Set([
  "", "总调度 · 任务拓扑分解", "群主 · 任务分派与权限", "群文件管家 · 地址同步",
  "只读代码探索员", "架构规划师", "通用执行代理", "协作成员",
]);

export function profileFor(id, bot) {
  const key = String(id || "").trim();
  const base = PROFILES[key] || PROFILES[key.toLowerCase()] || {
    name: bot?.name || key || "Bot",
    role: "成员",
    tagline: bot?.tagline || "",
    glyph: "general",
    color: "#475569",
    darkColor: "#94a3b8",
    tone: "slate",
  };
  const backendName = String(bot?.name || "").trim();
  const isDefaultName = !backendName
    || backendName.toLowerCase() === key.toLowerCase()
    || backendName === "Chief Router"
    || (key === "general-purpose" && backendName === "General");
  const tagline = bot?.tagline && !BACKEND_DEFAULT_TAGLINES.has(bot.tagline) ? bot.tagline : base.tagline;
  return {
    ...base,
    name: isDefaultName ? base.name : backendName,
    tagline,
    // Intentionally strip emojis so the UI stays crisp and vector-consistent.
    emoji: "",
    badge: bot?.badge || base.badge || "",
    color: base.color || bot?.color || "#2563eb",
    tone: base.tone || "slate",
  };
}

export function roleIconSvg(id, bot) {
  const p = profileFor(id, bot);
  const body = ROLE_GLYPHS[p.glyph] || ROLE_GLYPHS.general;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function brandMarkSvg(size = 24) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">
    <path d="M12 4.5 5.4 16.8h13.2L12 4.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity="0.45"/>
    <circle cx="12" cy="5" r="2.2" fill="currentColor"/>
    <circle cx="5.8" cy="16.6" r="2" fill="currentColor" opacity="0.82"/>
    <circle cx="18.2" cy="16.6" r="2" fill="currentColor" opacity="0.82"/>
    <circle cx="12" cy="12.6" r="1.9" fill="var(--accent)"/>
  </svg>`;
}

export function avatarSvg(kind) {
  const body = ROLE_GLYPHS[kind] || ROLE_GLYPHS.general;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/* Custom avatars are resolved by the store from GET /api/avatars. */
let customAvatars = {};

export function setCustomAvatars(map) {
  customAvatars = map || {};
}

export function customAvatarUrl(kind, id) {
  return customAvatars[`${kind}:${id}`]?.url || "";
}

function initialsFor(name) {
  const clean = String(name || "?").trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (/^[A-Za-z]/.test(clean)) return clean.slice(0, 2).toUpperCase();
  return clean.slice(0, 1);
}

export function avatar(id, size = 32, opts = {}) {
  const kind = opts.kind || "bot";
  const p = profileFor(id, opts.bot);
  const cls = opts.className ? ` ${opts.className}` : "";
  const title = opts.title ? ` title="${escapeAttr(opts.title)}"` : "";
  const url = customAvatarUrl(kind, id);
  const radius = Math.max(7, Math.round(size * 0.28));
  if (url) {
    return `<span class="avatar has-img${cls}"${title} style="width:${size}px;height:${size}px;border-radius:${radius}px" data-bot="${escapeAttr(String(id || ""))}"><img src="${escapeAttr(url)}" alt=""></span>`;
  }
  const hasKnownGlyph = Boolean(ROLE_GLYPHS[p.glyph] && (PROFILES[String(id || "").trim()] || PROFILES[String(id || "").trim().toLowerCase()]));
  if (hasKnownGlyph) {
    const iconSize = Math.max(12, Math.round(size * 0.52));
    return `<span class="avatar is-emblem tone-${escapeAttr(p.tone)}${cls}"${title} style="width:${size}px;height:${size}px;border-radius:${radius}px" data-bot="${escapeAttr(String(id || ""))}" aria-hidden="true"><span class="avatar-glyph" style="width:${iconSize}px;height:${iconSize}px">${roleIconSvg(id, opts.bot)}</span></span>`;
  }
  const initials = escapeHtml(initialsFor(p.name));
  return `<span class="avatar mono tone-${escapeAttr(p.tone)}${cls}"${title} style="width:${size}px;height:${size}px;border-radius:${radius}px;font-size:${Math.max(9, Math.round(size * 0.34))}px" data-bot="${escapeAttr(String(id || ""))}">${initials}</span>`;
}

export function userAvatar(size = 30, initial = "我") {
  const url = customAvatarUrl("user", "me");
  const radius = Math.max(7, Math.round(size * 0.28));
  if (url) {
    return `<span class="avatar has-img is-user" style="width:${size}px;height:${size}px;border-radius:${radius}px"><img src="${escapeAttr(url)}" alt=""></span>`;
  }
  const safe = escapeHtml(initial || "我").slice(0, 1);
  return `<span class="avatar is-user" style="width:${size}px;height:${size}px;border-radius:${radius}px;font-size:${Math.max(11, Math.round(size * 0.42))}px">${safe}</span>`;
}

export function groupAvatar(room, size = 34, botsById = {}) {
  const roomId = room?.room_id;
  const custom = roomId ? customAvatarUrl("room", roomId) : "";
  const radius = Math.max(7, Math.round(size * 0.28));
  if (custom) {
    return `<span class="group-av custom" style="width:${size}px;height:${size}px;border-radius:${radius}px"><img src="${escapeAttr(custom)}" alt=""></span>`;
  }
  const label = String(room?.title || room?.topic || "群").trim() || "群";
  const initials = /^[A-Za-z]/.test(label) ? label.slice(0, 2).toUpperCase() : label.slice(0, 1);
  const tones = ["blue", "teal", "indigo", "amber", "violet", "sky"];
  let h = 0;
  for (const ch of String(roomId || label)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const tone = tones[h % tones.length];
  return `<span class="group-av group-mono tone-${tone}" style="width:${size}px;height:${size}px;border-radius:${radius}px;font-size:${Math.max(12, Math.round(size * 0.38))}px" title="${escapeAttr(label)}">${escapeHtml(initials)}</span>`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}
