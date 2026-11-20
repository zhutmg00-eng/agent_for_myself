/* Bot profile — identity, model, tools, prompt. */

import { state, subscribe, updateBotModel, updateBotCapabilities, refreshModels } from "../store.js";
import { avatar, profileFor, escapeHtml } from "../avatars.js";
import { ICONS, formatTokens, $, toast } from "../ui.js";
import {
  buildModelSelectOptionsHTML, promptCustomModel, CUSTOM_MODEL_VALUE, formatModelShort,
} from "../models.js";

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
                <div class="set-desc">可为该成员独立选择任意网关模型，修改后立即对所有活跃群聊生效</div>
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

    $("#bot-settings", this.root).onclick = () => {
      document.dispatchEvent(new CustomEvent("ah:settings", { detail: { tab: "bots", botId: this.botId } }));
    };

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
          this.render();
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

