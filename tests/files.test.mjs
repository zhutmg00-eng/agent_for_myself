/**
 * Group file space tests (node:test).
 *
 * Contract: docs/FUSION_SPEC.md §6 — root `<DATA>/rooms/<roomId>/files`, `path`
 * stored relative + posix, 8-hex `file_id`, `file_moved` broadcast to the room
 * plus a pending notice so every member learns the new location next round.
 */
import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/store.js";
import { EventBus } from "../src/events.js";
import { FileSpace } from "../src/rooms/files.js";

const ROOM_ID = "file123";
const ROOT = path.join(TEST_DATA_ROOT, "rooms", ROOM_ID, "files");

function makeContext(name = "files") {
  const store = new Store(path.join(TEST_DATA_ROOT, "data", `${name}.db`));
  const events = new EventBus(store);
  const seen = [];
  const off = events.subscribe((evt) => seen.push(evt));
  onCleanup(() => {
    off();
    store.close();
  });
  const space = new FileSpace({ roomId: ROOM_ID, root: ROOT, store, events });
  return { store, events, seen, space };
}

function topicsOf(seen, suffix) {
  return seen.filter((e) => e.topic.endsWith(`.${suffix}`));
}

test("files: save writes to disk, indexes a stable 8-hex file_id and emits file_saved", async () => {
  const { store, seen, space } = makeContext("files-save");

  const rec = await space.save({
    name: "notes/draft.md",
    content: "# 初稿\n\n第一版。",
    description: "发布稿初稿",
    tags: ["draft"],
    actor: "librarian",
  });

  assert.match(rec.file_id, /^[0-9a-f]{8}$/, "file_id must be 8 hex chars");
  assert.equal(rec.path, "notes/draft.md", "path is stored relative + posix");
  assert.equal(rec.description, "发布稿初稿");
  assert.deepEqual(rec.tags, ["draft"]);
  assert.ok(rec.updated_at);

  const abs = path.join(ROOT, "notes", "draft.md");
  assert.ok(fs.existsSync(abs), "file must exist under <DATA>/rooms/<id>/files");
  assert.equal(fs.readFileSync(abs, "utf8"), "# 初稿\n\n第一版。");

  // Indexed in SQLite, readable from a second Store instance.
  assert.equal(store.getRoomFile(ROOM_ID, rec.file_id).path, "notes/draft.md");

  const saved = topicsOf(seen, "file_saved");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].topic, `room.${ROOM_ID}.file_saved`);
  assert.equal(saved[0].thread_id, `room:${ROOM_ID}`);
  assert.deepEqual(
    {
      file_id: saved[0].payload.file_id,
      path: saved[0].payload.path,
      name: saved[0].payload.name,
      description: saved[0].payload.description,
      actor: saved[0].payload.actor,
    },
    {
      file_id: rec.file_id,
      path: "notes/draft.md",
      name: "draft.md",
      description: "发布稿初稿",
      actor: "librarian",
    },
  );

  // list()/index()/indexText() expose the index to the room tools.
  assert.deepEqual(space.list().map((f) => f.file_id), [rec.file_id]);
  assert.equal(space.index().get(rec.file_id).path, "notes/draft.md");
  assert.ok(space.indexText().includes(rec.file_id));
  assert.ok(space.exists("notes/draft.md"));
  assert.equal(space.fileIdForPath("notes/draft.md"), rec.file_id);
  assert.equal(space.fileIdForPath("notes/nope.md"), null);
});

test("files: read resolves by file_id and follows the moved path", async () => {
  const { space } = makeContext("files-read");
  const saved = await space.save({ name: "a.md", content: "hello fusion", description: "问候" });

  const read = space.read({ fileId: saved.file_id });
  assert.equal(read.file_id, saved.file_id);
  assert.equal(read.path, "a.md");
  assert.equal(read.name, "a.md");
  assert.equal(read.description, "问候");
  assert.equal(read.content, "hello fusion");
  assert.equal(read.truncated, false);
  assert.equal(read.bytes, Buffer.byteLength("hello fusion", "utf8"));

  const moved = await space.move({ fileId: saved.file_id, path: "final/b.md" });
  assert.equal(moved.file_id, saved.file_id, "file_id is stable across moves");

  const after = space.read({ fileId: saved.file_id });
  assert.equal(after.path, "final/b.md");
  assert.equal(after.name, "b.md");
  assert.equal(after.content, "hello fusion");
  assert.ok(fs.existsSync(path.join(ROOT, "final", "b.md")));
  assert.ok(!fs.existsSync(path.join(ROOT, "a.md")));

  assert.throws(() => space.read({ fileId: "00000000" }), /not found/);
});

test("files: move emits file_moved and queues a room-wide notice", async () => {
  const { store, seen, space } = makeContext("files-move");
  const saved = await space.save({ name: "report/draft.md", content: "草稿", description: "报告草稿" });
  seen.length = 0;

  const moved = await space.move({
    fileId: saved.file_id,
    path: "report/final.md",
    description: "报告终稿",
    actor: "librarian",
  });
  assert.equal(moved.path, "report/final.md");
  assert.equal(moved.description, "报告终稿");

  const movedEvents = topicsOf(seen, "file_moved");
  assert.equal(movedEvents.length, 1);
  assert.equal(movedEvents[0].topic, `room.${ROOM_ID}.file_moved`);
  assert.equal(movedEvents[0].thread_id, `room:${ROOM_ID}`);
  assert.deepEqual(
    {
      file_id: movedEvents[0].payload.file_id,
      old_path: movedEvents[0].payload.old_path,
      new_path: movedEvents[0].payload.new_path,
      name: movedEvents[0].payload.name,
      actor: movedEvents[0].payload.actor,
    },
    {
      file_id: saved.file_id,
      old_path: "report/draft.md",
      new_path: "report/final.md",
      name: "final.md",
      actor: "librarian",
    },
  );

  // Real-time sync requirement: the next round must inject this notice.
  const pending = store.listNotices(ROOM_ID);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "file_moved");
  assert.equal(pending[0].parent_room_id, ROOM_ID);
  assert.ok(pending[0].text.includes("report/draft.md"));
  assert.ok(pending[0].text.includes("report/final.md"));
  assert.ok(pending[0].text.includes(saved.file_id), "notice must tell members to keep using file_id");

  const drained = store.drainNotices(ROOM_ID);
  assert.equal(drained.length, 1);
  assert.deepEqual(store.drainNotices(ROOM_ID), [], "notices are delivered exactly once");

  // Moving to an occupied path is rejected instead of clobbering a file.
  const other = await space.save({ name: "report/other.md", content: "别的" });
  await assert.rejects(() => space.move({ fileId: other.file_id, path: "report/final.md" }), /already exists/);
});

test("files: saving the same path reuses the file_id (stable index)", async () => {
  const { store, seen, space } = makeContext("files-overwrite");
  const first = await space.save({ name: "spec.md", content: "v1", description: "规范" });
  const second = await space.save({ name: "spec.md", content: "v2", description: "规范 v2" });

  assert.equal(second.file_id, first.file_id);
  assert.equal(space.list().length, 1);
  assert.equal(space.read({ fileId: second.file_id }).content, "v2");
  assert.equal(store.getRoomFile(ROOM_ID, first.file_id).description, "规范 v2");

  const savedEvents = topicsOf(seen, "file_saved");
  assert.equal(savedEvents.length, 2);
  assert.equal(savedEvents[1].payload.replaced, true);
});

test("files: paths are confined to the room file space", async () => {
  const { space } = makeContext("files-escape");

  // Traversal is neutralised — nothing can land outside the room root.
  const escaped = await space.save({ name: "../../../evil.md", content: "pwned" });
  assert.equal(escaped.path, "evil.md");
  assert.ok(fs.existsSync(path.join(ROOT, "evil.md")));
  assert.ok(!fs.existsSync(path.join(TEST_DATA_ROOT, "evil.md")));
  assert.ok(!escaped.path.includes(".."));

  // Drive letters / absolute paths are stripped too.
  const absolute = await space.save({ name: "D:\\tmp\\abs.md", content: "x" });
  assert.equal(absolute.path, "tmp/abs.md");
  assert.ok(fs.existsSync(path.join(ROOT, "tmp", "abs.md")));

  // A FileSpace can never be pointed at C:.
  assert.throws(
    () => new FileSpace({ roomId: "c-room", root: "C:\\Users\\public\\fusion", store: null, events: null }),
    /refusing to write to C:/i,
  );
});

test("files: read truncates files larger than 200KB and marks it", async () => {
  const { space } = makeContext("files-big");
  const big = "x".repeat(250_000);
  const saved = await space.save({ name: "big.txt", content: big, description: "大文件" });

  const read = space.read({ fileId: saved.file_id });
  assert.equal(read.truncated, true);
  assert.equal(read.bytes, 250_000);
  assert.ok(read.content.length > 0);
  assert.ok(read.content.length < big.length);
  assert.ok(read.content.includes("已截断"));
  assert.equal(read.content.split("\n\n…（已截断").length, 2);
});

test("files: remove deletes the disk file and the index row", async () => {
  const { store, space } = makeContext("files-remove");
  const saved = await space.save({ name: "temp/throwaway.md", content: "bye" });

  const removed = space.remove({ fileId: saved.file_id });
  assert.equal(removed.file_id, saved.file_id);
  assert.equal(store.getRoomFile(ROOM_ID, saved.file_id), null);
  assert.ok(!fs.existsSync(path.join(ROOT, "temp", "throwaway.md")));
  assert.deepEqual(space.list(), []);
  assert.throws(() => space.remove({ fileId: saved.file_id }), /not found/);
});

test("files: index survives a Store reopen (file_id is the durable handle)", async () => {
  const dbPath = path.join(TEST_DATA_ROOT, "data", "files-reopen.db");
  const store = new Store(dbPath);
  const space = new FileSpace({ roomId: ROOM_ID, root: ROOT, store, events: null });
  const saved = await space.save({ name: "persisted.md", content: "survives restart", description: "持久" });
  store.close();

  const reopened = new Store(dbPath);
  onCleanup(() => reopened.close());
  const again = new FileSpace({ roomId: ROOM_ID, root: ROOT, store: reopened, events: null });
  const read = again.read({ fileId: saved.file_id });
  assert.equal(read.path, "persisted.md");
  assert.equal(read.content, "survives restart");
  assert.equal(read.description, "持久");
});
