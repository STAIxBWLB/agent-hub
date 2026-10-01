import { appendFileSync, existsSync, readFileSync } from "node:fs";

/** Bumped whenever a field changes meaning or goes away; new fields and new types do not bump it. */
export const EVENTS_SCHEMA = 1;

/**
 * One line of `events.jsonl`, the machine-readable twin of hub.log (issue #40). Never a message body: envelopes carry
 * ids, routing and sizes, tasks carry ids and states, so the file can be exported without leaking what agents wrote.
 */
export type HubEvent =
  | { type: "envelope"; id: string; from: string; to?: string[]; priority: string; hop: number; kind?: string; task?: string; bytes: number; private?: boolean; dropped?: string }
  | { type: "overflow" | "undeliverable"; id: string; from: string; peer: string }
  | { type: "state"; peer: string; state: string }
  | { type: "turn_start"; peer: string; turn: string }
  | { type: "turn_end"; peer: string; turn: string; ms: number; tokens?: number }
  | { type: "tokens"; peer: string; n: number }
  | { type: "task"; id: number; event: string; by: string; state: string; owner: string | null; reviewer: string | null; class: string; pii: boolean }
  | { type: "overlap"; task: number; owner: string; others: { task: number; owner: string; paths: string[] }[] }
  | { type: "quota"; peer: string; windows: { id: string; used: number; resetsAt?: number }[]; hard: boolean };

export type StampedEvent = HubEvent & { v: number; at: string };

/** An appender that never throws: the state dir can vanish under a running hub, and telemetry must not take it down. */
export function eventLog(file: string): (e: HubEvent) => void {
  return (e) => {
    try {
      appendFileSync(file, `${JSON.stringify({ v: EVENTS_SCHEMA, at: new Date().toISOString(), ...e })}\n`);
    } catch {
      // the state dir is gone; the watchdog is stopping the hub
    }
  };
}

/** Events at or after `since` (ms), skipping lines a crash cut short. */
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
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : t;
}
