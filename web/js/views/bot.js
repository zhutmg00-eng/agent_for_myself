/* Bot profile — identity, model, tools, prompt. */

import { state, subscribe } from "../store.js";
import { avatar, profileFor, escapeHtml } from "../avatars.js";
import { ICONS, formatTokens, $, $$, toast } from "../ui.js";

export class BotView {
  constructor(root, botId) {
    this.root = root;
    this.botId = botId;
    this.unsub = null;
  }

  mount() {
    this.render();
    this.unsub = subscribe(() => this.render());
  }

  destroy() { if (this.unsub) this.unsub(); }

  render() {
    const bot = state.botsById[this.botId] || { id: this.botId };
    const p = profileFor(this.botId, bot);
    const ctx = state.context || {};
    const usage = (ctx.bots || []).find((b) => b.bot_id === this.botId);
    const tools = bot.allowed_tools || [];
    const isChief = this.botId === "ChiefRouter";
    this.root.innerHTML = `
      <div class="view-head">
        <div class="view-head-main">
          <div class="view-title">${escapeHtml(p.name)} <span class="tag">${escapeHtml(p.role)}</span></div>
          <div class="view-sub">团队成员资料</div>
        </div>
        <div class="head-actions">
          <button class="head-btn" id="bot-settings">${ICONS.edit}<span>编辑</span></button>
        </div>
      </div>
      <div class="chat-body">
        <div class="chat-inner" style="max-width:720px">
          <div style="display:flex;align-items:center;gap:18px;padding:28px 0 8px">
            ${avatar(this.botId, 72)}
            <div style="min-width:0">
              <h1 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-.01em">${escapeHtml(p.name)}</h1>
              <div style="margin-top:4px;color:var(--text-2);font-size:13px">${escapeHtml(p.tagline)}</div>
              <div style="margin-top:8px;display:flex;gap:6px">
                <span class="tag accent">${escapeHtml(p.role)}</span>
                <span class="tag">${bot.state === "working" ? "工作中" : "空闲"}</span>
                ${isChief ? `<span class="tag amber">总管</span>` : ""}
              </div>
            </div>
          </div>

          <div class="section-label">配置</div>
          <div class="set-card">
            <div class="set-row"><div class="set-copy"><div class="set-name">模型</div><div class="set-desc">该成员使用的推理模型</div></div><div class="set-value">${escapeHtml(bot.model || state.settings?.model || "")}</div></div>
            <div class="set-row"><div class="set-copy"><div class="set-name">温度</div><div class="set-desc">越低越稳定，越高越发散</div></div><div class="set-value">${Number(bot.temperature || 0).toFixed(1)}</div></div>
            <div class="set-row"><div class="set-copy"><div class="set-name">权限</div><div class="set-desc">${bot.read_only ? "只读成员：不能写文件或执行命令" : "可写成员：可以调用写文件与命令工具"}</div></div><div class="set-value">${bot.read_only ? "只读" : "可写"}</div></div>
            <div class="set-row"><div class="set-copy"><div class="set-name">本轮用量</div><div class="set-desc">累计上下文与消息数</div></div><div class="set-value">${formatTokens(usage?.tokens)} tokens · ${usage?.messages_count || 0} 条</div></div>
          </div>

          <div class="section-label">可用工具 <span class="count">${tools.length}</span></div>
          <div class="set-card" style="padding:12px 14px;display:flex;flex-wrap:wrap;gap:6px">
            ${tools.map((t) => `<span class="tag" style="height:22px;font-family:var(--mono);font-size:10.5px">${escapeHtml(t)}</span>`).join("") || `<span class="empty-mini">没有挂载工具</span>`}
          </div>

          <div class="section-label">身份设定</div>
          <div class="set-card" style="padding:13px 14px">
            <div style="white-space:pre-wrap;font-size:12px;line-height:1.65;color:var(--text-2);max-height:220px;overflow:auto">${escapeHtml(bot.system_prompt || "未设置")}</div>
          </div>
        </div>
      </div>`;
    $("#bot-settings", this.root).onclick = () => {
      document.dispatchEvent(new CustomEvent("ah:settings", { detail: { tab: "bots", botId: this.botId } }));
    };
  }
}
