/**
 * Store round-trip tests (node:test).
 *
 * Contract: docs/FUSION_SPEC.md §3 (`Store` interface) + §4 (schema).
 * Everything is exercised against a real node:sqlite database in a throw-away
 * data root on D:, so a green run also proves persistence across close/reopen.
 */
import { TEST_DATA_ROOT, TEST_DB_DIR, onCleanup } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store, defaultPermissions, makeId } from "../src/store.js";

/** Fresh database per test group; closed automatically at the end of the file. */
function openStore(name) {
  const dbPath = path.join(TEST_DB_DIR, `${name}.db`);
  const store = new Store(dbPath);
  onCleanup(() => store.close());
  return store;
}

test("store: database file is created under the data root", () => {
  const store = openStore("location");
  assert.equal(store.dbPath, path.join(TEST_DB_DIR, "location.db"));
  assert.ok(fs.existsSync(store.dbPath), "sqlite file should exist on disk");
  assert.ok(store.dbPath.startsWith(TEST_DATA_ROOT));
  assert.ok(!/^c:/i.test(store.dbPath), "must never live on C:");
});

test("store: bots upsert/get/list/delete", () => {
  const store = openStore("bots");
  assert.deepEqual(store.listBots(), []);
  assert.equal(store.getBot("nope"), null);

  store.upsertBot({ id: "coder", name: "Coder", emoji: "💻", archetype: "coder", allowed_tools: ["read"] });
  store.upsertBot({ id: "boss", name: "Boss", emoji: "👑", archetype: "boss" });

  assert.equal(store.getBot("coder").name, "Coder");
  assert.deepEqual(store.getBot("coder").allowed_tools, ["read"]);
  assert.deepEqual(store.listBots().map((b) => b.id), ["coder", "boss"]);

  // Upsert overwrites the JSON blob.
  store.upsertBot({ id: "coder", name: "Coder v2" });
  assert.equal(store.getBot("coder").name, "Coder v2");
  assert.equal(store.listBots().length, 2);

  store.deleteBot("boss");
  assert.equal(store.getBot("boss"), null);
  assert.deepEqual(store.listBots().map((b) => b.id), ["coder"]);
});

test("store: rooms upsert/get/list/status/delete", () => {
  const store = openStore("rooms");
  const room = store.upsertRoom({
    room_id: "r1",
    title: "发布准备",
    owner_id: "boss",
    parent_room_id: null,
    topic: "v1 发布",
    context_policy: "shared",
    status: "active",
  });

  assert.equal(room.room_id, "r1");
  assert.equal(room.title, "发布准备");
  assert.equal(room.owner_id, "boss");
  assert.equal(room.context_policy, "shared");
  assert.ok(room.created_at);
  assert.ok(room.updated_at);

  // Upsert keeps created_at but refreshes mutable metadata.
  const again = store.upsertRoom({ ...room, title: "发布准备 v2", context_policy: "summary" });
  assert.equal(again.title, "发布准备 v2");
  assert.equal(again.context_policy, "summary");
  assert.equal(again.created_at, room.created_at);

  store.upsertRoom({ room_id: "r2", title: "另一个群", parent_room_id: "r1" });
  assert.equal(store.getRoom("r2").parent_room_id, "r1");
  assert.equal(store.listRooms().length, 2);
  assert.equal(store.getRoom("missing"), null);

  assert.equal(store.setRoomStatus("r1", "paused").status, "paused");
  assert.equal(store.getRoom("r1").status, "paused");

  store.deleteRoom("r1");
  assert.equal(store.getRoom("r1"), null);
  assert.equal(store.listRooms().length, 1);
});

test("store: room members keep insertion order and merge permission patches", () => {
  const store = openStore("members");
  store.upsertRoom({ room_id: "r1", title: "群" });

  const rows = store.setRoomMembers("r1", [
    { bot_id: "boss", permissions: defaultPermissions({ can_create_subgroup: true }) },
    "coder", // plain id → defaults
    { bot_id: "librarian", permissions: defaultPermissions({ context_access: "summary" }) },
  ]);

  assert.deepEqual(rows.map((r) => r.bot_id), ["boss", "coder", "librarian"]);
  assert.deepEqual(rows[0].permissions, {
    can_speak: true,
    context_access: "full",
    can_create_subgroup: true,
    allowed_tool_overrides: null,
  });
  assert.equal(rows[1].permissions.can_speak, true);
  assert.equal(rows[2].permissions.context_access, "summary");

  // Partial patch: unspecified fields keep their current value.
  const patched = store.setMemberPermissions("r1", "coder", { can_speak: false });
  assert.equal(patched.can_speak, false);
  assert.equal(patched.context_access, "full");
  assert.equal(store.listRoomMembers("r1").find((r) => r.bot_id === "coder").permissions.can_speak, false);

  // Unknown member → row is created with merged defaults (Room.addMember path).
  store.setMemberPermissions("r1", "reviewer", { context_access: "none" });
  assert.equal(store.listRoomMembers("r1").length, 4);
  assert.equal(store.listRoomMembers("r1")[3].permissions.context_access, "none");

  // Replacing the member set drops stale rows.
  store.setRoomMembers("r1", ["boss", "coder"]);
  assert.deepEqual(store.listRoomMembers("r1").map((r) => r.bot_id), ["boss", "coder"]);

  store.removeRoomMember("r1", "coder");
  assert.deepEqual(store.listRoomMembers("r1").map((r) => r.bot_id), ["boss"]);
});

test("store: room messages get increasing seq and the transcript tail", () => {
  const store = openStore("messages");
  store.upsertRoom({ room_id: "r1", title: "群" });

  assert.equal(store.nextRoomSeq("r1"), 1);
  const first = store.appendRoomMessage("r1", { speaker: "user", content: "大家好", kind: "user" });
  assert.equal(first.seq, 1);
  const second = store.appendRoomMessage("r1", { speaker: "boss", content: "开始分工", kind: "assistant" });
  assert.equal(second.seq, 2);
  assert.equal(store.nextRoomSeq("r1"), 3);

  const rows = store.listRoomMessages("r1");
  assert.deepEqual(rows.map((m) => m.seq), [1, 2]);
  assert.deepEqual(rows.map((m) => m.speaker), ["user", "boss"]);
  assert.equal(rows[0].kind, "user");
  assert.equal(rows[1].kind, "assistant");
  assert.ok(rows[0].ts);

  // limit returns the newest N rows, still ascending.
  const tail = store.listRoomMessages("r1", 1);
  assert.deepEqual(tail.map((m) => m.seq), [2]);

  // Messages are per-room.
  store.upsertRoom({ room_id: "r2", title: "另一个群" });
  store.appendRoomMessage("r2", { speaker: "user", content: "hi" });
  assert.equal(store.listRoomMessages("r2").length, 1);
  assert.equal(store.listRoomMessages("r1").length, 2);
  assert.equal(store.listRoomMessages("r1")[1].room_id, "r1");

  // Appending bumps the room row's updated_at (room list ordering).
  assert.ok(store.getRoom("r1").updated_at);
});

test("store: room files upsert/get/list/delete", () => {
  const store = openStore("files");
  store.upsertRoom({ room_id: "r1", title: "群" });

  assert.deepEqual(store.listRoomFiles("r1"), []);
  assert.equal(store.getRoomFile("r1", "missing"), null);

  const rec = store.upsertRoomFile("r1", {
    file_id: "a1b2c3d4",
    path: "report/draft.md",
    description: "初稿",
    tags: ["draft", "md"],
  });
  assert.equal(rec.file_id, "a1b2c3d4");
  assert.equal(rec.path, "report/draft.md");
  assert.deepEqual(rec.tags, ["draft", "md"]);
  assert.ok(rec.updated_at);

  const read = store.getRoomFile("r1", "a1b2c3d4");
  assert.deepEqual(read, {
    room_id: "r1",
    file_id: "a1b2c3d4",
    path: "report/draft.md",
    description: "初稿",
    tags: ["draft", "md"],
    updated_at: read.updated_at,
  });

  // Move = same file_id, new path (the whole point of the index).
  store.upsertRoomFile("r1", { file_id: "a1b2c3d4", path: "final/report.md", description: "终稿", tags: ["final"] });
  const moved = store.getRoomFile("r1", "a1b2c3d4");
  assert.equal(moved.path, "final/report.md");
  assert.equal(moved.description, "终稿");
  assert.equal(store.listRoomFiles("r1").length, 1);

  store.upsertRoomFile("r1", { file_id: "ffffffff", path: "notes.md" });
  assert.equal(store.listRoomFiles("r1").length, 2);

  store.deleteRoomFile("r1", "ffffffff");
  assert.equal(store.getRoomFile("r1", "ffffffff"), null);
  assert.equal(store.listRoomFiles("r1").length, 1);
});

test("store: notices are queued, drained once and still listable", () => {
  const store = openStore("notices");
  store.upsertRoom({ room_id: "parent", title: "父群" });

  store.addNotice({ parent_room_id: "parent", child_room_id: "sub1", kind: "subgroup_report", text: "小群有结论了" });
  store.addNotice({ parent_room_id: "parent", kind: "file_moved", text: "文件已移动" });
  store.addNotice({ parent_room_id: "other", kind: "info", text: "别的群" });

  assert.equal(store.listNotices("parent").length, 2);

  const drained = store.drainNotices("parent");
  assert.deepEqual(drained.map((n) => n.kind), ["subgroup_report", "file_moved"]);
  assert.equal(drained[0].text, "小群有结论了");
  assert.equal(drained[0].child_room_id, "sub1");

  // Second drain returns nothing — the next round must not repeat the notice.
  assert.deepEqual(store.drainNotices("parent"), []);
  assert.equal(store.listNotices("parent").length, 0);
  assert.equal(store.listNotices("parent", { includeDrained: true }).length, 2);
  // Other rooms are untouched.
  assert.equal(store.listNotices("other").length, 1);
});

test("store: kv stores arbitrary JSON with a fallback", () => {
  const store = openStore("kv");
  assert.equal(store.getKV("missing", "fallback"), "fallback");
  assert.equal(store.getKV("missing"), null);

  store.setKV("settings", { theme: "dark", model: "auto/deepseek-v4.1-flash" });
  assert.deepEqual(store.getKV("settings"), { theme: "dark", model: "auto/deepseek-v4.1-flash" });

  store.setKV("count", 3);
  assert.equal(store.getKV("count"), 3);
  store.setKV("count", 4);
  assert.equal(store.getKV("count"), 4);
});

test("store: events append with increasing seq and replay per thread", () => {
  const store = openStore("events");
  assert.equal(store.lastEventSeq(), 0);

  const s1 = store.appendEvent({
    ts: 100.5,
    topic: "room.r1.round_started",
    sender: "group_room",
    payload: { round_id: "abc", members: ["boss", "coder"] },
    thread_id: "room:r1",
  });
  const s2 = store.appendEvent({
    ts: 101,
    topic: "room.r1.turn_completed",
    sender: "group_room",
    payload: { speaker: "boss", content: "分工如下", timestamp: "2026-01-01T00:00:00.000Z" },
    thread_id: "room:r1",
  });
  store.appendEvent({ ts: 102, topic: "harness.room.created", sender: "runtime", payload: {}, thread_id: null });

  assert.equal(s1, 1);
  assert.equal(s2, 2);
  assert.equal(store.lastEventSeq(), 3);

  const rows = store.listEvents({ thread_id: "room:r1" });
  assert.deepEqual(rows.map((e) => e.topic), ["room.r1.round_started", "room.r1.turn_completed"]);
  assert.deepEqual(rows[0].payload.members, ["boss", "coder"]);
  assert.equal(rows[1].payload.speaker, "boss");
  assert.equal(typeof rows[0].ts, "number");
  assert.equal(rows[0].thread_id, "room:r1");
  assert.ok(rows[0].seq < rows[1].seq);

  // Cursor replay.
  assert.deepEqual(
    store.listEvents({ thread_id: "room:r1", after_seq: rows[0].seq }).map((e) => e.topic),
    ["room.r1.turn_completed"],
  );
  // Limit.
  assert.equal(store.listEvents({ thread_id: "room:r1", limit: 1 }).length, 1);
  // No thread filter → every event, ascending.
  assert.deepEqual(store.listEvents({}).map((e) => e.topic), [
    "room.r1.round_started",
    "room.r1.turn_completed",
    "harness.room.created",
  ]);
  // Unknown thread.
  assert.deepEqual(store.listEvents({ thread_id: "room:nope" }), []);
});

test("store: usage accounting aggregates by bot", () => {
  const store = openStore("usage");
  assert.deepEqual(store.usageSummary(), {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    ms: 0,
    by_bot: [],
  });

  store.addUsage({ bot_id: "boss", room_id: "r1", model: "auto/deepseek-v4.1-flash", input_tokens: 100, output_tokens: 20, ms: 900 });
  store.addUsage({ bot_id: "boss", room_id: "r1", model: "auto/deepseek-v4.1-flash", input_tokens: 50, output_tokens: 10, ms: 300 });
  store.addUsage({ bot_id: "coder", room_id: "r1", input_tokens: 70, output_tokens: 30, ms: 500 });

  const summary = store.usageSummary();
  assert.equal(summary.calls, 3);
  assert.equal(summary.input_tokens, 220);
  assert.equal(summary.output_tokens, 60);
  assert.equal(summary.total_tokens, 280);
  assert.equal(summary.ms, 1700);
  assert.deepEqual(summary.by_bot.map((b) => [b.bot_id, b.calls, b.input_tokens]), [
    ["boss", 2, 150],
    ["coder", 1, 70],
  ]);
});

test("store: tickets create/update/list", () => {
  const store = openStore("tickets");
  assert.deepEqual(store.listTickets(), []);

  const created = store.createTicket({ title: "修一个 bug", state: "open", detail: { a: 1 } });
  assert.ok(created.id);
  assert.equal(created.title, "修一个 bug");
  assert.ok(created.created_at);

  const updated = store.updateTicket(created.id, { state: "done", summary: "已修复" });
  assert.equal(updated.state, "done");
  assert.equal(updated.title, "修一个 bug", "patch must not drop existing fields");
  assert.deepEqual(store.getTicket(created.id).detail, { a: 1 });

  store.createTicket({ id: "fixed-id", title: "第二个工单" });
  assert.deepEqual(store.listTickets().map((t) => t.id).sort(), [created.id, "fixed-id"].sort());
  assert.equal(store.listTickets(1).length, 1);
  assert.equal(store.getTicket("nope"), null);
});

test("store: makeId/defaultPermissions helpers keep the documented shape", () => {
  assert.match(makeId(), /^[0-9a-f]{12}$/);
  assert.match(makeId(4), /^[0-9a-f]{8}$/);
  assert.deepEqual(defaultPermissions(), {
    can_speak: true,
    context_access: "full",
    can_create_subgroup: false,
    allowed_tool_overrides: null,
  });
  assert.equal(defaultPermissions({ can_speak: false }).can_speak, false);
  assert.equal(defaultPermissions({ can_speak: false }).context_access, "full");
});

test("store: everything survives close() + reopen()", () => {
  const dbPath = path.join(TEST_DB_DIR, "durability.db");
  assert.ok(!fs.existsSync(dbPath));

  const store = new Store(dbPath);
  store.upsertBot({ id: "coder", name: "Coder", archetype: "coder" });
  store.upsertRoom({
    room_id: "dur",
    title: "持久化群",
    owner_id: "boss",
    topic: "重启恢复",
    context_policy: "summary",
    status: "active",
  });
  store.setRoomMembers("dur", [
    { bot_id: "boss", permissions: defaultPermissions({ can_create_subgroup: true }) },
    { bot_id: "coder", permissions: defaultPermissions({ context_access: "none" }) },
  ]);
  store.appendRoomMessage("dur", { speaker: "user", content: "重启后还记得吗", kind: "user" });
  store.appendRoomMessage("dur", { speaker: "boss", content: "记得", kind: "assistant" });
  store.upsertRoomFile("dur", { file_id: "deadbeef", path: "a/b.md", description: "草稿", tags: ["x"] });
  store.addNotice({ parent_room_id: "dur", child_room_id: "sub1", kind: "subgroup_report", text: "小群已完成" });
  store.appendEvent({
    ts: 1.5,
    topic: "room.dur.round_started",
    sender: "group_room",
    payload: { round_id: "r-1" },
    thread_id: "room:dur",
  });
  store.setKV("settings", { theme: "dark", model: "m" });
  store.addUsage({ bot_id: "boss", room_id: "dur", model: "m", input_tokens: 3, output_tokens: 4, ms: 5 });
  store.createTicket({ id: "tk1", title: "工单" });
  const seqBefore = store.lastEventSeq();
  store.close();

  const reopened = new Store(dbPath);
  onCleanup(() => reopened.close());

  assert.equal(reopened.getBot("coder").name, "Coder");
  assert.equal(reopened.getRoom("dur").context_policy, "summary");
  assert.equal(reopened.getRoom("dur").title, "持久化群");

  const members = reopened.listRoomMembers("dur");
  assert.deepEqual(members.map((m) => m.bot_id), ["boss", "coder"]);
  assert.equal(members[0].permissions.can_create_subgroup, true);
  assert.equal(members[1].permissions.context_access, "none");

  const messages = reopened.listRoomMessages("dur");
  assert.deepEqual(messages.map((m) => `${m.seq}:${m.speaker}`), ["1:user", "2:boss"]);

  const file = reopened.getRoomFile("dur", "deadbeef");
  assert.equal(file.path, "a/b.md");
  assert.deepEqual(file.tags, ["x"]);

  const notices = reopened.listNotices("dur");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].text, "小群已完成");
  assert.equal(reopened.drainNotices("dur").length, 1);

  const events = reopened.listEvents({ thread_id: "room:dur" });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, { round_id: "r-1" });
  assert.equal(reopened.lastEventSeq(), seqBefore);

  assert.deepEqual(reopened.getKV("settings"), { theme: "dark", model: "m" });
  assert.equal(reopened.usageSummary().calls, 1);
  assert.equal(reopened.listTickets().length, 1);
});

test("store: rooms 持久化 settings_json，旧库自动补列", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  // 旧库：只有 Hermes 吸收前的 rooms 列（没有 settings_json）。
  const legacyPath = path.join(TEST_DB_DIR, "legacy-rooms.db");
  const raw = new DatabaseSync(legacyPath);
  raw.exec(`CREATE TABLE rooms(room_id TEXT PRIMARY KEY, title TEXT, owner_id TEXT, parent_room_id TEXT,
            topic TEXT, context_policy TEXT, status TEXT, created_at TEXT, updated_at TEXT)`);
  raw.prepare("INSERT INTO rooms VALUES(?,?,?,?,?,?,?,?,?)").run(
    "old", "老房间", null, null, "", "shared", "active", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
  );
  raw.close();

  const store = new Store(legacyPath);
  const migrated = store.getRoom("old");
  assert.equal(migrated.title, "老房间", "旧数据仍在");
  assert.deepEqual(migrated.settings, {}, "补列后默认空对象");

  store.upsertRoom({ ...migrated, settings: { disabled_toolsets: ["exec"], context_budget: 5000 } });
  assert.deepEqual(store.getRoom("old").settings, { disabled_toolsets: ["exec"], context_budget: 5000 });
  store.close();

  const reopened = new Store(legacyPath);
  assert.deepEqual(reopened.getRoom("old").settings, { disabled_toolsets: ["exec"], context_budget: 5000 }, "跨重开保留");
  reopened.close();
});
