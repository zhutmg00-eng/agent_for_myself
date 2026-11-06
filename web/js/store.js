/* Central state + event reducer. No framework: views re-render on `emit`. */

import { api, openEventStream } from "./api.js";
import { profileFor, setCustomAvatars } from "./avatars.js";

const listeners = new Set();
let eventSource = null;

export const state = {
  view: { type: "chief", id: null },
  ready: false,
  connected: false,
  connecting: true,
  error: "",
  bots: [],
  botsById: {},
  avatars: {},
  rooms: [],
  roomById: {},
  messages: {},          // roomId -> message[] (chat + cards)
  files: {},             // roomId -> file[]
  activity: {},          // roomId -> { round: bool, typing: Set, tools: Map }
  unread: {},            // roomId -> count
  chief: {
    messages: [],
    active: false,
    plan: null,
    streamText: "",
    tools: [],
    ticketId: null,
    threadId: null,
  },
  settings: null,
  health: null,          // normalised /api/health (kernel, gateway, data root)
  models: [],
  skills: [],
  hooks: null,
  context: null,
  stats: null,
  approvals: {           // E26 审批：默认全空，等 refreshApprovals() 填充
    mode: "yolo",
    approvals: [],
    stats: {},
    audit: [],
    roomId: "",
    at: null,
    error: "",
  },
  evidence: {},          // roomId -> { summary, records, at, error }（E29 证据阶梯）
  skillProposals: {      // E27 技能提案（学习闭环）：面板打开时才拉，失败静默
    proposals: [],
    report: {},
    status: "",
    at: null,
    error: null,
    open: false,
  },
  theme: localStorage.getItem("ah-theme") || "light",
  inspector: null,       // { type: 'group'|'bot'|'usage', id }
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of Array.from(listeners)) {
    try { fn(); } catch (err) { console.error("[store] listener failed", err); }
  }
}

function uid(prefix = "l") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function applyTheme(theme = state.theme) {
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ah-theme", theme);
}

/* ------------------------------------------------------------------ boot */

export async function boot() {
  applyTheme();
  try {
    const [bots, rooms, settings, models, skills, hooks, context, stats, avatars, health, approvals] = await Promise.allSettled([
      api.bots(), api.rooms(), api.settings(), api.models(), api.skills(), api.hooks(), api.context(), api.stats(), api.avatars(), api.health(), api.approvals(),
    ]);
    if (bots.status === "fulfilled") setBots(bots.value.bots || []);
    if (rooms.status === "fulfilled") setRooms(rooms.value.rooms || []);
    if (settings.status === "fulfilled") state.settings = settings.value;
    if (health.status === "fulfilled") state.health = health.value;
    if (models.status === "fulfilled") state.models = models.value.data || models.value.models || [];
    if (skills.status === "fulfilled") state.skills = skills.value.skills || [];
    if (hooks.status === "fulfilled") state.hooks = hooks.value;
    if (context.status === "fulfilled") state.context = context.value;
    if (stats.status === "fulfilled") state.stats = stats.value;
    if (approvals.status === "fulfilled") applyApprovalsPayload(approvals.value);
    if (avatars.status === "fulfilled") {
      state.avatars = avatars.value.avatars || {};
      setCustomAvatars(state.avatars);
    }
  } catch (err) {
    state.error = err.message || String(err);
  }
  state.ready = true;
  emit();
  connectEvents();
}

function setBots(bots) {
  state.bots = bots.map((b) => ({ ...b, id: String(b.id || b.bot_id || "") })).filter((b) => b.id);
  state.botsById = Object.fromEntries(state.bots.map((b) => [b.id, b]));
}

/* Rooms arrive from two sources (list + single snapshot) and the backend may
 * omit optional fields (member_permissions, file_count, updated_at...).
 * Normalise once so views can trust the shape. */
export function normalizeRoom(raw) {
  if (!raw || typeof raw !== "object") return null;
  const roomId = String(raw.room_id || raw.roomId || raw.id || "");
  if (!roomId) return null;
  const members = Array.isArray(raw.members)
    ? raw.members
      .map((m) => String((m && typeof m === "object" ? m.bot_id || m.id || "" : m) || ""))
      .filter(Boolean)
    : [];
  const perms = raw.member_permissions && typeof raw.member_permissions === "object"
    ? raw.member_permissions
    : {};
  return {
    ...raw,
    room_id: roomId,
    title: String(raw.title || ""),
    topic: String(raw.topic || ""),
    owner_id: raw.owner_id || null,
    parent_room_id: raw.parent_room_id || null,
    context_policy: ["shared", "summary", "isolated"].includes(raw.context_policy) ? raw.context_policy : "shared",
    status: raw.status || "active",
    members,
    member_permissions: perms,
    file_count: Number(raw.file_count || 0),
    message_count: Number(raw.message_count || 0),
    updated_at: raw.updated_at || raw.updatedAt || raw.created_at || null,
  };
}

function roomTime(room) {
  const t = Date.parse(room?.updated_at || "");
  return Number.isNaN(t) ? 0 : t;
}

/* Rooms have no guaranteed ordering from the API; sort by updated_at with a
 * created_at/insertion fallback so a missing timestamp never reorders wildly. */
export function sortedRooms(list = state.rooms) {
  return [...list].sort((a, b) => roomTime(b) - roomTime(a));
}

function setRooms(rawRooms) {
  const rooms = (Array.isArray(rawRooms) ? rawRooms : []).map(normalizeRoom).filter(Boolean);
  state.rooms = sortedRooms(rooms);
  state.roomById = Object.fromEntries(rooms.map((r) => [r.room_id, r]));
  for (const room of rooms) {
    if (!state.messages[room.room_id]) state.messages[room.room_id] = [];
    if (!state.files[room.room_id]) state.files[room.room_id] = [];
    if (!state.activity[room.room_id]) state.activity[room.room_id] = newActivity();
    if (state.unread[room.room_id] == null) state.unread[room.room_id] = 0;
  }
}

function newActivity() {
  return { round: false, typing: new Set(), tools: new Map() };
}

export async function refreshRooms() {
  const data = await api.rooms();
  setRooms(data.rooms || (Array.isArray(data) ? data : []));
  emit();
}

export async function refreshHealth() {
  try {
    state.health = await api.health();
    emit();
  } catch { /* health poll is best-effort */ }
}

export async function refreshModels() {
  try {
    const data = await api.models();
    state.models = data.data || data.models || [];
    emit();
  } catch { /* gateway may be down; keep the previous catalogue */ }
}

export async function refreshBots() {
  const data = await api.bots();
  setBots(data.bots || []);
  emit();
}

export async function refreshContext() {
  try {
    const [context, stats] = await Promise.all([api.context(), api.stats()]);
    state.context = context;
    state.stats = stats;
    emit();
  } catch { /* non-fatal */ }
}

/* ------------------------------------------------------------- approvals */
/* E26 审批面板的数据来自三个端点（列表带 mode/stats、审计、裁决走 POST）。
 * 合并式刷新：单个请求失败只写 error，不清空旧列表——一次网络抖动不该让
 * 房间里真实的挂起审批从界面上消失。 */
function applyApprovalsPayload(data) {
  const prev = state.approvals || {};
  const stats = data && typeof data.stats === "object" && data.stats ? data.stats : prev.stats || {};
  state.approvals = {
    ...prev,
    mode: data?.mode || prev.mode || "yolo",
    approvals: Array.isArray(data?.approvals) ? data.approvals : prev.approvals || [],
    stats,
    at: new Date().toISOString(),
    error: "",
  };
}

export async function refreshApprovals(roomId = state.approvals.roomId || "") {
  const rid = roomId ? String(roomId) : "";
  state.approvals.roomId = rid;
  const [list, audit] = await Promise.allSettled([
    api.approvals({ roomId: rid }),
    api.approvalAudit(10),
  ]);
  if (list.status === "fulfilled") applyApprovalsPayload(list.value);
  else state.approvals.error = list.reason?.message || String(list.reason || "审批列表加载失败");
  if (audit.status === "fulfilled" && Array.isArray(audit.value)) state.approvals.audit = audit.value;
  emit();
  return state.approvals;
}

/* 徽标与面板共用：优先用后端 stats.pending（全局口径，不受列表过滤影响）。 */
export function pendingApprovalCount() {
  const a = state.approvals || {};
  const n = Number(a.stats?.pending);
  if (Number.isFinite(n) && n >= 0) return n;
  return Array.isArray(a.approvals) ? a.approvals.length : 0;
}

/* -------------------------------------------------------------- evidence */
/* E09/E29 证据阶梯：只有三态，其他一律当"没判定"（null），不猜。 */
export const EVIDENCE_STATUSES = ["observed", "prepared", "mismatch"];

export function normalizeEvidenceStatus(raw) {
  const value = String(raw ?? "").toLowerCase();
  return EVIDENCE_STATUSES.includes(value) ? value : null;
}

const EVIDENCE_TTL_MS = 15_000;
const evidenceInflight = new Map();
const evidenceTimers = new Map();

/* 汇总刷新：房间级缓存 + 在途去重 + 失败静默。
 * 失败时保留旧数据（不让 head 的汇总闪没），同时记 error 供调试；绝不 toast，
 * 因为证据只是"附加说明"，不能盖过群聊本身。force=true 时绕过 TTL。 */
export async function refreshEvidence(roomId, { force = false, maxAge = EVIDENCE_TTL_MS } = {}) {
  const id = String(roomId || "").trim();
  if (!id) return null;
  const current = state.evidence?.[id];
  if (!force && current && Date.now() - Number(current.at || 0) < maxAge) return current;
  if (evidenceInflight.has(id)) return evidenceInflight.get(id);

  const task = (async () => {
    try {
      const data = await api.roomEvidence(id);
      state.evidence[id] = {
        summary: data.summary,
        records: Array.isArray(data.records) ? data.records : [],
        at: Date.now(),
        error: "",
      };
    } catch (err) {
      state.evidence[id] = {
        summary: current?.summary || { observed: 0, prepared: 0, mismatch: 0, total: 0 },
        records: current?.records || [],
        at: Date.now(),
        error: err?.message || String(err || "证据汇总加载失败"),
      };
    } finally {
      evidenceInflight.delete(id);
    }
    emit();
    return state.evidence[id];
  })();
  evidenceInflight.set(id, task);
  return task;
}

/* SSE 一个回合会连发多条 turn_completed（每个成员一条），防抖成一次拉取。 */
function scheduleEvidenceRefresh(roomId, delay = 350) {
  const id = String(roomId || "");
  if (!id) return;
  clearTimeout(evidenceTimers.get(id));
  evidenceTimers.set(id, setTimeout(() => {
    evidenceTimers.delete(id);
    refreshEvidence(id, { force: true }).catch(() => {});
  }, delay));
}

export function evidenceSummaryOf(roomId) {
  const summary = state.evidence?.[roomId]?.summary;
  if (!summary || !Number(summary.total)) return null;
  return summary;
}

/* -------------------------------------------------------- skill proposals */
/* 学习闭环（E27）：真实回合里自动 propose -> 人工 review -> adopt 落盘。
 * 列表只在面板打开时拉；失败静默（保留旧数据，只记 error），端点 404 时面板
 * 退化成空态而不是红屏。 */
export async function refreshSkillProposals(status = state.skillProposals?.status || "") {
  const value = status ? String(status) : "";
  state.skillProposals.status = value;
  try {
    const data = await api.skillProposals({ status: value });
    state.skillProposals = {
      ...state.skillProposals,
      proposals: data.proposals,
      report: data.report,
      at: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    state.skillProposals = {
      ...state.skillProposals,
      at: new Date().toISOString(),
      error: err?.message || String(err || "技能提案加载失败"),
    };
  }
  emit();
  return state.skillProposals;
}

/* 本地先替换一行，避免 review 后整表闪烁；随后仍以服务端列表为准。 */
function patchProposal(proposal) {
  if (!proposal || !proposal.id) return;
  const list = state.skillProposals.proposals || [];
  const idx = list.findIndex((item) => item.id === proposal.id);
  if (idx >= 0) list[idx] = proposal;
  else list.unshift(proposal);
}

/* review：adopt(通过) / reject(拒绝) / defer(延后)，可带 reason。 */
export async function reviewSkillProposal(id, { decision, reason = "", by = "user" } = {}) {
  const res = await api.reviewSkillProposal(id, { decision, reason, by });
  if (res?.proposal) patchProposal(res.proposal);
  await refreshSkillProposals();
  return res;
}

/* 两段式采纳：先 review(adopt) 把状态推到 approved，再 adopt 落盘（guard 在
 * adopt 阶段把关）。任一步失败都返回结构化结果，绝不在半途报成功。 */
export async function adoptSkillProposal(id, { by = "user" } = {}) {
  try {
    const reviewed = await api.reviewSkillProposal(id, { decision: "adopt", by });
    if (reviewed && reviewed.ok === false) {
      return { ok: false, stage: "review", error: reviewed.error || "review 失败" };
    }
    if (reviewed?.proposal) patchProposal(reviewed.proposal);
  } catch (err) {
    await refreshSkillProposals();
    return { ok: false, stage: "review", error: err?.message || String(err), status: err?.status };
  }

  let result;
  try {
    const adopted = await api.adoptSkillProposal(id, { by });
    result = { ok: true, skill: adopted?.skill || null, guard: adopted?.guard || null };
  } catch (err) {
    // 409 = guard 阻断或状态不对；error 文案已经是中文原因，guard 明细在 body 里。
    result = { ok: false, stage: "adopt", error: err?.message || String(err), guard: err?.body?.guard || null, status: err?.status };
  }
  await refreshSkillProposals();
  if (result.ok) await refreshSkills();
  return result;
}

/* 采纳后服务端会 reload 技能库，前端跟着重拉一次「能力」分区用的列表。 */
export async function refreshSkills() {
  try {
    const data = await api.skills();
    state.skills = data.skills || [];
    emit();
  } catch { /* 技能列表是附加信息，失败静默 */ }
}

/* ------------------------------------------------------------- messages */

function roomEventTs(evt) {
  if (evt.payload?.timestamp) return evt.payload.timestamp;
  if (evt.ts) {
    const d = new Date(Number(evt.ts) * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function mapRoomEvents(events) {
  const items = [];
  for (const evt of evtList(events)) {
    const topic = evt.topic || "";
    const match = topic.match(/^room\.([^.]+)\.([a-zA-Z_]+)$/);
    if (!match) continue;
    const kind = match[2];
    const p = evt.payload || {};
    const base = { id: `ev_${evt.seq}`, seq: evt.seq, ts: roomEventTs(evt) };
    if (kind === "turn_completed" && (p.speaker || p.member)) {
      items.push({
        ...base, type: "msg", speaker: String(p.speaker || p.member), content: String(p.content ?? ""),
        messageSeq: Number(p.seq) || null,
        evidence: normalizeEvidenceStatus(p.evidence),
      });
    } else if (kind === "task_assigned" && (p.member || p.bot_id || p.assignee)) {
      items.push({
        ...base, type: "assign",
        member: String(p.member || p.bot_id || p.assignee),
        task: String(p.task || p.instruction || ""),
      });
    } else if (kind === "file_saved" && (p.file_id || p.fileId)) {
      items.push({
        ...base, type: "file",
        fileId: String(p.file_id || p.fileId), path: p.path,
        description: p.description,
      });
    } else if (kind === "file_moved" && (p.file_id || p.fileId)) {
      items.push({
        ...base, type: "file_moved",
        fileId: String(p.file_id || p.fileId),
        oldPath: p.old_path || p.from || p.oldPath,
        newPath: p.new_path || p.to || p.newPath,
      });
    } else if (kind === "subgroup_report") {
      items.push({
        ...base, type: "subgroup",
        subRoomId: p.sub_room_id || p.child_room_id || p.room_id,
        topic: p.topic || p.title,
        report: p.report ?? p.summary ?? p.content,
        members: Array.isArray(p.members) ? p.members : [],
      });
    } else if (kind === "permission_changed" && (p.member || p.bot_id)) {
      items.push({
        ...base, type: "notice",
        content: `${String(p.member || p.bot_id)} 的权限已更新`,
      });
    } else if (kind === "context_policy_changed" && p.policy) {
      const label = { shared: "共享全文", summary: "仅摘要", isolated: "各自独立" }[p.policy] || p.policy;
      items.push({ ...base, type: "notice", content: `上下文共享策略切换为「${label}」` });
    } else if (kind === "circuit_breaker_tripped") {
      items.push({ ...base, type: "notice", content: "本轮发言达到上限，房间已暂停。发送新消息可继续。" });
    }
  }
  return items.sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

function evtList(events) {
  if (Array.isArray(events)) return events;
  if (events && Array.isArray(events.events)) return events.events;
  return [];
}

export async function loadRoom(roomId) {
  if (!state.roomById[roomId]) {
    const room = normalizeRoom(await api.room(roomId));
    if (room) {
      state.roomById[roomId] = room;
      if (!state.rooms.some((r) => r.room_id === roomId)) state.rooms = sortedRooms([...state.rooms, room]);
    }
  }
  const [events, files] = await Promise.allSettled([api.roomEvents(roomId), api.files(roomId)]);
  if (events.status === "fulfilled" && (events.value.events || []).length) {
    state.messages[roomId] = mapRoomEvents(events.value.events);
  } else {
    try {
      const msgs = await api.messages(roomId);
      state.messages[roomId] = (msgs.messages || []).map((m) => ({
        id: `seq_${m.seq}`, seq: m.seq, type: "msg", speaker: String(m.speaker || ""),
        content: String(m.content ?? ""), ts: m.ts || new Date().toISOString(),
        messageSeq: Number(m.seq) || null,
        evidence: normalizeEvidenceStatus(m.evidence),
      }));
    } catch { /* keep whatever is in memory */ }
  }
  if (files.status === "fulfilled") state.files[roomId] = (files.value.files || []).map(normalizeFile);
  if (!state.activity[roomId]) state.activity[roomId] = newActivity();
  state.unread[roomId] = 0;
  emit();
  // 证据汇总是附加信息：异步补，失败静默，不阻塞进房。
  refreshEvidence(roomId, { force: true }).catch(() => {});
}

export function normalizeFile(raw) {
  if (!raw || typeof raw !== "object") return { file_id: "", path: "", description: "", tags: [] };
  return {
    ...raw,
    file_id: String(raw.file_id || raw.fileId || raw.id || ""),
    path: String(raw.path || raw.name || ""),
    description: String(raw.description || ""),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    updated_at: raw.updated_at || raw.updatedAt || null,
  };
}

function mergeMessages(server, localCards) {
  const merged = [...server];
  // Keep card events that occurred after the last persisted chat message.
  const lastTs = server.length ? new Date(server[server.length - 1].ts).getTime() : 0;
  for (const card of localCards) {
    if (new Date(card.ts).getTime() >= lastTs) merged.push(card);
  }
  merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return merged;
}

function appendRoomEvent(roomId, event) {
  if (!state.messages[roomId]) state.messages[roomId] = [];
  const list = state.messages[roomId];
  if (event.type === "msg" && event.id) {
    if (list.some((m) => m.id === event.id)) return false;
  }
  list.push(event);
  if (list.length > 1200) list.splice(0, list.length - 1200);
  return true;
}

function isViewingRoom(roomId) {
  return state.view.type === "group" && state.view.id === roomId;
}

function bumpUnread(roomId) {
  if (!isViewingRoom(roomId) && !(state.inspector && state.inspector.type === "group" && state.inspector.id === roomId)) {
    state.unread[roomId] = (state.unread[roomId] || 0) + 1;
  }
}

/* --------------------------------------------------------------- actions */

export async function openRoom(roomId) {
  state.view = { type: "group", id: roomId };
  if (state.inspector?.type === "group" && state.inspector.id !== roomId) state.inspector = null;
  state.unread[roomId] = 0;
  emit();
  await loadRoom(roomId);
}

export function openChief() {
  state.view = { type: "chief", id: null };
  if (state.inspector?.type === "group") state.inspector = null;
  emit();
}

export function openBot(botId) {
  state.view = { type: "bot", id: botId };
  state.inspector = null;
  emit();
}

export function toggleInspector(type, id) {
  if (state.inspector && state.inspector.type === type && state.inspector.id === id) {
    state.inspector = null;
  } else {
    state.inspector = { type, id };
  }
  emit();
}

export function closeInspector() {
  state.inspector = null;
  emit();
}

export async function sendRoomMessage(roomId, content) {
  const text = String(content || "").trim();
  if (!text) return;
  state.activity[roomId] = state.activity[roomId] || newActivity();
  state.activity[roomId].round = true;
  state.activity[roomId].sending = true;
  const optimistic = {
    id: uid("u"), type: "msg", speaker: "user", content: text,
    ts: new Date().toISOString(), pending: true,
  };
  appendRoomEvent(roomId, optimistic);
  markRoomUpdated(roomId);
  emit();
  try {
    await api.say(roomId, text);
  } catch (err) {
    optimistic.pending = false;
    optimistic.failed = true;
    state.activity[roomId].round = false;
    emit();
    throw err;
  } finally {
    state.activity[roomId].sending = false;
    emit();
  }
}

export async function submitChief(prompt) {
  const text = String(prompt || "").trim();
  if (!text || state.chief.active) return;
  state.chief.active = true;
  state.chief.plan = null;
  state.chief.streamText = "";
  state.chief.tools = [];
  state.chief.messages.push({
    id: uid("u"), type: "msg", speaker: "user", content: text, ts: new Date().toISOString(),
  });
  emit();
  try {
    const res = await api.submitTask(text);
    state.chief.ticketId = res.ticket_id;
    state.chief.threadId = res.thread_id;
  } catch (err) {
    state.chief.active = false;
    state.chief.messages.push({
      id: uid("e"), type: "msg", speaker: "system", content: `任务提交失败：${err.message}`, ts: new Date().toISOString(), error: true,
    });
    emit();
    throw err;
  }
}

export async function createRoom(payload) {
  const res = await api.createRoom(payload);
  const roomId = res?.room_id || res?.roomId || res?.id;
  if (roomId && res && typeof res === "object") {
    const room = normalizeRoom(res);
    if (room) state.roomById[roomId] = room;
  }
  await refreshRooms();
  return roomId;
}

export async function updateRoomMeta(roomId, payload) {
  const raw = await api.updateRoom(roomId, payload);
  const updated = normalizeRoom({ ...(state.roomById[roomId] || {}), ...(raw || {}), room_id: roomId });
  state.roomById[roomId] = updated;
  const idx = state.rooms.findIndex((r) => r.room_id === roomId);
  if (idx >= 0) state.rooms[idx] = updated;
  else state.rooms = sortedRooms([...state.rooms, updated]);
  emit();
  return updated;
}

export async function refreshFiles(roomId) {
  const data = await api.files(roomId);
  state.files[roomId] = (data.files || []).map(normalizeFile);
  emit();
}

export async function updateSettings(payload) {
  const next = await api.updateSettings(payload);
  state.settings = { ...state.settings, ...next };
  emit();
  return next;
}

export async function reloadHooks() {
  const res = await api.reloadHooks();
  const hooks = await api.hooks();
  state.hooks = hooks;
  emit();
  return res;
}

export async function uploadAvatar(kind, id, dataUrl) {
  const result = await api.uploadAvatar(kind, id, dataUrl);
  state.avatars = { ...state.avatars, [`${kind}:${id}`]: result };
  setCustomAvatars(state.avatars);
  emit();
  return result;
}

export async function resetAvatar(kind, id) {
  await api.deleteAvatar(kind, id);
  const next = { ...state.avatars };
  delete next[`${kind}:${id}`];
  state.avatars = next;
  setCustomAvatars(state.avatars);
  emit();
}

/* ------------------------------------------------------------------ SSE */

let approvalsTimer = null;
let everConnected = false;

/* SSE 可能在一轮里连发多条审批事件（多个成员同时卡在 tool_call），
 * 防抖后再拉一次列表，避免每个事件各打一次 HTTP。 */
function scheduleApprovalsRefresh(delay = 200) {
  clearTimeout(approvalsTimer);
  approvalsTimer = setTimeout(() => {
    approvalsTimer = null;
    refreshApprovals().catch(() => { /* 列表失败已在 state.approvals.error 里体现 */ });
  }, delay);
}

let skillProposalsTimer = null;

/* room.<id>.skill_proposed：只在「技能提案」面板打开时防抖刷新；
 * 面板没开就丢弃事件，别为后台房间白打接口。 */
function scheduleSkillProposalsRefresh(delay = 400) {
  clearTimeout(skillProposalsTimer);
  skillProposalsTimer = setTimeout(() => {
    skillProposalsTimer = null;
    refreshSkillProposals().catch(() => { /* 失败已记在 state.skillProposals.error */ });
  }, delay);
}

function connectEvents() {
  if (eventSource) return;
  state.connecting = true;
  emit();
  eventSource = openEventStream({
    onOpen: () => {
      state.connected = true;
      state.connecting = false;
      state.error = "";
      // 断线期间可能有人裁决过审批：重连时补一次拉取（首连由 boot() 负责）。
      if (everConnected) scheduleApprovalsRefresh(60);
      everConnected = true;
      emit();
    },
    onError: () => {
      state.connected = false;
      state.connecting = true;
      emit();
    },
    onEvent: (evt) => {
      try {
        applyEvent(evt);
      } catch (err) {
        console.error("[store] event apply failed", evt.topic, err);
      }
    },
  });
}

export function applyEvent(evt) {
  const { topic, payload } = evt;
  let changed = false;

  // room.<id>.skill_proposed —— 学习闭环新提案：面板开着才刷新，且落在 room
  // 分支之前处理（房间可能还没加载，事件仍然应当被消费掉）。
  if (/^room\.[^.]+\.skill_proposed$/.test(topic)) {
    if (state.skillProposals?.open) scheduleSkillProposalsRefresh(400);
    return;
  }

  // room.<id>.<kind>
  const roomMatch = topic.match(/^room\.([^.]+)\.([a-zA-Z_]+)$/);
  if (roomMatch) {
    const [, roomId, kind] = roomMatch;
    const room = state.roomById[roomId];
    const act = state.activity[roomId] || (state.activity[roomId] = newActivity());
    if (room) {
      switch (kind) {
        case "turn_completed": {
          const speaker = payload?.speaker || payload?.member;
          if (speaker) {
            const body = String(payload?.content ?? "");
            const stamp = payload?.timestamp || new Date().toISOString();
            if (String(speaker) === "user") {
              // Reconcile the optimistic bubble instead of duplicating it.
              const list = state.messages[roomId] || [];
              const pending = [...list].reverse().find((m) => m.type === "msg" && m.pending && m.content === body);
              if (pending) {
                pending.pending = false;
                pending.ts = stamp;
                changed = true;
                break;
              }
            }
            const msg = {
              id: uid("m"), type: "msg", speaker: String(speaker), content: body, ts: stamp,
              messageSeq: Number(payload?.seq) || null,
              evidence: normalizeEvidenceStatus(payload?.evidence),
            };
            changed = appendRoomEvent(roomId, msg) || changed;
            act.typing.delete(speaker);
            act.tools.delete(speaker);
            if (speaker !== "user") bumpUnread(roomId);
            lastMessageCache[roomId] = body;
            // 成员回合刚落库一条证据记录：合并刷新本群汇总（防抖，不打断渲染）。
            if (String(speaker) !== "user" && payload?.evidence) scheduleEvidenceRefresh(roomId);
          }
          break;
        }
        case "round_started": {
          act.round = true;
          changed = true;
          break;
        }
        case "round_completed": {
          act.round = false;
          act.typing.clear();
          act.tools.clear();
          changed = true;
          refreshRooms().catch(() => {});
          refreshContext();
          break;
        }
        case "member_started": {
          if (payload?.member) act.typing.add(payload.member);
          act.round = true;
          changed = true;
          break;
        }
        case "member_finished": {
          if (payload?.member) { act.typing.delete(payload.member); act.tools.delete(payload.member); }
          changed = true;
          break;
        }
        case "task_assigned": {
          const member = payload?.member || payload?.bot_id || payload?.assignee;
          if (!member) break;
          changed = appendRoomEvent(roomId, {
            id: uid("a"), type: "assign", member: String(member),
            task: String(payload?.task || payload?.instruction || ""),
            ts: new Date().toISOString(),
          }) || changed;
          break;
        }
        case "file_saved": {
          const fileId = payload?.file_id || payload?.fileId;
          if (!fileId) break;
          changed = appendRoomEvent(roomId, {
            id: uid("f"), type: "file", fileId: String(fileId), path: payload?.path,
            description: payload?.description, ts: new Date().toISOString(),
          }) || changed;
          refreshFiles(roomId).catch(() => {});
          break;
        }
        case "file_moved": {
          const fileId = payload?.file_id || payload?.fileId;
          if (!fileId) break;
          changed = appendRoomEvent(roomId, {
            id: uid("fm"), type: "file_moved", fileId: String(fileId),
            oldPath: payload?.old_path || payload?.from, newPath: payload?.new_path || payload?.to,
            ts: new Date().toISOString(),
          }) || changed;
          refreshFiles(roomId).catch(() => {});
          break;
        }
        case "permission_changed": {
          const member = payload?.member || payload?.bot_id;
          if (member) {
            room.member_permissions = room.member_permissions || {};
            room.member_permissions[member] = payload?.permissions || payload?.patch || room.member_permissions[member];
            changed = true;
          }
          break;
        }
        case "context_policy_changed": {
          if (room && payload?.policy) { room.context_policy = payload.policy; changed = true; }
          break;
        }
        case "subgroup_report": {
          changed = appendRoomEvent(roomId, {
            id: uid("sg"), type: "subgroup",
            subRoomId: payload?.sub_room_id || payload?.child_room_id || payload?.room_id,
            topic: payload?.topic || payload?.title,
            report: payload?.report ?? payload?.summary ?? payload?.content ?? "",
            ts: new Date().toISOString(),
          }) || changed;
          refreshRooms().catch(() => {});
          break;
        }
        case "updated": {
          const patch = payload && typeof payload === "object" ? payload : {};
          const merged = normalizeRoom({ ...room, ...patch, room_id: roomId });
          if (merged) {
            state.roomById[roomId] = merged;
            const idx = state.rooms.findIndex((r) => r.room_id === roomId);
            if (idx >= 0) state.rooms[idx] = merged;
            else state.rooms = sortedRooms([...state.rooms, merged]);
            changed = true;
          }
          break;
        }
        case "circuit_breaker_tripped": {
          act.round = false;
          changed = appendRoomEvent(roomId, {
            id: uid("cb"), type: "notice",
            content: "本轮发言达到上限，房间已暂停。发送新消息可继续。",
            ts: new Date().toISOString(),
          }) || changed;
          break;
        }
        case "circuit_breaker_reset": {
          act.round = false;
          changed = true;
          break;
        }
      }
    }
    if (changed) { markRoomUpdated(roomId); emit(); }
    return;
  }

  // worker.<bot>.approval_requested / approval_resolved —— 只触发防抖刷新，
  // 具体行与徽标数字以服务端为准（多端同时打开时也保持一致）。
  const approvalMatch = topic.match(/^(?:worker|agent)\.[^.]+\.(approval_requested|approval_resolved)$/);
  if (approvalMatch) {
    scheduleApprovalsRefresh(approvalMatch[1] === "approval_resolved" ? 120 : 250);
    return;
  }

  // worker.<bot>.turn_started / agent.<bot>.tool_invoked
  const agentMatch = topic.match(/^(?:worker|agent)\.([^.]+)\.(turn_started|turn_completed|tool_invoked|tool_result|state_changed)$/);
  if (agentMatch) {
    const [, botId, kind] = agentMatch;
    for (const roomId of activeRoomIdsFor(botId)) {
      const act = state.activity[roomId];
      if (!act) continue;
      if (kind === "turn_started") act.typing.add(botId);
      if (kind === "turn_completed") { act.typing.delete(botId); act.tools.delete(botId); }
      if (kind === "tool_invoked") act.tools.set(botId, { name: payload?.tool || "tool", args: payload?.args || {}, ts: Date.now() });
      if (kind === "tool_result") act.tools.delete(botId);
      changed = true;
    }
    const bot = state.botsById[botId];
    if (bot) {
      bot.state = kind === "turn_started" ? "working" : (kind === "turn_completed" ? "idle" : bot.state);
    }
    if (state.chief.active) {
      if (kind === "tool_invoked") {
        state.chief.tools.push({ name: payload?.tool, args: payload?.args, ts: Date.now() });
        state.chief.tools = state.chief.tools.slice(-8);
        changed = true;
      }
    }
    if (changed) emit();
    return;
  }

  switch (topic) {
    case "router.goal_received": {
      state.chief.active = true;
      state.chief.plan = null;
      state.chief.streamText = "";
      changed = true;
      break;
    }
    case "router.plan_decomposed": {
      state.chief.plan = {
        goal: payload?.goal || "",
        subtasks: (payload?.subtasks || []).map((s) => ({ ...s, status: "pending" })),
        startedAt: Date.now(),
      };
      changed = true;
      break;
    }
    case "router.subtask.dispatched": {
      updatePlanStep(payload?.subtask_id, "active");
      changed = true;
      break;
    }
    case "router.subtask.completed": {
      updatePlanStep(payload?.subtask_id, "done");
      changed = true;
      break;
    }
    case "router.subtask.failed": {
      updatePlanStep(payload?.subtask_id, "failed");
      changed = true;
      break;
    }
    case "router.synthesis_delta": {
      state.chief.active = true;
      state.chief.streamText += String(payload?.delta || "");
      changed = true;
      break;
    }
    case "router.synthesis_completed": {
      const summary = String(payload?.summary || "");
      const text = state.chief.streamText || summary;
      if (text) {
        state.chief.messages.push({
          id: uid("c"), type: "msg", speaker: "ChiefRouter", content: text, ts: new Date().toISOString(),
        });
      }
      state.chief.active = false;
      state.chief.streamText = "";
      state.chief.plan = null;
      state.chief.tools = [];
      changed = true;
      refreshContext();
      break;
    }
    case "harness.task.completed":
    case "harness.task.failed":
    case "harness.task.rejected": {
      state.chief.active = false;
      refreshContext();
      changed = true;
      break;
    }
    case "context.stats.updated": {
      if (payload) { state.context = { ...(state.context || {}), ...payload }; changed = true; }
      break;
    }
    case "harness.room.created": {
      refreshRooms().catch(() => {});
      break;
    }
  }

  if (changed) emit();
}

const lastMessageCache = {};

function markRoomUpdated(roomId) {
  const room = state.roomById[roomId];
  if (!room) return;
  room.updated_at = new Date().toISOString();
  const idx = state.rooms.findIndex((r) => r.room_id === roomId);
  if (idx >= 0) state.rooms[idx] = room;
  else state.rooms = sortedRooms([...state.rooms, room]);
}

function activeRoomIdsFor(botId) {
  const ids = [];
  for (const room of state.rooms) {
    if ((room.members || []).includes(botId)) {
      const act = state.activity[room.room_id];
      if (act && (act.round || act.typing.has(botId))) ids.push(room.room_id);
    }
  }
  return ids;
}

function updatePlanStep(subtaskId, status) {
  if (!state.chief.plan || !subtaskId) return;
  const step = state.chief.plan.subtasks.find((s) => s.id === subtaskId);
  if (step) step.status = status;
}

export function roomLastPreview(roomId) {
  if (lastMessageCache[roomId]) {
    return String(lastMessageCache[roomId]).replace(/\s+/g, " ").slice(0, 60);
  }
  const list = state.messages[roomId] || [];
  const msg = [...list].reverse().find((m) => m.type === "msg" && m.speaker !== "user");
  return msg ? String(msg.content).replace(/\s+/g, " ").slice(0, 60) : "";
}

export function activeMembers(roomId) {
  const act = state.activity[roomId];
  if (!act) return [];
  const ids = new Set([...act.typing.keys(), ...act.tools.keys()]);
  return Array.from(ids).map((id) => ({
    id,
    tool: act.tools.get(id)?.name || null,
  }));
}

export function profileOf(botId) {
  return profileFor(botId, state.botsById[botId]);
}

/* Emoji/badge/tagline for a member, using backend bot records with local
 * archetype fallbacks (backend buildBot sends emoji + badge + tagline). */
export function memberIdentity(botId) {
  const bot = state.botsById[botId] || {};
  const p = profileOf(botId);
  return {
    id: botId,
    name: p.name,
    role: p.role,
    emoji: bot.emoji || p.emoji || "",
    badge: bot.badge || p.badge || "",
    tagline: bot.tagline || p.tagline || "",
    color: bot.color || p.color || "var(--text-2)",
  };
}

export function roomTitle(room) {
  if (!room) return "群聊";
  return room.title || `群聊 ${room.room_id}`;
}

export function childRooms(roomId) {
  return state.rooms.filter((r) => r.parent_room_id === roomId);
}
