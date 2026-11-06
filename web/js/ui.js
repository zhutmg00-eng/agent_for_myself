/* Shared UI primitives: icons, toast, modal, formatting. */

export const ICONS = {
  search: `<svg viewBox="0 0 20 20"><circle cx="8.8" cy="8.8" r="4.7"/><path d="m12.4 12.4 3.3 3.3"/></svg>`,
  plus: `<svg viewBox="0 0 20 20"><path d="M10 4.4v11.2M4.4 10h11.2"/></svg>`,
  close: `<svg viewBox="0 0 20 20"><path d="m5 5 10 10m0-10L5 15"/></svg>`,
  send: `<svg viewBox="0 0 20 20"><path d="M10 15V5m0 0L5.8 9.2M10 5l4.2 4.2"/></svg>`,
  settings: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.6"/><path d="M10 3.2v1.6m0 10.4v1.6M3.2 10h1.6m10.4 0h1.6M5.2 5.2l1.1 1.1m7.4 7.4 1.1 1.1m0-9.6-1.1 1.1m-7.4 7.4-1.1 1.1"/></svg>`,
  chart: `<svg viewBox="0 0 20 20"><path d="M4 15.5V10m6 5.5V5m6 10.5v-7"/></svg>`,
  folder: `<svg viewBox="0 0 20 20"><path d="M3.2 6.5A1.5 1.5 0 0 1 4.7 5h3l1.5 1.8h6.1a1.5 1.5 0 0 1 1.5 1.5v6.2a1.5 1.5 0 0 1-1.5 1.5H4.7a1.5 1.5 0 0 1-1.5-1.5Z"/></svg>`,
  users: `<svg viewBox="0 0 20 20"><circle cx="8" cy="7.4" r="3"/><path d="M3.2 16c.5-2.7 2.4-4.2 4.8-4.2s4.3 1.5 4.8 4.2"/><path d="M13.4 5.2a2.6 2.6 0 0 1 0 5M14.5 12.2c1.5.5 2.5 1.8 2.8 3.8"/></svg>`,
  info: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.7"/><path d="M10 9.2v4.2M10 6.8h.01"/></svg>`,
  more: `<svg viewBox="0 0 20 20"><circle cx="4.5" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r="1.1" fill="currentColor" stroke="none"/></svg>`,
  check: `<svg viewBox="0 0 20 20"><path d="m5 10.5 3.2 3.2L15.2 6.6"/></svg>`,
  checkCircle: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.6"/><path d="m6.8 10.2 2.1 2.1 4.4-4.5"/></svg>`,
  bell: `<svg viewBox="0 0 20 20"><path d="M5.3 8.4a4.7 4.7 0 0 1 9.4 0v3.1l1.2 2.1H4.1l1.2-2.1Z"/><path d="M8.3 16.1a1.8 1.8 0 0 0 3.4 0"/></svg>`,
  mute: `<svg viewBox="0 0 20 20"><path d="M4 7.5h2.5L10 4.6v10.8L6.5 12.5H4Z"/><path d="m13 7.8 3.4 4.4m0-4.4L13 12.2"/></svg>`,
  sound: `<svg viewBox="0 0 20 20"><path d="M4 7.5h2.5L10 4.6v10.8L6.5 12.5H4Z"/><path d="M12.8 7.4a3.6 3.6 0 0 1 0 5.2M14.8 5.4a6.4 6.4 0 0 1 0 9.2"/></svg>`,
  star: `<svg viewBox="0 0 20 20"><path d="m10 3.6 1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6Z"/></svg>`,
  usersPlus: `<svg viewBox="0 0 20 20"><circle cx="7.6" cy="7.4" r="3"/><path d="M2.8 16c.5-2.7 2.4-4.2 4.8-4.2 1.2 0 2.2.3 3 .9"/><path d="M14.2 10.2v4.4M12 12.4h4.4"/></svg>`,
  file: `<svg viewBox="0 0 20 20"><path d="M5.2 3.5h6.2l3.4 3.4v9.6H5.2Z"/><path d="M11.4 3.7v3.4H14.7"/></svg>`,
  arrowRight: `<svg viewBox="0 0 20 20"><path d="M4 10h11m0 0-4.2-4.2M15 10l-4.2 4.2"/></svg>`,
  chevron: `<svg viewBox="0 0 20 20"><path d="m6.5 8 3.5 3.5L13.5 8"/></svg>`,
  refresh: `<svg viewBox="0 0 20 20"><path d="M15.5 8.2A6 6 0 0 0 4.8 6.4M4.5 11.8a6 6 0 0 0 10.7 1.8"/><path d="M15.7 4.8v3.7h-3.7M4.3 15.2v-3.7h3.7"/></svg>`,
  tool: `<svg viewBox="0 0 20 20"><path d="M11.7 5.1a3.4 3.4 0 0 0-4.3 4.3l-4 4a1.3 1.3 0 0 0 1.9 1.9l4-4a3.4 3.4 0 0 0 4.3-4.3l-2 2-1.9-1.9Z"/></svg>`,
  chevronRight: `<svg viewBox="0 0 20 20"><path d="m8 6.5 3.5 3.5L8 13.5"/></svg>`,
  edit: `<svg viewBox="0 0 20 20"><path d="m4 16 1-3.4 7.7-7.7 2.4 2.4L7.4 15Z"/><path d="m11.5 5.7 2.4 2.4"/></svg>`,
  camera: `<svg viewBox="0 0 20 20"><path d="M3.5 6.7h3l1.1-1.8h4.8l1.1 1.8h3v8.3h-13Z"/><circle cx="10" cy="10.6" r="2.5"/></svg>`,
  copy: `<svg viewBox="0 0 20 20"><rect x="7" y="7" width="8.4" height="8.4" rx="1.4"/><path d="M5 12.6H4.3A1.3 1.3 0 0 1 3 11.3V4.3A1.3 1.3 0 0 1 4.3 3h7a1.3 1.3 0 0 1 1.3 1.3V5"/></svg>`,
  sun: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.4"/><path d="M10 2.6v1.5m0 11.8v1.5M2.6 10h1.5m11.8 0h1.5M4.8 4.8l1 1m8.4 8.4 1 1m0-10.4-1 1m-8.4 8.4-1 1"/></svg>`,
  moon: `<svg viewBox="0 0 20 20"><path d="M15.7 12.2A6.3 6.3 0 0 1 7.8 4.3a6.3 6.3 0 1 0 7.9 7.9Z"/></svg>`,
  spark: `<svg viewBox="0 0 20 20"><path d="M10 3.2c.5 3.5 1.9 5 5.4 5.6-3.5.6-4.9 2.1-5.4 5.6-.5-3.5-1.9-5-5.4-5.6 3.5-.6 4.9-2.1 5.4-5.6Z"/><path d="M15.2 13.4c.2 1.4.8 2 2.2 2.3-1.4.2-2 .9-2.2 2.3-.2-1.4-.8-2.1-2.2-2.3 1.4-.3 2-.9 2.2-2.3Z"/></svg>`,
  spinner: `<svg viewBox="0 0 20 20" class="spin"><path d="M10 3.2a6.8 6.8 0 1 0 6.8 6.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
export function escapeAttr(value) { return escapeHtml(value).replaceAll("\n", " "); }

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function toast(message, kind = "info") {
  const root = $("#toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "toast";
  const icon = kind === "error" ? ICONS.info : kind === "success" ? ICONS.checkCircle : ICONS.info;
  el.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 200);
  }, kind === "error" ? 4200 : 2600);
}

let activeModal = null;

export function openModal(html, options = {}) {
  closeModal();
  const root = $("#modal-root");
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = html;
  root.appendChild(backdrop);
  activeModal = { backdrop, onClose: options.onClose };
  backdrop.addEventListener("mousedown", (ev) => {
    if (ev.target === backdrop && options.dismissable !== false) closeModal();
  });
  const onKey = (ev) => { if (ev.key === "Escape") closeModal(); };
  document.addEventListener("keydown", onKey);
  activeModal.onKey = onKey;
  if (options.onMount) options.onMount(backdrop);
  return { backdrop, close: closeModal };
}

export function closeModal() {
  if (!activeModal) return;
  const { backdrop, onKey, onClose } = activeModal;
  activeModal = null;
  if (onKey) document.removeEventListener("keydown", onKey);
  backdrop.style.animation = "fade-in .12s reverse";
  backdrop.style.pointerEvents = "none";
  setTimeout(() => backdrop.remove(), 120);
  if (onClose) onClose();
}

export function confirmDialog({ title, body, confirm = "确认", danger = false }) {
  return new Promise((resolve) => {
    openModal(`
      <div class="modal" role="dialog" aria-modal="true" style="width:min(420px,100%)">
        <div class="modal-head">
          <div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn ${danger ? "danger" : "primary"}" data-act="ok">${escapeHtml(confirm)}</button>
        </div>
      </div>`, {
      onMount(root) {
        root.querySelector('[data-act="cancel"]').onclick = () => { closeModal(); resolve(false); };
        root.querySelector('[data-act="ok"]').onclick = () => { closeModal(); resolve(true); };
      },
      onClose() { resolve(false); },
    });
  });
}

export function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function relTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTime(ts);
}

export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

export function fileName(path = "") {
  const clean = String(path).replace(/\\/g, "/");
  return clean.split("/").filter(Boolean).pop() || clean;
}

export function fileExt(path = "") {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileBadge(path = "") {
  const ext = fileExt(path);
  if (ext === "md") return "MD";
  if (ext === "json") return "JSON";
  if (ext === "py") return "PY";
  if (ext === "js") return "JS";
  if (ext === "ts") return "TS";
  if (ext === "txt") return "TXT";
  return ext ? ext.toUpperCase().slice(0, 4) : "FILE";
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function scrollToBottom(el, smooth = false) {
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

export function isNearBottom(el, threshold = 80) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

/* Pick a local image and crop it to a 512×512 JPEG for the avatar store. */
export function pickAvatarFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.remove();
      resolve(file || null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function fileToAvatarDataUrl(file) {
  if (!file) return "";
  if (!/^image\//.test(file.type)) throw new Error("请选择图片文件");
  if (file.size > 12 * 1024 * 1024) throw new Error("图片过大（最大 12MB）");
  const bitmap = await createImageBitmap(file);
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fbfaf7";
  ctx.fillRect(0, 0, size, size);
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  if (bitmap.close) bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.92);
}
