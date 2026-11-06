/**
 * RoomManager tests (node:test): create / get / list / snapshotAll / restore.
 *
 * Contract: docs/CONTRACT_ROOM.md §2 (create+restore) and docs/CONTRACT_API.md
 * E18 (`POST /api/rooms`: `include_roles`, ≥2 members, minimal response).
 * No LLM: rooms are created and restored, but no speaking round is executed.
 */
import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/store.js";
import { EventBus } from "../src/events.js";
import { RoomManager } from "../src/rooms/manager.js";

async function makeManager(name) {
  const store = new Store(path.join(TEST_DATA_ROOT, "data", `${name}.db`));
  onCleanup(() => store.close());
  const events = new EventBus(store);
  const seen = [];
  const off = events.subscribe((evt) => seen.push(evt));
  onCleanup(off);
  const manager = new RoomManager({ store, events, engine: null, hooks: null, skills: null, archetypes: null });
  await manager.restore();
  onCleanup(() => manager.dispose());
  return { manager, store, events, seen };
}

test("manager: create() adds owner+librarian with include_roles and persists everything", async () => {
  const { manager, store, seen } = await makeManager("mgr-create");

  const res = await manager.create({
    title: "产品发布准备",
    members: ["coder", "reviewer"],
    include_roles: true,
    topic: "v1 上线",
  });

  // E18: minimal response is {room_id, members} plus optional metadata.
  assert.match(res.room_id, /^[0-9a-f]{6}$/, "room id is 6 hex chars");
  assert.deepEqual(res.members, ["boss", "coder", "reviewer", "librarian"]);
  assert.equal(res.owner_id, "boss");
  assert.equal(res.title, "产品发布准备");
  assert.equal(res.context_policy, "shared");

  // Persisted room row.
  const row = store.getRoom(res.room_id);
  assert.equal(row.title, "产品发布准备");
  assert.equal(row.owner_id, "boss");
  assert.equal(row.topic, "v1 上线");
  assert.equal(row.context_policy, "shared");
  assert.equal(row.status, "active");
  assert.ok(row.created_at);

  // Persisted member order (speaking order) and default permissions.
  const members = store.listRoomMembers(res.room_id);
  assert.deepEqual(members.map((m) => m.bot_id), ["boss", "coder", "reviewer", "librarian"]);
  assert.deepEqual(members[1].permissions, {
    can_speak: true,
    context_access: "full",
    can_create_subgroup: false,
    allowed_tool_overrides: null,
  });
  // The owner keeps the sub-group capability (vision point d).
  assert.equal(members[0].permissions.can_create_subgroup, true);

  // Live room instance is registered and snapshot-able.
  const room = manager.get(res.room_id);
  assert.ok(room);
  assert.deepEqual(room.snapshot().members, ["boss", "coder", "reviewer", "librarian"]);

  // File space directory is prepared.
  assert.ok(fs.existsSync(path.join(TEST_DATA_ROOT, "rooms", res.room_id, "files")));

  // Broadcast for the UI («harness.room.created» triggers a room list refresh).
  const created = seen.filter((e) => e.topic === "harness.room.created");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].payload, {
    room_id: res.room_id,
    members: ["boss", "coder", "reviewer", "librarian"],
    owner_id: "boss",
    title: "产品发布准备",
    parent_room_id: null,
  });
  assert.equal(created[0].sender, "runtime");
});

test("manager: create() without include_roles has no owner and a minimal response", async () => {
  const { manager, store } = await makeManager("mgr-plain");

  const res = await manager.create({ members: ["coder", "reviewer"] });
  assert.deepEqual(Object.keys(res).sort(), ["members", "room_id"]);
  assert.deepEqual(res.members, ["coder", "reviewer"]);
  assert.equal(store.getRoom(res.room_id).owner_id, null);
  assert.equal(store.getRoom(res.room_id).title, "");
  assert.equal(manager.get(res.room_id).owner_id, null);
});

test("manager: create() dedupes members and rejects fewer than two", async () => {
  const { manager } = await makeManager("mgr-validation");

  const res = await manager.create({ members: ["coder", "reviewer", "coder"], include_roles: false });
  assert.deepEqual(res.members, ["coder", "reviewer"]);

  await assert.rejects(() => manager.create({ members: ["solo"] }), /at least 2 members/);
  await assert.rejects(() => manager.create({ members: [] }), /at least 2 members/);
});

test("manager: get/list/snapshotAll expose the room snapshots", async () => {
  const { manager } = await makeManager("mgr-list");
  const a = await manager.create({ title: "A", members: ["boss", "coder"], include_roles: true });
  const b = await manager.create({ title: "B", members: ["boss", "coder", "reviewer"], include_roles: true });

  assert.equal(manager.get("nope"), null);
  assert.ok(manager.get(a.room_id));

  const all = manager.snapshotAll();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((r) => r.room_id).sort(), [a.room_id, b.room_id].sort());
  assert.deepEqual(
    manager.list().map((r) => r.room_id).sort(),
    all.map((r) => r.room_id).sort(),
  );

  const snapshot = manager.get(b.room_id).snapshot();
  assert.equal(snapshot.room_id, b.room_id);
  assert.equal(snapshot.owner_id, "boss");
  assert.deepEqual(snapshot.members, ["boss", "coder", "reviewer", "librarian"]);
  assert.equal(snapshot.context_policy, "shared");
  assert.deepEqual(Object.keys(snapshot.member_permissions).sort(), snapshot.members.slice().sort());
});

test("manager: restore() rebuilds live rooms (members, permissions, transcript) from SQLite", async () => {
  const { manager, store } = await makeManager("mgr-restore");
  const created = await manager.create({
    title: "恢复测试",
    members: ["boss", "coder"],
    include_roles: true,
    context_policy: "summary",
    topic: "重启后恢复",
  });

  // Simulate a previous session's durable state.
  store.appendRoomMessage(created.room_id, { speaker: "user", content: "重启前的消息", kind: "user" });
  store.appendRoomMessage(created.room_id, { speaker: "boss", content: "收到", kind: "assistant" });
  store.setMemberPermissions(created.room_id, "coder", { context_access: "none", can_speak: false });

  // A fresh manager (new process) restores from the same database.
  const fresh = new RoomManager({ store, events: manager.events, engine: null, hooks: null, skills: null, archetypes: null });
  await fresh.restore();
  onCleanup(() => fresh.dispose());

  const restored = fresh.get(created.room_id);
  assert.ok(restored, "room must be restored from SQLite");
  assert.equal(restored.title, "恢复测试");
  assert.equal(restored.owner_id, "boss");
  assert.equal(restored.topic, "重启后恢复");
  assert.equal(restored.context_policy, "summary");
  assert.equal(restored.status, "active");
  assert.deepEqual(restored.members, ["boss", "coder", "librarian"]);

  // Permissions survive the restart.
  assert.equal(restored.permissionsOf("coder").context_access, "none");
  assert.equal(restored.permissionsOf("coder").can_speak, false);

  // Transcript tail is replayed so context injection still works after a restart.
  assert.deepEqual(restored.message_log.map((m) => m.content), ["重启前的消息", "收到"]);
  assert.equal(restored.message_log[0].kind, "user");

  // restore() is idempotent-ish: calling it again keeps one instance per room.
  await fresh.restore();
  assert.equal(fresh.get(created.room_id).room_id, created.room_id);
});

test("manager: delete() drops the room from memory and SQLite", async () => {
  const { manager, store } = await makeManager("mgr-delete");
  const created = await manager.create({ title: "待删除", members: ["boss", "coder"], include_roles: true });
  store.appendRoomMessage(created.room_id, { speaker: "user", content: "x" });

  assert.equal(manager.delete(created.room_id), true);
  assert.equal(manager.get(created.room_id), null);
  assert.equal(store.getRoom(created.room_id), null);
  assert.deepEqual(store.listRoomMembers(created.room_id), []);
  assert.deepEqual(store.listRoomMessages(created.room_id), []);
  assert.equal(manager.delete("missing"), false);
});

test("manager: delete 递归删除子房（小群不成为孤儿）", async () => {
  const { manager, store } = await makeManager("mgr-cascade");
  const parent = await manager.create({ title: "父群", members: ["boss", "coder", "reviewer"] });
  const child = await manager.create({
    title: "小群",
    members: ["coder", "reviewer"],
    parent_room_id: parent.room_id,
    is_subgroup: true,
  });
  assert.ok(store.getRoom(child.room_id), "子房已落库");

  manager.delete(parent.room_id);

  assert.equal(store.getRoom(parent.room_id), null, "父房删除");
  assert.equal(store.getRoom(child.room_id), null, "子房级联删除");
  assert.equal(manager.get(child.room_id), null, "内存里也不再持有子房");
  const childSessions = path.join(TEST_DATA_ROOT, "sessions", child.room_id);
  assert.equal(fs.existsSync(childSessions), false, "不应创建子房会话目录");
});
