/* Chief — direct conversation with the router. */

import { state, subscribe, submitChief, refreshContext } from "../store.js";
import { avatar, userAvatar, profileFor, escapeHtml } from "../avatars.js";
import {
  ICONS, $, $$, toast, formatTokens, escapeAttr, scrollToBottom, isNearBottom,
} from "../ui.js";
import { renderMarkdown } from "../markdown.js";

const SUGGESTIONS = [
  { title: "规划并执行一个多步任务", body: "Chief 先拆解，再调度合适的 Worker。", prompt: "帮我完成一个多步任务：先分析需求并拆解，再分派给合适的成员执行，最后汇总结果。任务：" },
  { title: "调研并写成报告", body: "搜索、整理、成稿，一条链路走完。", prompt: "调研这个主题并写一份结构化报告，最后给出结论与建议。主题：" },
  { title: "检查现有项目", body: "读代码、找问题、给出修改建议。", prompt: "检查当前工作区的项目：找出最值得修的三个问题，给出证据和修改建议。范围：" },
  { title: "整理工作区文件", body: "盘点、归类、产出清单。", prompt: "盘点当前工作区的文件，按用途归类，指出重复与过期文件，产出一份清单。" },
];

export class ChiefView {
  constructor(root) {
    this.root = root;
    this.unsub = null;
  }

  mount() {
    this.root.innerHTML = `
      <div class="view-head" id="c-head"></div>
      <div class="chat-body" id="c-scroll"><div class="chat-inner" id="c-inner"></div></div>
      <div class="composer-wrap">
        <div class="composer-inner">
          <div class="composer">
            <textarea id="c-input" rows="1" aria-label="给 Chief 的消息" placeholder="今天想让团队做什么？"></textarea>
            <div class="composer-bar">
              <button class="composer-plus" id="c-plus" title="提示" aria-label="提示">${ICONS.spark}</button>
              <span class="composer-hint"><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</span>
              <span class="composer-model">${escapeHtml(modelShort())}</span>
              <button class="send-btn" id="c-send" title="发送" aria-label="发送">${ICONS.send}</button>
            </div>
          </div>
        </div>
      </div>`;
    this.el = {
      head: $("#c-head", this.root),
      scroll: $("#c-scroll", this.root),
      inner: $("#c-inner", this.root),
      input: $("#c-input", this.root),
      send: $("#c-send", this.root),
    };
    const input = this.el.input;
    const autosize = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
      this.el.send.disabled = !input.value.trim() || state.chief.active;
    };
    input.addEventListener("input", autosize);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.submit();
      }
    });
    this.el.send.addEventListener("click", () => this.submit());
    $("#c-plus", this.root).addEventListener("click", () => toast("直接描述目标即可；Chief 会决定拆几个子任务、交给谁。"));
    this.el.scroll.addEventListener("scroll", () => { this.userScrolled = true; });
    this.update(true);
    if (this.unsub) this.unsub();
    this.unsub = subscribe(() => this.update());
    refreshContext();
  }

  destroy() { if (this.unsub) this.unsub(); this.unsub = null; }

  async submit() {
    const input = this.el.input;
    const text = input.value.trim();
    if (!text || state.chief.active) return;
    input.value = "";
    input.style.height = "auto";
    this.el.send.disabled = true;
    this.userScrolled = false;
    try {
      await submitChief(text);
    } catch (err) {
      toast(`提交失败：${err.message}`, "error");
      input.value = text;
    }
  }

  update(force = false) {
    this.renderHead();
    this.renderBody();
    this.el.send.disabled = !this.el.input.value.trim() || state.chief.active;
    if ((force || !this.userScrolled) && this.el.scroll) {
      requestAnimationFrame(() => scrollToBottom(this.el.scroll));
      this.userScrolled = false;
    }
  }

  renderHead() {
    const chief = profileFor("ChiefRouter", state.botsById.ChiefRouter);
    const ctx = state.context || {};
    const pct = Number(ctx.usage_percentage || 0);
    this.el.head.innerHTML = `
      ${avatar("ChiefRouter", 30)}
      <div class="view-head-main">
        <div class="view-title">${escapeHtml(chief.name)} <span class="tag">总管</span>${state.chief.active ? `<span class="tag accent">工作中</span>` : ""}</div>
        <div class="view-sub">${escapeHtml(chief.tagline)} · 上下文 ${formatTokens(ctx.active_tokens)} / ${formatTokens(ctx.max_context_tokens || 1_000_000)} (${pct.toFixed(1)}%)</div>
      </div>
      <div class="head-actions">
        <button class="head-btn icon-only" id="c-info" title="上下文与用量">${ICONS.chart}</button>
      </div>`;
    $("#c-info", this.el.head).onclick = () => {
      state.inspector = state.inspector?.type === "chief" ? null : { type: "chief" };
      document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
    };
  }

  renderBody() {
    const chief = state.chief;
    const near = isNearBottom(this.el.scroll);
    if (!chief.messages.length && !chief.active && !chief.plan) {
      this.el.inner.className = "chat-inner is-empty";
      this.el.inner.innerHTML = this.welcomeHTML();
      this.bindWelcome();
      return;
    }
    this.el.inner.className = "chat-inner";
    const blocks = chief.messages.map((m) => this.messageHTML(m));
    if (chief.plan) blocks.push(this.planHTML(chief.plan));
    if (chief.tools.length) {
      const last = chief.tools[chief.tools.length - 1];
      blocks.push(`<div class="tool-line">${ICONS.tool}<span>正在调用</span><code>${escapeHtml(last.name || "tool")}</code></div>`);
    }
    if (chief.active) {
      const p = profileFor("ChiefRouter", state.botsById.ChiefRouter);
      blocks.push(`<div class="msg-row is-bot">
        ${avatar("ChiefRouter", 30)}
        <div class="msg-main">
          <div class="msg-head"><span class="msg-name" style="color:${p.color}">${escapeHtml(p.name)}</span><span class="msg-tag">总管</span></div>
          <div class="bubble">${chief.streamText ? renderMarkdown(chief.streamText) + `<span class="stream-caret"></span>` : `<span style="color:var(--text-3)">正在拆解目标</span><span class="typing-dots"><i></i><i></i><i></i></span>`}</div>
        </div>
      </div>`);
    }
    this.el.inner.innerHTML = blocks.join("");
    this.bindActions();
    if (near) requestAnimationFrame(() => scrollToBottom(this.el.scroll));
  }

  bindActions() {
    $$(".msg-copy", this.el.inner).forEach((btn) => {
      btn.onclick = async () => {
        const bubble = btn.closest(".msg-main")?.querySelector(".bubble");
        if (!bubble) return;
        try { await navigator.clipboard.writeText(bubble.innerText); toast("已复制", "success"); }
        catch { toast("复制失败，请手动选择文本", "error"); }
      };
    });
  }

  welcomeHTML() {
    return `
      <div class="welcome">
        <div class="welcome-orb">${avatar("ChiefRouter", 76)}</div>
        <h1>今天想让团队做什么？</h1>
        <p>说一句目标就行。Chief 会拆解任务、调度成员、把结果汇总给你。</p>
        <div class="suggest-grid">
          ${SUGGESTIONS.map((s, i) => `<button class="suggest-card" data-suggest="${i}"><b>${escapeHtml(s.title)}</b><span>${escapeHtml(s.body)}</span></button>`).join("")}
        </div>
      </div>`;
  }

  bindWelcome() {
    $$("[data-suggest]", this.el.inner).forEach((btn) => {
      btn.onclick = () => {
        const s = SUGGESTIONS[Number(btn.dataset.suggest)];
        this.el.input.value = s.prompt;
        this.el.input.focus();
        this.el.input.dispatchEvent(new Event("input"));
      };
    });
  }

  messageHTML(m) {
    if (m.speaker === "user") {
      return `<div class="msg-row is-user">
        <div class="msg-main">
          <div class="msg-head"><span class="msg-name">你</span></div>
          <div class="bubble">${renderMarkdown(m.content)}</div>
        </div>
        <span class="msg-av">${userAvatar(28)}</span>
      </div>`;
    }
    if (m.speaker === "system" || m.error) {
      return `<div class="sysline">${ICONS.info}<span>${escapeHtml(m.content)}</span></div>`;
    }
    const p = profileFor("ChiefRouter", state.botsById.ChiefRouter);
    return `<div class="msg-row is-bot">
      ${avatar("ChiefRouter", 30)}
      <div class="msg-main">
        <div class="msg-head">
          <span class="msg-name" style="color:${p.color}">${escapeHtml(p.name)}</span>
          <span class="msg-tag">总管</span>
          <button class="msg-copy" type="button" title="复制内容" aria-label="复制内容">${ICONS.copy}</button>
        </div>
        <div class="bubble">${renderMarkdown(m.content)}</div>
      </div>
    </div>`;
  }

  planHTML(plan) {
    const steps = plan.subtasks || [];
    return `<div class="plan-card msg-card">
      <div class="msg-card-head">
        <span class="kicker">任务计划</span>
        <span class="spacer"></span>
        <span class="tag">${steps.length} 步</span>
      </div>
      <div class="msg-card-body">
        <div class="plan-list">
          ${steps.map((s) => {
            const status = s.status || "pending";
            const icon = status === "done" ? ICONS.check : status === "failed" ? ICONS.close : "";
            return `<div class="plan-step ${status}">
              <span class="plan-ico">${icon}</span>
              <div class="plan-copy">
                <div class="plan-desc">${escapeHtml(s.description || "")}</div>
                <div class="plan-meta">${escapeHtml(s.archetype || "worker")}${s.depends_on?.length ? ` · 依赖 ${s.depends_on.join(", ")}` : ""}</div>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>
    </div>`;
  }
}

function modelShort() {
  const raw = state.settings?.model || state.health?.model || "";
  if (!raw) return "pi 内核 · 本地运行";
  return String(raw)
    .replace(/^(auto|magpie|workbuddy|openai|anthropic)\//i, "")
    .replace(/^deepseek-/, "DeepSeek ");
}

export function chiefInspectorHTML() {
  const ctx = state.context || {};
  const dist = ctx.distribution || {};
  const total = Math.max(1, (dist.system || 0) + (dist.user || 0) + (dist.assistant || 0) + (dist.tool || 0));
  const rows = [
    ["系统提示", dist.system || 0, "var(--text-3)"],
    ["你的消息", dist.user || 0, "var(--accent)"],
    ["助手回复", dist.assistant || 0, "var(--green)"],
    ["工具输出", dist.tool || 0, "var(--amber)"],
  ];
  const usd = state.stats?.tokens || ctx.tokens_total || {};
  return `
    <div class="insp-head"><h2>上下文与用量</h2><button class="insp-close" data-insp-close>${ICONS.close}</button></div>
    <div class="insp-body">
      <div class="stat-grid" style="grid-template-columns:repeat(2,1fr)">
        <div class="stat-card"><div class="stat-label">当前上下文</div><div class="stat-value">${formatTokens(ctx.active_tokens)}<small>tokens</small></div><div class="stat-sub">上限 ${formatTokens(ctx.max_context_tokens || 1_000_000)}</div></div>
        <div class="stat-card"><div class="stat-label">缓存命中率</div><div class="stat-value">${Math.round((ctx.cache_hit_rate || 0) * 100)}<small>%</small></div><div class="stat-sub">本次输入 ${formatTokens(usd.prompt)}</div></div>
      </div>
      <div class="section-label">构成 <span class="count">${formatTokens(total)} tokens</span></div>
      <div class="set-card" style="padding:12px 14px">
        ${rows.map(([label, value, color]) => `<div class="bar-row" style="margin:8px 0">
          <span class="bar-name" style="width:72px">${label}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.round(value / total * 100)}%;background:${color}"></span></span>
          <span class="bar-value">${formatTokens(value)}</span>
        </div>`).join("")}
      </div>
      <div class="section-label">成员用量</div>
      <div class="set-card" style="padding:12px 14px">
        ${(ctx.bots || []).map((b) => `<div class="bar-row" style="margin:8px 0">
          ${avatar(b.bot_id, 22)}
          <span class="bar-name" style="width:72px">${escapeHtml(profileFor(b.bot_id, state.botsById[b.bot_id]).name)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, Math.round((b.tokens || 0) / Math.max(1, ctx.active_tokens) * 100))}%"></span></span>
          <span class="bar-value">${formatTokens(b.tokens)}</span>
        </div>`).join("") || `<div class="empty-mini">还没有成员用量记录</div>`}
      </div>
      <div class="section-label">模型</div>
      <div class="set-card"><div class="set-row"><div class="set-copy"><div class="set-name">${escapeHtml(state.settings?.model || "")}</div><div class="set-desc">${escapeHtml(state.settings?.gateway_url || "")}</div></div></div></div>
    </div>`;
}
