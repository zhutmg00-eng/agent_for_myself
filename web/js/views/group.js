/* Group chat — the flagship surface. */

import { api } from "../api.js";
import {
  state, subscribe, openRoom, sendRoomMessage, refreshFiles, updateRoomMeta,
  activeMembers, roomTitle, childRooms, profileOf, uploadAvatar, resetAvatar,
  memberIdentity, refreshEvidence, evidenceSummaryOf,
} from "../store.js";
import { avatar, groupAvatar, userAvatar, profileFor, escapeHtml, customAvatarUrl } from "../avatars.js";
import {
  ICONS, $, $$, toast, openModal, closeModal, formatTime, fileName, fileBadge,
  scrollToBottom, isNearBottom, escapeAttr, pickAvatarFile, fileToAvatarDataUrl,
} from "../ui.js";
import { renderMarkdown } from "../markdown.js";

const POLICY_LABEL = { shared: "共享全文", summary: "仅摘要", isolated: "各自独立" };
const POLICY_HINT = {
  shared: "所有成员都能看到完整群聊记录。",
  summary: "成员只看到最近几条与摘要，节省上下文。",
  isolated: "成员互相看不到发言，只接收群主分派。",
};

const SUGGESTIONS = [
  { title: "让群主分派一个任务", body: "描述目标，Boss 拆解后分给合适的成员。" , prompt: "请群主分派：先了解这个目标，再拆成可执行的任务分给合适的成员。目标：" },
  { title: "让文件管家归档", body: "成员产出统一存进群文件空间，用 file_id 引用。" , prompt: "请文件管家说明群文件空间怎么用，并演示归档一份说明。" },
  { title: "让团队互相评审", body: "一个成员产出，另一个成员复核，群主汇总。" , prompt: "请群主安排：coder 出一份方案，reviewer 复核并指出问题，最后群主汇总。" },
  { title: "拉一个小组讨论", body: "只邀请相关成员，在子群里讨论后回报结论。" , prompt: "请群主拉一个小群，只让 coder 和 reviewer 讨论当前任务的实现方案，结论回报本群。" },
];

/* 证据阶梯三态的界面口径，与 src/rooms/evidence.js:23 的 EVIDENCE_LABELS /
 * docs/hermes/EVIDENCE.md §3 的判定表一致；web 端不能 import 服务端模块，故此处
 * 只做展示映射，判定永远由后端给（前端不改判）。 */
const EVIDENCE_META = {
  observed: {
    label: "已观测",
    hint: "本回合至少有一次工具调用成功（ok:true），文本里的操作/产物有执行结果佐证",
  },
  prepared: {
    label: "仅声明",
    hint: "本回合没有成功的工具调用，内容只是成员的说法（讨论、建议也会落在这一态），没有可核对的操作记录",
  },
  mismatch: {
    label: "证据不符",
    hint: "声明与工具记录冲突：点名了不存在的 file_id，或声称已保存/已读取但对应工具没有成功（优先级最高）",
  },
};

/* 原因码 -> 中文（src/rooms/evidence.js:54-71 的 codes）；未收录的原样显示。 */
const EVIDENCE_REASONS = {
  claim_save_without_successful_room_file_save: "声称已保存，但没有成功的 room_file_save",
  claim_save_but_room_file_save_failed: "声称已保存，但 room_file_save 调用失败",
  claim_read_but_room_file_read_failed: "声称已读取，但 room_file_read 调用失败",
  no_tool_calls: "本回合没有工具调用",
  no_successful_tool_call: "本回合没有成功的工具调用",
};

function evidenceReasonLabel(code) {
  const value = String(code || "");
  if (!value) return "";
  if (EVIDENCE_REASONS[value]) return EVIDENCE_REASONS[value];
  if (value.startsWith("unknown_file_id:")) return `声明了不存在的 file_id ${value.slice("unknown_file_id:".length)}`;
  if (value.startsWith("tool_failed:")) return `工具失败：${value.slice("tool_failed:".length)}`;
  if (value.startsWith("tool_ok:")) return `工具成功：${value.slice("tool_ok:".length)}`;
  return value;
}

function evidenceBadgeTitle(status, item, roomId) {
  const meta = EVIDENCE_META[status];
  if (!meta) return "";
  let title = `证据：${meta.label} · ${meta.hint}`;
  if (status === "mismatch") {
    const record = (state.evidence?.[roomId]?.records || [])
      .find((r) => Number(r.message_seq) === Number(item?.messageSeq));
    const reason = evidenceReasonLabel(record?.reasons?.[0]);
    if (reason) title += `。本回合判定：${reason}`;
  }
  return title;
}

/* 消息元信息里的三态徽标；null / 未知状态不渲染。 */
function evidenceBadgeHTML(status, item, roomId) {
  const meta = EVIDENCE_META[status];
  if (!meta) return "";
  return `<span class="ev-badge is-${status}" title="${escapeAttr(evidenceBadgeTitle(status, item, roomId))}">${meta.label}</span>`;
}

/* 群聊头里的汇总：只显示非 0 项；total=0 时调用方不渲染（"暂无判定"不是 0%）。 */
function evidenceSummaryHTML(summary) {
  if (!summary || !Number(summary.total)) return "";
  const parts = [
    ["observed", summary.observed],
    ["prepared", summary.prepared],
    ["mismatch", summary.mismatch],
  ].filter(([, count]) => Number(count) > 0);
  const title = `本群证据汇总（E29）：${Number(summary.observed)} 条已观测 · ${Number(summary.prepared)} 条仅声明 · ${Number(summary.mismatch)} 条证据不符`;
  return `<span class="ev-summary" title="${escapeAttr(title)}">${parts.map(([key, count]) => `<span class="ev-chip is-${key}"><span class="ev-dot"></span>${Number(count)} ${EVIDENCE_META[key].label}</span>`).join("")}</span>`;
}

export class GroupView {
  constructor(root) {
    this.root = root;
    this.roomId = null;
    this.unsub = null;
    this.mentionIndex = 0;
    this.mentionMatches = [];
  }

  mount(roomId) {
    this.roomId = roomId;
    this.root.innerHTML = `
      <div class="view-head" id="g-head"></div>
      <div class="chat-body" id="g-scroll"><div class="chat-inner" id="g-inner"></div></div>
      <div class="composer-wrap">
        <div class="composer-inner" id="g-composer-inner">
          <div class="composer">
            <textarea id="g-input" rows="1" aria-label="群聊消息" placeholder="给群主下达任务，或 @成员 直接对话"></textarea>
            <div class="composer-bar">
              <button class="composer-plus" id="g-plus" title="可用工具" aria-label="提示">${ICONS.spark}</button>
              <span class="composer-hint"><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · 输入 <b>@</b> 提及成员</span>
              <span class="composer-model">${escapeHtml(modelShort())}</span>
              <button class="send-btn" id="g-send" title="发送" aria-label="发送">${ICONS.send}</button>
            </div>
          </div>
          <div class="mention-pop" id="g-mentions" hidden></div>
          <div class="composer-menu" id="g-menu" hidden>
            <button data-menu="mention">${ICONS.users}<span>提及成员</span><small>@</small></button>
            <button data-menu="files">${ICONS.folder}<span>群文件空间</span><small>${(state.files[this.roomId] || []).length}</small></button>
            <button data-menu="settings">${ICONS.settings}<span>群资料与权限</span></button>
          </div>
        </div>
      </div>`;
    this.el = {
      head: $("#g-head", this.root),
      scroll: $("#g-scroll", this.root),
      inner: $("#g-inner", this.root),
      input: $("#g-input", this.root),
      send: $("#g-send", this.root),
      plus: $("#g-plus", this.root),
      mentions: $("#g-mentions", this.root),
      menu: $("#g-menu", this.root),
      composerInner: $("#g-composer-inner", this.root),
    };
    this.bind();
    this.update(true);
    if (this.unsub) this.unsub();
    this.unsub = subscribe(() => this.update());
    loadRoomQuiet(this.roomId);
    // 进房补一次证据汇总（有缓存时秒回；失败静默，不影响群聊渲染）。
    refreshEvidence(this.roomId).catch(() => {});
  }

  destroy() {
    if (this.unsub) this.unsub();
    this.unsub = null;
    if (this.onDocMouseDown) document.removeEventListener("mousedown", this.onDocMouseDown);
  }

  bind() {
    const { input, send, plus } = this.el;
    const autosize = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
      send.disabled = !input.value.trim();
    };
    input.addEventListener("input", () => { autosize(); this.updateMentions(); });
    input.addEventListener("keydown", (ev) => {
      if (this.handleMentionKey(ev)) return;
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.submit();
      }
    });
    input.addEventListener("blur", () => setTimeout(() => { this.el.mentions.hidden = true; }, 120));
    send.addEventListener("click", () => this.submit());
    plus.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const fileCount = (state.files[this.roomId] || []).length
        || state.roomById[this.roomId]?.file_count || 0;
      const fileBadgeEl = this.el.menu.querySelector('[data-menu="files"] small');
      if (fileBadgeEl) fileBadgeEl.textContent = String(fileCount);
      this.el.menu.hidden = !this.el.menu.hidden;
      this.el.mentions.hidden = true;
    });
    this.el.menu.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-menu]");
      if (!btn) return;
      this.el.menu.hidden = true;
      if (btn.dataset.menu === "mention") {
        this.el.input.value += this.el.input.value.endsWith(" ") || !this.el.input.value ? "@" : " @";
        this.el.input.focus();
        this.el.input.dispatchEvent(new Event("input"));
      } else if (btn.dataset.menu === "files") {
        state.inspector = { type: "group", id: this.roomId, tab: "files" };
        document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
      } else if (btn.dataset.menu === "settings") {
        openGroupEditor(this.roomId, () => this.update(true));
      }
    });
    this.onDocMouseDown = (ev) => {
      if (!this.el.menu.hidden && !this.el.composerInner.contains(ev.target)) this.el.menu.hidden = true;
    };
    document.addEventListener("mousedown", this.onDocMouseDown);
    this.el.scroll.addEventListener("scroll", () => { this.userScrolled = true; });
  }

  async submit() {
    const text = this.el.input.value.trim();
    if (!text) return;
    this.el.input.value = "";
    this.el.input.style.height = "auto";
    this.el.send.disabled = true;
    this.el.mentions.hidden = true;
    this.userScrolled = false;
    try {
      await sendRoomMessage(this.roomId, text);
    } catch (err) {
      toast(`发送失败：${err.message}`, "error");
      this.el.input.value = text;
    }
  }

  updateMentions() {
    const value = this.el.input.value;
    const caret = this.el.input.selectionStart || value.length;
    const before = value.slice(0, caret);
    const match = before.match(/@([A-Za-z0-9_\-]*)$/);
    const room = state.roomById[this.roomId];
    if (!match || !room) { this.el.mentions.hidden = true; return; }
    const q = match[1].toLowerCase();
    const members = (room.members || []).filter((m) => m.toLowerCase().includes(q));
    if (!members.length) { this.el.mentions.hidden = true; return; }
    this.mentionMatches = members;
    this.mentionIndex = 0;
    this.el.mentions.innerHTML = members.map((m, i) => {
      const p = profileOf(m);
      return `<button class="mention-item${i === 0 ? " is-active" : ""}" data-mention="${escapeAttr(m)}">
        ${avatar(m, 22)}<span>${escapeHtml(p.name)}</span><small>${escapeHtml(p.role)}</small>
      </button>`;
    }).join("");
    this.el.mentions.hidden = false;
    const rect = this.el.input.getBoundingClientRect();
    const parentRect = this.el.composerInner.getBoundingClientRect();
    this.el.mentions.style.left = "0";
    this.el.mentions.style.bottom = `${parentRect.bottom - rect.top + 8}px`;
    $$(".mention-item", this.el.mentions).forEach((btn) => {
      btn.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.insertMention(btn.dataset.mention);
      });
    });
  }

  handleMentionKey(ev) {
    if (this.el.mentions.hidden) return false;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const delta = ev.key === "ArrowDown" ? 1 : -1;
      this.mentionIndex = (this.mentionIndex + delta + this.mentionMatches.length) % this.mentionMatches.length;
      $$(".mention-item", this.el.mentions).forEach((el, i) => el.classList.toggle("is-active", i === this.mentionIndex));
      return true;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
      if (this.mentionMatches[this.mentionIndex]) {
        ev.preventDefault();
        this.insertMention(this.mentionMatches[this.mentionIndex]);
        return true;
      }
    }
    if (ev.key === "Escape") {
      this.el.mentions.hidden = true;
      return true;
    }
    return false;
  }

  insertMention(name) {
    const input = this.el.input;
    const value = input.value;
    const caret = input.selectionStart || value.length;
    const before = value.slice(0, caret).replace(/@([A-Za-z0-9_\-]*)$/, `@${name} `);
    input.value = before + value.slice(caret);
    input.focus();
    input.selectionStart = input.selectionEnd = before.length;
    this.el.mentions.hidden = true;
    input.dispatchEvent(new Event("input"));
  }

  update(force = false) {
    const room = state.roomById[this.roomId];
    if (!room) return;
    this.renderHead(room);
    this.renderTimeline(room);
    if ((force || !this.userScrolled) && this.el.scroll) {
      requestAnimationFrame(() => scrollToBottom(this.el.scroll));
      this.userScrolled = false;
    }
  }

  renderHead(room) {
    const owner = profileOf(room.owner_id);
    const files = state.files[this.roomId] || [];
    const fileCount = files.length || room.file_count || 0;
    const members = room.members || [];
    const m = memberIdentity(room.owner_id);
    this.el.head.className = "view-head has-roster";
    this.el.head.innerHTML = `
      ${groupAvatar(room, 34, state.botsById)}
      <div class="view-head-main">
        <div class="view-title">${m.emoji ? `<span class="crown" aria-hidden="true">${escapeHtml(m.emoji)}</span>` : ""}${escapeHtml(roomTitle(room))}
          <span class="tag">${escapeHtml(POLICY_LABEL[room.context_policy] || "共享全文")}</span>
        </div>
        <div class="view-sub">${members.length} 位成员 · 群主 ${escapeHtml(owner.name)} · ${escapeHtml(POLICY_LABEL[room.context_policy] || "共享全文")}${evidenceSummaryHTML(evidenceSummaryOf(this.roomId))}</div>
        <div class="member-chips" id="g-roster">
          ${members.map((id) => {
            const idn = memberIdentity(id);
            const isOwner = id === room.owner_id;
            return `<button class="mchip${isOwner ? " is-owner" : ""}" type="button" data-goto-member="${escapeAttr(id)}" title="${escapeAttr(`${idn.name} · ${idn.role} · ${idn.tagline}`)}">
              <span class="mchip-emoji" aria-hidden="true">${escapeHtml(idn.emoji || "•")}</span>
              <span>${escapeHtml(idn.name)}</span>
              <span class="mchip-badge">${isOwner ? "群主" : escapeHtml(idn.badge || idn.role)}</span>
            </button>`;
          }).join("")}
        </div>
      </div>
      <div class="head-actions">
        <button class="head-btn" id="g-files" title="群文件空间">${ICONS.folder}<span>群文件</span><span class="head-count">${fileCount}</span></button>
        <button class="head-btn icon-only${state.inspector?.type === "group" && state.inspector?.id === this.roomId ? " is-on" : ""}" id="g-info" title="群信息">${ICONS.users}</button>
      </div>`;
    $$("[data-goto-member]", this.el.head).forEach((btn) => {
      btn.onclick = () => {
        state.inspector = { type: "group", id: this.roomId, tab: "members", member: btn.dataset.gotoMember };
        document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
      };
    });
    $("#g-files", this.el.head).onclick = () => {
      state.inspector = { type: "group", id: this.roomId, tab: "files" };
      state.inspectorNonce = (state.inspectorNonce || 0) + 1;
      // notify app via custom event so it can render the inspector
      document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
    };
    $("#g-info", this.el.head).onclick = () => {
      const same = state.inspector?.type === "group" && state.inspector?.id === this.roomId;
      state.inspector = same ? null : { type: "group", id: this.roomId, tab: "members" };
      document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
    };
  }

  renderTimeline(room) {
    const list = state.messages[this.roomId] || [];
    const near = isNearBottom(this.el.scroll);
    if (!list.length && !activeMembers(this.roomId).length) {
      this.el.inner.className = "chat-inner is-empty";
      this.el.inner.innerHTML = this.welcomeHTML(room);
      this.bindWelcome(room);
      return;
    }
    this.el.inner.className = "chat-inner";
    const blocks = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item.type === "msg") {
        blocks.push(this.messageHTML(item, room));
      } else if (item.type === "assign") {
        const rows = [item];
        while (list[i + 1]?.type === "assign") rows.push(list[++i]);
        blocks.push(this.assignHTML(rows, room));
      } else if (item.type === "file") {
        const rows = [item];
        while (list[i + 1]?.type === "file") rows.push(list[++i]);
        blocks.push(this.fileCardHTML(rows));
      } else if (item.type === "file_moved") {
        blocks.push(`<div class="sysline">${ICONS.refresh}<span>文件 <b>${escapeHtml(fileName(item.newPath))}</b> 已移动，成员将按 file_id 自动使用新路径</span></div>`);
      } else if (item.type === "subgroup") {
        blocks.push(this.subgroupHTML(item));
      } else if (item.type === "notice") {
        blocks.push(`<div class="sysline">${ICONS.info}<span>${escapeHtml(item.content)}</span></div>`);
      }
    }
    const active = activeMembers(this.roomId);
    for (const member of active) {
      const p = profileOf(member.id);
      const label = member.tool ? `正在执行 ${member.tool}` : "正在思考";
      blocks.push(`<div class="typing-row">${avatar(member.id, 26)}<span style="color:${p.color};font-weight:500">${escapeHtml(p.name)}</span><span>${escapeHtml(label)}</span><span class="typing-dots"><i></i><i></i><i></i></span></div>`);
    }
    this.el.inner.innerHTML = blocks.join("");
    if (near) requestAnimationFrame(() => scrollToBottom(this.el.scroll));
    this.bindMessageActions();
  }

  welcomeHTML(room) {
    const members = room.members || [];
    return `
      <div class="welcome">
        ${groupAvatar(room, 68, state.botsById)}
        <h1>把任务交给团队</h1>
        <p>群主会先拆解目标，再分派给合适的成员。产出自动进入群文件空间，全程可回看。</p>
        <div class="suggest-grid">
          ${SUGGESTIONS.map((s, i) => `<button class="suggest-card" data-suggest="${i}"><b>${escapeHtml(s.title)}</b><span>${escapeHtml(s.body)}</span></button>`).join("")}
        </div>
        <p class="welcome-note">想换成自己的角色？在「群信息 → 更换头像」或「设置 → 机器人」上传图片即可。</p>
      </div>`;
  }

  bindWelcome(room) {
    $$("[data-suggest]", this.el.inner).forEach((btn) => {
      btn.onclick = () => {
        const s = SUGGESTIONS[Number(btn.dataset.suggest)];
        this.el.input.value = s.prompt;
        this.el.input.focus();
        this.el.input.dispatchEvent(new Event("input"));
      };
    });
  }

  messageHTML(item, room) {
    const isUser = item.speaker === "user";
    const p = profileOf(item.speaker);
    if (isUser) {
      const stateTag = item.failed
        ? `<span class="msg-time" style="color:var(--red)">发送失败</span>`
        : item.pending
          ? `<span class="msg-time">发送中<span class="typing-dots" style="margin-left:4px"><i></i><i></i><i></i></span></span>`
          : "";
      return `<div class="msg-row is-user${item.pending ? " is-pending" : ""}">
        <div class="msg-main">
          <div class="msg-head">${stateTag}<span class="msg-time">${formatTime(item.ts)}</span><span class="msg-name">你</span></div>
          <div class="bubble">${renderMarkdown(item.content)}</div>
        </div>
        <span class="msg-av">${userAvatar(28)}</span>
      </div>`;
    }
    if (String(item.speaker).startsWith("subgroup:")) {
      return `<div class="sysline">${ICONS.users}<span>子群讨论结论已回报</span></div>`;
    }
    const isError = /^Tool failure/i.test(item.content || "");
    return `<div class="msg-row is-bot">
      ${avatar(item.speaker, 30)}
      <div class="msg-main">
        <div class="msg-head">
          <span class="msg-name" style="color:${p.color}">${escapeHtml(p.name)}</span>
          <span class="msg-tag">${escapeHtml(p.role)}</span>
          ${evidenceBadgeHTML(item.evidence, item, room?.room_id || this.roomId)}
          <span class="msg-time">${formatTime(item.ts)}</span>
          <button class="msg-copy" type="button" title="复制内容" aria-label="复制内容">${ICONS.copy}</button>
        </div>
        <div class="bubble${isError ? " is-error" : ""}">${isError ? `${ICONS.info}<span>工具调用失败，已记录到运行日志。</span>` : renderMarkdown(item.content)}</div>
      </div>
    </div>`;
  }

  assignHTML(rows, room) {
    const ownerIdn = memberIdentity(room.owner_id);
    return `<div class="plan-card msg-card">
      <div class="msg-card-head">
        <span class="kicker">任务分派</span>
        <span class="spacer"></span>
        <span class="tag">${ownerIdn.emoji ? `${escapeHtml(ownerIdn.emoji)} ` : ""}${escapeHtml(ownerIdn.name)} 分派</span>
      </div>
      <div class="msg-card-body">
        ${rows.map((r) => {
          const idn = memberIdentity(r.member);
          const meta = [idn.role, idn.badge, idn.tagline].filter(Boolean).join(" · ");
          return `<div class="assign-row">
            <div class="assign-who">${avatar(r.member, 26)}<span>${escapeHtml(idn.name)}</span></div>
            <div class="assign-text">${escapeHtml(r.task || "")}<small>${escapeHtml(meta)} · 已进入本轮发言队列</small></div>
          </div>`;
        }).join("")}
      </div>
    </div>`;
  }

  fileCardHTML(rows) {
    return `<div class="plan-card msg-card">
      <div class="msg-card-head">
        <span class="kicker">群文件</span>
        <span class="spacer"></span>
        <span class="tag green">已归档</span>
      </div>
      <div class="msg-card-body">
        ${rows.map((r) => {
          const short = String(r.fileId || "").slice(0, 8);
          return `<div class="file-row" data-file="${escapeAttr(r.fileId || "")}" data-path="${escapeAttr(r.path || "")}">
          <span class="file-ico">${escapeHtml(fileBadge(r.path))}</span>
          <div class="file-copy">
            <div class="file-name">${escapeHtml(fileName(r.path))}
              <span class="file-id" title="file_id（文件移动后不变）">#${escapeHtml(short)}</span>
            </div>
            <div class="file-meta">${escapeHtml(r.description || "尚未添加说明")}</div>
            <div class="file-hint">${ICONS.refresh}<span>路径可能被移动 · 取文件请用 file_id</span></div>
          </div>
          <button class="file-open">查看</button>
        </div>`;
        }).join("")}
      </div>
    </div>`;
  }

  subgroupHTML(item) {
    const title = item.topic || "子群讨论";
    return `<div class="plan-card msg-card">
      <div class="msg-card-head">
        <span class="kicker">小群结论</span>
        <span class="spacer"></span>
        <span class="tag">${escapeHtml(item.subRoomId || "")}</span>
      </div>
      <div class="msg-card-body">
        <div class="subgroup-head">
          <span class="subgroup-topic">${escapeHtml(title)}</span>
          <span class="tag accent">已回报</span>
        </div>
        <div class="bubble" style="padding:0;background:transparent">${renderMarkdown(item.report || "")}</div>
        ${item.subRoomId ? `<div class="subgroup-actions"><button class="btn sm ghost" type="button" data-open-sub="${escapeAttr(item.subRoomId)}">进入小群 ${ICONS.arrowRight}</button></div>` : ""}
      </div>
    </div>`;
  }

  bindMessageActions() {
    $$("[data-file]", this.el.inner).forEach((row) => {
      row.onclick = () => openFilePreview(this.roomId, row.dataset.file, row.dataset.path);
    });
    $$("[data-open-sub]", this.el.inner).forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        openRoom(btn.dataset.openSub);
      };
    });
    $$(".msg-copy", this.el.inner).forEach((btn) => {
      btn.onclick = async () => {
        const bubble = btn.closest(".msg-main")?.querySelector(".bubble");
        if (!bubble) return;
        try {
          await navigator.clipboard.writeText(bubble.innerText);
          toast("已复制", "success");
        } catch {
          toast("复制失败，请手动选择文本", "error");
        }
      };
    });
  }
}

function modelShort() {
  const raw = state.settings?.model || state.health?.model || "";
  if (!raw) return "pi 内核 · 本地运行";
  return String(raw)
    .replace(/^(auto|magpie|workbuddy|openai|anthropic)\//i, "")
    .replace(/^deepseek-/, "DeepSeek ");
}

async function loadRoomQuiet(roomId) {
  if ((state.messages[roomId] || []).length) return;
  try {
    const { loadRoom } = await import("../store.js");
    await loadRoom(roomId);
  } catch (err) {
    toast(`加载群聊失败：${err.message}`, "error");
  }
}

/* ---------------------------------------------------------------- inspector */

export function groupInspectorHTML(roomId, tab = "members") {
  const room = state.roomById[roomId];
  if (!room) return `<div class="insp-body"><div class="empty-mini">群聊不存在</div></div>`;
  const members = room.members || [];
  const files = state.files[roomId] || [];
  const subs = childRooms(roomId);
  const isFiles = tab === "files";
  const body = isFiles
    ? filesTabHTML(roomId, files)
    : membersTabHTML(room, members);
  return `
    <div class="insp-head">
      <h2>群信息</h2>
      <button class="insp-close" data-insp-close aria-label="关闭">${ICONS.close}</button>
    </div>
    <div class="insp-body">
      <div class="group-hero">
        <div class="group-avatar-wrap">
          ${groupAvatar(room, 64, state.botsById)}
          <button class="avatar-edit-btn" data-group-avatar title="更换群头像" aria-label="更换群头像">${ICONS.camera}</button>
        </div>
        <h3>${escapeHtml(roomTitle(room))}</h3>
        <p>${members.length} 位成员 · 群主 ${escapeHtml(profileOf(room.owner_id).name)}</p>
        <button class="btn sm ghost" data-group-edit style="margin-top:8px">编辑群资料</button>
      </div>
      <div class="seg" role="tablist" style="margin-bottom:14px">
        <button data-tab="members" class="${!isFiles ? "is-on" : ""}">成员 ${members.length}</button>
        <button data-tab="files" class="${isFiles ? "is-on" : ""}">文件 ${files.length}</button>
      </div>
      ${body}
      ${evidenceSectionHTML(roomId)}
      ${subs.length ? `<div class="section-label">小群 <span class="count">${subs.length}</span></div>
        ${subs.map((s) => `<button class="file-item" data-open-room="${escapeAttr(s.room_id)}">
          <span class="file-ico" style="background:var(--surface-2);color:var(--text-2)">${ICONS.users}</span>
          <span class="file-copy"><span class="file-name">${escapeHtml(s.title || s.topic || s.room_id)}</span><span class="file-meta">${(s.members || []).length} 位成员 · 点击进入</span></span>
        </button>`).join("")}` : ""}
    </div>`;
}

function membersTabHTML(room, members) {
  const CONTEXT_LABEL = { full: "全文", summary: "摘要", none: "隔离" };
  const CONTEXT_HINT = {
    full: "看到完整群聊转录",
    summary: "只看到压缩摘要 + 近段",
    none: "只收到本轮任务与系统通知",
  };
  return `
    <div class="section-label">上下文共享 <span class="count">${escapeHtml(POLICY_LABEL[room.context_policy] || "")}</span></div>
    <div class="seg" data-policy>
      ${["shared", "summary", "isolated"].map((p) => `<button data-policy-val="${p}" class="${room.context_policy === p ? "is-on" : ""}">${POLICY_LABEL[p]}</button>`).join("")}
    </div>
    <div class="seg-hint">${POLICY_HINT[room.context_policy] || ""} 群主可随时调整；成员的「上下文」权限优先于房间策略。</div>
    <div class="section-label">成员 <span class="count">${members.length}</span></div>
    ${members.map((id) => {
      const idn = memberIdentity(id);
      const perm = room.member_permissions?.[id] || { can_speak: true, context_access: "full", can_create_subgroup: false };
      const isOwner = id === room.owner_id;
      return `<div class="member-row" data-member="${escapeAttr(id)}">
        ${avatar(id, 32)}
        <div class="member-copy">
          <div class="member-name">${escapeHtml(idn.name)}${isOwner ? `<span class="owner-star" title="群主 · 可发言/分派/授权">👑</span>` : ""}
            ${idn.badge && !isOwner ? `<span class="tag" style="height:15px;font-size:9.5px">${escapeHtml(idn.badge)}</span>` : ""}
          </div>
          <div class="member-role">${escapeHtml(isOwner ? "群主 · 分派任务 · 授权 · 决定共享范围" : `${idn.role} · ${idn.tagline}`)}</div>
        </div>
        <div class="member-tools">
          <button class="mini-toggle${perm.can_speak ? " is-on" : ""}" data-act="speak" title="${perm.can_speak ? "正在发言队列中（点击静音）" : "已静音（点击允许发言）"}">${perm.can_speak ? ICONS.sound : ICONS.mute}</button>
          <button class="mini-toggle text${perm.context_access === "full" ? " is-on" : ""}" data-act="context" title="上下文权限：${CONTEXT_LABEL[perm.context_access] || perm.context_access} · ${CONTEXT_HINT[perm.context_access] || ""}">${CONTEXT_LABEL[perm.context_access] || "全文"}</button>
          <button class="mini-toggle${perm.can_create_subgroup ? " is-on" : ""}" data-act="subgroup" title="${perm.can_create_subgroup ? "可以拉小群" : "不允许拉小群"}">${ICONS.usersPlus}</button>
        </div>
      </div>`;
    }).join("")}
  `;
}

/* 检查器里的证据阶梯汇总：来自 E29 summary；全 0 / 未加载 / 端点不可用时整段不渲染。 */
function evidenceSectionHTML(roomId) {
  const snapshot = state.evidence?.[roomId];
  const summary = snapshot?.summary;
  if (!summary || !Number(summary.total)) return "";
  const rows = [
    ["observed", "有成功的工具调用佐证"],
    ["prepared", "没有成功的工具调用，只是说法"],
    ["mismatch", "声明与工具记录冲突"],
  ];
  const mismatches = (snapshot.records || [])
    .filter((r) => r.status === "mismatch")
    .slice(-3)
    .reverse();
  return `
    <div class="section-label">证据阶梯 <span class="count">${Number(summary.total)} 条判定</span></div>
    <div class="ev-panel">
      ${rows.map(([status, desc]) => `<div class="ev-panel-row">
        <span class="ev-badge is-${status}">${EVIDENCE_META[status].label}</span>
        <span class="ev-panel-num">${Number(summary[status] || 0)}</span>
        <span class="ev-panel-desc">${desc}</span>
      </div>`).join("")}
      ${mismatches.length ? `<div class="ev-mismatch-list">
        <div class="ev-mismatch-head">最近的不符判定</div>
        ${mismatches.map((r) => `<div class="ev-mismatch-row">
          ${avatar(r.bot_id, 18)}
          <span class="ev-mismatch-who">${escapeHtml(profileOf(r.bot_id).name)} · #${Number(r.message_seq)}</span>
          <span class="ev-mismatch-why">${escapeHtml(evidenceReasonLabel(r.reasons?.[0]) || "声明与记录不一致")}</span>
        </div>`).join("")}
      </div>` : ""}
      <div class="ev-panel-hint">来自 E29（/api/rooms/{id}/evidence）。判定口径：有成功工具调用 → 已观测；点名不存在的 file_id、或声称已保存/已读取但工具没成功 → 证据不符；其余 → 仅声明。</div>
    </div>`;
}

function filesTabHTML(roomId, files) {
  if (!files.length) {
    return `<div class="empty-mini">群文件空间还是空的。让文件管家归档成员产出，文件会在这里出现，并按 file_id 全局同步。</div>`;
  }
  return files.map((f) => {
    const short = String(f.file_id || "").slice(0, 8);
    return `<div class="file-item" data-file-id="${escapeAttr(f.file_id)}" data-path="${escapeAttr(f.path)}">
    <span class="file-ico">${escapeHtml(fileBadge(f.path))}</span>
    <div class="file-copy">
      <div class="file-name">${escapeHtml(fileName(f.path))} <span class="file-id" title="file_id（移动后不变）">#${escapeHtml(short)}</span></div>
      <div class="file-meta">${escapeHtml(f.description || "未添加说明")}</div>
      <div class="file-hint">${ICONS.refresh}<span>移动只改路径，按 file_id 引用不会失效</span></div>
    </div>
  </div>`;
  }).join("");
}

export function bindGroupInspector(root, roomId, tab = "members", rerender) {
  const room = state.roomById[roomId];
  if (!room) return;
  // 打开检查器时顺手补一次证据汇总（有 15s 缓存，重复渲染不会打接口）。
  refreshEvidence(roomId).catch(() => {});
  $("[data-insp-close]", root)?.addEventListener("click", () => {
    state.inspector = null;
    document.dispatchEvent(new CustomEvent("ah:inspector", { detail: null }));
  });
  $("[data-group-avatar]", root)?.addEventListener("click", async () => {
    const file = await pickAvatarFile();
    if (!file) return;
    try {
      const data = await fileToAvatarDataUrl(file);
      await uploadAvatar("room", roomId, data);
      toast("群头像已更新", "success");
      rerender();
    } catch (err) { toast(`头像更新失败：${err.message}`, "error"); }
  });
  $("[data-group-edit]", root)?.addEventListener("click", () => openGroupEditor(roomId, rerender));
  $$("[data-tab]", root).forEach((btn) => {
    btn.addEventListener("click", () => {
      state.inspector = { type: "group", id: roomId, tab: btn.dataset.tab };
      document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
    });
  });
  $$("[data-policy-val]", root).forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await updateRoomMeta(roomId, { context_policy: btn.dataset.policyVal });
        toast(`上下文策略已切换为${POLICY_LABEL[btn.dataset.policyVal]}`);
        rerender();
      } catch (err) { toast(err.message, "error"); }
    });
  });
  $$("[data-member]", root).forEach((row) => {
    const memberId = row.dataset.member;
    $$("[data-act]", row).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const perm = { ...(room.member_permissions?.[memberId] || { can_speak: true, context_access: "full", can_create_subgroup: false }) };
        if (btn.dataset.act === "speak") perm.can_speak = !perm.can_speak;
        if (btn.dataset.act === "subgroup") perm.can_create_subgroup = !perm.can_create_subgroup;
        if (btn.dataset.act === "context") {
          perm.context_access = perm.context_access === "full" ? "summary" : perm.context_access === "summary" ? "none" : "full";
        }
        try {
          await updateRoomMeta(roomId, { member_permissions: { [memberId]: perm } });
          room.member_permissions = { ...(room.member_permissions || {}), [memberId]: perm };
          rerender();
        } catch (err) { toast(err.message, "error"); }
      });
    });
  });
  $$("[data-file-id]", root).forEach((el) => {
    el.addEventListener("click", () => openFilePreview(roomId, el.dataset.fileId, el.dataset.path));
  });
  $$("[data-open-room]", root).forEach((el) => {
    el.addEventListener("click", () => openRoom(el.dataset.openRoom));
  });
}

export function openGroupEditor(roomId, rerender) {
  const room = state.roomById[roomId];
  if (!room) return;
  openModal(`
    <div class="modal" role="dialog" aria-modal="true" style="width:min(480px,100%)">
      <div class="modal-head">
        <div><h2>群资料</h2><p>群名称和主题会展示在群聊头部。</p></div>
        <span class="spacer"></span>
        <button class="modal-close" data-close>${ICONS.close}</button>
      </div>
      <div class="modal-body">
        <div class="field"><label>群名称</label><input class="input" id="ge-title" maxlength="40" value="${escapeAttr(roomTitle(room))}"></div>
        <div class="field"><label>群主题</label><input class="input" id="ge-topic" maxlength="80" placeholder="例如：产品发布准备" value="${escapeAttr(room.topic || "")}"></div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost danger" id="ge-reset-avatar" style="margin-right:auto" ${customAvatarUrl("room", roomId) ? "" : "hidden"}>恢复默认头像</button>
        <button class="btn ghost" data-close>取消</button>
        <button class="btn primary" id="ge-save">保存</button>
      </div>
    </div>`, {
    onMount(root) {
      $$("[data-close]", root).forEach((b) => b.addEventListener("click", closeModal));
      $("#ge-reset-avatar", root)?.addEventListener("click", async () => {
        try {
          await resetAvatar("room", roomId);
          closeModal();
          toast("已恢复默认群头像");
          rerender();
        } catch (err) { toast(`恢复失败：${err.message}`, "error"); }
      });
      $("#ge-save", root)?.addEventListener("click", async () => {
        const title = $("#ge-title", root).value.trim() || roomTitle(room);
        const topic = $("#ge-topic", root).value.trim();
        try {
          await updateRoomMeta(roomId, { title, topic });
          closeModal();
          toast("群资料已更新", "success");
          rerender();
        } catch (err) { toast(`保存失败：${err.message}`, "error"); }
      });
    },
  });
}

export async function openFilePreview(roomId, fileId, path) {
  if (!fileId) return;
  openModal(`
    <div class="modal preview-modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div style="min-width:0">
          <h2 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(fileName(path))}</h2>
          <p>${escapeHtml(fileId)} · 群文件空间</p>
        </div>
        <span class="spacer"></span>
        <button class="modal-close" data-close>${ICONS.close}</button>
      </div>
      <div class="preview-meta" id="preview-meta"></div>
      <div class="preview-body" id="preview-body">正在读取…</div>
      <div class="modal-foot">
        <button class="btn ghost" id="preview-toggle" hidden>查看原文</button>
        <button class="btn ghost" data-close>关闭</button>
      </div>
    </div>`, {
    onMount(root) {
      root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
      api.filePreview(roomId, fileId).then((data) => {
        const body = root.querySelector("#preview-body");
        const toggle = root.querySelector("#preview-toggle");
        if (!body) return;
        const raw = data.content || "";
        const isMarkdown = /\.(md|markdown)$/i.test(data.path || path || "");
        let showRaw = !isMarkdown;
        const draw = () => {
          if (data.binary) {
            body.className = "preview-body";
            body.textContent = "这是二进制文件，无法在应用内预览。";
          } else if (isMarkdown && !showRaw) {
            body.className = "preview-body preview-md";
            body.innerHTML = raw.trim() ? renderMarkdown(raw) : "<p style=\"color:var(--text-3)\">（空文件）</p>";
          } else {
            body.className = "preview-body";
            body.textContent = raw || "（空文件）";
          }
          if (toggle && isMarkdown) {
            toggle.hidden = false;
            toggle.textContent = showRaw ? "预览 Markdown" : "查看原文";
          }
        };
        draw();
        if (toggle) {
          toggle.addEventListener("click", () => { showRaw = !showRaw; draw(); });
        }
        const meta = root.querySelector("#preview-meta");
        if (meta) {
          meta.innerHTML = `
            <span class="tag accent">${escapeHtml(fileBadge(data.path || path))}</span>
            <span class="tag">${escapeHtml(String(data.size || 0))} 字节</span>
            ${data.description ? `<span class="tag">${escapeHtml(data.description)}</span>` : ""}
            ${data.truncated ? `<span class="tag amber">已截断</span>` : ""}
            <span style="font-size:10.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(data.path || path || "")}</span>`;
        }
      }).catch((err) => {
        const body = root.querySelector("#preview-body");
        if (body) body.textContent = `读取失败：${err.message}`;
      });
    },
  });
}
