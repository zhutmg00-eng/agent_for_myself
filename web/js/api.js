/* Thin API client for the local AgentFusion server (pi kernel).
 *
 * Contract: fusion/docs/CONTRACT_API.md (HTTP + SSE) and FUSION_SPEC.md §7
 * (event topics). Everything here is plain fetch/EventSource — no build step,
 * no framework, no external CDN.
 */

const BASE = "";

async function request(path, { method = "GET", body, timeout = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const message = (data && (data.error || data.detail)) || `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("请求超时，请检查本地服务是否仍在运行");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ shapes */

/* New server: {status:"ok", service, version, kernel, kernel_version, model,
 *              data_root, gateway_url, gateway:{ok,url,models,error}, ...}
 * Old server: {status:"ok", model, workspace_root, gateway_url}.
 * Normalise both into one object the views can trust; never throw on a
 * missing field (the UI degrades to "未知"). */
export function normalizeHealth(raw) {
  const h = raw && typeof raw === "object" ? raw : {};
  const gateway = h.gateway && typeof h.gateway === "object" ? h.gateway : {};
  const ok = h.status === "ok" || h.ok === true || h.status === undefined;
  return {
    ok,
    status: h.status || (ok ? "ok" : "error"),
    service: h.service || "AgentFusion",
    version: h.version || "",
    kernel: h.kernel || h.kernel_name || "pi",
    kernel_version: h.kernel_version || h.kernelVersion || "1.3.0",
    model: h.model || h.current_model || "",
    default_model: h.default_model || h.model || "",
    workspace_root: h.workspace_root || "",
    data_root: h.data_root || h.workspace_root || "",
    gateway_url: h.gateway_url || gateway.url || "",
    gateway_ok: typeof gateway.ok === "boolean" ? gateway.ok : Boolean(h.gateway_url),
    gateway_models: Number(gateway.models || 0),
    gateway_error: gateway.error || null,
    rooms: Number(h.rooms || 0),
    bots: Number(h.bots || 0),
    sse_clients: Number(h.sse_clients || 0),
    uptime_ms: Number(h.uptime_ms || 0),
    raw: h,
  };
}

/* New server: {object:"list", data:[...], current_model, gateway_url, is_fallback}
 * Accepts a bare array or {models:[...]} too. */
export function normalizeModels(payload) {
  let list = [];
  if (Array.isArray(payload)) list = payload;
  else if (payload && Array.isArray(payload.data)) list = payload.data;
  else if (payload && Array.isArray(payload.models)) list = payload.models;
  return list
    .map((m) => {
      if (typeof m === "string") return { id: m, display_name: m, owned_by: "" };
      if (!m || typeof m !== "object") return null;
      const id = String(m.id || m.name || m.model || "");
      if (!id) return null;
      return {
        ...m,
        id,
        display_name: m.display_name || m.displayName || m.label || id,
        owned_by: m.owned_by || m.owner || "",
        context_length: m.context_length || m.contextLength || null,
      };
    })
    .filter(Boolean);
}

/* Approval request row (GET /api/approvals). The server already maps
 * input_json -> input, but a hand-inserted row or an older build may not, so
 * parse defensively and never let a missing field crash the panel. */
export function normalizeApproval(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.request_id || "");
  if (!id) return null;
  let input = raw.input;
  if (!input || typeof input !== "object") {
    input = {};
    if (typeof raw.input_json === "string" && raw.input_json) {
      try { input = JSON.parse(raw.input_json); } catch { input = {}; }
    }
  }
  return {
    ...raw,
    id,
    tool: String(raw.tool || ""),
    input,
    room_id: String(raw.room_id || ""),
    bot_id: String(raw.bot_id || ""),
    pattern_key: String(raw.pattern_key || ""),
    reason: String(raw.reason || ""),
    status: String(raw.status || "pending"),
    created_at: raw.created_at || null,
    expires_at: raw.expires_at || null,
    ttl_ms: Number(raw.ttl_ms || 0),
  };
}

/* appr_audit row: {id, ts, decision, tool, scope, by, mode, reason, room_id, bot_id, request_id} */
export function normalizeApprovalAudit(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    id: raw.id ?? null,
    ts: raw.ts || null,
    decision: String(raw.decision || ""),
    scope: String(raw.scope || ""),
    by: String(raw.by || ""),
    tool: String(raw.tool || ""),
    mode: String(raw.mode || ""),
    reason: String(raw.reason || ""),
    room_id: String(raw.room_id || ""),
    bot_id: String(raw.bot_id || ""),
  };
}

/* --------------------------------------------------------------------- api */

export const api = {
  /* health — returns a normalised object (see normalizeHealth) */
  health: async () => normalizeHealth(await request("/api/health", { timeout: 4000 })),

  bots: () => request("/api/bots"),
  updateBot: (id, payload) => request(`/api/bots/${encodeURIComponent(id)}`, { method: "PUT", body: payload }),

  avatars: () => request("/api/avatars"),
  uploadAvatar: (kind, id, data) => request(`/api/avatars/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: "POST", body: { data } }),
  deleteAvatar: (kind, id) => request(`/api/avatars/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  avatarUrl: (kind, id, version) => `/api/avatars/${encodeURIComponent(kind)}/${encodeURIComponent(id)}${version ? `?v=${version}` : ""}`,

  rooms: () => request("/api/rooms"),
  room: (id) => request(`/api/rooms/${encodeURIComponent(id)}`),
  messages: (id, limit = 500, afterSeq = 0) =>
    request(`/api/rooms/${encodeURIComponent(id)}/messages?after_seq=${afterSeq}&limit=${limit}`),
  roomEvents: (id, afterSeq = 0, limit = 2000) =>
    request(`/api/thread/${encodeURIComponent(`room:${id}`)}/events?after_seq=${afterSeq}&limit=${limit}`),
  files: (id) => request(`/api/rooms/${encodeURIComponent(id)}/files`),
  filePreview: (roomId, fileId) => request(`/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}`),
  createRoom: (payload) => request("/api/rooms", { method: "POST", body: payload }),
  updateRoom: (id, payload) => request(`/api/rooms/${encodeURIComponent(id)}`, { method: "PUT", body: payload }),
  say: (id, content) => request(`/api/rooms/${encodeURIComponent(id)}/say`, { method: "POST", body: { content }, timeout: 60000 }),

  settings: () => request("/api/settings"),
  updateSettings: (payload) => request("/api/settings", { method: "PUT", body: payload }),

  /* models — normalised array under .data, plus raw metadata kept alongside */
  models: async () => {
    const raw = await request("/api/models", { timeout: 8000 });
    const data = normalizeModels(raw);
    return {
      object: "list",
      data,
      models: data,
      current_model: (raw && raw.current_model) || "",
      gateway_url: (raw && raw.gateway_url) || "",
      is_fallback: Boolean(raw && raw.is_fallback),
      raw,
    };
  },

  skills: () => request("/api/skills"),
  hooks: () => request("/api/hooks"),
  reloadHooks: () => request("/api/hooks/reload", { method: "POST", body: {} }),

  /* 审批（Hermes 吸收层 E26）：列表/模式/裁决/审计。函数本体见文件末尾。 */
  approvals: fetchApprovals,
  resolveApproval,
  setApprovalMode,
  approvalAudit: fetchApprovalAudit,

  /* 证据阶梯（E29）：房间级三态汇总。函数本体见文件末尾。 */
  roomEvidence: fetchRoomEvidence,

  /* 技能学习闭环（E27）：提案列表/裁决/落盘，以及可选的技能用量。 */
  skillProposals: fetchSkillProposals,
  reviewSkillProposal,
  adoptSkillProposal,
  skillUsage: fetchSkillUsage,

  context: () => request("/api/context"),
  stats: () => request("/api/stats"),
  diagnostics: () => request("/api/diagnostics", { timeout: 8000 }),

  submitTask: (prompt) => request("/api/task", { method: "POST", body: { prompt } }),
  tickets: () => request("/api/tickets"),
  threads: () => request("/api/threads"),
  threadEvents: (threadId, afterSeq = 0, limit = 2000) =>
    request(`/api/thread/${encodeURIComponent(threadId)}/events?after_seq=${afterSeq}&limit=${limit}`),
};

/* --------------------------------------------------------------- approvals */
/* E26：GET /api/approvals → {approvals, mode, stats}
 * 状态默认只看 pending（server 的 /api/approvals 不带 status=all 就是 pending），
 * status:"all" 时才回放历史请求行。函数声明提升，供上面 api 对象直接引用。 */
export async function fetchApprovals({ roomId = "", botId = "", status = "", limit = 50 } = {}) {
  const qs = new URLSearchParams();
  if (roomId) qs.set("room_id", roomId);
  if (botId) qs.set("bot_id", botId);
  if (status) qs.set("status", status);
  if (limit) qs.set("limit", String(limit));
  const suffix = qs.toString() ? `?${qs}` : "";
  const raw = await request(`/api/approvals${suffix}`, { timeout: 8000 });
  const list = Array.isArray(raw?.approvals) ? raw.approvals : Array.isArray(raw) ? raw : [];
  return {
    approvals: list.map(normalizeApproval).filter(Boolean),
    mode: raw?.mode || "",
    stats: raw?.stats && typeof raw.stats === "object" ? raw.stats : {},
    raw,
  };
}

/* POST /api/approvals/{id} body {decision, scope, by, reason} → {ok, approval}
 * 已裁决/已过期时后端回 409 {ok:false, error:"already_resolved"}，这里原样抛出，
 * 由视图决定提示文案（不是网络错误）。 */
export function resolveApproval(id, body = {}) {
  const requestId = String(id || "").trim();
  if (!requestId) return Promise.reject(new Error("缺少审批 id"));
  const payload = {
    decision: body.decision,
    scope: body.scope || "once",
    by: body.by || "user",
  };
  if (body.reason) payload.reason = String(body.reason);
  return request(`/api/approvals/${encodeURIComponent(requestId)}`, { method: "POST", body: payload, timeout: 8000 });
}

/* PUT /api/approval/mode body {mode, room_id} → {ok, mode} */
export function setApprovalMode(mode, roomId = "") {
  const payload = { mode, by: "user" };
  if (roomId) payload.room_id = String(roomId);
  return request("/api/approval/mode", { method: "PUT", body: payload, timeout: 8000 });
}

/* GET /api/approvals/audit?limit= → {audit:[...]} */
export async function fetchApprovalAudit(limit = 10) {
  const raw = await request(`/api/approvals/audit?limit=${encodeURIComponent(Number(limit) || 10)}`, { timeout: 8000 });
  const list = Array.isArray(raw?.audit) ? raw.audit : Array.isArray(raw) ? raw : [];
  return list.map(normalizeApprovalAudit).filter(Boolean);
}

/* ---------------------------------------------------------------- evidence */
/* E29：GET /api/rooms/{id}/evidence → {room_id, summary, records}
 * summary 只报计数 {observed, prepared, mismatch, total}；total=0 是"暂无判定"，
 * 不是"0% 已观测"（口径见 docs/hermes/EVIDENCE.md §4）。records 里每条带
 * {message_seq, bot_id, status, claims, reasons, ts}，可用于 hover/详情。 */
export function normalizeEvidenceSummary(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const observed = Math.max(0, Number(s.observed || 0));
  const prepared = Math.max(0, Number(s.prepared || 0));
  const mismatch = Math.max(0, Number(s.mismatch || 0));
  return {
    observed,
    prepared,
    mismatch,
    total: Math.max(0, Number(s.total || observed + prepared + mismatch)),
  };
}

export async function fetchRoomEvidence(roomId) {
  const id = String(roomId || "").trim();
  if (!id) throw new Error("缺少群聊 id");
  const raw = await request(`/api/rooms/${encodeURIComponent(id)}/evidence`, { timeout: 8000 });
  return {
    room_id: raw?.room_id || id,
    summary: normalizeEvidenceSummary(raw?.summary),
    records: Array.isArray(raw?.records) ? raw.records : [],
  };
}

/* ---------------------------------------------------------- skill proposals */
/* E27 学习闭环：GET /api/skills/proposals → { proposals:[...], report:{...} }
 * 提案对象本身是 camelCase（src/skills/curator.js:107 toProposal），但 evidence
 * 数组元素仍是 snake_case（{room_id, round_id, file_ids}），这里统一成 UI 形状，
 * 同时容忍 fileIds / roomId 写法，避免后端字段微调就炸界面。 */
export function normalizeSkillProposal(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "");
  if (!id) return null;
  const evidenceRaw = Array.isArray(raw.evidence) ? raw.evidence : [];
  return {
    ...raw,
    id,
    title: String(raw.title || ""),
    body: String(raw.body || ""),
    evidence: evidenceRaw.map((item) => {
      const entry = item && typeof item === "object" ? item : {};
      const fileIds = Array.isArray(entry.file_ids)
        ? entry.file_ids
        : Array.isArray(entry.fileIds)
          ? entry.fileIds
          : [];
      return {
        room_id: String(entry.room_id || entry.roomId || ""),
        round_id: String(entry.round_id || entry.roundId || ""),
        file_ids: fileIds.map(String).filter(Boolean),
      };
    }),
    roomId: String(raw.roomId || raw.room_id || ""),
    botId: String(raw.botId || raw.bot_id || ""),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    status: String(raw.status || "proposed"),
    reason: raw.reason ? String(raw.reason) : "",
    reviewedBy: raw.reviewedBy ? String(raw.reviewedBy) : "",
    skill: raw.skill ? String(raw.skill) : "",
    guardVerdict: raw.guardVerdict ? String(raw.guardVerdict) : "",
    createdAt: raw.createdAt || raw.created_at || null,
    updatedAt: raw.updatedAt || raw.updated_at || null,
    reviewedAt: raw.reviewedAt || raw.reviewed_at || null,
    adoptedAt: raw.adoptedAt || raw.adopted_at || null,
  };
}

export async function fetchSkillProposals({ status = "", limit = 50 } = {}) {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (limit) qs.set("limit", String(limit));
  const suffix = qs.toString() ? `?${qs}` : "";
  const raw = await request(`/api/skills/proposals${suffix}`, { timeout: 8000 });
  const list = Array.isArray(raw?.proposals) ? raw.proposals : [];
  return {
    proposals: list.map(normalizeSkillProposal).filter(Boolean),
    report: raw?.report && typeof raw.report === "object" ? raw.report : {},
    raw,
  };
}

/* POST /api/skills/proposals/{id}/review {decision: adopt|reject|defer, reason, by}
 * 200 {ok, proposal}；409 {ok:false, error}（已 adopted / 未知裁决）。 */
export function reviewSkillProposal(id, body = {}) {
  const proposalId = String(id || "").trim();
  if (!proposalId) return Promise.reject(new Error("缺少提案 id"));
  const payload = { decision: body.decision, by: body.by || "user" };
  if (body.reason) payload.reason = String(body.reason);
  return request(`/api/skills/proposals/${encodeURIComponent(proposalId)}/review`, { method: "POST", body: payload, timeout: 8000 });
}

/* POST /api/skills/proposals/{id}/adopt {by}
 * 200 {ok, skill:{slug,...}, guard}；409 {ok:false, guard?} —— guard 阻断时
 * error 里带原因，guard.findings 里有逐条命中。 */
export function adoptSkillProposal(id, body = {}) {
  const proposalId = String(id || "").trim();
  if (!proposalId) return Promise.reject(new Error("缺少提案 id"));
  return request(`/api/skills/proposals/${encodeURIComponent(proposalId)}/adopt`, {
    method: "POST",
    body: { by: body.by || "user" },
    timeout: 10000,
  });
}

/* GET /api/skills/usage?days=30 → {usage:[{skill,views,invokes,errors,lastUsed,score,status}]} */
export async function fetchSkillUsage(days = 30) {
  const raw = await request(`/api/skills/usage?days=${encodeURIComponent(Number(days) || 30)}`, { timeout: 8000 });
  return Array.isArray(raw?.usage) ? raw.usage : [];
}

/* Optional endpoints: the server may legitimately 404 one of these (grayed
 * feature); boot() uses Promise.allSettled, this helper is for one-off calls
 * where a missing endpoint must not surface as an error. */
export async function optional(promise, fallback = null) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

/* --------------------------------------------------------------------- SSE */

export function openEventStream(handlers = {}) {
  const { onEvent, onOpen, onError, onStatus } = handlers;
  let source = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    source = new EventSource("/api/events");
    source.onopen = () => {
      if (onStatus) onStatus("connected");
      if (onOpen) onOpen();
    };
    source.onerror = () => {
      if (onStatus) onStatus("connecting");
      if (onError) onError();
    };
    source.onmessage = (msg) => {
      if (!msg.data) return;
      try {
        const evt = JSON.parse(msg.data);
        if (evt && evt.topic && onEvent) onEvent(evt);
      } catch {
        /* ignore malformed frames */
      }
    };
  };

  connect();
  return {
    close() {
      closed = true;
      if (source) source.close();
    },
  };
}
