/**
 * Real-time System & Token Performance Monitor.
 *
 * Tracks host/process memory utilization (%), Node RSS/Heap, CPU load, and
 * real-time LLM token processing speed (TPS, tokens/sec) + TTFT (ms) in an
 * in-memory ring buffer exposed via GET /api/perf for the Recharts monitor UI.
 */
import os from "node:os";

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_HISTORY_SIZE = 60;
const ROLLING_WINDOW_MS = 10_000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function round1(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}

function toMb(bytes) {
  return round1((Number(bytes) || 0) / (1024 * 1024));
}

export class PerfMonitor {
  /**
   * @param {{
   *   intervalMs?: number,
   *   maxHistory?: number,
   *   now?: () => number,
   *   readSystem?: () => { totalMem: number, freeMem: number, rss: number, heapUsed: number, heapTotal: number, load1m: number, cpuCount: number }
   * }} [options]
   */
  constructor(options = {}) {
    this.intervalMs = Math.max(500, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
    this.maxHistory = Math.max(10, Number(options.maxHistory) || DEFAULT_HISTORY_SIZE);
    this._now = typeof options.now === "function" ? options.now : () => Date.now();
    this._readSystem = typeof options.readSystem === "function" ? options.readSystem : defaultSystemReader;

    this.history = [];
    this.activeTurns = 0;
    this.totalTokens = 0;
    this.totalTurns = 0;
    this.peakTps = 0;
    this.peakMemPct = 0;
    this.lastTurnTps = 0;
    this.lastTurnAt = 0;
    this.lastTtftMs = 0;

    // Prompt Cache & Tool Calling Accuracy telemetry (dsh + OpenCode optimization layer)
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.promptInputTokens = 0;
    this.prefixRequests = 0;
    this.prefixStable = 0;
    this.prefixBusts = 0;
    this.lastBustReason = null;

    this.toolCallsTotal = 0;
    this.toolCallsOk = 0;
    this.toolCallsFailed = 0;
    this.toolCallsRepaired = 0;
    this.editFuzzyHits = 0;
    this.doomLoopsPrevented = 0;

    /** Recent completed turn telemetry samples (last 20 turns) */
    this._recentTurns = [];
    /** Streaming token buckets for live mid-turn TPS estimation: [{ ts, tokens }] */
    this._streamBuckets = [];
    this._timer = null;

    // Seed with an initial live reading immediately so UI never opens empty.
    this.sampleNow();
  }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => {
      this.sampleNow();
    }, this.intervalMs);
    this._timer.unref?.();
    return this;
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return this;
  }

  dispose() {
    return this.stop();
  }

  beginTurn() {
    this.activeTurns += 1;
  }

  endTurn() {
    this.activeTurns = Math.max(0, this.activeTurns - 1);
  }

  /**
   * Record live streaming output tokens (or estimated tokens from text delta)
   * so the real-time TPS chart moves smoothly even before a turn finishes.
   */
  recordStreamTokens(tokens) {
    const n = Number(tokens) || 0;
    if (n <= 0) return;
    const ts = this._now();
    this._streamBuckets.push({ ts, tokens: n });
    this._pruneStreamBuckets(ts);
  }

  /**
   * Record a completed assistant turn's authoritative telemetry.
   * @param {{ tps?: number, ttft_ms?: number, input_tokens?: number, output_tokens?: number, bot_id?: string }} info
   */
  recordTurnTelemetry(info = {}) {
    const ts = this._now();
    const tps = Number(info.tps || 0);
    const ttftMs = Number(info.ttft_ms || 0);
    const inputTokens = Math.max(0, Number(info.input_tokens || 0));
    const outputTokens = Math.max(0, Number(info.output_tokens || 0));
    const cacheRead = Math.max(0, Number(info.cache_read_tokens ?? info.cache_read ?? 0));
    const cacheWrite = Math.max(0, Number(info.cache_write_tokens ?? info.cache_write ?? 0));

    this.totalTurns += 1;
    this.totalTokens += inputTokens + outputTokens + cacheRead + cacheWrite;
    this.promptInputTokens += inputTokens;
    this.cacheReadTokens += cacheRead;
    this.cacheWriteTokens += cacheWrite;

    if (tps > 0) {
      this.lastTurnTps = round1(tps);
      this.lastTurnAt = ts;
      if (this.lastTurnTps > this.peakTps) this.peakTps = this.lastTurnTps;
    }
    if (ttftMs > 0) {
      this.lastTtftMs = Math.round(ttftMs);
    }

    const turnPromptTotal = inputTokens + cacheRead + cacheWrite;
    const cacheHitPct = turnPromptTotal > 0 ? round1((cacheRead / turnPromptTotal) * 100) : 0;

    this._recentTurns.push({
      ts,
      tps: round1(tps),
      ttft_ms: Math.round(ttftMs),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      cache_hit_pct: cacheHitPct,
      bot_id: info.bot_id ? String(info.bot_id) : null,
    });
    if (this._recentTurns.length > 20) {
      this._recentTurns.splice(0, this._recentTurns.length - 20);
    }
  }

  /** Record one provider-request prefix stability check from CacheOptimizer. */
  recordCacheCheck(info = {}) {
    this.prefixRequests += 1;
    if (info.prefixStable !== false) {
      this.prefixStable += 1;
    } else {
      this.prefixBusts += 1;
      this.lastBustReason = info.cacheBustReason ? String(info.cacheBustReason) : "prefix_changed";
    }
  }

  /** Record one tool execution outcome or accuracy recovery event. */
  recordToolMetric(info = {}) {
    const type = String(info.type || "");
    if (type === "arg_repaired" || type === "name_repaired" || info.repaired) {
      this.toolCallsRepaired += 1;
      return;
    }
    if (type === "fuzzy_edit" || info.fuzzyEdit) {
      this.editFuzzyHits += Math.max(1, Number(info.fuzzyCount || 1));
      return;
    }
    if (type === "loop_prevented" || info.loopPrevented) {
      this.doomLoopsPrevented += 1;
      return;
    }
    if (type === "tool_result" || typeof info.ok === "boolean") {
      this.toolCallsTotal += 1;
      if (info.ok) this.toolCallsOk += 1;
      else this.toolCallsFailed += 1;
    }
  }

  _pruneStreamBuckets(now) {
    const cutoff = now - ROLLING_WINDOW_MS;
    while (this._streamBuckets.length && this._streamBuckets[0].ts < cutoff) {
      this._streamBuckets.shift();
    }
  }

  /** Compute current live Token Processing Speed (tokens/sec). */
  currentTps(now = this._now()) {
    this._pruneStreamBuckets(now);
    if (this._streamBuckets.length > 0) {
      const total = this._streamBuckets.reduce((sum, b) => sum + b.tokens, 0);
      const oldest = this._streamBuckets[0].ts;
      const spanSec = Math.max(1, (now - oldest) / 1000);
      const live = round1(total / spanSec);
      if (live > this.peakTps) this.peakTps = live;
      return live;
    }
    // Hold the last completed turn's TPS briefly (15s) so single-turn bursts are visible on the curve
    if (this.lastTurnTps > 0 && now - this.lastTurnAt <= 15_000) {
      return this.lastTurnTps;
    }
    return 0;
  }

  /** Take one sample and append to the ring buffer. */
  sampleNow() {
    const ts = this._now();
    const sys = this._readSystem();
    const totalMem = Math.max(1, Number(sys.totalMem) || 1);
    const freeMem = Math.max(0, Math.min(totalMem, Number(sys.freeMem) || 0));
    const usedMem = totalMem - freeMem;
    const memPct = round1((usedMem / totalMem) * 100);
    const heapTotal = Math.max(1, Number(sys.heapTotal) || 1);
    const heapUsed = Math.max(0, Number(sys.heapUsed) || 0);
    const heapPct = round1((heapUsed / heapTotal) * 100);
    const tps = this.currentTps(ts);

    if (memPct > this.peakMemPct) this.peakMemPct = memPct;

    const point = {
      ts,
      time: formatClock(ts),
      mem_pct: memPct,
      mem_used_mb: toMb(usedMem),
      mem_total_mb: toMb(totalMem),
      proc_rss_mb: toMb(sys.rss),
      heap_used_mb: toMb(heapUsed),
      heap_total_mb: toMb(heapTotal),
      heap_pct: heapPct,
      cpu_load_1m: round1(sys.load1m),
      tps,
      ttft_ms: this.lastTtftMs,
      active_turns: this.activeTurns,
    };

    this.history.push(point);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    return point;
  }

  /** Return full snapshot for GET /api/perf. */
  snapshot({ storeUsage = null, uptimeMs = 0 } = {}) {
    const now = this._now();
    const last = this.history[this.history.length - 1];
    // Refresh if last sample is older than interval
    const current = !last || now - last.ts >= this.intervalMs ? this.sampleNow() : last;

    const tpsSamples = this._recentTurns.filter((t) => t.tps > 0);
    const ttftSamples = this._recentTurns.filter((t) => t.ttft_ms > 0);
    const avgTps = tpsSamples.length
      ? round1(tpsSamples.reduce((s, t) => s + t.tps, 0) / tpsSamples.length)
      : round1(storeUsage?.avg_tps || 0);
    const avgTtftMs = ttftSamples.length
      ? Math.round(ttftSamples.reduce((s, t) => s + t.ttft_ms, 0) / ttftSamples.length)
      : Math.round(storeUsage?.avg_ttft_ms || 0);

    const totalCacheRead = Math.max(this.cacheReadTokens, Number(storeUsage?.cache_read || storeUsage?.cache_read_tokens || 0));
    const totalCacheWrite = Math.max(this.cacheWriteTokens, Number(storeUsage?.cache_write || storeUsage?.cache_write_tokens || 0));
    const totalPromptIn = Math.max(this.promptInputTokens, Number(storeUsage?.input_tokens || 0));
    const totalPromptAll = totalPromptIn + totalCacheRead + totalCacheWrite;
    const cacheHitRatePct = totalPromptAll > 0 ? round1((totalCacheRead / totalPromptAll) * 100) : 0;

    const prefixStabilityPct = this.prefixRequests > 0
      ? round1((this.prefixStable / this.prefixRequests) * 100)
      : 100;
    const toolAccuracyPct = this.toolCallsTotal > 0
      ? round1((this.toolCallsOk / this.toolCallsTotal) * 100)
      : 100;

    const sys = this._readSystem();
    return {
      current,
      history: [...this.history],
      summary: {
        avg_tps: avgTps,
        peak_tps: round1(Math.max(this.peakTps, avgTps)),
        avg_ttft_ms: avgTtftMs,
        peak_mem_pct: round1(this.peakMemPct),
        total_tokens: Math.max(this.totalTokens, Number(storeUsage?.total_tokens || 0)),
        total_turns: Math.max(this.totalTurns, Number(storeUsage?.calls || 0)),
        active_turns: this.activeTurns,
      },
      optimization: {
        cache_hit_rate_pct: cacheHitRatePct,
        cache_read_tokens: totalCacheRead,
        cache_write_tokens: totalCacheWrite,
        prompt_tokens: totalPromptAll,
        prefix_stability_pct: prefixStabilityPct,
        prefix_requests: this.prefixRequests,
        prefix_stable: this.prefixStable,
        prefix_busts: this.prefixBusts,
        last_bust_reason: this.lastBustReason,
        tool_accuracy_pct: toolAccuracyPct,
        tool_calls_total: this.toolCallsTotal,
        tool_calls_ok: this.toolCallsOk,
        tool_calls_failed: this.toolCallsFailed,
        tool_calls_repaired: this.toolCallsRepaired,
        edit_fuzzy_hits: this.editFuzzyHits,
        doom_loops_prevented: this.doomLoopsPrevented,
      },
      system: {
        platform: process.platform,
        arch: process.arch,
        node_version: process.version,
        cpu_count: Number(sys.cpuCount) || 1,
        uptime_ms: Number(uptimeMs) || Math.round(process.uptime() * 1000),
      },
    };
  }
}

function defaultSystemReader() {
  const mem = process.memoryUsage();
  const load = os.loadavg?.() || [0, 0, 0];
  const cpus = os.cpus?.() || [];
  return {
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    load1m: Number(load[0] || 0),
    cpuCount: cpus.length || 1,
  };
}

export function createPerfMonitor(options = {}) {
  return new PerfMonitor(options);
}

export default PerfMonitor;
