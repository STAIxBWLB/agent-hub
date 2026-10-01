import type { PeerId, Priority } from "./envelope.ts";

/** Per-sender limits on what agents send (issue #38). 0 turns a limit off; the console user and the hub are never limited. */
export interface LimitsConfig {
  /** Messages a sender may send per minute, to anyone. */
  sender_per_min: number;
  /** Messages a sender may send per minute to one recipient (a broadcast counts as one recipient, `*`). */
  pair_per_min: number;
  /** `important` messages a sender may send per hour: each can interrupt a running turn. */
  important_per_hour: number;
  /** An identical message to the same recipients within this many seconds is dropped. */
  repeat_window_s: number;
}
// Off here like approvals.notify, so tests and a hub without a config file are unlimited; the template turns it on.
export const DEFAULT_LIMITS: LimitsConfig = { sender_per_min: 0, pair_per_min: 0, important_per_hour: 0, repeat_window_s: 0 };
/** What a project config gets unless it says otherwise. */
export const PROJECT_LIMITS: LimitsConfig = { sender_per_min: 12, pair_per_min: 6, important_per_hour: 6, repeat_window_s: 120 };

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Token buckets per sender, per (sender, recipient) and for `important`, plus repeat suppression. A refusal says why
 * and when to retry, and costs no token: the sender learns at once instead of a queue filling up downstream.
 */
export class Limiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly cfg: LimitsConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** undefined when the message may go; otherwise the reason, for the sender. */
  admit(from: PeerId, to: PeerId[] | undefined, priority: Priority, body: string): string | undefined {
    const now = this.now();
    const audience = to?.length ? [...to].sort() : ["*"];
    if (this.cfg.repeat_window_s > 0) {
      const key = `${from}\0${audience.join(",")}\0${body.trim().replace(/\s+/g, " ")}`;
      const last = this.recent.get(key);
      if (last !== undefined && now - last < this.cfg.repeat_window_s * 1000) {
        return `the same message went to ${audience.join(", ")} ${Math.round((now - last) / 1000)} s ago`;
      }
      this.recent.set(key, now);
      if (this.recent.size > 1000) for (const [k, at] of this.recent) if (now - at >= this.cfg.repeat_window_s * 1000) this.recent.delete(k);
    }
    const wanted: [string, number, number][] = []; // key, capacity, refill per ms
    if (this.cfg.sender_per_min > 0) wanted.push([`s\0${from}`, this.cfg.sender_per_min, this.cfg.sender_per_min / 60_000]);
    if (this.cfg.pair_per_min > 0) for (const r of audience) wanted.push([`p\0${from}\0${r}`, this.cfg.pair_per_min, this.cfg.pair_per_min / 60_000]);
    if (priority === "important" && this.cfg.important_per_hour > 0) wanted.push([`i\0${from}`, this.cfg.important_per_hour, this.cfg.important_per_hour / 3_600_000]);
    const filled = wanted.map(([key, cap, rate]) => {
      const b = this.buckets.get(key) ?? { tokens: cap, at: now };
      return { key, rate, b: { tokens: Math.min(cap, b.tokens + (now - b.at) * rate), at: now } };
    });
    const short = filled.filter((f) => f.b.tokens < 1);
    if (short.length) {
      const wait = Math.max(...short.map((f) => Math.ceil(Math.round((1 - f.b.tokens) / f.rate) / 1000))); // whole ms first: 1/(1/x) is not always x
      if (this.cfg.repeat_window_s > 0) this.recent.delete(`${from}\0${audience.join(",")}\0${body.trim().replace(/\s+/g, " ")}`); // refused, so not sent
      const what = short.some((f) => f.key.startsWith("i\0")) ? "important messages" : "messages";
      return `rate limited: too many ${what} from ${from}; retry after ${wait} s${what === "important messages" ? ", or send it without [IMPORTANT]" : ""}`;
    }
    for (const f of filled) this.buckets.set(f.key, { tokens: f.b.tokens - 1, at: now });
    return undefined;
  }
}
