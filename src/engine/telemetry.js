/**
 * Compute fine-grained turn execution telemetry: TTFT, pure generation TPS,
 * total turn duration, and token accounting.
 *
 * @param {{
 *   startedAt: number,
 *   firstTokenAt: number|null,
 *   endedAt?: number,
 *   usage?: { input?: number, output?: number, cacheRead?: number, cacheWrite?: number, input_tokens?: number, output_tokens?: number, cache_read_tokens?: number, cache_write_tokens?: number },
 * }} params
 * @returns {{
 *   ttft_ms: number,
 *   gen_ms: number,
 *   total_ms: number,
 *   tps: number,
 *   e2e_tps: number,
 *   input_tokens: number,
 *   output_tokens: number,
 *   cache_read: number,
 *   cache_write: number,
 * }}
 */
export function computeTurnTelemetry({ startedAt, firstTokenAt, endedAt = Date.now(), usage = {} } = {}) {
  const totalMs = Math.max(0, endedAt - startedAt);
  const ttftMs = firstTokenAt !== null && Number.isFinite(firstTokenAt)
    ? Math.max(0, firstTokenAt - startedAt)
    : totalMs;
  const genMs = Math.max(0, totalMs - ttftMs);

  const outputTokens = Number(usage?.output ?? usage?.output_tokens ?? 0);
  const inputTokens = Number(usage?.input ?? usage?.input_tokens ?? 0);
  const cacheRead = Number(usage?.cacheRead ?? usage?.cache_read_tokens ?? usage?.cache_read ?? 0);
  const cacheWrite = Number(usage?.cacheWrite ?? usage?.cache_write_tokens ?? usage?.cache_write ?? 0);

  // Pure Generation TPS: tokens emitted per second during active generation
  const genSec = genMs / 1000;
  const tps = genSec > 0 && outputTokens > 0 ? Number((outputTokens / genSec).toFixed(1)) : 0;

  // End-to-end TPS: tokens emitted per total turn second
  const totalSec = totalMs / 1000;
  const e2eTps = totalSec > 0 && outputTokens > 0 ? Number((outputTokens / totalSec).toFixed(1)) : 0;

  return {
    ttft_ms: ttftMs,
    gen_ms: genMs,
    total_ms: totalMs,
    tps,
    e2e_tps: e2eTps,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read: cacheRead,
    cache_read_tokens: cacheRead,
    cache_write: cacheWrite,
    cache_write_tokens: cacheWrite,
  };
}
