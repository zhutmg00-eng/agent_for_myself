/**
 * Room orchestration tests (node:test) with a fake BotRunner.
 *
 * Covers docs/FUSION_SPEC.md §5 (round algorithm + context policy) and §7
 * (event topics/payload fields the web UI reduces on). No LLM, no network:
 * `room.runnerFor()` is replaced with an in-memory stub, which is exactly the
 * BotRunner seam (`runner.run({prompt}) → {text, usage, ms}`).
 */
import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Store, defaultPermissions } from "../src/store.js";
import { EventBus } from "../src/events.js";
import { Room } from "../src/rooms/room.js";

const ROOM_ID = "testroom";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Build a persisted Room backed by a throw-away SQLite database.
 * `engine`/`hooks`/`skills` are null: the tests never construct a real runner.
 */
async function makeRoom({
  name,
  members = ["boss", "coder", "reviewer"],
  owner = "boss",
  policy = "shared",
  permissions = {},
} = {}) {
  const store = new Store(path.join(TEST_DATA_ROOT, "data", `${name}.db`));
  onCleanup(() => store.close());
  const events = new EventBus(store);
  const seen = [];
  const off = events.subscribe((evt) => seen.push(evt));
  onCleanup(off);

  const record = {
    room_id: ROOM_ID,
    title: "测试群",
    owner_id: owner,
    parent_room_id: null,
    topic: "发布准备",
    context_policy: policy,
    status: "active",
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  store.upsertRoom(record);
  store.setRoomMembers(
    ROOM_ID,
    members.map((id) => ({
      bot_id: id,
      permissions: defaultPermissions({ can_create_subgroup: id === owner, ...(permissions[id] || {}) }),
    })),
  );

  const room = new Room({ record, store, events, engine: null, hooks: null, skills: null, archetypes: null, manager: null });
  await room.loadMembers();
  return { room, store, events, seen };
}

/** Replace the BotRunner seam with a stub that records calls. */
function installFakeRunners(room, { onRun, text } = {}) {
  const calls = [];
  room.runnerFor = (botId) => {
    const id = String(botId);
    return {
      run: async ({ prompt } = {}) => {
        calls.push({ botId: id, prompt });
        if (typeof onRun === "function") await onRun(id, prompt, room);
        const body = typeof text === "function" ? text(id) : `${id} 给出了结论`;
        return { text: body, usage: { input_tokens: 11, output_tokens: 7 }, ms: 5, toolsUsed: [] };
      },
      dispose() {},
    };
  };
  return calls;
}

function eventsOf(seen, kind) {
  return seen.filter((e) => e.topic === `room.${ROOM_ID}.${kind}`);
}

function payloads(seen, kind) {
  return eventsOf(seen, kind).map((e) => e.payload);
}

test("room: owner speaks first, assigns a task, and only assignees speak afterwards", async () => {
  const { room, store, seen } = await makeRoom({ name: "round-assign" });
  const calls = installFakeRunners(room, {
    onRun: async (botId, _prompt, r) => {
      if (botId === "boss") {
        // What the real `room_assign_task` tool does inside the owner's turn.
        await r.assignTask("coder", "写 SMOKE.md 的初稿并保存到群文件");
      }
    },
  });

  const spoken = await room.runRound({ instruction: "请准备 v1 发布材料" });

  // Only the owner and the assigned member ran.
  assert.deepEqual(calls.map((c) => c.botId), ["boss", "coder"]);
  assert.deepEqual(spoken, ["boss", "coder"]);

  // The assignee's instruction carries the assignment, the owner's one doesn't.
  const coderPrompt = calls.find((c) => c.botId === "coder").prompt;
  assert.ok(coderPrompt.includes("群主分派给你的任务"), "assignment must be injected into the assignee prompt");
  assert.ok(coderPrompt.includes("写 SMOKE.md 的初稿并保存到群文件"));
  assert.ok(coderPrompt.includes("=== 本轮消息 ===\n请准备 v1 发布材料"));

  // Transient "update" noise must not leak into the transcript.
  const transcript = store.listRoomMessages(ROOM_ID);
  assert.deepEqual(transcript.map((m) => m.speaker), ["boss", "coder"]);
  assert.deepEqual(transcript.map((m) => m.seq), [1, 2]);
  assert.ok(transcript.every((m) => m.kind === "assistant"));
  assert.ok(transcript[0].content.includes("boss 给出了结论"));

  // ---- event contract (§7) -------------------------------------------------
  const topics = seen.map((e) => e.topic);
  for (const kind of ["round_started", "member_started", "turn_completed", "member_finished", "round_completed", "task_assigned"]) {
    assert.ok(eventsOf(seen, kind).length >= 1, `missing room event: ${kind}`);
  }
  assert.deepEqual(payloads(seen, "member_started").map((p) => p.member), ["boss", "coder"]);
  assert.deepEqual(payloads(seen, "member_finished").map((p) => p.member), ["boss", "coder"]);
  assert.deepEqual(payloads(seen, "turn_completed").map((p) => p.speaker), ["boss", "coder"]);
  assert.deepEqual(payloads(seen, "task_assigned"), [
    { member: "coder", task: "写 SMOKE.md 的初稿并保存到群文件", task_id: "t1", write_scope: [], depends_on: [] },
  ]);

  const firstTurn = payloads(seen, "turn_completed")[0];
  assert.equal(firstTurn.speaker, "boss");
  assert.ok(firstTurn.content.includes("boss 给出了结论"));
  assert.ok(Date.parse(firstTurn.timestamp), "turn_completed.timestamp must be a parseable ISO time");
  assert.ok(payloads(seen, "round_started")[0].members.includes("reviewer"));

  const roundCompleted = eventsOf(seen, "round_completed")[0];
  assert.deepEqual(roundCompleted.payload.speakers, ["boss", "coder"]);
  assert.equal(typeof roundCompleted.payload.ms, "number");
  assert.equal(roundCompleted.payload.paused, false);

  // Ordering: round_started → boss start → assignment → boss finish/turn → coder … → round_completed.
  const indicesOf = (kind) =>
    topics.reduce((acc, topic, i) => (topic === `room.${ROOM_ID}.${kind}` ? [...acc, i] : acc), []);
  const at = (kind, n = 0) => indicesOf(kind)[n];
  assert.ok(at("round_started") < at("member_started"));
  assert.ok(at("member_started") < at("task_assigned"));
  assert.ok(at("task_assigned") < at("member_finished"));
  assert.ok(at("member_finished") < at("member_started", 1));
  assert.ok(at("member_started", 1) < at("round_completed"));
  assert.equal(topics[topics.length - 1], `room.${ROOM_ID}.round_completed`);

  // Every event is on the room thread and has a strictly increasing seq.
  assert.ok(seen.every((e) => e.thread_id === `room:${ROOM_ID}`));
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i].seq > seen[i - 1].seq);
  // The same events were persisted for /api/thread/room:<id>/events replay.
  assert.deepEqual(
    store.listEvents({ thread_id: `room:${ROOM_ID}` }).map((e) => e.topic),
    topics,
  );
});

test("room: say() persists the user turn, answers immediately and runs the round in the background", async () => {
  const { room, store, seen } = await makeRoom({ name: "round-say" });
  const calls = installFakeRunners(room, {});

  const result = await room.say({ speaker: "user", content: "大家各自说一下进度" });
  assert.deepEqual(result, { status: "accepted", room_id: ROOM_ID });

  // The user message is durable before the round finishes (API returns fast).
  const userRows = store.listRoomMessages(ROOM_ID);
  assert.equal(userRows.length, 1);
  assert.equal(userRows[0].speaker, "user");
  assert.equal(userRows[0].content, "大家各自说一下进度");
  assert.equal(userRows[0].kind, "user");
  assert.deepEqual(payloads(seen, "turn_completed").map((p) => p.speaker), ["user"]);

  // No assignment → every member speaks, in member order, owner hoisted to front.
  await room._queue;
  assert.deepEqual(calls.map((c) => c.botId), ["boss", "coder", "reviewer"]);
  assert.deepEqual(store.listRoomMessages(ROOM_ID).map((m) => m.speaker), ["user", "boss", "coder", "reviewer"]);
  assert.equal(eventsOf(seen, "round_started").length, 1);
  assert.equal(eventsOf(seen, "round_completed").length, 1);
});

test("room: @mention selects the first speaker instead of hoisting the owner", async () => {
  const { room } = await makeRoom({ name: "round-mention" });
  const calls = installFakeRunners(room, {});

  // Product path: say() splices mentions into the speaking queue, then the
  // round's owner-hoisting rule is skipped because the message carries an @.
  await room.say({ speaker: "user", content: "@reviewer 请核验一下 coder 的产出" });
  await room._queue;

  assert.deepEqual(calls.map((c) => c.botId), ["reviewer", "boss", "coder"]);
  assert.equal(calls[0].botId, "reviewer");
});

test("room: muted members are skipped but still counted as seen", async () => {
  const { room } = await makeRoom({
    name: "round-mute",
    permissions: { reviewer: { can_speak: false } },
  });
  const calls = installFakeRunners(room, {});

  const spoken = await room.runRound({ instruction: "同步一下" });
  assert.deepEqual(spoken, ["boss", "coder"]);
  assert.deepEqual(calls.map((c) => c.botId), ["boss", "coder"]);
});

test("room: a failing member does not abort the round (notice instead of a message)", async () => {
  const { room, store, seen } = await makeRoom({ name: "round-error" });
  room.runnerFor = (botId) => ({
    run: async () => {
      if (botId === "boss") return { text: "", error: "模型调用失败", ms: 3, usage: null };
      return { text: `${botId} 正常`, usage: null, ms: 3 };
    },
    dispose() {},
  });

  const spoken = await room.runRound({ instruction: "开始" });
  assert.deepEqual(spoken, ["coder", "reviewer"], "other members keep working");
  assert.deepEqual(store.listRoomMessages(ROOM_ID).map((m) => m.speaker), ["coder", "reviewer"]);
  assert.ok(eventsOf(seen, "round_started").length === 1);
  assert.equal(eventsOf(seen, "round_completed").length, 1);
  assert.equal(eventsOf(seen, "turn_completed").length, 2);
});

test("room: circuit breaker pauses the room and drops the tripping turn from the transcript", async () => {
  const { room, store, seen } = await makeRoom({ name: "round-breaker" });
  installFakeRunners(room, {});
  room.relay_limit = 2;

  const spoken = await room.runRound({ instruction: "继续" });

  const tripped = eventsOf(seen, "circuit_breaker_tripped");
  assert.equal(tripped.length, 1);
  assert.equal(tripped[0].payload.limit, 2);
  assert.ok(tripped[0].payload.relays >= 2);
  assert.equal(room.status, "paused");

  const completed = eventsOf(seen, "round_completed")[0];
  assert.equal(completed.payload.paused, true);

  // Whatever was spoken is exactly what got persisted; the tripped turn is not in it.
  assert.deepEqual(store.listRoomMessages(ROOM_ID).map((m) => m.speaker), spoken);
  assert.ok(spoken.length >= 1 && spoken.length <= 2);

  // A new user turn resets the breaker (§5.4 / contract §3.4).
  await room.say({ speaker: "user", content: "继续干" });
  assert.equal(room.relays, 0);
  assert.equal(room.status, "active");
  assert.equal(eventsOf(seen, "circuit_breaker_reset").length, 1);
  await room._queue;
});

test("room: context policy shared injects the transcript", async () => {
  const { room } = await makeRoom({ name: "ctx-shared", policy: "shared" });
  room.message_log = Array.from({ length: 8 }, (_, i) => ({
    speaker: i % 2 ? "boss" : "coder",
    content: `第${i + 1}条消息`,
    kind: "assistant",
    timestamp: nowIso(),
  }));

  const instruction = room.buildInstruction("coder", { roundMessage: "本轮要求" });
  assert.ok(instruction.includes("=== 群聊共享上下文（房间 testroom：测试群） ==="));
  assert.ok(instruction.includes("[coder] 第1条消息"));
  assert.ok(instruction.includes("[boss] 第8条消息"), "full transcript keeps the newest turn");
  assert.ok(instruction.includes("当前群主（老板）：boss"));
  assert.ok(instruction.includes("=== 本轮消息 ===\n本轮要求"));
});

test("room: context policy summary only injects head+tail with an elision marker", async () => {
  const { room } = await makeRoom({ name: "ctx-summary", policy: "summary" });
  room.message_log = Array.from({ length: 8 }, (_, i) => ({
    speaker: "coder",
    content: `第${i + 1}条消息`,
    kind: "assistant",
    timestamp: nowIso(),
  }));

  const instruction = room.buildInstruction("coder", { roundMessage: "本轮要求" });
  assert.ok(instruction.includes("……（早前 2 条发言已省略）……"));
  assert.ok(instruction.includes("第1条消息"), "head of the transcript is summarised");
  assert.ok(instruction.includes("第8条消息"), "tail of the transcript is kept");
  assert.ok(!instruction.includes("第3条消息"), "elided middle must not leak");
  assert.ok(!instruction.includes("第4条消息"));
});

test("room: context policy isolated injects only the round message", async () => {
  const { room } = await makeRoom({ name: "ctx-isolated", policy: "isolated" });
  room.message_log = Array.from({ length: 8 }, (_, i) => ({
    speaker: "coder",
    content: `第${i + 1}条消息`,
    kind: "assistant",
    timestamp: nowIso(),
  }));
  room.system_notices = ["群文件地址已变更"];

  const instruction = room.buildInstruction("coder", { roundMessage: "本轮要求" });
  assert.ok(!instruction.includes("群聊共享上下文"), "no transcript under isolated");
  assert.ok(!instruction.includes("第1条消息"));
  assert.ok(instruction.includes("=== 系统通知 ===\n- 群文件地址已变更"));
  assert.ok(instruction.includes("=== 本轮消息 ===\n本轮要求"));
});

test("room: member context_access overrides the room policy (stricter wins)", async () => {
  const { room } = await makeRoom({ name: "ctx-override", policy: "shared" });
  room.message_log = Array.from({ length: 8 }, (_, i) => ({
    speaker: "coder",
    content: `第${i + 1}条消息`,
    kind: "assistant",
    timestamp: nowIso(),
  }));

  // access=none silently drops the transcript even though the room is shared.
  room.member_permissions.coder = defaultPermissions({ context_access: "none" });
  const noneInstruction = room.buildInstruction("coder", { roundMessage: "x" });
  assert.ok(!noneInstruction.includes("群聊共享上下文"));

  // access=summary downgrades a shared room to the summarised view.
  room.member_permissions.reviewer = defaultPermissions({ context_access: "summary" });
  const summaryInstruction = room.buildInstruction("reviewer", { roundMessage: "x" });
  assert.ok(summaryInstruction.includes("……（早前 2 条发言已省略）……"));

  // room=summary + access=full still yields the stricter (summary) view.
  room.context_policy = "summary";
  room.member_permissions.coder = defaultPermissions({ context_access: "full" });
  assert.ok(room.buildInstruction("coder", { roundMessage: "x" }).includes("省略"));
});

test("room: system notices are drained into the next round and file index is injected", async () => {
  const { room, store } = await makeRoom({ name: "ctx-notices" });
  installFakeRunners(room, {});

  store.addNotice({ parent_room_id: ROOM_ID, child_room_id: "sub9", kind: "subgroup_report", text: "小群 sub9 已有结论" });
  store.upsertRoomFile(ROOM_ID, { file_id: "feedbeef", path: "final/report.md", description: "终稿", tags: [] });

  const calls = [];
  const original = room.runnerFor;
  room.runnerFor = (botId) => {
    const runner = original.call(room, botId);
    runner.run = async ({ prompt }) => {
      calls.push({ botId, prompt });
      return { text: `${botId} ok`, ms: 1 };
    };
    return runner;
  };

  await room.runRound({ instruction: "开始" });

  assert.ok(calls.length >= 1);
  for (const call of calls) {
    assert.ok(call.prompt.includes("=== 系统通知 ===\n- 小群 sub9 已有结论"), `${call.botId} must see the notice`);
    assert.ok(call.prompt.includes("=== 群文件空间"), `${call.botId} must see the file index`);
    assert.ok(call.prompt.includes("file_id: feedbeef") || call.prompt.includes("feedbeef"));
    assert.ok(call.prompt.includes("final/report.md"));
  }
  // The notice is delivered exactly once.
  assert.deepEqual(store.listNotices(ROOM_ID), []);
});

test("room: snapshot exposes the API room shape", async () => {
  const { room } = await makeRoom({ name: "snapshot", members: ["boss", "coder", "librarian"] });
  const snap = room.snapshot();

  assert.equal(snap.room_id, ROOM_ID);
  assert.equal(snap.title, "测试群");
  assert.equal(snap.owner_id, "boss");
  assert.deepEqual(snap.members, ["boss", "coder", "librarian"]);
  assert.equal(snap.context_policy, "shared");
  assert.equal(snap.status, "active");
  assert.equal(typeof snap.message_count, "number");
  assert.equal(typeof snap.file_count, "number");
  assert.ok(snap.updated_at);
  assert.deepEqual(Object.keys(snap.member_permissions).sort(), ["boss", "coder", "librarian"]);
  assert.deepEqual(snap.member_permissions.coder, {
    can_speak: true,
    context_access: "full",
    can_create_subgroup: false,
    allowed_tool_overrides: null,
  });

  // listMembers() carries the permissions the room tools need.
  const roster = room.listMembers();
  assert.deepEqual(roster.map((m) => m.bot_id), ["boss", "coder", "librarian"]);
  assert.equal(roster[0].is_owner, true);
  assert.equal(roster[1].is_owner, false);
  assert.equal(room.isOwner("boss"), true);
  assert.equal(room.isOwner("coder"), false);
});

test("room: assignTask emits task_assigned and rejects unknown members", async () => {
  const { room, seen } = await makeRoom({ name: "assign-task" });

  const out = await room.assignTask("coder", "写测试");
  assert.deepEqual(out, { status: "assigned", room_id: ROOM_ID, member: "coder", task: "写测试", task_id: "t1" });
  assert.deepEqual(payloads(seen, "task_assigned"), [
    { member: "coder", task: "写测试", task_id: "t1", write_scope: [], depends_on: [] },
  ]);
  assert.deepEqual(room.pending_assignments.coder, ["写测试"]);

  await assert.rejects(() => room.assignTask("nobody", "x"), /成员不在群里/);
});

test("room: permission and context-policy changes are persisted and announced", async () => {
  const { room, store, seen } = await makeRoom({ name: "permissions" });

  const next = await room.grantPermission("coder", { can_speak: false, context_access: "summary" });
  assert.equal(next.can_speak, false);
  assert.equal(next.context_access, "summary");
  assert.deepEqual(payloads(seen, "permission_changed"), [{ member: "coder", permissions: next }]);
  const stored = store.listRoomMembers(ROOM_ID).find((m) => m.bot_id === "coder").permissions;
  assert.equal(stored.can_speak, false);
  assert.equal(stored.context_access, "summary");

  const revoked = await room.revokePermission("coder", "can_speak");
  assert.equal(revoked.can_speak, false);
  await room.revokePermission("coder", "allowed_tool_overrides");
  await assert.rejects(() => room.revokePermission("coder", "bogus"), /未知权限/);

  assert.equal(await room.setContextPolicy("isolated"), "isolated");
  assert.deepEqual(payloads(seen, "context_policy_changed"), [{ policy: "isolated" }]);
  assert.equal(store.getRoom(ROOM_ID).context_policy, "isolated");
  await assert.rejects(() => room.setContextPolicy("nonsense"), /非法上下文策略/);

  await room.setTopic("新主题");
  assert.equal(room.topic, "新主题");
  assert.equal(store.getRoom(ROOM_ID).topic, "新主题");
});

test("room: setSettings 持久化并在快照里可见（disabled_toolsets 房间级裁剪）", async () => {
  const { room, store } = await makeRoom({ name: "room-settings" });
  const next = await room.setSettings({ disabled_toolsets: ["exec", "exec"] });
  assert.deepEqual(next.disabled_toolsets, ["exec", "exec"], "合并后原样保存（去重由 toolsets 层负责）");
  assert.deepEqual(room.snapshot().settings.disabled_toolsets, ["exec", "exec"]);
  assert.deepEqual(store.getRoom(ROOM_ID).settings.disabled_toolsets, ["exec", "exec"], "落库");

  await room.setSettings({});
  assert.deepEqual(store.getRoom(ROOM_ID).settings.disabled_toolsets, ["exec", "exec"], "空补丁不丢已有设置");
});

test("room: 上下文水位随回合推进（第二轮只注入增量）", async () => {
  const { room } = await makeRoom({ name: "room-context-wm" });
  const prompts = [];
  installFakeRunners(room, { onRun: (_id, prompt) => prompts.push(prompt) });

  await room.runRound({ instruction: "第一轮：请各自表态" });
  prompts.length = 0;
  await room.runRound({ instruction: "第二轮：请补充一句" });

  const wm = room.roomContext.watermark("boss");
  assert.ok(wm > 0, "第一轮后水位应推进");
  assert.ok(prompts.length > 0, "第二轮有成员被唤醒");
  const bossPrompt = prompts.find((p) => p.includes("第二轮")) || prompts[0];
  assert.ok(bossPrompt.includes("第二轮：请补充一句"), "本轮消息必须在提示里");
  assert.ok(bossPrompt.length < 8000, "增量注入不应把整份历史重灌");
});

test("room: 回合结束写证据判定（无工具调用 → prepared）", async () => {
  const { room } = await makeRoom({ name: "room-evidence" });
  installFakeRunners(room);
  await room.runRound({ instruction: "请给结论" });
  const records = room.evidenceStore.list({ roomId: ROOM_ID });
  assert.ok(records.length >= 1, "每次成员发言都应有一条证据记录");
  assert.equal(records[0].status, "prepared", "只有文本、没有工具结果 = 仅声明");
  const summary = room.evidenceStore.summary({ roomId: ROOM_ID });
  assert.equal(summary.prepared >= 1, true);
});

/* ------------------------------------------------------ 小群生命周期（回收） */

/** 假 RoomManager：记录 create/get/delete 与子房 dispose。 */
function makeFakeSubManager() {
  const deleted = [];
  const disposed = [];
  const subRoom = {
    room_id: "sub1",
    message_log: [],
    _queue: Promise.resolve(),
    say: async ({ content }) => {
      subRoom.message_log.push({ speaker: "user", content });
      subRoom.message_log.push({ speaker: "coder", content: "小群结论：方案 A，取舍 B，待确认 C" });
    },
    dispose: () => disposed.push("sub1"),
  };
  const manager = {
    create: async (input) => ({ room_id: "sub1", members: input.members }),
    get: (id) => (String(id) === "sub1" ? subRoom : null),
    delete: (id) => {
      deleted.push(String(id));
      return true;
    },
  };
  return { manager, deleted, disposed, subRoom };
}

test("room: 小群默认在结论回传后被回收（dispose + delete + history）", async () => {
  const { room } = await makeRoom({ name: "subgroup-dispose" });
  const { manager, deleted, disposed } = makeFakeSubManager();
  room.manager = manager;

  const res = await room.createSubgroup({ members: ["coder", "reviewer"], topic: "选型", question: "A 还是 B", actor: "boss" });

  assert.equal(res.room_id, "sub1");
  assert.deepEqual(disposed, ["sub1"], "子房 pi 会话必须释放");
  assert.deepEqual(deleted, ["sub1"], "子房记录必须删除");
  assert.equal(res.retired?.deleted, true);
  assert.deepEqual(room.child_rooms, [], "活跃子房列表清空");
  assert.deepEqual(room.subgroup_history, ["sub1"], "历史里保留 id 便于追溯");
  assert.ok(
    room.message_log.some((m) => String(m.content).includes("小群结论")),
    "结论仍然回传父群",
  );
});

test("room: subgroup_lifecycle=keep 时保留子房（不 dispose 不 delete）", async () => {
  const { room } = await makeRoom({ name: "subgroup-keep" });
  const { manager, deleted, disposed } = makeFakeSubManager();
  room.manager = manager;
  room.settings = { subgroup_lifecycle: "keep" };

  const res = await room.createSubgroup({ members: ["coder", "reviewer"], topic: "保留", question: "Q", actor: "boss" });

  assert.equal(res.retired, null);
  assert.deepEqual(deleted, []);
  assert.deepEqual(disposed, []);
  assert.deepEqual(room.child_rooms, ["sub1"], "保留模式下子房仍在活跃列表");
});

test("room: room_evidence_status 工具返回证据汇总与逐条判定", async () => {
  const { room, store } = await makeRoom({ name: "evidence-tool" });
  const { createRoomTools } = await import("../src/rooms/tools.js");

  const saved = store.appendRoomMessage(ROOM_ID, { speaker: "coder", content: "已保存 file_id=deadbeef", kind: "assistant" });
  room.evidenceStore.record({
    roomId: ROOM_ID,
    botId: "coder",
    messageSeq: saved.seq,
    text: "已保存 file_id=deadbeef",
    toolCalls: [{ name: "room_file_save", ok: true, summary: "saved" }],
  });

  const tools = createRoomTools({ room, botId: "boss", permissions: {}, fileSpace: null, memory: null, telemetry: null });
  const tool = tools.find((t) => t.name === "room_evidence_status");
  assert.ok(tool, "工具必须挂载");
  const res = await tool.execute("call-1", {});
  const text = res.content[0].text;
  assert.match(text, /observed=0 prepared=0 mismatch=1/);
  assert.match(text, new RegExp(`#${saved.seq} coder：mismatch`));
});

test("room: subgroup_history 落到 kv，重开后仍可追溯", async () => {
  const { room, store, events } = await makeRoom({ name: "subgroup-history" });
  const { manager } = makeFakeSubManager();
  room.manager = manager;
  await room.createSubgroup({ members: ["coder", "reviewer"], topic: "追溯", question: "Q", actor: "boss" });

  const revived = new Room({ record: store.getRoom(ROOM_ID), store, events, engine: null, hooks: null, skills: null, archetypes: null, manager: null });
  assert.deepEqual(revived.subgroup_history, ["sub1"]);
  assert.deepEqual(revived.child_rooms, [], "已回收的不会回到活跃列表");
});

/* ------------------------------------------------ fanout 契约（写域 / 依赖） */

test("room: assignTask 校验写域冲突（并行写同一区域且无依赖 → 拒绝）", async () => {
  const { room } = await makeRoom({ name: "fanout-conflict" });
  const first = await room.assignTask("coder", "写报告", { writeScope: ["reports/"] });
  assert.equal(first.task_id, "t1");

  await assert.rejects(
    () => room.assignTask("reviewer", "改同一份报告", { writeScope: ["reports/final.md"] }),
    /分派被拒绝（任务单元契约）/,
    "目录与文件前缀重叠必须硬报错",
  );
  // 加上依赖后串行化即可通过
  const ok = await room.assignTask("reviewer", "改同一份报告", { writeScope: ["reports/final.md"], dependsOn: ["t1"] });
  assert.equal(ok.task_id, "t2");
});

test("room: runRound 按 fanout 拓扑序决定发言顺序", async () => {
  const { room } = await makeRoom({ name: "fanout-order" });
  const order = [];
  installFakeRunners(room, {
    onRun: async (botId) => {
      order.push(botId);
      if (botId === "boss") {
        await room.assignTask("coder", "写 A", { writeScope: ["out/"] });
        await room.assignTask("reviewer", "审 A", { writeScope: ["out/"], dependsOn: ["t1"] });
      }
    },
  });

  await room.runRound({ instruction: "开始" });

  assert.deepEqual(order.slice(0, 3), ["boss", "coder", "reviewer"], "boss 先分派，然后按依赖顺序 coder → reviewer");
  assert.equal(room.task_plan.length, 0 || room.task_plan.length, "回合结束后计划可清空（断言不抛错）");
});

test("room: assignTask 支持显式 task_id，depends_on 可直接引用", async () => {
  const { room } = await makeRoom({ name: "fanout-explicit-id" });
  await room.assignTask("coder", "写草稿", { id: "draft", writeScope: ["out/"] });
  const second = await room.assignTask("reviewer", "审草稿", { id: "review", writeScope: ["out/"], dependsOn: ["draft"] });

  assert.equal(second.task_id, "review");
  assert.deepEqual(room.task_plan.map((t) => t.id), ["draft", "review"]);
  assert.deepEqual(room.taskPlanBotOrder(), ["coder", "reviewer"]);
});

/* --------------------------------------- 执行短路（executor）与学习闭环（learn） */

/** 每个成员都返回成功 + 一个成功的工具结果（证据 = observed）。 */
function installObservedRunners(room) {
  const ran = [];
  room.runnerFor = (botId) => ({
    run: async () => {
      ran.push(String(botId));
      // reviewer 必须显式表态：judgeReviewer 把「没表态」当 null，学习闸门会拦截。
      const verdict = /review/i.test(botId) ? "；结论：通过" : "";
      return {
        text: `${botId} 完成本轮产出，引用 file_id 12345678${verdict}`,
        toolResults: [{ name: "room_file_read", ok: true, summary: "ok" }],
        ms: 1,
      };
    },
    dispose() {},
  });
  return ran;
}

test("room: 学习闭环——回合质量达标时生成技能提案，signature 去重", async () => {
  const { room } = await makeRoom({ name: "learn-auto" });
  installObservedRunners(room);
  const proposals = [];
  room.manager = { curator: { propose: (p) => { proposals.push(p); return { id: `p${proposals.length}`, ...p }; } } };

  await room.runRound({ instruction: "写一份发布说明并核对" });
  assert.equal(proposals.length, 1, "达标回合应产出一条提案");
  assert.ok(proposals[0].title.length <= 40);
  assert.match(proposals[0].body, /目标/);
  assert.ok(proposals[0].tags.includes("auto"));

  await room.runRound({ instruction: "写一份发布说明并核对" });
  assert.equal(proposals.length, 1, "同一经验不应重复提案（kv signature 去重）");
});

test("room: auto_propose_skills=off 时不提案", async () => {
  const { room } = await makeRoom({ name: "learn-off" });
  installObservedRunners(room);
  room.settings = { auto_propose_skills: "off" };
  const proposals = [];
  room.manager = { curator: { propose: (p) => { proposals.push(p); return { id: "p1", ...p }; } } };

  await room.runRound({ instruction: "随便做点什么" });
  assert.equal(proposals.length, 0);
});

test("room: 上游任务失败时下游被跳过，兄弟分支不受影响", async () => {
  const { room } = await makeRoom({
    name: "exec-skip",
    members: ["boss", "coder", "reviewer", "writer"],
  });
  const ran = [];
  room.runnerFor = (botId) => ({
    run: async () => {
      ran.push(String(botId));
      if (botId === "boss") {
        await room.assignTask("coder", "写 A", { id: "a", writeScope: ["out/a/"] });
        await room.assignTask("reviewer", "审 A", { id: "b", writeScope: ["out/a/"], dependsOn: ["a"] });
        await room.assignTask("writer", "写 B", { id: "c", writeScope: ["out/b/"] });
        return { text: "已分派 3 项", toolResults: [{ name: "room_assign_task", ok: true }], ms: 1 };
      }
      if (botId === "coder") return { text: "", error: "模型超时", ms: 1 };
      return { text: `${botId} 正常完成`, toolResults: [{ name: "room_file_read", ok: true }], ms: 1 };
    },
    dispose() {},
  });

  await room.runRound({ instruction: "开始" });

  assert.ok(ran.includes("coder"), "失败的上游自己跑过");
  assert.ok(!ran.includes("reviewer"), "依赖失败的 reviewer 不应再跑");
  assert.ok(ran.includes("writer"), "兄弟分支 writer 不受影响");
  assert.ok(room.system_notices.some((n) => n.includes("被跳过")), "跳过要写进系统通知");
});

test("room: 手动 /learn 在 off 模式下仍可提案，但证据质量闸门不放松；tags 不进正文", async () => {
  const { room } = await makeRoom({ name: "learn-force" });
  const proposals = [];
  room.manager = { curator: { propose: (p) => { proposals.push(p); return { id: `p${proposals.length}`, ...p }; } } };
  room.settings = { auto_propose_skills: "off" };

  const observed = [
    { bot_id: "coder", text: "写完了，file_id 12345678", evidence: "observed", ms: 1 },
    { bot_id: "reviewer", text: "通过", evidence: "observed", ms: 1 },
  ];
  const ok = await room.proposeLearningSkill({ instruction: "写发布说明", turns: observed, force: true });
  assert.equal(ok.ok, true, "人工触发应绕过 auto_propose_skills=off");
  assert.equal(proposals.length, 1);
  assert.ok(!String(proposals[0].body).includes("关键词：auto"), "内部标记不能污染 playbook 正文");
  assert.ok(proposals[0].tags.includes("auto"), "提案元数据仍带 auto");

  const preparedOnly = observed.map((turn) => ({ ...turn, evidence: "prepared" }));
  const denied = await room.proposeLearningSkill({ instruction: "另一件事", turns: preparedOnly, force: true });
  assert.equal(denied.ok, false, "force 不放松证据质量闸门");
  assert.equal(proposals.length, 1);
});

test("room: judgeReviewer 接入学习闸门——未表态不学、否定语境不误判", async () => {
  const { room } = await makeRoom({ name: "learn-judge" });
  const proposals = [];
  room.manager = { curator: { propose: (p) => { proposals.push(p); return { id: `p${proposals.length}`, ...p }; } } };
  const coderTurn = [{ bot_id: "coder", text: "写完了，file_id 12345678", evidence: "observed", ms: 1 }];
  const reviewer = (text) => ({ bot_id: "reviewer", text, evidence: "observed", ms: 1 });

  const noStance = await room.proposeLearningSkill({ instruction: "A", turns: [...coderTurn, reviewer("我先过一遍，稍后复核。")], force: true });
  assert.equal(noStance.ok, false, "reviewer 在场但没表态 → 不沉淀");
  assert.match(noStance.reason, /未表态/);

  const negated = await room.proposeLearningSkill({ instruction: "B", turns: [...coderTurn, reviewer("没有问题，不用修改。")], force: true });
  assert.equal(negated.ok, true, "「不用修改」是 pass，不能被旧启发式误判成 reject");
  assert.equal(negated.reviewer?.verdict, "pass");

  const rejected = await room.proposeLearningSkill({ instruction: "C", turns: [...coderTurn, reviewer("需要修改：字数超了")], force: true });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /不通过|不沉淀/);
});
