/* Bot profile — identity, model, tools, prompt. */

import { state, subscribe } from "../store.js";
import { avatar, profileFor, escapeHtml } from "../avatars.js";
import { ICONS, formatTokens, $ } from "../ui.js";

export class BotView {
  constructor(root, botId) {
    this.root = root;
    this.botId = botId;
    this.unsub = null;
    this.destroyed = false;
  }

  mount() {
    this.destroyed = false;
    this.render();
    this.unsub = subscribe(() => this.render());
  }

  destroy() {
    this.destroyed = true;
    if (this.unsub) { this.unsub(); this.unsub = null; }
  }

  render() {
    if (this.destroyed) return;
    const bot = state.botsById[this.botId] || { id: this.botId };
    const p = profileFor(this.botId, bot);
    const ctx = state.context || {};
    const usage = (ctx.bots || []).find((b) => b.bot_id === this.botId);
    const tools = bot.allowed_tools || [];
    const isChief = this.botId === "ChiefRouter";
    this.root.innerHTML = `
      <div class="view-head">
        ${avatar(this.botId, 32)}
        <div class="view-head-main">
          <div class="view-title">${escapeHtml(p.name)} <span class="tag">${escapeHtml(p.role)}</span></div>
          <div class="view-sub">团队成员配置与工具能力</div>
        </div>
        <div class="head-actions">
          <button class="head-btn" id="bot-settings">${ICONS.edit}<span>编辑配置</span></button>
        </div>
      </div>
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
                ${isChief ? `<span class="tag amber">总管</span>` : ""}
              </div>
            </div>
          </div>

          <div class="section-label">运行配置</div>
          <div class="set-card">
            <div class="set-row"><div class="set-copy"><div class="set-name">推理模型</div><div class="set-desc">该成员当前使用的推理模型</div></div><div class="set-value is-mono">${escapeHtml(bot.model || state.settings?.model || "默认模型")}</div></div>
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
    $("#bot-settings", this.root).onclick = () => {
      document.dispatchEvent(new CustomEvent("ah:settings", { detail: { tab: "bots", botId: this.botId } }));
    };
  }
}
