import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

/** Bumped whenever a field changes meaning or goes away; new fields and new types do not bump it. */
export const EVENTS_SCHEMA = 1;

/**
 * One line of `events.jsonl`, the machine-readable twin of hub.log (issue #40). Never a message body: envelopes carry
 * ids, routing and sizes, tasks carry ids and states, so the file can be exported without leaking what agents wrote.
 */
export type HubEvent =
  | { type: "envelope"; id: string; from: string; to?: string[]; priority: string; hop: number; kind?: string; task?: string; bytes?: number; private?: boolean; dropped?: string }
  | { type: "overflow" | "undeliverable"; id: string; from: string; peer: string }
  | { type: "state"; peer: string; state: string }
  | { type: "turn_start"; peer: string; turn: string }
  | { type: "turn_end"; peer: string; turn: string; ms: number; tokens?: number; files?: number; snapshotMs?: number }
  | { type: "tokens"; peer: string; n: number }
  | { type: "task"; id: number; event: string; by: string; state: string; owner: string | null; reviewer: string | null; class: string; pii: boolean }
  | { type: "overlap"; task: number; owner: string; others: { task: number; owner: string; paths: string[] }[] }
  | { type: "quota"; peer: string; windows: { id: string; used: number; resetsAt?: number }[]; hard: boolean; measuredAt?: string };

export type StampedEvent = HubEvent & { v: number; at: string };

/** Whether the file's last byte is something other than a newline: a crash cut its last line short. */
function cutShort(file: string): boolean {
  if (!existsSync(file)) return false;
  const fd = openSync(file, "r");
  try {
    const { size } = fstatSync(fd);
    if (!size) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** An appender that never throws: the state dir can vanish under a running hub, and telemetry must not take it down. */
export function eventLog(file: string): (e: HubEvent) => void {
  let first = true;
  return (e) => {
    try {
      // After a crash the first line goes on a line of its own, so only the cut event is lost.
      const lead = first && cutShort(file) ? "\n" : "";
      first = false;
      appendFileSync(file, `${lead}${JSON.stringify({ v: EVENTS_SCHEMA, at: new Date().toISOString(), ...e })}\n`);
    } catch {
      // the state dir is gone; the watchdog is stopping the hub
    }
  };
}

/**
 * Kimi's running session totals to increments: only what was added since the last update counts; a new session
 * starts from zero whatever its first total, and a smaller total in the same session means it was reset. (Codex
 * differences its thread totals in the adapter, which knows whether a thread was started or resumed.)
 */
export function tokenDeltas(): (peer: string, total: number, session: string) => number {
  const last = new Map<string, { session: string; total: number }>();
  return (peer, total, session) => {
    const prev = last.get(peer);
    last.set(peer, { session, total });
    return prev?.session === session && total >= prev.total ? total - prev.total : total;
  };
}

/**
 * Events at or after `since` (ms), skipping lines a crash cut short.
 * ponytail: reads the whole file, which is never rotated; rotate by month or index by time when it gets large.
 */
export function readEvents(file: string, since = 0): StampedEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const e = JSON.parse(line) as StampedEvent;
      return Date.parse(e.at) >= since ? [e] : [];
    } catch {
      return [];
    }
  });
}

/** `7d`, `24h`, `90m` or an ISO date, as epoch ms; undefined when it is neither. */
export function parseSince(text: string, now = Date.now()): number | undefined {
  const m = /^(\d+)([dhm])$/.exec(text);
  if (m) return now - Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d" | "h" | "m"];
  // ISO dates only: Date.parse also takes "7" (a year in 2001), which would silently mean everything.
  const t = /^\d{4}-\d\d-\d\d/.test(text) ? Date.parse(text) : NaN;
  return Number.isNaN(t) ? undefined : t;
}
