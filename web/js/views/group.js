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
export function evidenceBadgeHTML(status, item, roomId) {
  const meta = EVIDENCE_META[status];
  if (!meta) return "";
  const title = evidenceBadgeTitle(status, item, roomId);
  return `<button class="ev-badge is-${status} is-interactive" type="button" data-ev-badge="${status}" data-ev-status="${status}" data-seq="${escapeAttr(item?.messageSeq ?? item?.seq ?? "")}" data-msg-seq="${escapeAttr(item?.messageSeq ?? item?.seq ?? "")}" title="${escapeAttr(title)}" aria-label="证据阶梯：${escapeAttr(meta.label)}">${meta.label}</button>`;
}

export function toolIconSVG(name = "") {
  const n = String(name || "").toLowerCase();
  if (n === "bash" || n === "powershell" || n === "sh" || n === "terminal") {
    return `<svg viewBox="0 0 20 20" class="tool-icon is-terminal"><path d="m5 6 4 4-4 4m6 0h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (n.includes("read") || n === "cat") {
    return `<span class="tool-icon is-file">${ICONS.file}</span>`;
  }
  if (n.includes("write") || n.includes("edit") || n.includes("save")) {
    return `<span class="tool-icon is-edit">${ICONS.edit}</span>`;
  }
  if (n === "grep" || n === "find" || n === "ls") {
    return `<span class="tool-icon is-search">${ICONS.search}</span>`;
  }
  if (n.includes("search") || n.includes("web") || n.includes("fetch") || n.includes("http")) {
    return `<svg viewBox="0 0 20 20" class="tool-icon is-search"><circle cx="10" cy="10" r="6.7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 10h13M10 3.3c1.8 2 2.7 4.2 2.7 6.7s-.9 4.7-2.7 6.7c-1.8-2-2.7-4.2-2.7-6.7s.9-4.7 2.7-6.7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
  }
  return `<span class="tool-icon">${ICONS.tool}</span>`;
}

export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

export function formatToolParams(args) {
  if (!args || (typeof args === "object" && Object.keys(args).length === 0)) {
    return `<span style="color:var(--text-3);font-size:11px">无参数</span>`;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return formatToolParams(parsed);
    } catch {
      return `<pre class="tool-code-block"><code>${escapeHtml(args)}</code></pre>`;
    }
  }
  const keys = Object.keys(args);
  const isAllScalar = keys.every((k) => {
    const val = args[k];
    return typeof val === "string" || typeof val === "number" || typeof val === "boolean" || val === null;
  });
  if (isAllScalar && keys.length <= 4) {
    return `<div class="tool-param-pills">${keys.map((k) => `
      <div class="tool-param-pill">
        <span class="tool-param-k">${escapeHtml(k)}:</span>
        <span class="tool-param-v">${escapeHtml(String(args[k]))}</span>
      </div>`).join("")}</div>`;
  }
  return `<pre class="tool-code-block"><code>${escapeHtml(JSON.stringify(args, null, 2))}</code></pre>`;
}

export function formatToolOutput(rawOutput) {
  if (rawOutput === undefined || rawOutput === null || rawOutput === "") {
    return { html: `<span style="color:var(--text-3);font-size:11px">（执行完成，无返回内容）</span>`, isClamped: false, lineCount: 0, rawText: "" };
  }
  const text = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2);
  const lines = text.split("\n");
  const lineCount = lines.length;
  const isClamped = lineCount > 6 || text.length > 240;
  return {
    html: `<pre class="tool-code-block"><code>${escapeHtml(text)}</code></pre>`,
    isClamped,
    lineCount,
    rawText: text,
  };
}

export function toolCardHTML(tool, options = {}) {
  const toolName = tool.name || tool.tool || "tool";
  const stateVal = tool.status || tool.state || (tool.ok === false || tool.failed ? "error" : "success");
  const isRunning = stateVal === "running";
  const isError = stateVal === "error" || stateVal === "failed" || tool.ok === false || tool.failed;
  const isExpanded = options.forceExpanded !== undefined
    ? Boolean(options.forceExpanded)
    : (isRunning || isError);
  const durationText = formatDuration(tool.duration || tool.durationMs || tool.ms);
  const outInfo = formatToolOutput(tool.output || tool.summary || tool.content || tool.result);
  const toolId = tool.id || `tc_${Math.random().toString(36).slice(2, 8)}`;

  return `
    <div class="tool-card is-${stateVal}${isExpanded ? " is-expanded" : ""}" data-tool-card="${escapeAttr(toolId)}">
      <div class="tool-card-head" role="button" tabindex="0" aria-expanded="${isExpanded ? "true" : "false"}">
        ${toolIconSVG(toolName)}
        <span class="tool-name-badge">${escapeHtml(toolName)}</span>
        <span class="tool-name" style="display:none">${escapeHtml(toolName)}</span>
        <span class="tool-status ${isError ? "is-failed" : "is-ok"}" style="display:none">${isError ? "失败" : "成功"}</span>
        <span class="tool-state-indicator is-${stateVal}">
          ${isRunning
            ? `<span class="tool-spinner">${ICONS.spinner}</span><span>执行中</span>`
            : isError
              ? `<span class="tool-dot is-error"></span><span>失败</span>`
              : `<span class="tool-dot is-success">${ICONS.check}</span><span>完成</span>`}
        </span>
        ${durationText ? `<span class="tool-duration tool-duration-pill">${durationText}</span>` : ""}
        <span class="tool-chevron">${ICONS.chevron}</span>
      </div>
      <div class="tool-card-body bubble markdown-body" ${isExpanded ? "" : "hidden"}>
        <div class="tool-section tool-params">
          <div class="tool-section-head">
            <span class="tool-section-title">输入参数</span>
            <button class="tool-copy-btn" type="button" data-copy="params" data-copy-target="params" title="复制参数">${ICONS.copy}</button>
          </div>
          <div class="tool-params-wrap">${formatToolParams(tool.params || tool.args)}</div>
        </div>
        ${(tool.output || tool.summary || tool.content || tool.result) ? `
        <div class="tool-section tool-output">
          <div class="tool-section-head">
            <span class="tool-section-title">执行输出</span>
            <button class="tool-copy-btn" type="button" data-copy="output" data-copy-target="output" title="复制输出">${ICONS.copy}</button>
          </div>
          <div class="tool-output-box${outInfo.isClamped ? " is-clamped" : ""}">
            ${outInfo.html}
            <div class="tool-output-fade"></div>
          </div>
          ${outInfo.isClamped ? `<button class="tool-expand-output-btn" type="button" data-clamp-toggle data-expand-text="展开完整输出 (${outInfo.lineCount} 行)">展开完整输出 (${outInfo.lineCount} 行)</button>` : ""}
        </div>` : ""}
      </div>
    </div>`;
}

export function toolsClusterHTML(tools = []) {
  if (!Array.isArray(tools) || !tools.length) return "";
  return `<div class="msg-tools">${tools.map((t) => toolCardHTML(t)).join("")}</div>`;
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
    this.isLatched = true;
    this.unreadCount = 0;
    this.lastMsgCount = 0;
    this.isProgrammaticScroll = false;
    this.latchThreshold = 64;
    this.pendingAttachments = [];
    this.mentionIndex = 0;
    this.mentionMatches = [];
    this._headDataSig = "";
  }

  mount(roomId) {
    this.roomId = roomId;
    this.isLatched = true;
    this.unreadCount = 0;
    this.lastMsgCount = 0;
    this.isProgrammaticScroll = false;
    this.latchThreshold = 64;
    this.pendingAttachments = [];
    this.mentionIndex = 0;
    this.mentionMatches = [];

    this.root.innerHTML = `
      <div class="view-head capsule-header" id="g-head"></div>
      <div class="chat-body" id="g-scroll"><div class="chat-inner" id="g-inner"></div></div>
      <button class="btn-scroll-bottom" id="btn-scroll-bottom" type="button" aria-label="回到底部" hidden>
        <span class="scroll-btn-arrow"><svg viewBox="0 0 20 20"><path d="M10 4v12m0 0 4-4m-4 4-4-4"/></svg></span>
        <span class="scroll-btn-text">最新消息</span>
        <span class="scroll-unread-badge" id="scroll-unread-badge" hidden>0</span>
      </button>
      <div class="composer-wrap">
        <div class="composer-inner" id="g-composer-inner">
          <div class="composer floating-dock" id="g-composer">
            <div class="composer-attachments" id="composer-attachments" hidden></div>
            <textarea id="g-input" rows="1" aria-label="群聊消息" placeholder="给群主下达任务，或 @成员 直接对话"></textarea>
            <div class="composer-bar">
              <div class="composer-bar-left">
                <button class="composer-btn" id="btn-attach" type="button" title="添加附件" aria-label="添加附件">${ICONS.plus}</button>
                <button class="composer-btn" id="g-plus" type="button" title="快捷动作" aria-label="快捷动作">${ICONS.spark}</button>
                <span class="composer-policy-pill" id="composer-policy" title="上下文策略">
                  <span class="policy-dot"></span><span class="policy-text">共享全文</span>
                </span>
                <span class="composer-model" id="composer-model" title="当前模型">${escapeHtml(modelShort())}</span>
              </div>
              <span class="composer-hint"><kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行 · <kbd>@</kbd> 提及</span>
              <div class="composer-bar-right">
                <button class="send-btn" id="g-send" type="button" title="发送" aria-label="发送" disabled>${ICONS.send}</button>
              </div>
            </div>
          </div>
          <div class="mention-pop" id="composer-mentions" hidden></div>
          <div class="mention-pop" id="g-mentions" style="display:none" hidden></div>
          <div class="composer-menu" id="g-menu" hidden>
            <button data-menu="mention">${ICONS.users}<span>提及成员</span><small>@</small></button>
            <button data-menu="files">${ICONS.folder}<span>群文件空间</span><small>${(state.files[this.roomId] || []).length}</small></button>
            <button data-menu="settings">${ICONS.settings}<span>群资料与权限</span></button>
          </div>
          <input type="file" id="g-file-picker" multiple style="display:none" />
        </div>
      </div>`;

    this.el = {
      head: $("#g-head", this.root),
      scroll: $("#g-scroll", this.root),
      inner: $("#g-inner", this.root),
      btnScrollBottom: $("#btn-scroll-bottom", this.root),
      scrollBottomBtn: $("#btn-scroll-bottom", this.root),
      scrollUnreadBadge: $("#scroll-unread-badge", this.root),
      composer: $("#g-composer", this.root),
      composerInner: $("#g-composer-inner", this.root),
      input: $("#g-input", this.root),
      send: $("#g-send", this.root),
      plus: $("#g-plus", this.root),
      attach: $("#btn-attach", this.root),
      attachments: $("#composer-attachments", this.root),
      filePicker: $("#g-file-picker", this.root),
      policyPill: $("#composer-policy", this.root),
      modelText: $("#composer-model", this.root),
      mentions: $("#composer-mentions", this.root) || $("#g-mentions", this.root),
      menu: $("#g-menu", this.root),
    };

    this.bind();
    this.update(true);
    if (this.unsub) this.unsub();
    this.unsub = subscribe(() => this.update());
    loadRoomQuiet(this.roomId);
    refreshEvidence(this.roomId).catch(() => {});
  }

  destroy() {
    if (this.unsub) this.unsub();
    this.unsub = null;
    if (this.onDocMouseDown) document.removeEventListener("mousedown", this.onDocMouseDown);
    if (this.onInspectorChange) document.removeEventListener("ah:inspector", this.onInspectorChange);
    if (this.onScroll && this.el.scroll) this.el.scroll.removeEventListener("scroll", this.onScroll);
    this._headDataSig = "";
  }

  bind() {
    const { input, send, plus, attach, filePicker } = this.el;

    this.autosize = () => {
      input.style.height = "auto";
      const scrollHeight = !input.value.trim() ? 40 : (Number(input.scrollHeight) || 40);
      const minH = 40;
      const maxH = 160;
      if (scrollHeight > maxH) {
        input.style.height = `${maxH}px`;
        input.style.overflowY = "auto";
      } else {
        input.style.height = `${Math.max(minH, scrollHeight)}px`;
        input.style.overflowY = "hidden";
      }
      this.syncSendButtonState();
    };

    input.addEventListener("input", () => {
      this.autosize();
      this.updateMentions();
    });

    input.addEventListener("keydown", (ev) => {
      if (this.handleMentionKey(ev)) return;
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.submit();
      }
    });

    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (this.el.mentions) this.el.mentions.hidden = true;
      }, 140);
    });

    send.addEventListener("click", () => {
      const isGenerating = Boolean(state.activity[this.roomId]?.round || state.activity[this.roomId]?.sending);
      if (isGenerating) {
        this.stopGeneration();
      } else {
        this.submit();
      }
    });

    if (attach && filePicker) {
      attach.addEventListener("click", (ev) => {
        ev.stopPropagation();
        filePicker.click();
      });
      filePicker.addEventListener("change", () => {
        const files = Array.from(filePicker.files || []);
        for (const f of files) {
          this.pendingAttachments.push({
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: f.name || "file.txt",
            size: f.size || 0,
            file: f,
          });
        }
        filePicker.value = "";
        this.renderAttachments();
        this.syncSendButtonState();
      });
    }

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
        this.autosize();
        this.updateMentions();
      } else if (btn.dataset.menu === "files") {
        state.inspector = { type: "group", id: this.roomId, tab: "files" };
        document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
      } else if (btn.dataset.menu === "settings") {
        openGroupEditor(this.roomId, () => this.update(true));
      }
    });

    this.onInspectorChange = () => this.syncHeadActiveState();
    document.addEventListener("ah:inspector", this.onInspectorChange);

    this.onDocMouseDown = (ev) => {
      if (!this.el.menu.hidden && !this.el.composerInner.contains(ev.target)) this.el.menu.hidden = true;
      if (!this.el.mentions.hidden && !this.el.composerInner.contains(ev.target)) this.el.mentions.hidden = true;
    };
    document.addEventListener("mousedown", this.onDocMouseDown);

    // Feature 12: Viewport Latching State Machine
    this.onScroll = () => {
      if (this.isProgrammaticScroll) {
        this.isProgrammaticScroll = false;
        return;
      }
      const el = this.el.scroll;
      if (!el) return;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (dist <= this.latchThreshold) {
        this.isLatched = true;
        this.unreadCount = 0;
        this.updateScrollBottomButton();
      } else {
        this.isLatched = false;
        this.updateScrollBottomButton();
      }
    };
    this.el.scroll.addEventListener("scroll", this.onScroll);

    if (this.el.btnScrollBottom) {
      this.el.btnScrollBottom.addEventListener("click", () => {
        this.isLatched = true;
        this.unreadCount = 0;
        this.updateScrollBottomButton();
        this.isProgrammaticScroll = true;
        scrollToBottom(this.el.scroll, true);
        setTimeout(() => { this.isProgrammaticScroll = false; }, 320);
      });
    }
  }

  updateScrollBottomButton() {
    const btn = this.el.btnScrollBottom;
    const badge = this.el.scrollUnreadBadge;
    if (!btn) return;
    if (this.isLatched) {
      btn.hidden = true;
      if (badge) {
        badge.hidden = true;
        badge.textContent = "0";
      }
    } else {
      btn.hidden = false;
      if (badge) {
        if (this.unreadCount > 0) {
          badge.hidden = false;
          badge.textContent = String(this.unreadCount);
        } else {
          badge.hidden = true;
          badge.textContent = "0";
        }
      }
    }
  }

  stopGeneration() {
    if (state.activity[this.roomId]) {
      state.activity[this.roomId].round = false;
      state.activity[this.roomId].sending = false;
      state.activity[this.roomId].typing.clear();
      state.activity[this.roomId].tools.clear();
    }
    this.syncSendButtonState();
    toast("已停止生成", "info");
  }

  syncSendButtonState() {
    const room = state.roomById[this.roomId];
    const isGenerating = Boolean(state.activity[this.roomId]?.round || state.activity[this.roomId]?.sending);
    const hasText = Boolean(this.el.input.value.trim());
    const hasAttachments = (this.pendingAttachments || []).length > 0;

    if (isGenerating) {
      this.el.send.classList.add("is-stop");
      this.el.send.innerHTML = '<svg viewBox="0 0 20 20" class="stop-icon"><rect x="5.5" y="5.5" width="9" height="9" rx="1.8" fill="currentColor"/></svg>';
      this.el.send.title = "停止生成";
      this.el.send.setAttribute("aria-label", "停止生成");
      this.el.send.disabled = false;
    } else {
      this.el.send.classList.remove("is-stop");
      this.el.send.innerHTML = ICONS.send;
      this.el.send.title = "发送";
      this.el.send.setAttribute("aria-label", "发送");
      this.el.send.disabled = !hasText && !hasAttachments;
    }

    if (this.el.policyPill && room) {
      const txt = this.el.policyPill.querySelector(".policy-text");
      if (txt) txt.textContent = POLICY_LABEL[room.context_policy] || "共享全文";
      this.el.policyPill.title = `上下文策略：${POLICY_LABEL[room.context_policy] || "共享全文"} · ${POLICY_HINT[room.context_policy] || ""}`;
    }
    if (this.el.modelText) {
      this.el.modelText.textContent = modelShort();
    }
  }

  renderAttachments() {
    if (!this.el.attachments) return;
    if (!this.pendingAttachments.length) {
      this.el.attachments.hidden = true;
      this.el.attachments.innerHTML = "";
      return;
    }
    this.el.attachments.hidden = false;
    this.el.attachments.innerHTML = this.pendingAttachments
      .map(
        (att) => `
        <div class="attachment-chip" data-att-id="${escapeAttr(att.id)}">
          <span class="attachment-chip-badge">${escapeHtml(fileBadge(att.name))}</span>
          <span class="attachment-chip-name" title="${escapeAttr(att.name)}">${escapeHtml(att.name)}</span>
          <button class="attachment-chip-remove" type="button" data-remove-id="${escapeAttr(att.id)}" aria-label="移除附件">×</button>
        </div>`
      )
      .join("");

    $$("[data-remove-id]", this.el.attachments).forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.removeId;
        this.pendingAttachments = this.pendingAttachments.filter((a) => a.id !== id);
        this.renderAttachments();
        this.syncSendButtonState();
      };
    });
  }

  async submit() {
    const text = this.el.input.value.trim();
    const hasAttachments = (this.pendingAttachments || []).length > 0;
    if (!text && !hasAttachments) return;

    let fullMessage = text;
    if (hasAttachments) {
      const attLines = this.pendingAttachments.map((a) => `[附件: ${a.name}]`).join("\n");
      fullMessage = fullMessage ? `${fullMessage}\n\n${attLines}` : attLines;
    }

    this.el.input.value = "";
    this.el.input.style.height = "40px";
    this.el.input.style.overflowY = "hidden";
    this.pendingAttachments = [];
    this.renderAttachments();
    this.syncSendButtonState();
    if (this.el.mentions) this.el.mentions.hidden = true;

    // Feature 12: Re-latch on user message submit
    this.isLatched = true;
    this.unreadCount = 0;
    this.updateScrollBottomButton();
    this.isProgrammaticScroll = true;
    requestAnimationFrame(() => {
      scrollToBottom(this.el.scroll, false);
      this.isProgrammaticScroll = false;
    });

    try {
      await sendRoomMessage(this.roomId, fullMessage);
    } catch (err) {
      toast(`发送失败：${err.message}`, "error");
      this.el.input.value = text;
      this.autosize();
    }
  }

  updateMentions() {
    const value = this.el.input.value;
    const caret = this.el.input.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const match = before.match(/@([A-Za-z0-9_\-\u4e00-\u9fa5]*)$/);
    const room = state.roomById[this.roomId];
    if (!match || !room) {
      this.el.mentions.hidden = true;
      return;
    }
    const q = match[1].toLowerCase();

    const memberIds = room.members || [];
    const allBotIds = Object.keys(state.botsById || {});
    const combinedIds = Array.from(new Set([...memberIds, ...allBotIds]));

    const matches = combinedIds
      .map((id) => {
        const idn = memberIdentity(id);
        const isMember = memberIds.includes(id);
        return { id, ...idn, isMember };
      })
      .filter((m) => {
        if (!q) return true;
        return (
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          (m.role && m.role.toLowerCase().includes(q)) ||
          (m.badge && m.badge.toLowerCase().includes(q))
        );
      });

    if (!matches.length) {
      this.el.mentions.hidden = true;
      return;
    }

    this.mentionMatches = matches;
    this.mentionIndex = 0;
    this.el.mentions.innerHTML = matches
      .map(
        (m, i) => `
        <button class="mention-item${i === 0 ? " is-active" : ""}" data-mention="${escapeAttr(m.id)}" type="button">
          ${avatar(m.id, 22)}
          <span class="mention-name">${escapeHtml(m.name)}</span>
          <span class="mention-tag">${m.isMember ? escapeHtml(m.badge || m.role) : "可邀请"}</span>
        </button>`
      )
      .join("");

    this.el.mentions.hidden = false;
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
      $$(".mention-item", this.el.mentions).forEach((el, i) => {
        el.classList.toggle("is-active", i === this.mentionIndex);
      });
      return true;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
      if (this.mentionMatches[this.mentionIndex]) {
        ev.preventDefault();
        this.insertMention(this.mentionMatches[this.mentionIndex].id);
        return true;
      }
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.el.mentions.hidden = true;
      return true;
    }
    return false;
  }

  insertMention(name) {
    const input = this.el.input;
    const value = input.value;
    const caret = input.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([A-Za-z0-9_\-\u4e00-\u9fa5]*)$/, `@${name} `);
    input.value = before + value.slice(caret);
    if (typeof input.focus === "function") input.focus();
    input.selectionStart = input.selectionEnd = before.length;
    this.el.mentions.hidden = true;
    this.autosize();
    input.dispatchEvent(new Event("input"));
  }

  update(force = false) {
    const room = state.roomById[this.roomId];
    if (!room) return;
    this.renderHead(room);
    this.renderTimeline(room, force);
    this.syncSendButtonState();
  }

  renderHead(room) {
    const owner = profileOf(room.owner_id);
    const files = state.files[this.roomId] || [];
    const fileCount = files.length || room.file_count || 0;
    const members = room.members || [];
    const m = memberIdentity(room.owner_id);
    const activeMember = (state.inspector?.type === "group" && state.inspector?.id === this.roomId)
      ? state.inspector.member
      : null;
    const isInfoOn = state.inspector?.type === "group" && state.inspector?.id === this.roomId;

    // Header memoization: prevent mid-flight DOM destruction during async evidence fetch or clicks
    const headSig = `${this.roomId}:${room.title || ""}:${room.topic || ""}:${room.context_policy || ""}:${room.owner_id || ""}:${members.join(",")}:${fileCount}`;
    if (this._headDataSig === headSig && this.el.head.firstElementChild) {
      this.syncHeadActiveState(room);
      return;
    }
    this._headDataSig = headSig;

    this.el.head.className = "view-head has-roster capsule-header";
    this.el.head.innerHTML = `
      <div class="capsule-left">
        ${groupAvatar(room, 34, state.botsById)}
        <div class="view-head-main">
          <div class="view-title">
            ${m.emoji ? `<span class="crown" aria-hidden="true">${escapeHtml(m.emoji)}</span>` : ""}
            <span class="room-title-text">${escapeHtml(roomTitle(room))}</span>
            ${room.topic ? `<span class="tag topic-pill" title="${escapeAttr(room.topic)}">${escapeHtml(room.topic)}</span>` : ""}
            <span class="tag policy-pill" title="${escapeAttr(POLICY_HINT[room.context_policy] || "")}"><span class="policy-dot"></span>${escapeHtml(POLICY_LABEL[room.context_policy] || "共享全文")}</span>
          </div>
          <div class="view-sub">${members.length} 位成员 · 群主 ${escapeHtml(owner.name)} · ${escapeHtml(POLICY_LABEL[room.context_policy] || "共享全文")}<span class="g-head-ev">${evidenceSummaryHTML(evidenceSummaryOf(this.roomId))}</span></div>
          <div class="member-chips" id="g-roster">
            ${members.map((id) => {
              const idn = memberIdentity(id);
              const isOwner = id === room.owner_id;
              const isSelected = Boolean(activeMember && activeMember === id);
              return `<button class="mchip${isOwner ? " is-owner" : ""}${isSelected ? " is-selected" : ""}" type="button" data-goto-member="${escapeAttr(id)}" aria-pressed="${isSelected ? "true" : "false"}" title="${escapeAttr(`${idn.name} · ${idn.role} · ${idn.tagline}`)}">
                <span class="mchip-emoji" aria-hidden="true">${escapeHtml(idn.emoji || "•")}</span>
                <span class="mchip-name">${escapeHtml(idn.name)}</span>
                <span class="mchip-badge">${isOwner ? "群主" : escapeHtml(idn.badge || idn.role)}</span>
              </button>`;
            }).join("")}
          </div>
        </div>
      </div>
      <div class="head-actions">
        <button class="head-btn" id="g-files" title="群文件空间">${ICONS.folder}<span>群文件</span><span class="head-count">${fileCount}</span></button>
        <button class="head-btn icon-only${isInfoOn ? " is-on" : ""}" id="g-info" title="群信息与成员权限" aria-pressed="${isInfoOn ? "true" : "false"}">${ICONS.users}</button>
      </div>`;
    $$("[data-goto-member]", this.el.head).forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const memberId = btn.dataset.gotoMember;
        state.inspector = { type: "group", id: this.roomId, tab: "members", member: memberId };
        this.syncHeadActiveState();
        document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
      };
    });
    $("#g-files", this.el.head).onclick = (ev) => {
      ev.stopPropagation();
      state.inspector = { type: "group", id: this.roomId, tab: "files" };
      state.inspectorNonce = (state.inspectorNonce || 0) + 1;
      this.syncHeadActiveState();
      document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
    };
    $("#g-info", this.el.head).onclick = (ev) => {
      ev.stopPropagation();
      const isCurrentGroup = state.inspector?.type === "group" && state.inspector?.id === this.roomId;
      if (isCurrentGroup) {
        if (state.inspector.member) {
          // Switch to general group view (clear member focus) without closing
          state.inspector = { type: "group", id: this.roomId, tab: "members" };
        } else {
          // Already on general group view -> collapse inspector
          state.inspector = null;
        }
      } else {
        state.inspector = { type: "group", id: this.roomId, tab: "members" };
      }
      this.syncHeadActiveState();
      document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
    };
  }

  syncHeadActiveState(room) {
    if (!this.el.head) return;
    const isCurrentGroup = state.inspector?.type === "group" && state.inspector?.id === this.roomId;
    const activeMember = isCurrentGroup ? state.inspector.member : null;
    $$("[data-goto-member]", this.el.head).forEach((btn) => {
      const isSelected = Boolean(activeMember && btn.dataset.gotoMember === activeMember);
      btn.classList.toggle("is-selected", isSelected);
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
    });
    const infoBtn = $("#g-info", this.el.head);
    if (infoBtn) {
      infoBtn.classList.toggle("is-on", Boolean(isCurrentGroup));
      infoBtn.setAttribute("aria-pressed", Boolean(isCurrentGroup) ? "true" : "false");
    }
    const targetRoom = room || state.roomById[this.roomId];
    if (targetRoom) {
      const files = state.files[this.roomId] || [];
      const fileCount = files.length || targetRoom.file_count || 0;
      const countEl = $("#g-files .head-count", this.el.head);
      if (countEl && countEl.textContent !== String(fileCount)) countEl.textContent = String(fileCount);
    }
    const evEl = $(".g-head-ev", this.el.head);
    if (evEl) {
      const nextEvHtml = evidenceSummaryHTML(evidenceSummaryOf(this.roomId));
      if (evEl.innerHTML !== nextEvHtml) evEl.innerHTML = nextEvHtml;
    }
  }

  renderTimeline(room, force = false) {
    const list = state.messages[this.roomId] || [];
    const prevCount = this.lastMessageCount ?? 0;
    const newCount = list.length;
    const diff = newCount - prevCount;

    if (!list.length && !activeMembers(this.roomId).length) {
      this.el.inner.className = "chat-inner is-empty";
      this.el.inner.innerHTML = this.welcomeHTML(room);
      this.bindWelcome(room);
      this.lastMessageCount = 0;
      this.unreadCount = 0;
      this.updateScrollBottomButton();
      return;
    }

    // Feature 12: Viewport Latching State Machine
    if (diff > 0 && !this.isLatched) {
      this.unreadCount = (this.unreadCount || 0) + diff;
      this.updateScrollBottomButton();
    } else if (this.isLatched) {
      this.unreadCount = 0;
      this.updateScrollBottomButton();
    }
    this.lastMessageCount = newCount;

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

    if (this.isLatched || force) {
      this.isProgrammaticScroll = true;
      requestAnimationFrame(() => {
        scrollToBottom(this.el.scroll, false);
        this.isProgrammaticScroll = false;
      });
    }
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
    // Feature 13: 4 distinct role cluster styles
    // 1. System role
    if (item.role === "system" || item.speaker === "system") {
      return `<div class="msg-row is-system" data-role="system" data-msg-id="${escapeAttr(item.id || "")}">
        <div class="msg-system-pill">${escapeHtml(item.content || "")}</div>
      </div>`;
    }

    // 2. Tool role
    if (item.role === "tool" || item.speaker === "tool") {
      return this.toolMessageRowHTML(item);
    }

    // 3. User role
    const isUser = item.speaker === "user" || item.role === "user";
    if (isUser) {
      const stateTag = item.failed
        ? `<span class="msg-time" style="color:var(--red)">发送失败</span>`
        : item.pending
          ? `<span class="msg-time">发送中<span class="typing-dots" style="margin-left:4px"><i></i><i></i><i></i></span></span>`
          : "";
      return `<div class="msg-row is-user${item.pending ? " is-pending" : ""}" data-role="user" data-msg-id="${escapeAttr(item.id || "")}">
        <div class="msg-main">
          <div class="msg-head">${stateTag}<span class="msg-time">${formatTime(item.ts)}</span><span class="msg-name">你</span></div>
          <div class="bubble markdown-body is-user-bubble">${renderMarkdown(item.content || "")}</div>
          <div class="msg-toolbar">
            <button class="msg-copy" type="button" title="复制内容" aria-label="复制内容">${ICONS.copy} 复制</button>
          </div>
        </div>
        <span class="msg-av">${userAvatar(28)}</span>
      </div>`;
    }

    if (String(item.speaker).startsWith("subgroup:")) {
      return `<div class="sysline">${ICONS.users}<span>子群讨论结论已回报</span></div>`;
    }

    // 4. Assistant role
    let tools = item.tools || [];
    if (!tools.length && Array.isArray(item.ev_records)) {
      tools = item.ev_records.filter((e) => e && (e.tool || e.call_id)).map((e, idx) => ({
        id: e.call_id || e.id || `ev-tool-${idx}`,
        tool: e.tool || "tool",
        status: e.status || "ok",
        duration: e.duration || 0,
        params: e.args || e.params || {},
        output: e.output || e.result || ""
      }));
    }

    const isError = /^Tool failure/i.test(item.content || "");
    const p = profileOf(item.speaker);
    const modelTag = `<span class="msg-model">${escapeHtml(modelShort())}</span>`;
    const toolsHTML = tools && tools.length ? toolsClusterHTML(tools) : "";
    const telem = item.telemetry || (item.tps || item.ttft_ms ? item : null);
    const telemetryPill = telem?.tps || telem?.ttft_ms
      ? `<span class="msg-telemetry-pill" style="display:inline-flex;align-items:center;font-size:10px;padding:2px 6px;border-radius:10px;background:rgba(234,179,8,0.12);color:var(--amber,#d97706);font-weight:500;gap:3px" title="TTFT: ${telem.ttft_ms ?? 0}ms · 速率: ${telem.tps ?? 0} tok/s · 耗时: ${item.ms ?? telem.total_ms ?? 0}ms">⚡ ${telem.tps ?? 0} tok/s · ${telem.ttft_ms ?? 0}ms</span>`
      : (item.ms ? `<span class="msg-telemetry-pill" style="display:inline-flex;align-items:center;font-size:10px;padding:2px 6px;border-radius:10px;background:rgba(234,179,8,0.12);color:var(--amber,#d97706);font-weight:500;gap:3px" title="耗时: ${item.ms}ms">⚡ ${item.ms}ms</span>` : "");

    return `<div class="msg-row is-bot is-assistant" data-role="assistant" data-msg-id="${escapeAttr(item.id || "")}">
      ${avatar(item.speaker, 30)}
      <div class="msg-main">
        <div class="msg-head">
          <span class="msg-name" style="color:${p.color}">${escapeHtml(p.name)}</span>
          <span class="msg-tag">${escapeHtml(p.role)}</span>
          ${modelTag}
          ${evidenceBadgeHTML(item.evidence, item, room?.room_id || this.roomId)}
          ${telemetryPill}
          <span class="msg-time">${formatTime(item.ts)}</span>
        </div>
        ${toolsHTML}
        <div class="bubble markdown-body${isError ? " is-error" : ""}">
          ${isError ? `${ICONS.info}<span>工具调用失败，已记录到运行日志。</span>` : renderMarkdown(item.content || "")}
        </div>
        <div class="msg-toolbar">
          <button class="msg-copy" type="button" title="复制内容" aria-label="复制内容">${ICONS.copy} 复制</button>
          <button class="msg-retry" type="button" data-speaker="${escapeAttr(item.speaker)}" title="重试此回答" aria-label="重试此回答">${ICONS.refresh} 重试</button>
        </div>
      </div>
    </div>`;
  }

  toolMessageRowHTML(item) {
    const toolData = {
      id: item.tool_call_id || item.id || "tool-msg",
      tool: item.tool_name || item.tool || "tool",
      status: item.status || "ok",
      duration: item.duration || 0,
      params: item.args || item.params || {},
      output: item.content || item.output || ""
    };
    return `<div class="msg-row is-tool" data-role="tool" data-msg-id="${escapeAttr(item.id || "")}">
      ${toolCardHTML(toolData)}
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

    // Feature 14: Tool card accordion toggle
    $$(".tool-card-head", this.el.inner).forEach((head) => {
      head.onclick = (ev) => {
        if (ev && ev.target && typeof ev.target.closest === "function" && ev.target.closest("button") && !ev.target.closest(".tool-toggle-btn") && !ev.target.classList.contains("tool-card-head")) {
          return;
        }
        const card = head.closest(".tool-card");
        if (!card) return;
        const body = card.querySelector(".tool-card-body");
        if (!body) return;
        const isHidden = body.hidden;
        body.hidden = !isHidden;
        card.classList.toggle("is-expanded", isHidden);
      };
    });

    // Feature 14: Output clamp toggle
    $$("[data-clamp-toggle]", this.el.inner).forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const card = btn.closest(".tool-card");
        const box = card ? card.querySelector(".tool-output-box") : null;
        if (!box) return;
        const isClamped = box.classList.contains("is-clamped");
        if (isClamped) {
          box.classList.remove("is-clamped");
          btn.textContent = "收起输出";
        } else {
          box.classList.add("is-clamped");
          const lineCount = btn.dataset.lines || (box.textContent ? box.textContent.split("\n").length : 0);
          btn.textContent = `展开完整输出 (${lineCount} 行)`;
        }
      };
    });

    // Feature 14: Tool copy buttons (params & output)
    $$(".tool-copy-btn", this.el.inner).forEach((btn) => {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        const raw = btn.dataset.copyRaw || "";
        let textToCopy = raw;
          const target = btn.dataset.copyTarget || btn.dataset.copy;
          const card = btn.closest(".tool-card");
          if (target === "output" && card) {
            textToCopy = card.querySelector(".tool-output-box code")?.textContent || card.querySelector(".tool-output-box")?.textContent || "";
          } else if (target === "params" && card) {
            textToCopy = card.querySelector(".tool-params-wrap")?.textContent || card.querySelector(".tool-params")?.textContent || "";
          }
        try {
          await navigator.clipboard.writeText(textToCopy);
          const origText = btn.textContent;
          btn.textContent = "已复制";
          setTimeout(() => { btn.textContent = origText; }, 1500);
          toast("已复制到剪贴板", "success");
        } catch {
          toast("复制失败", "error");
        }
      };
    });

    // Feature 15: Interactive evidence badges
    $$("[data-ev-badge]", this.el.inner).forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const seq = btn.dataset.seq ? Number(btn.dataset.seq) : null;
        const msgRow = btn.closest(".msg-row");
        if (msgRow) {
          const toolCards = $$(".tool-card", msgRow);
          toolCards.forEach((tc) => {
            const body = tc.querySelector(".tool-card-body");
            if (body) body.hidden = false;
            tc.classList.add("is-expanded");
            tc.classList.add("is-highlighted");
            setTimeout(() => tc.classList.remove("is-highlighted"), 2500);
            if (typeof tc.scrollIntoView === "function") {
              tc.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
          });
        }
        state.inspector = { type: "group", id: this.roomId, tab: "evidence", seq };
        document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
      };
    });

    // Feature 13: Message toolbar copy
    $$(".msg-copy", this.el.inner).forEach((btn) => {
      btn.onclick = async () => {
        const bubble = btn.closest(".msg-main")?.querySelector(".bubble");
        if (!bubble) return;
        try {
          const text = bubble.innerText || bubble.textContent || "";
          await navigator.clipboard.writeText(text);
          const origHTML = btn.innerHTML;
          btn.textContent = "已复制";
          setTimeout(() => { btn.innerHTML = origHTML; }, 1500);
          toast("已复制", "success");
        } catch {
          toast("复制失败，请手动选择文本", "error");
        }
      };
    });

    // Feature 13: Message toolbar retry
    $$(".msg-retry", this.el.inner).forEach((btn) => {
      btn.onclick = () => {
        const speaker = btn.dataset.speaker || "";
        const input = this.el.input;
        if (!input) return;
        const retryPrompt = speaker ? `@${speaker} 请重新思考并优化回答：` : "请重新思考并优化回答：";
        input.value = retryPrompt;
        if (typeof input.focus === "function") input.focus();
        input.dispatchEvent(new Event("input"));
        this.autosize();
      };
    });

    // Feature 13: Code block copy in markdown-body
    $$(".markdown-body pre", this.el.inner).forEach((pre) => {
      if (pre.querySelector(".code-copy-btn")) return;
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "code-copy-btn";
      copyBtn.title = "复制代码";
      copyBtn.setAttribute("aria-label", "复制代码");
      copyBtn.innerHTML = ICONS.copy || "复制";
      copyBtn.onclick = async (ev) => {
        ev.stopPropagation();
        const codeText = pre.querySelector("code")?.innerText || pre.innerText || "";
        try {
          await navigator.clipboard.writeText(codeText);
          copyBtn.innerHTML = "已复制";
          setTimeout(() => { copyBtn.innerHTML = ICONS.copy || "复制"; }, 1500);
          toast("代码已复制", "success");
        } catch {
          toast("复制代码失败", "error");
        }
      };
      pre.style.position = "relative";
      pre.appendChild(copyBtn);
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

export function groupInspectorHTML(roomId, tab = "members", selectedMember = null) {
  const room = state.roomById[roomId];
  if (!room) return `<div class="insp-body"><div class="empty-mini">群聊不存在</div></div>`;
  const members = room.members || [];
  const files = state.files[roomId] || [];
  const subs = childRooms(roomId);
  const activeTab = ["members", "files", "evidence"].includes(tab) ? tab : "members";
  const activeMember = selectedMember !== null ? selectedMember : (state.inspector?.id === roomId ? state.inspector?.member : null);
  const isFiles = activeTab === "files";
  const isEvidence = activeTab === "evidence";
  const evSummary = evidenceSummaryOf(roomId);
  const evCount = evSummary?.total ? Number(evSummary.total) : 0;

  let body = "";
  if (isFiles) {
    body = filesTabHTML(roomId, files);
  } else if (isEvidence) {
    body = evidenceTabHTML(roomId);
  } else {
    body = membersTabHTML(room, members, activeMember);
  }

  return `
    <div class="insp-head">
      <div class="insp-title-wrap">
        <h2>群信息</h2>
        <span class="tag">${members.length} 成员</span>
      </div>
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
      <div class="seg insp-tabs" role="tablist" style="margin-bottom:14px">
        <button data-tab="members" class="${activeTab === "members" ? "is-on" : ""}">成员 ${members.length}</button>
        <button data-tab="files" class="${activeTab === "files" ? "is-on" : ""}">文件 ${files.length}</button>
        <button data-tab="evidence" class="${activeTab === "evidence" ? "is-on" : ""}">证据${evCount ? ` ${evCount}` : ""}</button>
      </div>
      ${body}
      ${activeTab === "members" ? evidenceSectionHTML(roomId) : ""}
      ${subs.length ? `<div class="section-label">小群 <span class="count">${subs.length}</span></div>
        ${subs.map((s) => `<button class="file-item" data-open-room="${escapeAttr(s.room_id)}">
          <span class="file-ico" style="background:var(--surface-2);color:var(--text-2)">${ICONS.users}</span>
          <span class="file-copy"><span class="file-name">${escapeHtml(s.title || s.topic || s.room_id)}</span><span class="file-meta">${(s.members || []).length} 位成员 · 点击进入</span></span>
        </button>`).join("")}` : ""}
    </div>`;
}

function membersTabHTML(room, members, activeMember = null) {
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
      const isSelected = Boolean(activeMember && activeMember === id);
      return `<div class="member-row${isSelected ? " is-selected" : ""}" data-member="${escapeAttr(id)}">
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

function evidenceTabHTML(roomId) {
  const snapshot = state.evidence?.[roomId];
  const summary = snapshot?.summary;
  if (!summary || !Number(summary.total)) {
    return `<div class="empty-mini">当前群聊暂无证据判定。等成员执行包含工具调用的回合后，判定会自动沉淀在此。</div>`;
  }
  return evidenceSectionHTML(roomId);
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

export function bindGroupInspector(root, roomId, tab = "members", rerender, selectedMember = null) {
  const room = state.roomById[roomId];
  if (!room) return;
  const currentEv = state.evidence?.[roomId];
  if (!currentEv || Date.now() - Number(currentEv.at || 0) > 15000) {
    refreshEvidence(roomId).catch(() => {});
  }
  const targetMember = selectedMember !== null ? selectedMember : (state.inspector?.id === roomId ? state.inspector?.member : null);
  if (targetMember && (!tab || tab === "members")) {
    const row = root.querySelector(`[data-member="${targetMember}"]`);
    if (row && typeof row.scrollIntoView === "function") {
      try { row.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch {}
    }
  }
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
      let inFlight = false;
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (btn.disabled || inFlight) return;
        inFlight = true;
        btn.disabled = true;
        const liveRoom = state.roomById[roomId];
        if (!liveRoom) {
          btn.disabled = false;
          inFlight = false;
          return;
        }
        if (!liveRoom.member_permissions) liveRoom.member_permissions = {};
        const currentPerms = liveRoom.member_permissions;
        const memberPerm = currentPerms[memberId] || { can_speak: true, context_access: "full", can_create_subgroup: false };

        const patch = {};
        if (btn.dataset.act === "speak") {
          patch.can_speak = !Boolean(memberPerm.can_speak);
        }
        if (btn.dataset.act === "subgroup") {
          patch.can_create_subgroup = !Boolean(memberPerm.can_create_subgroup);
        }
        if (btn.dataset.act === "context") {
          const curr = memberPerm.context_access || "full";
          patch.context_access = curr === "full" ? "summary" : curr === "summary" ? "none" : "full";
        }

        const prevMemberPerm = { ...memberPerm };
        // Optimistically update local state so rapid subsequent clicks read latest state
        currentPerms[memberId] = { ...memberPerm, ...patch };

        try {
          await updateRoomMeta(roomId, { member_permissions: { [memberId]: patch } });
          const updatedRoom = state.roomById[roomId];
          if (updatedRoom) {
            updatedRoom.member_permissions = {
              ...(updatedRoom.member_permissions || {}),
              [memberId]: { ...(updatedRoom.member_permissions?.[memberId] || {}), ...patch },
            };
          }
          rerender();
        } catch (err) {
          const rollBackRoom = state.roomById[roomId];
          if (rollBackRoom?.member_permissions) {
            rollBackRoom.member_permissions[memberId] = prevMemberPerm;
          }
          rerender();
          toast(err.message, "error");
        } finally {
          btn.disabled = false;
          inFlight = false;
        }
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
