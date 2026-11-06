/**
 * Event bus: persist every event (SQLite) and fan out to live subscribers (SSE).
 *
 * Event shape (contract with the web frontend):
 *   { seq, ts, topic, sender, payload, thread_id }
 *   ts is a float epoch-seconds value (frontend multiplies by 1000).
 */
import { createLogger } from "./log.js";

const log = createLogger("events");

export class EventBus {
  constructor(store) {
    this.store = store;
    this.listeners = new Set();
    this.lastSeq = typeof store?.lastEventSeq === "function" ? store.lastEventSeq() : 0;
    this.history = []; // small in-memory ring for fast replay
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * @param {{topic:string, sender?:string, payload?:object, thread_id?:string|null}} input
   * @returns {Promise<object>} the persisted event
   */
  async publish(input) {
    const topic = String(input.topic || "").trim();
    if (!topic) throw new Error("event topic is required");
    const evt = {
      seq: ++this.lastSeq,
      ts: Date.now() / 1000,
      topic,
      sender: input.sender || "system",
      payload: input.payload || {},
      thread_id: input.thread_id === undefined ? null : input.thread_id,
    };
    try {
      this.store.appendEvent(evt);
    } catch (err) {
      log.warn("failed to persist event", topic, err?.message || err);
    }
    this.history.push(evt);
    if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(evt);
      } catch (err) {
        log.warn("listener failed", topic, err?.message || err);
      }
    }
    return evt;
  }

  /** Publish many events in order (awaits each; keeps seq strictly increasing). */
  async publishAll(list) {
    const out = [];
    for (const item of list) out.push(await this.publish(item));
    return out;
  }

  list({ thread_id = undefined, after_seq = 0, limit = 2000 } = {}) {
    return this.store.listEvents({ thread_id, after_seq, limit });
  }

  recent(n = 100) {
    return this.history.slice(-n);
  }
}
