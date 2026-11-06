// markdown.js — small safe renderer: escape first, then transform.
// Supports fenced code, inline code, bold, links, headings, lists, tables,
// blockquotes and @mentions. Raw HTML never passes through.

let mentionColorizer = null;
export function setMentionColorizer(fn) { mentionColorizer = fn; }

function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s) {
  s = s.replace(/\\([_*`\[\]\\])/g, "$1");
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
    `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`);
  if (mentionColorizer) {
    s = s.replace(/@([A-Za-z0-9_\-]+)/g, (m, name) => {
      const color = mentionColorizer(name);
      const safe = esc(name);
      return color
        ? `<span class="mention" style="color:${color}">@${safe}</span>`
        : `@${safe}`;
    });
  }
  return s;
}

function tryTable(lines, i, out) {
  const isRow = (l) => /^\s*\|.+\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l) && l.includes("-");
  if (!(isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1]))) return i;
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const head = cells(lines[i]);
  const rows = [];
  let j = i + 2;
  while (j < lines.length && isRow(lines[j])) { rows.push(cells(lines[j])); j += 1; }
  const th = head.map((h) => `<th>${inline(h)}</th>`).join("");
  const tb = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
  out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
  return j;
}

export function renderMarkdown(src) {
  const text = esc(String(src ?? ""));
  const lines = text.split("\n");
  const out = [];
  let para = [];
  let list = null;
  let inCode = false;
  let code = [];

  const flushPara = () => { if (para.length) { out.push(`<p>${para.join("<br>")}</p>`); para = []; } };
  const flushList = () => {
    if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`); list = null; }
  };

  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k];
    const line = raw.replace(/\s+$/, "");

    if (inCode) {
      if (/^```/.test(line.trim())) {
        out.push(`<pre><code>${code.join("\n")}</code></pre>`);
        code = []; inCode = false;
      } else code.push(raw);
      continue;
    }
    if (/^```/.test(line.trim())) { flushPara(); flushList(); inCode = true; continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }

    if (/^\s*\|.+\|\s*$/.test(line)) {
      flushPara(); flushList();
      const next = tryTable(lines, k, out);
      if (next !== k) { k = next - 1; continue; }
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h4>${inline(h[2])}</h4>`); continue; }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flushPara(); flushList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }

    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ul) { flushPara(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(inline(ul[1])); continue; }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { flushPara(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(inline(ol[1])); continue; }

    flushList();
    para.push(inline(line));
  }
  if (inCode && code.length) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  flushPara(); flushList();
  return out.join("");
}
