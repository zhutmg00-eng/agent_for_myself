/**
 * tests/challenger_m5_stress.test.mjs
 *
 * Milestone 5 Challenger Empirical Stress Test Suite
 *
 * Adversarial and Stress Verification:
 * 1. Complex DAG Task Fanout under High Stress:
 *    - 5-tier task DAG with multiple concurrent dependencies (depths 0 to 4).
 *    - Topological ordering enforcement and fanout resolution with TCR = 100%.
 *    - Adversarial edge cases: cycle rejection, write conflict without dependency, cascading skips.
 * 2. Rapid Relay Extension & Boundary Clamping:
 *    - Rapid alternating mutating (Tier 1) and observational (Tier 2) turns.
 *    - Strict ceiling clamping: relay limit expands to max_relay_ceiling and NEVER overshoots.
 *    - Chatter tripping: consecutive non-progress turns cleanly trigger circuit breaker.
 * 3. Spillover Pruning Stress:
 *    - Rapid generation of 120 spillover log files with explicit timestamps.
 *    - Strict verification of `pruneSpillFiles({ maxFiles: 50 })`: bounded to <= 50, oldest-first eviction.
 *    - Integration stress with 120 rapid `clampToolOutput` calls on massive outputs.
 * 4. Telemetry Precision Under High-Frequency Rounds:
 *    - 10 rapid successive turns with non-trivial TTFT, gen duration, and token metrics.
 *    - Mathematical parity assertion: SQLite aggregate AVG matches exact mathematical formula.
 *    - Multi-bot breakdown parity: `by_bot` metrics match exact per-bot averages.
 *
 * Hard AOD Constraints:
 *  - Strict D-drive workspace isolation (zero C-drive writes).
 *  - Deterministic execution without external network or gateway dependency.
 */

import { TEST_DATA_ROOT, onCleanup } from "./_helpers/env.mjs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store, defaultPermissions } from "../src/store.js";
import { EventBus } from "../src/events.js";
import { Room, evalForwardProgress, detectInfiniteLoop } from "../src/rooms/room.js";
import { planTasks, FANOUT_LIMITS } from "../src/rooms/fanout.js";
import { clampToolOutput, pruneSpillFiles } from "../src/engine/clamp.js";
import { computeTurnTelemetry } from "../src/engine/telemetry.js";
import { DIRS, assertNotC } from "../src/config.js";

// Helper: Setup isolated room environment on D: drive
async function setupStressRoom({
  name = "m5_stress",
  members = ["boss", "planner", "coder", "reviewer", "explorer", "analyst", "writer"],
  owner = "boss",
  settings = {},
  permissions = {},
} = {}) {
  const dbPath = path.join(
    TEST_DATA_ROOT,
    "data",
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`,
  );
  assertNotC(dbPath, "test db path");
  const store = new Store(dbPath);
  onCleanup(() => store.close());
  const events = new EventBus(store);
  const seen = [];
  const off = events.subscribe((evt) => seen.push(evt));
  onCleanup(off);

  const roomId = `room_${name}`;
  const record = {
    room_id: roomId,
    title: `M5 Stress Suite Room - ${name}`,
    owner_id: owner,
    context_policy: "shared",
    status: "active",
    settings,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  store.upsertRoom(record);
  store.setRoomMembers(
    roomId,
    members.map((id) => ({
      bot_id: id,
      permissions: defaultPermissions({
        can_create_subgroup: id === owner,
        ...(permissions[id] || {}),
      }),
    })),
  );

  const room = new Room({
    record,
    store,
    events,
    approval: null,
    telemetry: null,
    engine: null,
  });
  await room.loadMembers();
  return { room, store, events, seen, roomId };
}

function payloads(seen, roomId, kind) {
  return seen.filter((e) => e.topic === `room.${roomId}.${kind}`).map((e) => e.payload);
}

// =============================================================================
// CHALLENGE 1: Complex DAG Task Fanout under High Stress
// =============================================================================
describe("Challenge 1: Complex DAG Task Fanout under High Stress", () => {
  test("1.1 5-tier task DAG with concurrent dependencies executes in topological order with TCR = 100%", async () => {
    const { room, store, seen, roomId } = await setupStressRoom({
      name: "dag_5tier_stress",
      members: ["boss", "planner", "coder", "reviewer", "explorer", "analyst", "writer"],
      owner: "boss",
      settings: {
        base_relay_limit: 15,
        max_relay_ceiling: 25,
      },
    });

    // Define 8 tasks across 5 distinct topological tiers (depths 0 through 4)
    // Tier 0 (depth 0):
    //   t_1_1 (analyst): schema survey
    //   t_1_2 (explorer): perf benchmarks
    // Tier 1 (depth 1):
    //   t_2_1 (planner): blueprint (deps: t_1_1, t_1_2)
    //   t_2_2 (coder): test harness (deps: t_1_1)
    // Tier 2 (depth 2):
    //   t_3_1 (coder): optimizer engine (deps: t_2_1, t_2_2)
    //   t_3_2 (analyst): statistical validator (deps: t_2_1)
    // Tier 3 (depth 3):
    //   t_4_1 (writer): technical manual (deps: t_3_1, t_3_2)
    // Tier 4 (depth 4):
    //   t_5_1 (reviewer): audit & verdict (deps: t_4_1)

    const rawTasks = [
      { id: "t_1_1", bot_id: "analyst", write_scope: ["reports/schema.json"], depends_on: [] },
      { id: "t_1_2", bot_id: "explorer", write_scope: ["reports/perf.json"], depends_on: [] },
      { id: "t_2_1", bot_id: "planner", write_scope: ["docs/blueprint.md"], depends_on: ["t_1_1", "t_1_2"] },
      { id: "t_2_2", bot_id: "coder", write_scope: ["tests/query_opt.test.mjs"], depends_on: ["t_1_1"] },
      { id: "t_3_1", bot_id: "coder", write_scope: ["src/query_opt.js"], depends_on: ["t_2_1", "t_2_2"] },
      { id: "t_3_2", bot_id: "analyst", write_scope: ["tests/stat_validation.mjs"], depends_on: ["t_2_1"] },
      { id: "t_4_1", bot_id: "writer", write_scope: ["docs/manual.md"], depends_on: ["t_3_1", "t_3_2"] },
      { id: "t_5_1", bot_id: "reviewer", write_scope: ["reports/audit.json"], depends_on: ["t_4_1"] },
    ];

    // Verify static DAG plan properties
    const plan = planTasks({ tasks: rawTasks, members: room.members });
    assert.equal(plan.ok, true, "5-tier DAG must be structurally valid");
    assert.equal(plan.errors.length, 0);
    assert.equal(plan.units.length, 8);

    // Verify depth calculation conforms to 5 tiers (depths 0..4)
    const depthMap = new Map(plan.units.map((u) => [u.id, u.depth]));
    assert.equal(depthMap.get("t_1_1"), 0, "Tier 0 depth");
    assert.equal(depthMap.get("t_1_2"), 0, "Tier 0 depth");
    assert.equal(depthMap.get("t_2_1"), 1, "Tier 1 depth");
    assert.equal(depthMap.get("t_2_2"), 1, "Tier 1 depth");
    assert.equal(depthMap.get("t_3_1"), 2, "Tier 2 depth");
    assert.equal(depthMap.get("t_3_2"), 2, "Tier 2 depth");
    assert.equal(depthMap.get("t_4_1"), 3, "Tier 3 depth");
    assert.equal(depthMap.get("t_5_1"), 4, "Tier 4 depth");

    // Assign all tasks to room
    for (const t of rawTasks) {
      await room.assignTask(t.bot_id, `Execute ${t.id}`, {
        id: t.id,
        writeScope: t.write_scope,
        dependsOn: t.depends_on,
      });
    }

    assert.equal(room.task_plan.length, 8);

    // Track execution history and unit completion order
    const executionTrace = [];
    const completedUnits = new Set();

    room.runnerFor = (botId) => ({
      run: async ({ prompt }) => {
        // Find which unit for this bot is ready
        const plan = room._executionPlan;
        assert.ok(plan, "Execution plan must be active");
        // Locate unit belonging to botId that is ready
        const readyUnits = rawTasks.filter((t) => {
          if (t.bot_id !== botId) return false;
          if (completedUnits.has(t.id)) return false;
          return t.depends_on.every((dep) => completedUnits.has(dep));
        });

        assert.ok(readyUnits.length > 0, `Bot ${botId} called but no unit ready! Prompt: ${prompt}`);
        const currentUnit = readyUnits[0];

        // Topological ordering assertion: ALL dependencies MUST have already completed!
        for (const depId of currentUnit.depends_on) {
          assert.ok(
            completedUnits.has(depId),
            `Topological violation: ${currentUnit.id} executed before dependency ${depId} finished!`,
          );
        }

        completedUnits.add(currentUnit.id);
        executionTrace.push({
          unitId: currentUnit.id,
          botId,
          depth: depthMap.get(currentUnit.id),
          timestamp: Date.now(),
        });

        // Save file in file space to verify mutating progress
        await room.fileSpace.save({
          name: currentUnit.write_scope[0],
          content: `// Artifact generated by ${botId} for ${currentUnit.id}`,
          description: `Deliverable for ${currentUnit.id}`,
          actor: botId,
        });

        return {
          text: `### 交付成果 ${currentUnit.id}\n已按架构要求完成对应层级的实现与测试，写域为 ${currentUnit.write_scope[0]}。`,
          toolsUsed: ["write_file"],
          toolResults: [{ name: "write_file", ok: true, file: currentUnit.write_scope[0] }],
          ms: 20,
          usage: { input_tokens: 150, output_tokens: 80 },
        };
      },
      dispose() {},
    });

    // Execute round
    const spoken = await room.runRound({ instruction: "请团队协同执行 5 层架构重构与验收计划" });

    // Assertions:
    // 1. All 8 units completed
    assert.equal(completedUnits.size, 8, "All 8 task units must be completed");
    assert.equal(executionTrace.length, 8, "Exactly 8 execution steps recorded");

    // 2. Task Completion Rate (TCR) = 100%
    const tcr = (completedUnits.size / rawTasks.length) * 100;
    assert.equal(tcr, 100.0, "TCR must be 100.0%");

    // 3. Verify topological invariants on the trace
    const executedIndices = new Map(executionTrace.map((e, idx) => [e.unitId, idx]));
    for (const task of rawTasks) {
      const taskIdx = executedIndices.get(task.id);
      assert.ok(taskIdx !== undefined, `Task ${task.id} must be in trace`);
      for (const dep of task.depends_on) {
        const depIdx = executedIndices.get(dep);
        assert.ok(
          depIdx < taskIdx,
          `Topological violation: Dependency ${dep} (idx ${depIdx}) executed after ${task.id} (idx ${taskIdx})`,
        );
      }
    }

    // 4. Verify all units transitioned to "done" in room execution plan
    for (const task of rawTasks) {
      assert.equal(
        room._executionPlan.states[task.id],
        "done",
        `Unit ${task.id} must be in 'done' state in execution plan`,
      );
    }

    // 5. Verify room files exist
    const files = room.fileSpace.list();
    assert.equal(files.length, 8, "All 8 deliverable files registered in file space");
  });

  test("1.2 Adversarial DAG edge cases: cycle rejection, self/unknown dependency, write conflict, and upstream cascading skip", async () => {
    const { room, store, seen, roomId } = await setupStressRoom({
      name: "dag_adversarial",
      members: ["boss", "coder", "reviewer", "planner"],
      owner: "boss",
    });

    // Edge Case A1: Direct planTasks cycle detection rejection on circular task graph
    const cyclicBatch = [
      { id: "cycle_a", bot_id: "coder", depends_on: ["cycle_b"] },
      { id: "cycle_b", bot_id: "planner", depends_on: ["cycle_c"] },
      { id: "cycle_c", bot_id: "reviewer", depends_on: ["cycle_a"] },
    ];
    const cyclePlan = planTasks({ tasks: cyclicBatch, members: room.members });
    assert.equal(cyclePlan.ok, false);
    assert.ok(cyclePlan.errors.some((e) => e.code === "cycle"), "planTasks must detect circular dependency");

    // Edge Case A2: assignTask self-dependency rejection
    await assert.rejects(
      async () => {
        await room.assignTask("coder", "Self dependent", { id: "self_task", dependsOn: ["self_task"] });
      },
      (err) => {
        assert.equal(err.code, "fanout_invalid");
        assert.ok(err.errors.some((e) => e.code === "self_dependency"));
        return true;
      },
      "Must reject self-dependency",
    );

    // Edge Case A3: assignTask unknown dependency rejection
    await assert.rejects(
      async () => {
        await room.assignTask("coder", "Unknown dependent", { id: "bad_task", dependsOn: ["ghost_task"] });
      },
      (err) => {
        assert.equal(err.code, "fanout_invalid");
        assert.ok(err.errors.some((e) => e.code === "unknown_dependency"));
        return true;
      },
      "Must reject unknown dependency",
    );

    // Edge Case B: Write conflict without dependency rejection
    const { room: conflictRoom } = await setupStressRoom({
      name: "dag_conflict",
      members: ["boss", "coder", "planner"],
      owner: "boss",
    });

    await conflictRoom.assignTask("coder", "Task 1", {
      id: "conf_1",
      writeScope: ["src/kernel/**"],
      dependsOn: [],
    });

    await assert.rejects(
      async () => {
        await conflictRoom.assignTask("planner", "Task 2", {
          id: "conf_2",
          writeScope: ["src/kernel/engine.js"],
          dependsOn: [], // Overlapping scope without dependency!
        });
      },
      (err) => {
        assert.equal(err.code, "fanout_invalid");
        assert.ok(err.errors.some((e) => e.code === "write_conflict"));
        return true;
      },
      "Must reject un-sequenced write conflicts",
    );

    // Edge Case C: Cascading skip on upstream task failure
    const { room: skipRoom, seen: skipSeen, roomId: skipRoomId } = await setupStressRoom({
      name: "dag_skip",
      members: ["boss", "coder", "reviewer"],
      owner: "boss",
    });

    await skipRoom.assignTask("coder", "Upstream step", { id: "step_1", dependsOn: [] });
    await skipRoom.assignTask("reviewer", "Downstream step", { id: "step_2", dependsOn: ["step_1"] });

    // Harness where step_1 fails
    skipRoom.runnerFor = (botId) => ({
      run: async () => {
        if (botId === "coder") {
          return { text: "", error: "Compilation fatal error: exit code 1", ms: 10 };
        }
        return { text: "Reviewer ok", ms: 10 };
      },
      dispose() {},
    });

    await skipRoom.runRound({ instruction: "Execute pipeline" });

    // step_2 must have been skipped
    assert.equal(skipRoom._executionPlan.states["step_1"], "failed");
    assert.equal(skipRoom._executionPlan.states["step_2"], "skipped");

    const skippedEvents = payloads(skipSeen, skipRoomId, "task_skipped");
    assert.ok(skippedEvents.some((e) => e.task_id === "step_2" && e.member === "reviewer"));
  });
});

// =============================================================================
// CHALLENGE 2: Rapid Relay Extension & Boundary Clamping
// =============================================================================
describe("Challenge 2: Rapid Relay Extension & Boundary Clamping", () => {
  test("2.1 High-frequency alternating mutating & observational progress expands to max_relay_ceiling and clamps cleanly", async () => {
    const { room, seen, roomId } = await setupStressRoom({
      name: "relay_clamp_stress",
      members: ["boss", "worker"],
      owner: "boss",
      settings: {
        base_relay_limit: 2,
        max_relay_ceiling: 10,
      },
    });

    assert.equal(room.relay_limit, 2);
    assert.equal(room.max_relay_ceiling, 10);

    const mutatingProgress = () =>
      evalForwardProgress({
        toolsUsed: ["write_file"],
        toolResults: [{ name: "write_file", ok: true }],
        text: "Mutating work done",
      });

    const observationalProgress = () =>
      evalForwardProgress({
        toolsUsed: ["read_file"],
        toolResults: [{ name: "read_file", ok: true }],
        text: "Observational work done",
      });

    // Rapid alternating sequence of 30 progress triggers
    let totalGranted = 0;
    const history = [];

    for (let i = 0; i < 30; i++) {
      const isMutating = i % 2 === 0;
      const progress = isMutating ? mutatingProgress() : observationalProgress();
      const expectedNominal = isMutating ? 2 : 1;
      assert.equal(progress.grant, expectedNominal);

      const oldLimit = room.relay_limit;
      const actualGrant = await room.extendRelayLimit(progress.grant, progress.reason);
      totalGranted += actualGrant;

      history.push({
        step: i,
        isMutating,
        nominal: progress.grant,
        actualGrant,
        oldLimit,
        newLimit: room.relay_limit,
      });

      // INVARIANT: relay_limit MUST NEVER overshoot max_relay_ceiling!
      assert.ok(
        room.relay_limit <= room.max_relay_ceiling,
        `Relay limit exceeded ceiling at step ${i}: ${room.relay_limit} > ${room.max_relay_ceiling}`,
      );

      // Once ceiling is reached, actualGrant MUST BE strictly 0
      if (oldLimit >= room.max_relay_ceiling) {
        assert.equal(actualGrant, 0, `Expected 0 grant once ceiling reached at step ${i}`);
        assert.equal(room.relay_limit, room.max_relay_ceiling);
      }
    }

    // Verification of exact arithmetic bounds:
    // Initial was 2, ceiling is 10. Total possible grants = 10 - 2 = 8.
    assert.equal(totalGranted, 8, "Total cumulative grants must equal (ceiling - base) = 8");
    assert.equal(room.relay_limit, 10, "Final relay limit must clamp exactly at 10");

    // Extreme oversized grant test:
    const hugeGrant = await room.extendRelayLimit(9999, "oversized_overflow_test");
    assert.equal(hugeGrant, 0, "Oversized grant at ceiling must yield 0");
    assert.equal(room.relay_limit, 10, "Relay limit remains clamped at 10");

    // Non-positive grant test:
    const zeroGrant = await room.extendRelayLimit(0, "zero_grant");
    assert.equal(zeroGrant, 0);
    const negativeGrant = await room.extendRelayLimit(-5, "negative_grant");
    assert.equal(negativeGrant, 0);

    // Emitted events verification: only actual positive grants emit relay_extended
    const extendedEvents = payloads(seen, roomId, "relay_extended");
    const sumEventGrants = extendedEvents.reduce((acc, ev) => acc + ev.grant, 0);
    assert.equal(sumEventGrants, 8, "Sum of emitted grant events must equal 8");
    for (const ev of extendedEvents) {
      assert.ok(ev.new_limit <= ev.ceiling, "Event new_limit <= ceiling");
    }
  });

  test("2.2 Consecutive chatter turns reliably trigger chatter_limit_tripped circuit breaker", async () => {
    const { room, seen, roomId } = await setupStressRoom({
      name: "chatter_tripped_stress",
      members: ["boss", "bot_chatter"],
      owner: "boss",
      settings: {
        base_relay_limit: 10,
        max_relay_ceiling: 15,
        max_chatter_relays: 2,
      },
    });

    let turnsExecuted = 0;
    room.runnerFor = () => ({
      run: async () => {
        turnsExecuted++;
        // Trivial chatter without tools or structured markdown
        return {
          text: "收到，明白，好的。",
          toolsUsed: [],
          toolResults: [],
          ms: 10,
        };
      },
      dispose() {},
    });

    const spoken = await room.runRound({ instruction: "请开始工作" });

    // Invariant: After max_chatter_relays (2) consecutive stagnant turns, round halts
    assert.ok(turnsExecuted <= 2, `Chatter breaker should halt round after <= 2 turns, got ${turnsExecuted}`);
    const tripEvents = payloads(seen, roomId, "chatter_limit_tripped");
    assert.equal(tripEvents.length, 1, "chatter_limit_tripped event must be emitted");
    assert.equal(tripEvents[0].consecutive_stagnant, 2);
  });
});

// =============================================================================
// CHALLENGE 3: Spillover Pruning Stress
// =============================================================================
describe("Challenge 3: Spillover Pruning Stress", () => {
  test("3.1 120 spillover files in rapid succession pruned to <= 50 with strict oldest-first eviction", async () => {
    const tempOutputsDir = path.join(DIRS.temp, "tool_outputs");
    assertNotC(tempOutputsDir, "tool outputs dir must not be on C:");
    fs.mkdirSync(tempOutputsDir, { recursive: true });

    // Clean existing test files in tempOutputsDir for deterministic test
    const preExisting = fs.readdirSync(tempOutputsDir).filter((f) => f.startsWith("stress_spill_"));
    for (const f of preExisting) {
      fs.unlinkSync(path.join(tempOutputsDir, f));
    }

    const totalFiles = 120;
    const now = Date.now();
    const createdFiles = [];

    // Create 120 files with strictly monotonic mtime timestamps
    // File 0 is oldest (now - 120 * 1000ms), File 119 is newest (now - 1 * 1000ms)
    for (let i = 0; i < totalFiles; i++) {
      const fileName = `stress_spill_${String(i).padStart(3, "0")}.log`;
      const fullPath = path.join(tempOutputsDir, fileName);
      assertNotC(fullPath, "spill file path");
      const content = `SPILLOVER_STRESS_PAYLOAD_FILE_${i}\n` + "x".repeat(500);
      fs.writeFileSync(fullPath, content, "utf8");

      const mtimeSec = Math.floor((now - (totalFiles - i) * 1000) / 1000);
      fs.utimesSync(fullPath, mtimeSec, mtimeSec);
      createdFiles.push({ index: i, fullPath, fileName, mtimeSec });
    }

    // Verify all 120 files exist before pruning
    const initialLogs = fs.readdirSync(tempOutputsDir).filter((f) => f.startsWith("stress_spill_"));
    assert.equal(initialLogs.length, 120, "120 files created successfully");

    // Execute prune with maxFiles = 50
    const prunedCount = pruneSpillFiles({ maxFiles: 50, maxAgeMs: 100000000 });

    // Invariant 1: Exactly 70 files pruned (120 - 50 = 70)
    assert.equal(prunedCount, 70, `Expected 70 pruned files, got ${prunedCount}`);

    // Invariant 2: Exactly 50 stress files remain on disk (<= 50)
    const remainingLogs = fs.readdirSync(tempOutputsDir).filter((f) => f.startsWith("stress_spill_"));
    assert.equal(remainingLogs.length, 50, `Expected exactly 50 remaining files, got ${remainingLogs.length}`);

    // Invariant 3: Strict oldest-first eviction check
    // The 70 oldest files (index 0 to 69) MUST BE DELETED
    for (let i = 0; i < 70; i++) {
      const exists = fs.existsSync(createdFiles[i].fullPath);
      assert.equal(exists, false, `Old file ${createdFiles[i].fileName} (index ${i}) was NOT pruned!`);
    }

    // The 50 newest files (index 70 to 119) MUST STILL EXIST
    for (let i = 70; i < 120; i++) {
      const exists = fs.existsSync(createdFiles[i].fullPath);
      assert.equal(exists, true, `New file ${createdFiles[i].fileName} (index ${i}) was incorrectly pruned!`);
    }

    // Clean up created files
    for (const f of createdFiles) {
      if (fs.existsSync(f.fullPath)) fs.unlinkSync(f.fullPath);
    }
  });

  test("3.2 120 rapid clampToolOutput invocations maintain bounded storage <= 50 files", async () => {
    const tempOutputsDir = path.join(DIRS.temp, "tool_outputs");
    assertNotC(tempOutputsDir, "tool outputs dir must not be on C:");
    fs.mkdirSync(tempOutputsDir, { recursive: true });

    // Clean existing test files in tempOutputsDir
    const existing = fs.readdirSync(tempOutputsDir).filter((f) => f.startsWith("rapid_clamp_"));
    for (const f of existing) {
      fs.unlinkSync(path.join(tempOutputsDir, f));
    }

    // Generate massive output (15,000 characters)
    const payload = "LOG_HEADER\n" + "Tracing compiler execution phase [PASS]\n".repeat(350) + "BUILD SUCCESS\n";
    assert.ok(payload.length > 10000);

    const generatedSpills = [];

    // Trigger 120 rapid clamps
    for (let i = 0; i < 120; i++) {
      const res = clampToolOutput(payload, {
        maxChars: 2000,
        headChars: 800,
        tailChars: 500,
        toolName: `rapid_clamp_${i}`,
      });

      assert.equal(res.clamped, true);
      assert.ok(res.spillPath !== null);
      assertNotC(res.spillPath, "Spill file strictly non-C");
      generatedSpills.push(res.spillPath);
    }

    // Verification: tool_outputs directory contains <= 50 .log files
    const remainingLogs = fs.readdirSync(tempOutputsDir).filter((f) => f.endsWith(".log"));
    assert.ok(
      remainingLogs.length <= 50,
      `Directory file count must be <= 50 after rapid clamps, got ${remainingLogs.length}`,
    );

    // Clean up any remaining rapid_clamp files
    for (const f of fs.readdirSync(tempOutputsDir)) {
      if (f.startsWith("rapid_clamp_")) {
        try {
          fs.unlinkSync(path.join(tempOutputsDir, f));
        } catch {}
      }
    }
  });
});

// =============================================================================
// CHALLENGE 4: Telemetry Precision Under High-Frequency Rounds
// =============================================================================
describe("Challenge 4: Telemetry Precision Under High-Frequency Rounds", () => {
  test("4.1 10 rapid successive turns verify average TPS & TTFT calculations in SQLite match exact math", async () => {
    const dbPath = path.join(TEST_DATA_ROOT, "data", `tel_stress_${Date.now()}.db`);
    assertNotC(dbPath, "dbPath strictly on non-C");
    const store = new Store(dbPath);
    onCleanup(() => store.close());

    const roomId = "room_tel_precision";
    const botId = "worker_speedy";
    const numRounds = 10;

    const roundData = [];
    let sumTtft = 0;
    let sumTps = 0;
    let sumInputTokens = 0;
    let sumOutputTokens = 0;
    let sumCacheRead = 0;
    let sumCacheWrite = 0;
    let sumTotalMs = 0;

    // Execute 10 rapid rounds with non-trivial telemetry
    for (let i = 1; i <= numRounds; i++) {
      const startedAt = 100000 + i * 5000;
      const ttftMs = 120 + i * 15; // 135, 150, 165, ...
      const firstTokenAt = startedAt + ttftMs;
      const genMs = 500 + i * 45;  // 545, 590, 635, ...
      const endedAt = firstTokenAt + genMs;
      const totalMs = ttftMs + genMs;

      const usage = {
        input_tokens: 1000 + i * 120,
        output_tokens: 400 + i * 85,
        cache_read_tokens: 2500 + i * 200,
        cache_write_tokens: 100 + i * 25,
      };

      const telemetry = computeTurnTelemetry({
        startedAt,
        firstTokenAt,
        endedAt,
        usage,
      });

      // Assert physical constraints of computeTurnTelemetry
      assert.equal(telemetry.ttft_ms, ttftMs);
      assert.equal(telemetry.total_ms, totalMs);
      assert.equal(telemetry.gen_ms, genMs);

      const exactExpectedTps = Number((usage.output_tokens / (genMs / 1000)).toFixed(1));
      assert.equal(telemetry.tps, exactExpectedTps);

      // Accumulate for mathematical benchmark
      sumTtft += telemetry.ttft_ms;
      sumTps += telemetry.tps;
      sumInputTokens += usage.input_tokens;
      sumOutputTokens += usage.output_tokens;
      sumCacheRead += usage.cache_read_tokens;
      sumCacheWrite += usage.cache_write_tokens;
      sumTotalMs += telemetry.total_ms;

      roundData.push({ telemetry, usage });

      // Persist into SQLite store
      store.addUsage({
        roomId,
        botId,
        model: "deepseek-chat-v3",
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        ms: telemetry.total_ms,
        ttft_ms: telemetry.ttft_ms,
        tps: telemetry.tps,
      });
    }

    // Exact Mathematical Formulas:
    const exactAvgTtft = Math.round(sumTtft / numRounds);
    const exactAvgTps = Number((sumTps / numRounds).toFixed(1));

    // Retrieve SQLite Aggregation via usageSummary
    const summary = store.usageSummary({ allFields: true, roomId });

    // Assert exact parity between SQLite aggregation and mathematical formulas
    assert.equal(summary.calls, numRounds, "Total calls must be 10");
    assert.equal(summary.input_tokens, sumInputTokens, "Input tokens match exact sum");
    assert.equal(summary.output_tokens, sumOutputTokens, "Output tokens match exact sum");
    assert.equal(summary.cache_read_tokens, sumCacheRead, "Cache read match exact sum");
    assert.equal(summary.cache_write_tokens, sumCacheWrite, "Cache write match exact sum");
    assert.equal(summary.ms, sumTotalMs, "Total duration ms matches exact sum");

    // CRITICAL ASSERTION: SQLite avg_ttft_ms matches exact mathematical average
    assert.equal(
      summary.avg_ttft_ms,
      exactAvgTtft,
      `SQLite avg_ttft_ms (${summary.avg_ttft_ms}) must match exact math (${exactAvgTtft})`,
    );

    // CRITICAL ASSERTION: SQLite avg_tps matches exact mathematical average to 1 decimal place
    assert.equal(
      summary.avg_tps,
      exactAvgTps,
      `SQLite avg_tps (${summary.avg_tps}) must match exact math (${exactAvgTps})`,
    );
  });

  test("4.2 Multi-bot telemetry isolation and per-bot average parity in SQLite", async () => {
    const dbPath = path.join(TEST_DATA_ROOT, "data", `tel_multibot_${Date.now()}.db`);
    assertNotC(dbPath, "dbPath strictly on non-C");
    const store = new Store(dbPath);
    onCleanup(() => store.close());

    const roomId = "room_multibot_tel";
    const bots = ["fast_bot", "slow_bot"];

    // Fast bot: 5 turns with low latency and high TPS
    const fastRecords = [
      { ttft: 50, gen: 200, out: 200 },
      { ttft: 60, gen: 250, out: 250 },
      { ttft: 40, gen: 180, out: 180 },
      { ttft: 70, gen: 220, out: 220 },
      { ttft: 55, gen: 210, out: 210 },
    ];

    // Slow bot: 5 turns with high latency and lower TPS
    const slowRecords = [
      { ttft: 300, gen: 1000, out: 150 },
      { ttft: 350, gen: 1200, out: 180 },
      { ttft: 280, gen: 950, out: 140 },
      { ttft: 320, gen: 1100, out: 160 },
      { ttft: 400, gen: 1300, out: 200 },
    ];

    const recordBot = (botId, list) => {
      let sumTtft = 0;
      let sumTps = 0;
      for (const rec of list) {
        const tps = Number((rec.out / (rec.gen / 1000)).toFixed(1));
        sumTtft += rec.ttft;
        sumTps += tps;
        store.addUsage({
          roomId,
          botId,
          model: botId === "fast_bot" ? "deepseek-coder" : "gpt-4-eval",
          input_tokens: 500,
          output_tokens: rec.out,
          ms: rec.ttft + rec.gen,
          ttft_ms: rec.ttft,
          tps,
        });
      }
      return {
        avgTtft: Math.round(sumTtft / list.length),
        avgTps: Number((sumTps / list.length).toFixed(1)),
      };
    };

    const fastExpected = recordBot("fast_bot", fastRecords);
    const slowExpected = recordBot("slow_bot", slowRecords);

    const summary = store.usageSummary({ allFields: true, roomId });
    assert.equal(summary.calls, 10);
    assert.equal(summary.by_bot.length, 2);

    const fastActual = summary.by_bot.find((b) => b.bot_id === "fast_bot");
    const slowActual = summary.by_bot.find((b) => b.bot_id === "slow_bot");

    assert.ok(fastActual);
    assert.ok(slowActual);

    assert.equal(fastActual.calls, 5);
    assert.equal(fastActual.avg_ttft_ms, fastExpected.avgTtft);
    assert.equal(fastActual.avg_tps, fastExpected.avgTps);

    assert.equal(slowActual.calls, 5);
    assert.equal(slowActual.avg_ttft_ms, slowExpected.avgTtft);
    assert.equal(slowActual.avg_tps, slowExpected.avgTps);
  });
});

// =============================================================================
// GLOBAL CONSTRAINT VERIFICATION: Zero C-Drive Writes
// =============================================================================
describe("Global System Constraint: Zero C-Drive Writes", () => {
  test("No temporary test artifacts, database files or logs exist on C: drive", () => {
    const cTmpFusion = path.join(os.tmpdir(), "fusion-tests");
    const cExists = fs.existsSync(cTmpFusion);
    assert.equal(cExists, false, `Forbidden: C-drive test folder exists at ${cTmpFusion}`);

    // Verify TEST_DATA_ROOT is strictly on D:
    assert.ok(
      TEST_DATA_ROOT.toLowerCase().startsWith("d:"),
      `TEST_DATA_ROOT must be on D: drive, got ${TEST_DATA_ROOT}`,
    );
  });
});
