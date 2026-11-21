/**
 * Project & Local Filesystem Workspace helpers.
 *
 * Allows binding specific local directories as AgentFusion "Projects" so that
 * Direct Chats and Group Rooms operate directly inside the user's target
 * codebase with safe directory browsing, tree inspection, and file previews.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertNotC } from "./config.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
]);

const MAX_PREVIEW_BYTES = 160_000;
const MAX_TREE_ENTRIES = 300;

/** Normalize and verify a project directory path (respecting the C:\ floor on Windows). */
export function normalizeProjectPath(rawPath) {
  const text = String(rawPath ?? "").trim();
  if (!text) throw new Error("项目目录路径不能为空");
  const expanded = text.startsWith("~/") || text === "~"
    ? path.join(os.homedir(), text.slice(1))
    : text;
  const resolved = path.resolve(expanded);
  return assertNotC(resolved, "project directory");
}

/** Validate (and optionally create) a target directory on disk. */
export function validateProjectDir(rawPath, { createIfMissing = false } = {}) {
  const rootPath = normalizeProjectPath(rawPath);
  if (!fs.existsSync(rootPath)) {
    if (createIfMissing) {
      fs.mkdirSync(rootPath, { recursive: true });
    } else {
      const err = new Error(`目录不存在：${rootPath}`);
      err.status = 400;
      throw err;
    }
  }
  const stat = fs.statSync(rootPath);
  if (!stat.isDirectory()) {
    const err = new Error(`路径不是文件夹：${rootPath}`);
    err.status = 400;
    throw err;
  }
  const baseName = path.basename(rootPath) || rootPath;
  return { root_path: rootPath, default_name: baseName };
}

/** Pure-fs git branch detection (reads .git/HEAD without spawning git). */
export function detectGitBranch(rootPath) {
  try {
    const headFile = path.join(rootPath, ".git", "HEAD");
    if (!fs.existsSync(headFile)) return null;
    const raw = fs.readFileSync(headFile, "utf8").trim();
    if (raw.startsWith("ref: ")) {
      return raw.replace(/^ref:\s*refs\/heads\//, "").trim() || null;
    }
    return raw ? raw.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** Guard against path traversal: resolved path must stay inside rootPath. */
export function resolveInsideProject(rootPath, relPath = "") {
  const root = path.resolve(String(rootPath || ""));
  const rel = String(relPath ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const target = rel ? path.resolve(root, rel) : root;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    const err = new Error("路径越界：只能访问当前项目目录内的文件");
    err.status = 403;
    throw err;
  }
  return { root, target, relPath: path.relative(root, target).replace(/\\/g, "/") };
}

/** Browse local directories for the UI folder picker modal. */
export function browseDirectory(rawPath = "") {
  let target;
  if (!rawPath || !String(rawPath).trim()) {
    target = process.cwd();
  } else {
    const text = String(rawPath).trim();
    const expanded = text.startsWith("~/") || text === "~"
      ? path.join(os.homedir(), text.slice(1))
      : text;
    target = path.resolve(expanded);
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    const err = new Error(`无法打开目录：${target}`);
    err.status = 400;
    throw err;
  }
  const parent = path.dirname(target);
  const entries = [];
  let dirents = [];
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    const e = new Error(`无权读取目录：${err?.message || target}`);
    e.status = 403;
    throw e;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith(".") && d.name !== ".aistudio") continue;
    const full = path.join(target, d.name);
    let isGit = false;
    try {
      isGit = fs.existsSync(path.join(full, ".git"));
    } catch {
      isGit = false;
    }
    entries.push({
      name: d.name,
      path: full,
      is_dir: true,
      is_git: isGit,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return {
    current: target,
    parent: parent !== target ? parent : null,
    entries: entries.slice(0, 200),
  };
}

/** List directory entries inside a registered project. */
export function listProjectTree(rootPath, subpath = "") {
  const { root, target, relPath } = resolveInsideProject(rootPath, subpath);
  if (!fs.existsSync(target)) {
    const err = new Error(`目录不存在：${relPath || root}`);
    err.status = 404;
    throw err;
  }
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    const err = new Error(`不是目录：${relPath}`);
    err.status = 400;
    throw err;
  }
  const dirents = fs.readdirSync(target, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const d of dirents) {
    if (d.isDirectory() && IGNORED_DIRS.has(d.name)) continue;
    const full = path.join(target, d.name);
    const entryRel = path.relative(root, full).replace(/\\/g, "/");
    let size = 0;
    let mtime = null;
    try {
      const st = fs.statSync(full);
      size = st.isDirectory() ? 0 : st.size;
      mtime = st.mtime.toISOString();
    } catch {
      /* ignore stat errors on broken symlinks */
    }
    const item = {
      name: d.name,
      rel_path: entryRel,
      is_dir: d.isDirectory(),
      size,
      mtime,
    };
    if (d.isDirectory()) dirs.push(item);
    else files.push(item);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  dirs.sort(byName);
  files.sort(byName);

  const combined = [...dirs, ...files];
  const parentSubpath = relPath ? path.posix.dirname(relPath) : null;
  return {
    root_path: root,
    subpath: relPath,
    parent_subpath: parentSubpath === "." ? "" : parentSubpath,
    git_branch: detectGitBranch(root),
    total: combined.length,
    truncated: combined.length > MAX_TREE_ENTRIES,
    entries: combined.slice(0, MAX_TREE_ENTRIES),
  };
}

/** Read a bounded text preview of a file inside a registered project. */
export function readProjectFilePreview(rootPath, relPath) {
  if (!relPath || !String(relPath).trim()) {
    const err = new Error("缺少文件路径");
    err.status = 400;
    throw err;
  }
  const { target, relPath: cleanRel } = resolveInsideProject(rootPath, relPath);
  if (!fs.existsSync(target)) {
    const err = new Error(`文件不存在：${cleanRel}`);
    err.status = 404;
    throw err;
  }
  const st = fs.statSync(target);
  if (!st.isFile()) {
    const err = new Error(`不是文件：${cleanRel}`);
    err.status = 400;
    throw err;
  }
  const fd = fs.openSync(target, "r");
  let buf;
  try {
    const toRead = Math.min(st.size, MAX_PREVIEW_BYTES);
    buf = Buffer.alloc(toRead);
    if (toRead > 0) fs.readSync(fd, buf, 0, toRead, 0);
  } finally {
    fs.closeSync(fd);
  }
  // Detect binary via NUL byte in first 4KB
  const probeLen = Math.min(buf.length, 4096);
  let binary = false;
  for (let i = 0; i < probeLen; i += 1) {
    if (buf[i] === 0) {
      binary = true;
      break;
    }
  }
  return {
    path: cleanRel,
    name: path.basename(target),
    size: st.size,
    mtime: st.mtime.toISOString(),
    truncated: st.size > MAX_PREVIEW_BYTES,
    binary,
    content: binary ? "" : buf.toString("utf8"),
  };
}

export default {
  normalizeProjectPath,
  validateProjectDir,
  detectGitBranch,
  resolveInsideProject,
  browseDirectory,
  listProjectTree,
  readProjectFilePreview,
};
