/* Direct Message (1-on-1 Private Chat) + Bot Profile Dossier workbench. */

import {
  state, subscribe, updateBotModel, updateBotCapabilities, refreshModels,
  activeProject, projectById, dmActivityFor, sendDmMessage, setDmProject,
  clearDm, abortDm, toggleInspector,
} from "../store.js";
import { avatar, userAvatar, profileFor, escapeHtml } from "../avatars.js";
import {
  ICONS, formatTokens, $, $$, toast, escapeAttr, formatTime, scrollToBottom, isNearBottom, confirmDialog,
} from "../ui.js";
import {
  buildModelSelectOptionsHTML, promptCustomModel, CUSTOM_MODEL_VALUE, formatModelShort,
} from "../models.js";
import { renderMarkdown } from "../markdown.js";
import { toolsClusterHTML } from "./group.js";
import { openProjectModal } from "./projects.js";

function startersFor(botId, botName, projectName) {
  const projHint = projectName ? `「${projectName}」` : "当前项目目录";
  if (botId === "coder") {
    return [
      { icon: "folderOpen", title: "快速梳理项目结构", body: `读取 ${projHint} 的核心目录、入口文件与构建脚本。`, prompt: `请先扫描当前项目目录结构，总结核心模块与入口文件。` },
      { icon: "code", title: "定位并修复 Bug", body: "直接读取报错位置，修改代码并跑单测验证。", prompt: "帮我排查一个问题：请先查看最近的改动与测试结果，我稍后贴上具体报错。" },
      { icon: "terminal", title: "运行测试与检查", body: "在绑定项目目录内执行测试命令并汇总失败原因。", prompt: "请在当前项目目录运行现有测试或语法检查，汇总状态与潜在风险。" },
    ];
  }
  if (botId === "reviewer") {
    return [
      { icon: "shieldCheck", title: "代码审查与风险排查", body: `审查 ${projHint} 的关键逻辑、边界条件与安全隐患。`, prompt: "请审查当前项目的核心代码，按严重级别列出潜在缺陷与改进建议。" },
      { icon: "layers", title: "架构合理性评估", body: "检查模块边界、耦合度与可维护性。", prompt: "请评估当前项目的模块划分与依赖边界，指出最值得重构的 3 个点。" },
      { icon: "file", title: "文档与接口核对", body: "核对 README、API 契约与实现是否一致。", prompt: "请核对当前项目的文档/接口定义与实际代码实现是否存在偏差。" },
    ];
  }
  return [
    { icon: "bolt", title: `直连 ${botName} 执行任务`, body: "跳过群聊路由，1v1 极速响应，直接操作当前项目目录。", prompt: `你好 ${botName}，请先了解当前项目目录的基本情况，准备好接受直接任务。` },
    { icon: "folderOpen", title: "分析当前项目文件", body: `基于 ${projHint} 快速阅读并提炼关键信息。`, prompt: "请浏览当前项目目录的关键文件，给我一份简洁的结构说明。" },
    { icon: "spark", title: "头脑风暴与方案细化", body: "快速迭代需求、拆解步骤并输出可执行清单。", prompt: "我有一个新想法，帮我拆解成最小可落地的 3 个里程碑：" },
  ];
}

export class BotView {
  constructor(root, botId) {
    this.root = root;
    this.botId = botId;
    this.mode = "chat"; // "chat" | "profile"
    this.unsub = null;
    this.destroyed = false;
    this.draft = "";
    this.lastRenderSig = "";
    this.shellRendered = false;
    this.isLatched = true;
  }

  mount() {
    this.destroyed = false;
    this.render(true);
    this.unsub = subscribe(() => this.render(false));
  }

  destroy() {
    this.destroyed = true;
    if (this.unsub) { this.unsub(); this.unsub = null; }
  }

  effectiveProject() {
    const dmProjId = state.dmProjects?.[this.botId] || null;
    if (dmProjId) return projectById(dmProjId) || activeProject();
    return activeProject();
  }

  render(force = false) {
    if (this.destroyed) return;
    if (this.mode === "profile") {
      this.shellRendered = false;
      this.renderProfile();
      return;
    }
    this.renderChat(force);
  }

  headerHTML(bot, p) {
    const defaultModel = state.settings?.model || state.health?.model || "";
    const overrideModel = String(bot.model_override || "").trim();
    const effectiveModel = overrideModel || bot.model || defaultModel;
    const modelOpts = buildModelSelectOptionsHTML(state.models || [], {
      selected: overrideModel,
      defaultModel,
      allowInherit: true,
      allowCustom: true,
      compact: true,
      extraIds: effectiveModel ? [effectiveModel] : [],
    });

    const dmProjId = state.dmProjects?.[this.botId] || "";
    const globalProj = activeProject();
    const effProj = this.effectiveProject();
    const projects = state.projects || [];
    const projOptions = [
      `<option value=""${!dmProjId ? " selected" : ""}>跟随全局 (${escapeHtml(globalProj?.name || "默认工作区")})</option>`,
      ...projects.map((pr) => `<option value="${escapeAttr(pr.id)}"${dmProjId === pr.id ? " selected" : ""}>${escapeHtml(pr.name)}</option>`),
    ].join("");

    const msgCount = (state.dmMessages?.[this.botId] || []).length;

    return `
      <div class="view-head dm-head">
        ${avatar(this.botId, 32)}
        <div class="view-head-main">
          <div class="view-title">
            ${escapeHtml(p.name)}
            <span class="tag">${escapeHtml(p.role)}</span>
            <span class="tag accent is-xs">1v1 直连</span>
            ${bot.can_use_browser ? `<span class="tag green is-xs">Browser</span>` : ""}
            ${bot.can_use_computer ? `<span class="tag amber is-xs">Computer</span>` : ""}
          </div>
          <div class="view-sub dm-head-sub">
            <span class="dm-sub-item" title="${escapeAttr(effProj?.root_path || "默认工作区")}">
              ${ICONS.folder}<span>${escapeHtml(effProj?.name || "默认工作区")}</span>
            </span>
            <span class="dm-sub-sep">·</span>
            <span class="dm-sub-item">${escapeHtml(formatModelShort(effectiveModel, state.models))}</span>
          </div>
        </div>
        <div class="head-actions dm-head-actions">
          <div class="seg dm-mode-seg" role="tablist" aria-label="视图切换">
            <button type="button" data-dm-mode="chat" class="${this.mode === "chat" ? "is-on" : ""}" role="tab" aria-selected="${this.mode === "chat" ? "true" : "false"}">${ICONS.messageSquare}<span>私聊对话</span></button>
            <button type="button" data-dm-mode="profile" class="${this.mode === "profile" ? "is-on" : ""}" role="tab" aria-selected="${this.mode === "profile" ? "true" : "false"}">${ICONS.info}<span>成员档案</span></button>
          </div>
          ${this.mode === "chat" && effProj ? `<button class="head-btn" type="button" id="dm-open-files" title="浏览当前绑定项目的文件目录">${ICONS.folderOpen}<span>项目文件</span></button>` : ""}
          ${this.mode === "chat" && msgCount > 0 ? `<button class="head-btn" type="button" id="dm-clear" title="清空与该成员的私聊记录并重置会话">${ICONS.trash}<span>清空</span></button>` : ""}
          <button class="head-btn" type="button" id="bot-settings">${ICONS.edit}<span>配置</span></button>
        </div>
      </div>
      ${this.mode === "chat" ? `
      <div class="dm-context-bar">
        <div class="dm-ctx-group">
          <span class="dm-ctx-label">${ICONS.folderOpen}<span>项目目录</span></span>
          <select class="dm-ctx-select" id="dm-project-select" aria-label="绑定项目目录">${projOptions}</select>
          <button class="btn xs ghost" type="button" id="dm-project-manage" title="添加或管理项目目录">${ICONS.plus}</button>
        </div>
        <div class="dm-ctx-group">
          <span class="dm-ctx-label">${ICONS.spark}<span>模型</span></span>
          <select class="dm-ctx-select" id="dm-model-select" aria-label="成员推理模型">${modelOpts}</select>
        </div>
        ${effProj?.root_path ? `<span class="dm-ctx-path" title="${escapeAttr(effProj.root_path)}">${escapeHtml(effProj.root_path)}</span>` : ""}
      </div>` : ""}`;
  }

  bindHeader(bot, p) {
    $$("[data-dm-mode]", this.root).forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextMode = btn.dataset.dmMode;
        if (nextMode && nextMode !== this.mode) {
          this.mode = nextMode;
          this.shellRendered = false;
          this.render(true);
        }
      });
    });

    $("#bot-settings", this.root)?.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("ah:settings", { detail: { tab: "bots", botId: this.botId } }));
    });

    $("#dm-open-files", this.root)?.addEventListener("click", () => {
      const eff = this.effectiveProject();
      if (!eff) {
        openProjectModal();
        return;
      }
      toggleInspector("project", eff.id);
      document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
    });

    $("#dm-project-manage", this.root)?.addEventListener("click", () => openProjectModal());

    $("#dm-clear", this.root)?.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: `清空与 ${p.name} 的私聊记录`,
        body: "这会清空当前 1v1 对话历史并重置该成员的私聊上下文会话（不影响项目文件）。",
        confirm: "清空记录",
        danger: true,
      });
      if (!ok) return;
      try {
        await clearDm(this.botId);
        toast("私聊记录已清空", "success");
      } catch (err) {
        toast(`清空失败：${err.message}`, "error");
      }
    });

    const projSel = $("#dm-project-select", this.root);
    if (projSel) {
      projSel.addEventListener("change", async () => {
        const val = projSel.value || null;
        projSel.disabled = true;
        try {
          await setDmProject(this.botId, val);
          const target = val ? projectById(val) : activeProject();
          toast(`已将 ${p.name} 的操作目录切换至「${target?.name || "全局默认"}」`, "success");
        } catch (err) {
          toast(`切换项目失败：${err.message}`, "error");
          this.render(true);
        }
      });
    }

    const modelSel = $("#dm-model-select", this.root);
    if (modelSel) {
      const overrideModel = String(bot.model_override || "").trim();
      const defaultModel = state.settings?.model || state.health?.model || "";
      const effectiveModel = overrideModel || bot.model || defaultModel;
      modelSel.addEventListener("change", async () => {
        let nextVal = modelSel.value;
        if (nextVal === CUSTOM_MODEL_VALUE) {
          const entered = await promptCustomModel({
            title: `为 ${p.name} 指定模型`,
            current: overrideModel || effectiveModel,
          });
          if (!entered) {
            modelSel.value = overrideModel;
            return;
          }
          nextVal = entered;
        }
        modelSel.disabled = true;
        try {
          await updateBotModel(this.botId, nextVal);
          toast(
            nextVal
              ? `${p.name} 已切换至 ${formatModelShort(nextVal, state.models)}`
              : `${p.name} 已恢复跟随全局默认模型`,
            "success",
          );
        } catch (err) {
          toast(`模型切换失败：${err.message}`, "error");
          this.render(true);
        }
      });
    }
  }

  renderChat(force = false) {
    const bot = state.botsById[this.botId] || { id: this.botId };
    const p = profileFor(this.botId, bot);
    const messages = state.dmMessages?.[this.botId] || [];
    const act = dmActivityFor(this.botId);
    const effProj = this.effectiveProject();
    const dmProjId = state.dmProjects?.[this.botId] || "";

    const headerSig = JSON.stringify({
      mode: this.mode,
      name: p.name,
      role: p.role,
      model: bot.model_override || bot.model || state.settings?.model || "",
      modelsLen: (state.models || []).length,
      browser: Boolean(bot.can_use_browser),
      computer: Boolean(bot.can_use_computer),
      projects: (state.projects || []).map((pr) => `${pr.id}:${pr.name}`).join(","),
      activeProj: state.activeProjectId,
      dmProjId,
      hasMsgs: messages.length > 0,
    });

    if (!this.shellRendered || force) {
      this.root.innerHTML = `
        <div class="dm-shell">
          <div id="dm-header-slot"></div>
          <div class="chat-body" id="dm-body">
            <div class="chat-inner" id="dm-feed"></div>
          </div>
          <div class="composer-wrap">
            <div class="composer">
              <div class="composer-box" id="dm-composer-box">
                <textarea class="composer-input" id="dm-input" rows="1" placeholder="直接向 ${escapeAttr(p.name)} 下达任务（Enter 发送，Shift+Enter 换行）…">${escapeHtml(this.draft)}</textarea>
                <div class="composer-bar">
                  <span class="composer-hint" id="dm-composer-hint">1v1 直连模式 · 工作目录：${escapeHtml(effProj?.name || "默认工作区")}</span>
                  <span class="spacer"></span>
                  <button class="btn xs danger" type="button" id="dm-stop" hidden>${ICONS.stop} 停止</button>
                  <button class="send-btn" type="button" id="dm-send" aria-label="发送" title="发送（Enter）">${ICONS.send}</button>
                </div>
              </div>
            </div>
          </div>
        </div>`;
      this.shellRendered = true;
      this.lastRenderSig = "";
      this.bindComposer();
    }

    if (this.lastRenderSig !== headerSig) {
      this.lastRenderSig = headerSig;
      const headSlot = $("#dm-header-slot", this.root);
      if (headSlot) {
        headSlot.innerHTML = this.headerHTML(bot, p);
        this.bindHeader(bot, p);
      }
      const hintEl = $("#dm-composer-hint", this.root);
      if (hintEl) {
        hintEl.textContent = `1v1 直连模式 · 工作目录：${effProj?.name || "默认工作区"}`;
      }
    }

    const stopBtn = $("#dm-stop", this.root);
    const sendBtn = $("#dm-send", this.root);
    if (stopBtn) stopBtn.hidden = !act.busy;
    if (sendBtn) sendBtn.disabled = Boolean(act.busy);

    this.renderFeed(bot, p, messages, act, effProj);
  }

  renderFeed(bot, p, messages, act, effProj) {
    const bodyEl = $("#dm-body", this.root);
    const feedEl = $("#dm-feed", this.root);
    if (!bodyEl || !feedEl) return;

    const wasNearBottom = isNearBottom(bodyEl, 96);

    if (!messages.length && !act.busy) {
      feedEl.classList.add("is-empty");
      const starters = startersFor(this.botId, p.name, effProj?.name || "");
      feedEl.innerHTML = `
        <div class="welcome dm-welcome">
          <div class="welcome-orb">${avatar(this.botId, 60)}</div>
          <h1>${escapeHtml(p.name)}</h1>
          <p>${escapeHtml(p.tagline || "直连智能体 · 无需群主路由，快速完成定向任务。")}</p>
          ${effProj ? `<div class="dm-welcome-proj">
            ${ICONS.folderOpen}
            <span>当前绑定项目：<strong>${escapeHtml(effProj.name)}</strong></span>
            <code class="dm-welcome-path">${escapeHtml(effProj.root_path)}</code>
          </div>` : ""}
          <div class="suggest-grid dm-starter-grid">
            ${starters.map((s) => `
              <button class="suggest-card" type="button" data-dm-starter="${escapeAttr(s.prompt)}">
                <span class="suggest-ico">${ICONS[s.icon] || ICONS.spark}</span>
                <span class="suggest-copy">
                  <b>${escapeHtml(s.title)}</b>
                  <span>${escapeHtml(s.body)}</span>
                </span>
              </button>`).join("")}
          </div>
          <p class="welcome-note">如需调整浏览器 / 桌面操控授权或系统提示词，请点击右上角「成员档案」。</p>
        </div>`;

      $$("[data-dm-starter]", feedEl).forEach((btn) => {
        btn.addEventListener("click", () => {
          const input = $("#dm-input", this.root);
          if (!input) return;
          input.value = btn.dataset.dmStarter || "";
          this.draft = input.value;
          input.dispatchEvent(new Event("input"));
          input.focus();
        });
      });
      return;
    }

    feedEl.classList.remove("is-empty");
    const rows = messages.map((m) => {
      const isUser = m.speaker === "user";
      if (isUser) {
        return `
          <div class="msg-row is-user${m.pending ? " is-pending" : ""}${m.failed ? " is-failed" : ""}">
            <div class="msg-main">
              <div class="msg-head">
                <span class="msg-time">${escapeHtml(formatTime(m.ts))}</span>
                <span class="msg-name">你</span>
              </div>
              <div class="bubble user-bubble">${escapeHtml(m.content || "")}</div>
              ${m.failed ? `<div class="msg-error-note">发送失败，请重试</div>` : ""}
            </div>
            <div class="msg-av">${userAvatar(30)}</div>
          </div>`;
      }
      const tel = m.telemetry && typeof m.telemetry === "object" ? m.telemetry : null;
      const metaParts = [];
      if (m.model) metaParts.push(formatModelShort(m.model, state.models));
      if (tel?.tps) metaParts.push(`${Number(tel.tps).toFixed(1)} tok/s`);
      if (tel?.ttft_ms) metaParts.push(`TTFT ${Math.round(tel.ttft_ms)}ms`);
      return `
        <div class="msg-row is-bot is-assistant">
          <div class="msg-av">${avatar(this.botId, 30)}</div>
          <div class="msg-main">
            <div class="msg-head">
              <span class="msg-name">${escapeHtml(p.name)}</span>
              <span class="tag is-xs">${escapeHtml(p.role)}</span>
              <span class="msg-time">${escapeHtml(formatTime(m.ts))}</span>
            </div>
            ${toolsClusterHTML(m.tools || [])}
            <div class="bubble markdown-body">${renderMarkdown(m.content || "")}</div>
            ${metaParts.length ? `<div class="dm-msg-telemetry">${escapeHtml(metaParts.join(" · "))}</div>` : ""}
          </div>
        </div>`;
    });

    if (act.busy) {
      const liveText = act.streamText || "";
      rows.push(`
        <div class="msg-row is-bot is-assistant is-streaming">
          <div class="msg-av">${avatar(this.botId, 30)}</div>
          <div class="msg-main">
            <div class="msg-head">
              <span class="msg-name">${escapeHtml(p.name)}</span>
              <span class="tag is-xs accent">思考与执行中</span>
            </div>
            ${toolsClusterHTML(act.tools || [])}
            <div class="bubble markdown-body dm-stream-bubble">
              ${liveText ? renderMarkdown(liveText) : `<span class="dm-thinking-dots">正在直连推理并处理任务…</span>`}
              <span class="dm-cursor" aria-hidden="true"></span>
            </div>
          </div>
        </div>`);
    }

    feedEl.innerHTML = rows.join("");
    this.bindToolCards(feedEl);

    if (wasNearBottom || this.isLatched) {
      scrollToBottom(bodyEl, false);
    }
  }

  bindToolCards(feedEl) {
    $$(".tool-card-head", feedEl).forEach((head) => {
      const toggle = () => {
        const card = head.closest(".tool-card");
        const body = card?.querySelector(".tool-card-body");
        if (!card || !body) return;
        const expanded = !card.classList.contains("is-expanded");
        card.classList.toggle("is-expanded", expanded);
        body.hidden = !expanded;
        head.setAttribute("aria-expanded", expanded ? "true" : "false");
      };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
      });
    });
    $$("[data-clamp-toggle]", feedEl).forEach((btn) => {
      btn.addEventListener("click", () => {
        const box = btn.previousElementSibling;
        if (!box) return;
        const expanded = box.classList.toggle("is-expanded");
        box.classList.toggle("is-clamped", !expanded);
        btn.textContent = expanded ? "收起输出" : (btn.dataset.expandText || "展开完整输出");
      });
    });
    $$("[data-copy]", feedEl).forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const section = btn.closest(".tool-section");
        const text = section?.querySelector("code, .tool-params-wrap")?.textContent || "";
        if (text && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(() => toast("已复制到剪贴板", "success")).catch(() => {});
        }
      });
    });
  }

  bindComposer() {
    const input = $("#dm-input", this.root);
    const sendBtn = $("#dm-send", this.root);
    const stopBtn = $("#dm-stop", this.root);
    const bodyEl = $("#dm-body", this.root);

    bodyEl?.addEventListener("scroll", () => {
      this.isLatched = isNearBottom(bodyEl, 96);
    });

    const autoGrow = () => {
      if (!input) return;
      input.style.height = "auto";
      input.style.height = `${Math.min(180, Math.max(38, input.scrollHeight))}px`;
    };

    const doSend = async () => {
      const text = input?.value?.trim() || "";
      if (!text) return;
      const act = dmActivityFor(this.botId);
      if (act.busy) return;
      this.draft = "";
      input.value = "";
      autoGrow();
      this.isLatched = true;
      try {
        await sendDmMessage(this.botId, text);
      } catch (err) {
        toast(`发送失败：${err.message}`, "error");
      }
    };

    input?.addEventListener("input", () => {
      this.draft = input.value;
      autoGrow();
    });
    input?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        doSend();
      }
    });
    sendBtn?.addEventListener("click", doSend);
    stopBtn?.addEventListener("click", async () => {
      stopBtn.disabled = true;
      try {
        await abortDm(this.botId);
        toast("已发送停止信号");
      } catch (err) {
        toast(`停止失败：${err.message}`, "error");
      } finally {
        stopBtn.disabled = false;
      }
    });
  }

  renderProfile() {
    const bot = state.botsById[this.botId] || { id: this.botId };
    const p = profileFor(this.botId, bot);
    const ctx = state.context || {};
    const usage = (ctx.bots || []).find((b) => b.bot_id === this.botId);
    const tools = bot.allowed_tools || [];
    const isChief = this.botId === "ChiefRouter";
    const defaultModel = state.settings?.model || state.health?.model || "";
    const overrideModel = String(bot.model_override || "").trim();
    const effectiveModel = overrideModel || bot.model || defaultModel;
    const modelOpts = buildModelSelectOptionsHTML(state.models || [], {
      selected: overrideModel,
      defaultModel,
      allowInherit: true,
      allowCustom: true,
      extraIds: effectiveModel ? [effectiveModel] : [],
    });

    this.root.innerHTML = `
      ${this.headerHTML(bot, p)}
      <div class="chat-body">
        <div class="chat-inner bot-dossier">
          <div class="bot-hero-card">
            ${avatar(this.botId, 64)}
            <div class="bot-hero-meta">
              <h1>${escapeHtml(p.name)}</h1>
              <div class="bot-hero-tagline">${escapeHtml(p.tagline || "团队协作成员")}</div>
              <div class="bot-hero-tags">
                <span class="tag accent">${escapeHtml(p.role)}</span>
                <span class="tag ${bot.state === "working" ? "green" : ""}">${bot.state === "working" ? "工作中" : "空闲"}</span>
                <span class="tag ${overrideModel ? "accent" : ""}">${escapeHtml(formatModelShort(effectiveModel, state.models))}</span>
                ${bot.can_use_browser ? `<span class="tag green">Browser Use</span>` : ""}
                ${bot.can_use_computer ? `<span class="tag amber">Computer Use</span>` : ""}
                ${isChief ? `<span class="tag amber">总管</span>` : ""}
              </div>
            </div>
          </div>

          <div class="section-label">操控能力授权（默认关闭，需手动授予）</div>
          <div class="set-card">
            <div class="set-row">
              <div class="set-copy">
                <div class="set-name">Browser Use · 浏览器操控 <span class="tag is-xs ${bot.can_use_browser ? "green" : ""}">${bot.can_use_browser ? "已授权" : "未授权"}</span></div>
                <div class="set-desc">允许通过独立 Playwright 会话打开网页、读取 DOM、点击输入与截图（成员无法自行申请）</div>
              </div>
              <button class="cap-grant-btn${bot.can_use_browser ? " is-granted" : ""}" id="bot-toggle-browser" type="button" aria-pressed="${bot.can_use_browser ? "true" : "false"}">
                ${ICONS.globe}<span>${bot.can_use_browser ? "已授予 · 点击收回" : "手动授予权限"}</span>
              </button>
            </div>
            <div class="set-row">
              <div class="set-copy">
                <div class="set-name">Computer Use · 桌面操控 <span class="tag is-xs ${bot.can_use_computer ? "amber" : ""}">${bot.can_use_computer ? "已授权" : "未授权"}</span></div>
                <div class="set-desc">允许截屏并操控本机窗口、鼠标点击拖拽与键盘输入（高危权限，建议仅在需要时手动开启）</div>
              </div>
              <button class="cap-grant-btn is-computer${bot.can_use_computer ? " is-granted" : ""}" id="bot-toggle-computer" type="button" aria-pressed="${bot.can_use_computer ? "true" : "false"}">
                ${ICONS.monitor}<span>${bot.can_use_computer ? "已授予 · 点击收回" : "手动授予权限"}</span>
              </button>
            </div>
          </div>

          <div class="section-label">运行配置</div>
          <div class="set-card">
            <div class="set-row">
              <div class="set-copy">
                <div class="set-name">推理模型 <span class="tag is-xs ${overrideModel ? "accent" : ""}">${overrideModel ? "独立指定" : "跟随默认"}</span></div>
                <div class="set-desc">可为该成员独立选择任意网关模型，修改后立即对所有活跃群聊与私聊生效</div>
              </div>
              <div class="bot-model-inline">
                <select class="select" id="bot-model-select" aria-label="选择成员模型">${modelOpts}</select>
                <button class="btn sm ghost" id="bot-model-refresh" type="button" title="从网关重新探测可用模型" aria-label="刷新网关模型">${ICONS.refresh}</button>
              </div>
            </div>
            <div class="set-row"><div class="set-copy"><div class="set-name">采样温度</div><div class="set-desc">越低越稳定，越高越具创造性</div></div><div class="set-value is-mono">${Number(bot.temperature || 0).toFixed(1)}</div></div>
            <div class="set-row"><div class="set-copy"><div class="set-name">执行权限</div><div class="set-desc">${bot.read_only ? "只读成员：不能写文件或执行命令" : "可写成员：允许调用文件写入与终端命令"}</div></div><div class="set-value"><span class="tag ${bot.read_only ? "" : "accent"}">${bot.read_only ? "只读" : "可写"}</span></div></div>
            <div class="set-row"><div class="set-copy"><div class="set-name">本轮用量</div><div class="set-desc">累计上下文 Token 与消息数</div></div><div class="set-value is-mono">${formatTokens(usage?.tokens)} tok · ${usage?.messages_count || 0} 条</div></div>
          </div>

          <div class="section-label">可用工具 <span class="count">${tools.length}</span></div>
          <div class="set-card bot-tools-card">
            ${tools.map((t) => `<span class="tool-chip">${escapeHtml(t)}</span>`).join("") || `<span class="empty-mini">没有挂载工具</span>`}
          </div>

          <div class="section-label">身份设定</div>
          <div class="set-card bot-prompt-card">
            <div class="bot-prompt-text">${escapeHtml(bot.system_prompt || "未设置")}</div>
          </div>
        </div>
      </div>`;

    this.bindHeader(bot, p);

    const selectEl = $("#bot-model-select", this.root);
    if (selectEl) {
      selectEl.onchange = async () => {
        let nextVal = selectEl.value;
        if (nextVal === CUSTOM_MODEL_VALUE) {
          const entered = await promptCustomModel({
            title: `为 ${p.name} 指定模型`,
            current: overrideModel || effectiveModel,
          });
          if (!entered) {
            selectEl.value = overrideModel;
            return;
          }
          nextVal = entered;
        }
        selectEl.disabled = true;
        try {
          await updateBotModel(this.botId, nextVal);
          const label = nextVal
            ? `${p.name} 已切换至 ${formatModelShort(nextVal, state.models)}`
            : `${p.name} 已恢复跟随全局默认模型`;
          toast(label, "success");
        } catch (err) {
          toast(`模型切换失败：${err.message}`, "error");
          this.render(true);
        }
      };
    }

    const refreshBtn = $("#bot-model-refresh", this.root);
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        refreshBtn.disabled = true;
        try {
          const res = await refreshModels({ refresh: true });
          const count = (res?.models || state.models || []).length;
          toast(res?.gateway_ok === false ? `网关离线，沿用本地 ${count} 个缓存模型` : `已从网关同步 ${count} 个模型`, "success");
        } catch (err) {
          toast(`刷新模型失败：${err.message}`, "error");
        } finally {
          refreshBtn.disabled = false;
        }
      };
    }

    const bindCapToggle = (selector, key, label) => {
      const btn = $(selector, this.root);
      if (!btn) return;
      btn.onclick = async () => {
        const nextVal = !Boolean(bot[key]);
        btn.disabled = true;
        try {
          await updateBotCapabilities(this.botId, { [key]: nextVal });
          toast(nextVal ? `已手动授予 ${p.name} ${label} 权限` : `已收回 ${p.name} 的 ${label} 权限`, nextVal ? "success" : "info");
        } catch (err) {
          toast(`权限更新失败：${err.message}`, "error");
          btn.disabled = false;
        }
      };
    };
    bindCapToggle("#bot-toggle-browser", "can_use_browser", "Browser Use");
    bindCapToggle("#bot-toggle-computer", "can_use_computer", "Computer Use");
  }
}
