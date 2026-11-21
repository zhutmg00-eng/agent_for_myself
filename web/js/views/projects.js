/* Projects — directory workspace manager, folder browser modal, and file explorer inspector. */

import { api } from "../api.js";
import {
  state, activeProject, projectById, createProject, activateProject, deleteProject, toggleInspector,
} from "../store.js";
import {
  ICONS, $, $$, toast, openModal, closeModal, confirmDialog, escapeHtml, escapeAttr, fileName, fileBadge,
} from "../ui.js";
import { renderMarkdown } from "../markdown.js";

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

export function openProjectModal({ onActivated } = {}) {
  let browsePath = "";
  let browseOpen = false;
  let browseData = null;
  let browseLoading = false;
  let browseError = "";

  const renderProjectList = () => {
    const projects = state.projects || [];
    const active = activeProject();
    if (!projects.length) {
      return `<div class="empty-mini">还没有绑定任何项目目录，在下方添加一个本地路径开始协作。</div>`;
    }
    return projects.map((p) => {
      const isActive = active && active.id === p.id;
      return `<div class="proj-row${isActive ? " is-active" : ""}" data-proj-id="${escapeAttr(p.id)}">
        <div class="proj-row-ico">${isActive ? ICONS.folderOpen : ICONS.folder}</div>
        <div class="proj-row-copy">
          <div class="proj-row-top">
            <span class="proj-row-name">${escapeHtml(p.name)}</span>
            ${isActive ? `<span class="tag is-xs accent">当前工作目录</span>` : ""}
            ${p.git_branch ? `<span class="tag is-xs proj-git-tag">${ICONS.gitBranch}<span>${escapeHtml(p.git_branch)}</span></span>` : ""}
            ${p.exists === false ? `<span class="tag is-xs red">目录不存在</span>` : ""}
          </div>
          <div class="proj-row-path" title="${escapeAttr(p.root_path)}">${escapeHtml(p.root_path)}</div>
        </div>
        <div class="proj-row-actions">
          <button class="btn xs ghost" type="button" data-proj-files="${escapeAttr(p.id)}" title="浏览项目文件">${ICONS.file} 文件</button>
          ${isActive
            ? `<span class="proj-active-check" title="当前项目">${ICONS.check}</span>`
            : `<button class="btn xs" type="button" data-proj-use="${escapeAttr(p.id)}">切换</button>`}
          ${projects.length > 1
            ? `<button class="btn xs ghost danger" type="button" data-proj-del="${escapeAttr(p.id)}" title="移除项目绑定" aria-label="移除">${ICONS.trash}</button>`
            : ""}
        </div>
      </div>`;
    }).join("");
  };

  const renderBrowserHTML = () => {
    if (!browseOpen) return "";
    if (browseLoading) {
      return `<div class="fs-browser"><div class="empty-mini">正在读取目录列表…</div></div>`;
    }
    if (browseError) {
      return `<div class="fs-browser"><div class="appr-error">${escapeHtml(browseError)}</div></div>`;
    }
    if (!browseData) return "";
    const curDir = browseData.current || browseData.path || "";
    const dirs = Array.isArray(browseData.entries)
      ? browseData.entries
      : (Array.isArray(browseData.directories) ? browseData.directories : []);
    return `
      <div class="fs-browser" id="fs-browser">
        <div class="fs-browser-bar">
          ${browseData.parent
            ? `<button class="btn xs ghost" type="button" data-fs-go="${escapeAttr(browseData.parent)}" title="上级目录">${ICONS.arrowUp} 上级</button>`
            : ""}
          <span class="fs-browser-cur" title="${escapeAttr(curDir)}">${escapeHtml(curDir)}</span>
          <button class="btn xs primary" type="button" id="fs-pick-current">选择此目录</button>
        </div>
        <div class="fs-browser-list">
          ${dirs.length
            ? dirs.map((d) => `<button class="fs-dir-item" type="button" data-fs-go="${escapeAttr(d.path)}">
                <span class="fs-dir-ico">${ICONS.folder}</span>
                <span class="fs-dir-name">${escapeHtml(d.name)}</span>
                ${d.is_git ? `<span class="tag is-xs">git</span>` : ""}
              </button>`).join("")
            : `<div class="empty-mini">该目录下没有子文件夹</div>`}
        </div>
      </div>`;
  };

  openModal(`
    <div class="modal modal-lg" role="dialog" aria-modal="true" id="project-modal">
      <div class="modal-head">
        <div>
          <h2>项目管理 · 工作目录绑定</h2>
          <p>为智能体指定本地代码仓或资料目录；群聊与 1v1 私聊的工具读写与终端命令均将在绑定目录内执行。</p>
        </div>
        <span class="spacer"></span>
        <button class="modal-close" data-close aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="modal-body proj-modal-body">
        <div class="section-label is-first">已绑定项目 <span class="count" id="proj-count">${(state.projects || []).length}</span></div>
        <div class="proj-list" id="proj-list">${renderProjectList()}</div>

        <div class="section-label">绑定新项目目录</div>
        <div class="proj-create-box">
          <div class="proj-form-grid">
            <div class="field">
              <label for="proj-name">项目名称</label>
              <input class="input" id="proj-name" placeholder="例如：my-webapp（留空自动取目录名）" maxlength="50">
            </div>
            <div class="field">
              <label for="proj-desc">备注说明（可选）</label>
              <input class="input" id="proj-desc" placeholder="技术栈、目标或注意事项" maxlength="120">
            </div>
          </div>
          <div class="field">
            <label for="proj-path">本地目录路径</label>
            <div class="proj-path-row">
              <input class="input is-mono" id="proj-path" placeholder="输入绝对路径，例如 /workspace/my-project" spellcheck="false">
              <button class="btn sm" type="button" id="proj-browse-btn">${ICONS.folderOpen} 浏览目录</button>
            </div>
          </div>
          <div id="proj-browser-slot"></div>
          <div class="proj-form-foot">
            <label class="proj-check-label">
              <input type="checkbox" id="proj-create-missing">
              <span>若路径不存在则自动创建该目录</span>
            </label>
            <button class="btn primary sm" type="button" id="proj-submit">${ICONS.plus} 绑定并设为当前项目</button>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-close>关闭</button>
      </div>
    </div>`, {
    onMount(root) {
      const redrawList = () => {
        const listEl = $("#proj-list", root);
        const countEl = $("#proj-count", root);
        if (listEl) listEl.innerHTML = renderProjectList();
        if (countEl) countEl.textContent = String((state.projects || []).length);
        bindListActions();
      };

      const redrawBrowser = () => {
        const slot = $("#proj-browser-slot", root);
        if (!slot) return;
        slot.innerHTML = renderBrowserHTML();
        $$("[data-fs-go]", slot).forEach((btn) => {
          btn.addEventListener("click", () => loadBrowse(btn.dataset.fsGo));
        });
        $("#fs-pick-current", slot)?.addEventListener("click", () => {
          const picked = browseData?.current || browseData?.path || "";
          if (picked) {
            const pathInput = $("#proj-path", root);
            const nameInput = $("#proj-name", root);
            if (pathInput) pathInput.value = picked;
            if (nameInput && !nameInput.value.trim()) {
              nameInput.value = fileName(picked);
            }
            browseOpen = false;
            redrawBrowser();
          }
        });
      };

      const loadBrowse = async (targetPath = "") => {
        browseOpen = true;
        browseLoading = true;
        browseError = "";
        redrawBrowser();
        try {
          browseData = await api.fsBrowse(targetPath);
          browsePath = browseData?.current || browseData?.path || targetPath;
          browseLoading = false;
        } catch (err) {
          browseLoading = false;
          browseError = err?.message || "目录读取失败";
        }
        redrawBrowser();
      };

      const bindListActions = () => {
        $$("[data-proj-use]", root).forEach((btn) => {
          btn.addEventListener("click", async () => {
            const id = btn.dataset.projUse;
            btn.disabled = true;
            try {
              await activateProject(id);
              const proj = projectById(id);
              toast(`当前项目已切换为 ${proj?.name || id}`, "success");
              redrawList();
              if (onActivated) onActivated(proj);
            } catch (err) {
              btn.disabled = false;
              toast(`切换失败：${err.message}`, "error");
            }
          });
        });

        $$("[data-proj-files]", root).forEach((btn) => {
          btn.addEventListener("click", () => {
            const id = btn.dataset.projFiles;
            closeModal();
            toggleInspector("project", id);
            document.dispatchEvent(new CustomEvent("ah:inspector", { detail: state.inspector }));
          });
        });

        $$("[data-proj-del]", root).forEach((btn) => {
          btn.addEventListener("click", async () => {
            const id = btn.dataset.projDel;
            const proj = projectById(id);
            const ok = await confirmDialog({
              title: "移除项目绑定",
              body: `确定要从工作台移除「${proj?.name || id}」吗？这不会删除磁盘上的任何本地文件。`,
              confirm: "移除",
              danger: true,
            });
            if (!ok) {
              openProjectModal({ onActivated });
              return;
            }
            try {
              await deleteProject(id);
              toast(`已移除项目「${proj?.name || id}」`);
              openProjectModal({ onActivated });
            } catch (err) {
              toast(`移除失败：${err.message}`, "error");
              openProjectModal({ onActivated });
            }
          });
        });
      };

      $$("[data-close]", root).forEach((b) => b.addEventListener("click", closeModal));
      bindListActions();

      $("#proj-browse-btn", root)?.addEventListener("click", () => {
        if (browseOpen) {
          browseOpen = false;
          redrawBrowser();
          return;
        }
        const curInput = $("#proj-path", root)?.value?.trim() || activeProject()?.root_path || "";
        loadBrowse(curInput);
      });

      $("#proj-submit", root)?.addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        const rootPath = $("#proj-path", root)?.value?.trim() || "";
        const name = $("#proj-name", root)?.value?.trim() || "";
        const description = $("#proj-desc", root)?.value?.trim() || "";
        const createIfMissing = Boolean($("#proj-create-missing", root)?.checked);
        if (!rootPath) {
          toast("请先输入或浏览选择本地目录路径", "error");
          $("#proj-path", root)?.focus();
          return;
        }
        btn.disabled = true;
        try {
          const created = await createProject({
            name: name || undefined,
            root_path: rootPath,
            description,
            create_if_missing: createIfMissing,
            activate: true,
          });
          toast(`已绑定项目「${created?.name || fileName(rootPath)}」`, "success");
          $("#proj-name", root).value = "";
          $("#proj-path", root).value = "";
          $("#proj-desc", root).value = "";
          browseOpen = false;
          redrawBrowser();
          redrawList();
          if (onActivated) onActivated(created);
        } catch (err) {
          toast(`绑定失败：${err.message}`, "error");
        } finally {
          btn.disabled = false;
        }
      });
    },
  });
}

/* ------------------------------------------------ Project File Explorer */

const treeState = {
  projectId: "",
  subpath: "",
  loading: false,
  error: "",
  entries: [],
  truncated: false,
  gitBranch: null,
};

export function projectInspectorHTML(projectId) {
  const proj = projectById(projectId) || activeProject();
  if (!proj) {
    return `<div class="insp-head"><h2>项目文件</h2><button class="modal-close" data-insp-close aria-label="关闭">${ICONS.close}</button></div>
      <div class="insp-body"><div class="empty-mini">尚未选择项目。</div></div>`;
  }
  const sameProj = treeState.projectId === proj.id;
  const subpath = sameProj ? treeState.subpath : "";
  const crumbs = subpath ? subpath.split("/").filter(Boolean) : [];
  const entries = sameProj ? treeState.entries : [];
  const branch = (sameProj && treeState.gitBranch) || proj.git_branch || "";

  return `
    <div class="insp-head">
      <div class="insp-head-copy">
        <h2 title="${escapeAttr(proj.name)}">${escapeHtml(proj.name)}</h2>
        <div class="insp-sub is-mono" title="${escapeAttr(proj.root_path)}">${escapeHtml(proj.root_path)}</div>
      </div>
      <button class="btn xs ghost" type="button" id="pi-manage" title="切换或管理项目">${ICONS.folderOpen}</button>
      <button class="modal-close" data-insp-close aria-label="关闭">${ICONS.close}</button>
    </div>
    <div class="insp-body proj-insp-body">
      <div class="proj-insp-meta">
        ${branch ? `<span class="tag accent proj-git-tag">${ICONS.gitBranch}<span>${escapeHtml(branch)}</span></span>` : `<span class="tag">本地目录</span>`}
        <button class="mini-refresh-btn" type="button" id="pi-refresh" title="刷新目录">${ICONS.refresh}<span>刷新</span></button>
      </div>
      <div class="proj-crumbs" id="pi-crumbs">
        <button class="proj-crumb${!subpath ? " is-current" : ""}" type="button" data-pi-sub="">根目录</button>
        ${crumbs.map((seg, idx) => {
          const pathTo = crumbs.slice(0, idx + 1).join("/");
          const isLast = idx === crumbs.length - 1;
          return `<span class="proj-crumb-sep">/</span><button class="proj-crumb${isLast ? " is-current" : ""}" type="button" data-pi-sub="${escapeAttr(pathTo)}">${escapeHtml(seg)}</button>`;
        }).join("")}
      </div>
      <div class="proj-tree" id="pi-tree">
        ${treeState.loading && sameProj
          ? `<div class="empty-mini">正在读取目录…</div>`
          : treeState.error && sameProj
            ? `<div class="appr-error">${escapeHtml(treeState.error)}</div>`
            : entries.length
              ? entries.map((e) => {
                const isDir = Boolean(e.is_dir || e.type === "dir");
                const rel = e.rel_path || e.path || e.name;
                return isDir
                  ? `<button class="proj-tree-row is-dir" type="button" data-pi-dir="${escapeAttr(rel)}">
                      <span class="proj-tree-ico">${ICONS.folder}</span>
                      <span class="proj-tree-name">${escapeHtml(e.name)}</span>
                      <span class="proj-tree-arrow">${ICONS.chevronRight}</span>
                    </button>`
                  : `<button class="proj-tree-row is-file" type="button" data-pi-file="${escapeAttr(rel)}">
                      <span class="proj-tree-badge">${escapeHtml(fileBadge(e.name))}</span>
                      <span class="proj-tree-name">${escapeHtml(e.name)}</span>
                      <span class="proj-tree-size">${escapeHtml(formatBytes(e.size))}</span>
                    </button>`;
              }).join("")
              : `<div class="empty-mini">${sameProj ? "该目录为空。" : "正在加载项目文件…"}</div>`}
        ${sameProj && treeState.truncated ? `<div class="field-hint" style="padding:8px 4px">仅显示前 160 项，进入子目录查看更多。</div>` : ""}
      </div>
    </div>`;
}

export function bindProjectInspector(root, projectId, rerender) {
  const proj = projectById(projectId) || activeProject();
  $("[data-insp-close]", root)?.addEventListener("click", () => {
    state.inspector = null;
    document.dispatchEvent(new CustomEvent("ah:inspector", { detail: null }));
  });
  $("#pi-manage", root)?.addEventListener("click", () => openProjectModal());
  if (!proj) return;

  const fetchTree = async (subpath = "") => {
    treeState.projectId = proj.id;
    treeState.subpath = subpath;
    treeState.loading = true;
    treeState.error = "";
    rerender();
    try {
      const res = await api.projectTree(proj.id, subpath);
      if (treeState.projectId !== proj.id || treeState.subpath !== subpath) return;
      treeState.entries = Array.isArray(res?.entries) ? res.entries : [];
      treeState.truncated = Boolean(res?.truncated);
      treeState.gitBranch = res?.git_branch || proj.git_branch || null;
      treeState.loading = false;
    } catch (err) {
      treeState.loading = false;
      treeState.error = err?.message || "读取目录失败";
    }
    rerender();
  };

  if (treeState.projectId !== proj.id && !treeState.loading) {
    fetchTree("");
    return;
  }

  $("#pi-refresh", root)?.addEventListener("click", () => fetchTree(treeState.subpath || ""));
  $$("[data-pi-sub]", root).forEach((btn) => {
    btn.addEventListener("click", () => fetchTree(btn.dataset.piSub || ""));
  });
  $$("[data-pi-dir]", root).forEach((btn) => {
    btn.addEventListener("click", () => fetchTree(btn.dataset.piDir || ""));
  });
  $$("[data-pi-file]", root).forEach((btn) => {
    btn.addEventListener("click", () => openProjectFilePreview(proj.id, btn.dataset.piFile || ""));
  });
}

export function openProjectFilePreview(projectId, relPath) {
  if (!projectId || !relPath) return;
  const proj = projectById(projectId);
  openModal(`
    <div class="modal preview-modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div style="min-width:0">
          <h2 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(fileName(relPath))}</h2>
          <p>${escapeHtml(proj?.name || "项目")} · ${escapeHtml(relPath)}</p>
        </div>
        <span class="spacer"></span>
        <button class="modal-close" data-close aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="preview-meta" id="proj-preview-meta"></div>
      <div class="preview-body" id="proj-preview-body">正在读取…</div>
      <div class="modal-foot">
        <button class="btn ghost" id="proj-preview-toggle" hidden>查看原文</button>
        <button class="btn ghost" data-close>关闭</button>
      </div>
    </div>`, {
    onMount(root) {
      $$("[data-close]", root).forEach((b) => b.addEventListener("click", closeModal));
      api.projectFile(projectId, relPath).then((data) => {
        const body = $("#proj-preview-body", root);
        const toggle = $("#proj-preview-toggle", root);
        const meta = $("#proj-preview-meta", root);
        if (!body) return;
        const raw = data.content || "";
        const isMarkdown = /\.(md|markdown)$/i.test(relPath);
        let showRaw = !isMarkdown;
        const draw = () => {
          if (data.binary) {
            body.className = "preview-body";
            body.textContent = "这是二进制文件，无法在工作台内直接预览。";
          } else if (isMarkdown && !showRaw) {
            body.className = "preview-body preview-md";
            body.innerHTML = raw.trim() ? renderMarkdown(raw) : `<p style="color:var(--text-3)">（空文件）</p>`;
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
        toggle?.addEventListener("click", () => { showRaw = !showRaw; draw(); });
        if (meta) {
          meta.innerHTML = `
            <span class="tag accent">${escapeHtml(fileBadge(relPath))}</span>
            <span class="tag">${escapeHtml(formatBytes(data.size || 0))}</span>
            ${data.truncated ? `<span class="tag amber">仅展示前 160 KB</span>` : ""}
            <span style="font-size:11px;color:var(--text-3);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(relPath)}</span>`;
        }
      }).catch((err) => {
        const body = $("#proj-preview-body", root);
        if (body) body.textContent = `读取失败：${err.message}`;
      });
    },
  });
}
