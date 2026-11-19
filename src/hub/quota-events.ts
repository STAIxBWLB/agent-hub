import type { HubEvent } from "./events.ts";

export const QUOTA_HEARTBEAT_MS = 15 * 60_000;
const QUOTA_USED_DELTA = 0.005;
type QuotaEvent = Extract<HubEvent, { type: "quota" }>;
type Reading = { peer: string; windows: QuotaEvent["windows"]; hard: boolean; at: number };
type State = { recorded: Reading; last: Reading; pending: boolean };

/** Recorded rows describe changes and bounded coverage, not the number of provider polls. */
export class QuotaEventFilter {
  private readonly peers = new Map<string, State>();
  constructor(private readonly emit: (event: QuotaEvent) => void) {}

  private write(reading: Reading): void {
    this.emit({ type: "quota", peer: reading.peer, windows: reading.windows, hard: reading.hard, measuredAt: new Date(reading.at).toISOString() });
    const previous = this.peers.get(reading.peer);
    if (previous) { previous.recorded = reading; if (previous.last === reading) previous.pending = false; }
    else this.peers.set(reading.peer, { recorded: reading, last: reading, pending: false });
  }

  record(peer: string, windows: QuotaEvent["windows"], hard: boolean, at: number): void {
    // ponytail: a crash loses at most one unemitted tail per peer; an older out-of-order reading can delay a flush.
    for (const state of this.peers.values()) if (state.pending && at - state.last.at >= QUOTA_HEARTBEAT_MS) this.write(state.last);
    const reading: Reading = { peer, windows: windows.map(window => ({ ...window })), hard, at };
    const state = this.peers.get(peer);
    if (!state) { this.write(reading); return; }
    const before = new Map(state.recorded.windows.map(window => [window.id, window]));
    const changed = hard !== state.recorded.hard || before.size !== windows.length || windows.some(window => {
      const prior = before.get(window.id);
      return !prior || prior.resetsAt !== window.resetsAt || Math.abs(window.used - prior.used) + Number.EPSILON >= QUOTA_USED_DELTA;
    });
    state.last = reading;
    if (changed || at - state.recorded.at >= QUOTA_HEARTBEAT_MS || at < state.recorded.at) this.write(reading);
    else state.pending = true;
  }

  flush(): void {
    for (const state of this.peers.values()) if (state.pending) this.write(state.last);
  }
}
