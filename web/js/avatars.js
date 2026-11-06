/* Original mascot system — hand-drawn SVG, one visual language across the team. */

const EYE = (x, y, s = 1) => `
  <ellipse cx="${x}" cy="${y}" rx="${4.4 * s}" ry="${5 * s}" fill="#fff"/>
  <ellipse cx="${x + 0.5}" cy="${y + 0.6}" rx="${2.15 * s}" ry="${2.7 * s}" fill="#221d18"/>
  <circle cx="${x + 1.2}" cy="${y - 0.8}" r="${0.85 * s}" fill="#fff"/>`;

const MOUTH = (x = 32, y = 42, w = 7) =>
  `<path d="M${x - w / 2} ${y}q${w / 4} 2.4 ${w / 2} 0q${w / 4} 2.4 ${w / 2} 0" fill="none" stroke="#221d18" stroke-width="1.5" stroke-linecap="round"/>`;

const BLUSH = (x1 = 20, x2 = 44, y = 38) =>
  `<ellipse cx="${x1}" cy="${y}" rx="3.4" ry="1.9" fill="#ff8fa3" opacity=".32"/>
   <ellipse cx="${x2}" cy="${y}" rx="3.4" ry="1.9" fill="#ff8fa3" opacity=".32"/>`;

const SHINE = `<ellipse cx="32" cy="23" rx="12" ry="7.5" fill="#fff" opacity=".16"/>`;

const CHARACTERS = {
  whale: `
    <path d="M48 35c5-4 9 0 8 4 1 4-4 7-7 5" fill="#3f57d8"/>
    <path d="M32 19c-2-4 1-6 3-8" fill="none" stroke="#8fa4ff" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="37" cy="10" r="1.8" fill="#8fa4ff"/><circle cx="31" cy="12" r="1.3" fill="#8fa4ff"/>
    <ellipse cx="32" cy="36" rx="19" ry="17.5" fill="#4d6bfe"/>
    <path d="M14 36c2 8 9 14 18 14s16-6 18-14c-4 5-10 7-18 7s-14-2-18-7Z" fill="#dfe7ff" opacity=".85"/>
    <path d="M23 44c3 2 6 3 9 3s6-1 9-3" fill="none" stroke="#b9c8ff" stroke-width="1.4" stroke-linecap="round" opacity=".8"/>
    ${SHINE}
    ${EYE(26, 33)} ${EYE(38, 33)}
    ${BLUSH(19, 45, 40)}
    <path d="M29 42q3 2.2 6 0" fill="none" stroke="#221d18" stroke-width="1.6" stroke-linecap="round"/>`,

  lion: `
    <circle cx="32" cy="34" r="22" fill="#f0a02b"/>
    <g fill="#f7b84a">
      <circle cx="32" cy="11" r="6"/><circle cx="46" cy="16" r="6"/><circle cx="55" cy="30" r="6"/>
      <circle cx="53" cy="45" r="6"/><circle cx="41" cy="55" r="6"/><circle cx="23" cy="55" r="6"/>
      <circle cx="11" cy="45" r="6"/><circle cx="9" cy="30" r="6"/><circle cx="18" cy="16" r="6"/>
    </g>
    <circle cx="32" cy="35" r="17.5" fill="#ffcb7d"/>
    <path d="M23 13l3-5 4 3.6 4-3.6 3 5Z" fill="#e2a41b" stroke="#b07c0d" stroke-width="1"/>
    <circle cx="32" cy="9" r="1.5" fill="#fff4d6"/>
    <ellipse cx="32" cy="42" rx="10" ry="7" fill="#fff0d2" opacity=".72"/>
    ${SHINE}
    ${EYE(26, 32)} ${EYE(38, 32)}
    ${BLUSH(19, 45, 39)}
    <ellipse cx="32" cy="39.6" rx="2.1" ry="1.5" fill="#5b3a1c"/>
    <path d="M32 41.5v2M32 43.5c-1.4 1.6-3 1.7-4 .7M32 43.5c1.4 1.6 3 1.7 4 .7" fill="none" stroke="#5b3a1c" stroke-width="1.2" stroke-linecap="round"/>`,

  fox: `
    <path d="M16 24 18 7l13 11Z" fill="#e0682f"/><path d="M20 20l1-8 6 6Z" fill="#ffc6a6"/>
    <path d="M48 24 46 7 33 18Z" fill="#e0682f"/><path d="M44 20l-1-8-6 6Z" fill="#ffc6a6"/>
    <ellipse cx="32" cy="35" rx="18" ry="17" fill="#f07b3f"/>
    <path d="M16 37c3 8 9 13 16 13s13-5 16-13c-4 4-9 6-16 6s-12-2-16-6Z" fill="#fff7ef"/>
    ${SHINE}
    ${EYE(26, 32)} ${EYE(38, 32)}
    ${BLUSH(19, 45, 39)}
    <path d="M29 40.5c1.6 1.4 4.4 1.4 6 0" fill="none" stroke="#3a2418" stroke-width="1.4" stroke-linecap="round"/>
    <ellipse cx="32" cy="38.6" rx="2" ry="1.4" fill="#332018"/>`,

  owl: `
    <path d="M16 21 18 8l10 8Z" fill="#6c5bd6"/><path d="M48 21 46 8 36 16Z" fill="#6c5bd6"/>
    <ellipse cx="32" cy="35" rx="19" ry="18" fill="#8b7cf6"/>
    <ellipse cx="32" cy="41" rx="11.5" ry="9.5" fill="#d9d2ff" opacity=".65"/>
    <circle cx="24" cy="32" r="8.2" fill="#fff"/><circle cx="40" cy="32" r="8.2" fill="#fff"/>
    <circle cx="24" cy="32.5" r="3.9" fill="#2a2140"/><circle cx="40" cy="32.5" r="3.9" fill="#2a2140"/>
    <circle cx="25.3" cy="31.1" r="1.2" fill="#fff"/><circle cx="41.3" cy="31.1" r="1.2" fill="#fff"/>
    <path d="M32 34.5l3.6 4.6h-7.2Z" fill="#f0a93b"/>
    <path d="M28 42c2.6 1.8 5.4 1.8 8 0" fill="none" stroke="#4a3f78" stroke-width="1.4" stroke-linecap="round"/>`,

  octopus: `
    <path d="M14 43c-3 6-2 10 1 11 4 1 5-4 5-7M50 43c3 6 2 10-1 11-4 1-5-4-5-7" fill="#0f9f8f"/>
    <path d="M20 45c-2 5-1 9 2 10 3 .8 4-4 4-6M44 45c2 5 1 9-2 10-3 .8-4-4-4-6" fill="#14b8a6"/>
    <ellipse cx="32" cy="33" rx="19" ry="18" fill="#14b8a6"/>
    <path d="M15 34c1 9 8 15 17 15s16-6 17-15c-4 5-10 8-17 8s-13-3-17-8Z" fill="#9ff0e6" opacity=".5"/>
    ${SHINE}
    ${EYE(25.5, 32)} ${EYE(38.5, 32)}
    ${BLUSH(19, 45, 39)}
    <path d="M29 41q3 2.2 6 0" fill="none" stroke="#0b4f49" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="21" cy="44" r="1" fill="#0b4f49" opacity=".35"/><circle cx="43" cy="44" r="1" fill="#0b4f49" opacity=".35"/>`,

  bird: `
    <path d="M49 34c6-2 8 2 7 6-6 1-10-1-12-3" fill="#168fc9"/>
    <path d="M14 33c-4 5-2 11 3 13 2-4 2-9 0-13Z" fill="#7dd3fc"/>
    <ellipse cx="32" cy="35" rx="18" ry="16.5" fill="#38bdf8"/>
    <ellipse cx="31" cy="41" rx="11" ry="8.5" fill="#d8f3ff" opacity=".8"/>
    ${SHINE}
    ${EYE(26, 32)} ${EYE(38, 32)}
    <path d="M32 36.5l6 4-6 3.5-1.5-4Z" fill="#f59e0b"/>
    ${BLUSH(19, 45, 39)}
    <path d="M26 43c2 1.5 4 1.8 6 1" fill="none" stroke="#115e7a" stroke-width="1.3" stroke-linecap="round"/>`,

  beaver: `
    <path d="M48 37c6-1 9 4 7 9-1 4-6 5-9 1" fill="#9a6428"/>
    <circle cx="18" cy="23" r="6.5" fill="#b97a35"/><circle cx="46" cy="23" r="6.5" fill="#b97a35"/>
    <circle cx="18" cy="23" r="3.4" fill="#e6b27a"/><circle cx="46" cy="23" r="3.4" fill="#e6b27a"/>
    <ellipse cx="32" cy="35" rx="18.5" ry="17" fill="#c98a3b"/>
    <ellipse cx="32" cy="42" rx="11" ry="8" fill="#f3d3a8" opacity=".85"/>
    ${SHINE}
    ${EYE(26, 31.5)} ${EYE(38, 31.5)}
    ${BLUSH(19, 45, 38)}
    <ellipse cx="32" cy="38" rx="2.2" ry="1.6" fill="#4a2d15"/>
    <rect x="29.2" y="41.2" width="2.6" height="5" rx="0.8" fill="#fffdf5" stroke="#d9c6a4" stroke-width=".6"/>
    <rect x="32.2" y="41.2" width="2.6" height="5" rx="0.8" fill="#fffdf5" stroke="#d9c6a4" stroke-width=".6"/>`,

  bear: `
    <circle cx="17" cy="22" r="7" fill="#8a5937"/><circle cx="47" cy="22" r="7" fill="#8a5937"/>
    <circle cx="17" cy="22" r="3.6" fill="#d6a078"/><circle cx="47" cy="22" r="3.6" fill="#d6a078"/>
    <ellipse cx="32" cy="35" rx="19" ry="17.5" fill="#a9714b"/>
    <ellipse cx="32" cy="41.5" rx="10.5" ry="7.5" fill="#e8c9a8"/>
    ${SHINE}
    ${EYE(26, 31.5)} ${EYE(38, 31.5)}
    ${BLUSH(18.5, 45.5, 39)}
    <ellipse cx="32" cy="38.2" rx="2.6" ry="1.9" fill="#3b2415"/>
    <path d="M32 40.2v2.2M32 42.4c-1.5 1.6-3.1 1.6-4.2.5M32 42.4c1.5 1.6 3.1 1.6 4.2.5" fill="none" stroke="#3b2415" stroke-width="1.3" stroke-linecap="round"/>`,

  rabbit: `
    <ellipse cx="24" cy="16" rx="5.2" ry="12" fill="#e77fa3" transform="rotate(-8 24 16)"/>
    <ellipse cx="40" cy="16" rx="5.2" ry="12" fill="#e77fa3" transform="rotate(8 40 16)"/>
    <ellipse cx="24" cy="16" rx="2.5" ry="8.5" fill="#ffd3e0" transform="rotate(-8 24 16)"/>
    <ellipse cx="40" cy="16" rx="2.5" ry="8.5" fill="#ffd3e0" transform="rotate(8 40 16)"/>
    <ellipse cx="32" cy="36" rx="17.5" ry="16.5" fill="#f08fb0"/>
    <ellipse cx="32" cy="42" rx="10.5" ry="8" fill="#ffe4ed" opacity=".9"/>
    ${SHINE}
    ${EYE(26, 33)} ${EYE(38, 33)}
    ${BLUSH(19, 45, 39.5)}
    <path d="M29.5 38.6h5l-2.5 2.2Z" fill="#c25a7d"/>
    <path d="M32 40.8v2.2M32 43c-1.4 1.5-3 1.5-4 .5M32 43c1.4 1.5 3 1.5 4 .5" fill="none" stroke="#8d3d57" stroke-width="1.2" stroke-linecap="round"/>`,

  user: `
    <circle cx="32" cy="32" r="32" fill="var(--user)"/>
    <text x="32" y="40" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="26" font-weight="600" fill="var(--user-text)">?</text>`,
};

export const PROFILES = {
  ChiefRouter: {
    name: "Chief", role: "总管", tagline: "拆解目标 · 调度团队 · 汇总结果",
    emoji: "🧠", badge: "chief",
    kind: "whale", color: "#4d6bfe", bg: "#e9eeff",
  },
  chief: {
    name: "Chief", role: "总管", tagline: "拆解目标 · 调度团队 · 汇总结果",
    emoji: "🧠", badge: "chief",
    kind: "whale", color: "#4d6bfe", bg: "#e9eeff",
  },
  boss: {
    name: "Boss", role: "群主", tagline: "分派任务 · 授权 · 决定共享范围",
    emoji: "👑", badge: "群主",
    kind: "lion", color: "#c47a10", bg: "#fff1d9",
  },
  coder: {
    name: "Coder", role: "工程师", tagline: "写代码 · 改文件 · 跑命令",
    emoji: "💻", badge: "coder",
    kind: "fox", color: "#c35a24", bg: "#ffeadf",
  },
  reviewer: {
    name: "Reviewer", role: "审查员", tagline: "验收 · 查漏 · 复核产出",
    emoji: "🔍", badge: "review",
    kind: "owl", color: "#6f5bd6", bg: "#eeebff",
  },
  librarian: {
    name: "Librarian", role: "文件管家", tagline: "群文件空间 · 归档 · 同步路径",
    emoji: "🗂", badge: "files",
    kind: "octopus", color: "#0f9182", bg: "#e2f7f3",
  },
  explore: {
    name: "Explore", role: "侦察员", tagline: "只读搜索 · 快速定位",
    emoji: "🧭", badge: "explore",
    kind: "bird", color: "#0d8fc7", bg: "#e3f5ff",
  },
  plan: {
    name: "Plan", role: "架构师", tagline: "方案设计 · 文件清单",
    emoji: "📐", badge: "plan",
    kind: "beaver", color: "#9a6428", bg: "#f7ead9",
  },
  planner: {
    name: "Planner", role: "规划师", tagline: "拆解 · 排期 · 依赖与风险",
    emoji: "📐", badge: "plan",
    kind: "beaver", color: "#8a6a2f", bg: "#f7ead9",
  },
  writer: {
    name: "Writer", role: "文案", tagline: "文档 · 文案 · 结构化表达",
    emoji: "✍️", badge: "writer",
    kind: "rabbit", color: "#c25a7d", bg: "#ffe8f0",
  },
  analyst: {
    name: "Analyst", role: "分析师", tagline: "数据 · 指标 · 可验证的结论",
    emoji: "📊", badge: "analyst",
    kind: "octopus", color: "#0f8f9f", bg: "#e2f7f3",
  },
  general: {
    name: "General", role: "执行者", tagline: "通用任务 · 工具执行",
    emoji: "⚙️", badge: "general",
    kind: "bear", color: "#8a5937", bg: "#f2e6dc",
  },
  "general-purpose": {
    name: "General", role: "执行者", tagline: "通用任务 · 工具执行",
    emoji: "⚙️", badge: "general",
    kind: "bear", color: "#8a5937", bg: "#f2e6dc",
  },
  teammate: {
    name: "Teammate", role: "协作者", tagline: "群内讨论 · 接力执行",
    emoji: "🧩", badge: "teammate",
    kind: "rabbit", color: "#c25a7d", bg: "#ffe8f0",
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
    kind: "bear",
    color: "#8a5937",
    bg: "#f2e6dc",
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
    // The pi-kernel backend ships a full identity record (emoji/color/badge);
    // prefer it over the local archetype table so the UI matches the engine.
    emoji: bot?.emoji || base.emoji || "",
    badge: bot?.badge || base.badge || "",
    color: bot?.color || base.color,
  };
}

export function avatarSvg(kind) {
  const body = CHARACTERS[kind] || CHARACTERS.bear;
  return `<svg viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;
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
  if (url) {
    return `<span class="avatar has-img${cls}"${title} style="width:${size}px;height:${size}px;background:${p.bg}" data-bot="${escapeAttr(String(id || ""))}"><img src="${escapeAttr(url)}" alt=""></span>`;
  }
  if (p.emoji) {
    return `<span class="avatar has-emoji${cls}"${title} style="width:${size}px;height:${size}px;background:${p.bg};font-size:${Math.max(11, Math.round(size * 0.46))}px" data-bot="${escapeAttr(String(id || ""))}" aria-hidden="true">${escapeHtml(p.emoji)}</span>`;
  }
  const initials = escapeHtml(initialsFor(p.name));
  return `<span class="avatar mono${cls}"${title} style="width:${size}px;height:${size}px;--av-bg:${p.bg};color:${p.color};font-size:${Math.max(9, Math.round(size * 0.34))}px" data-bot="${escapeAttr(String(id || ""))}">${initials}</span>`;
}

export function userAvatar(size = 30, initial = "我") {
  const url = customAvatarUrl("user", "me");
  if (url) {
    return `<span class="avatar has-img is-user" style="width:${size}px;height:${size}px"><img src="${escapeAttr(url)}" alt=""></span>`;
  }
  const safe = escapeHtml(initial || "我").slice(0, 1);
  return `<span class="avatar is-user" style="width:${size}px;height:${size}px">${safe}</span>`;
}

export function groupAvatar(room, size = 34, botsById = {}) {
  const roomId = room?.room_id;
  const custom = roomId ? customAvatarUrl("room", roomId) : "";
  if (custom) {
    return `<span class="group-av custom" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.32)}px"><img src="${escapeAttr(custom)}" alt=""></span>`;
  }
  const members = room?.members || [];
  const label = String(room?.title || room?.topic || "群").trim() || "群";
  const initials = /^[A-Za-z]/.test(label) ? label.slice(0, 2).toUpperCase() : label.slice(0, 1);
  const palette = [
    ["#e9eeff", "#3f5be8"], ["#e2f7f3", "#0f9182"], ["#fff1d9", "#c47a10"],
    ["#eeebff", "#6f5bd6"], ["#ffe8f0", "#c25a7d"], ["#e3f5ff", "#0d8fc7"],
  ];
  let h = 0;
  for (const ch of String(roomId || label)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = palette[h % palette.length];
  return `<span class="group-av group-mono" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.32)}px;font-size:${Math.max(12, Math.round(size * 0.36))}px;--group-bg:${bg};--group-fg:${fg}" title="${escapeAttr(label)}">${escapeHtml(initials)}</span>`;
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
