/**
 * Group file space for one room.
 *
 * Vision requirement: a dedicated file agent (librarian) organizes group files,
 * and when a file's address changes every member is told in real time. Members
 * therefore reference files by stable `file_id`, never by path.
 *
 * Disk layout: <DATA>/rooms/<roomId>/files/<relative posix path>
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DIRS, assertNotC } from "../config.js";
import { createLogger } from "../log.js";

const log = createLogger("files");
const MAX_READ_BYTES = 200_000;

function toPosix(p) {
  return String(p).replaceAll("\\", "/");
}

function sanitizeRelative(input, fallbackName = "file.md") {
  let raw = String(input ?? "").trim();
  raw = raw.replaceAll("\\", "/");
  if (!raw) raw = fallbackName;
  // Drop drive letters / leading slashes, collapse traversal.
  raw = raw.replace(/^[a-zA-Z]:/, "").replace(/^\/+/, "");
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === "." || part === "..") continue;
    parts.push(part.replace(/[<>:"|?*\u0000-\u001f]/g, "_"));
  }
  if (!parts.length) parts.push(fallbackName);
  return parts.join("/");
}

export class FileSpace {
  /**
   * @param {{roomId:string, root?:string, store:object, events:object}} options
   */
  constructor({ roomId, root, store, events }) {
    if (!roomId) throw new Error("FileSpace requires roomId");
    this.roomId = String(roomId);
    this.store = store;
    this.events = events;
    this.root = assertNotC(root || path.join(DIRS.rooms, this.roomId, "files"), "room files root");
    fs.mkdirSync(this.root, { recursive: true });
  }

  get threadId() {
    return `room:${this.roomId}`;
  }

  absPath(relPath) {
    const rel = sanitizeRelative(relPath);
    const abs = path.resolve(this.root, rel);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (abs !== this.root && !abs.startsWith(rootWithSep)) {
      throw new Error(`path escapes room file space: ${relPath}`);
    }
    return { abs, rel: toPosix(path.relative(this.root, abs)) };
  }

  exists(relPath) {
    try {
      return fs.existsSync(this.absPath(relPath).abs);
    } catch {
      return false;
    }
  }

  /** @returns {Array<{room_id,file_id,path,description,tags,updated_at}>} */
  list() {
    return this.store.listRoomFiles(this.roomId);
  }

  index() {
    const map = new Map();
    for (const rec of this.list()) map.set(rec.file_id, rec);
    return map;
  }

  get(fileId) {
    return this.store.getRoomFile(this.roomId, fileId);
  }

  fileIdForPath(relPath) {
    const { rel } = this.absPath(relPath);
    const rec = this.list().find((f) => f.path === rel);
    return rec ? rec.file_id : null;
  }

  /**
   * Save (create or overwrite at the same path) a text file.
   * @returns {Promise<{file_id:string,path:string,name:string,description:string,tags:string[],updated_at:string}>}
   */
  async save({ name, content, description = "", tags = [], actor = "librarian" } = {}) {
    if (content === undefined || content === null) throw new Error("content is required");
    const { abs, rel } = this.absPath(name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(content), "utf8");

    const existing = this.list().find((f) => f.path === rel);
    const fileId = existing?.file_id || crypto.randomBytes(4).toString("hex");
    const rec = this.store.upsertRoomFile(this.roomId, {
      file_id: fileId,
      path: rel,
      description,
      tags: Array.isArray(tags) ? tags : [],
      updated_at: new Date().toISOString(),
    });
    const payload = {
      file_id: rec.file_id,
      path: rec.path,
      name: path.posix.basename(rec.path),
      description: rec.description,
      tags: rec.tags,
      actor,
      replaced: Boolean(existing),
    };
    await this.events?.publish?.({
      topic: `room.${this.roomId}.file_saved`,
      sender: actor,
      payload,
      thread_id: this.threadId,
    });
    log.info("saved", this.roomId, rec.file_id, rec.path);
    return rec;
  }

  /** Read a file by stable file_id. */
  read({ fileId } = {}) {
    const rec = this.store.getRoomFile(this.roomId, fileId);
    if (!rec) throw new Error(`file_id not found: ${fileId}`);
    const { abs } = this.absPath(rec.path);
    if (!fs.existsSync(abs)) {
      throw new Error(`file ${rec.file_id} is registered at ${rec.path} but missing on disk`);
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error(`${rec.path} is a directory`);
    const raw = fs.readFileSync(abs);
    const truncated = raw.length > MAX_READ_BYTES;
    const content = raw.subarray(0, MAX_READ_BYTES).toString("utf8");
    return {
      file_id: rec.file_id,
      path: rec.path,
      name: path.posix.basename(rec.path),
      description: rec.description,
      tags: rec.tags,
      bytes: stat.size,
      truncated,
      content: truncated ? `${content}\n\n…（已截断，完整文件 ${stat.size} 字节）` : content,
    };
  }

  /**
   * Move/rename a file. Members keep using the same file_id; everyone is notified
   * so nobody looks for the old path.
   */
  async move({ fileId, path: newPath, description, actor = "librarian" } = {}) {
    const rec = this.store.getRoomFile(this.roomId, fileId);
    if (!rec) throw new Error(`file_id not found: ${fileId}`);
    const target = newPath || rec.path;
    const { abs: oldAbs } = this.absPath(rec.path);
    const { abs: newAbs, rel: newRel } = this.absPath(target);
    if (oldAbs !== newAbs) {
      fs.mkdirSync(path.dirname(newAbs), { recursive: true });
      if (fs.existsSync(newAbs)) throw new Error(`target already exists: ${newRel}`);
      fs.renameSync(oldAbs, newAbs);
    }
    const next = this.store.upsertRoomFile(this.roomId, {
      file_id: rec.file_id,
      path: newRel,
      description: description === undefined ? rec.description : description,
      tags: rec.tags,
      updated_at: new Date().toISOString(),
    });
    const payload = {
      file_id: next.file_id,
      old_path: rec.path,
      new_path: next.path,
      name: path.posix.basename(next.path),
      description: next.description,
      actor,
    };
    await this.events?.publish?.({
      topic: `room.${this.roomId}.file_moved`,
      sender: actor,
      payload,
      thread_id: this.threadId,
    });
    // Real-time sync requirement: put a notice in front of every member's next turn.
    this.store.addNotice?.({
      parent_room_id: this.roomId,
      child_room_id: null,
      kind: "file_moved",
      text: `群文件「${payload.name}」地址已变更：${rec.path} → ${next.path}。请继续使用 file_id ${next.file_id} 读取，不要缓存旧路径。`,
    });
    log.info("moved", this.roomId, next.file_id, rec.path, "→", next.path);
    return next;
  }

  remove({ fileId, actor = "librarian" } = {}) {
    const rec = this.store.getRoomFile(this.roomId, fileId);
    if (!rec) throw new Error(`file_id not found: ${fileId}`);
    try {
      const { abs } = this.absPath(rec.path);
      if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
    } catch (err) {
      log.warn("remove disk file failed", err?.message || err);
    }
    this.deleteRow(fileId);
    return rec;
  }

  deleteRow(fileId) {
    this.store.deleteRoomFile(this.roomId, fileId);
  }

  /** Compact index text injected into member instructions. */
  indexText({ max = 40 } = {}) {
    const files = this.list().slice(0, max);
    if (!files.length) return "（群文件空间为空）";
    return files
      .map((f) => `- file_id=${f.file_id} · ${path.posix.basename(f.path)}${f.description ? ` — ${f.description}` : ""}`)
      .join("\n");
  }
}

export function createFileSpace(options) {
  return new FileSpace(options);
}
