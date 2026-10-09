import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import type { TaskAttribution } from "./attribution.ts";
import type { SwitchTrace } from "../models/route/stage.ts";

/** Bumped whenever a field changes meaning or goes away; new fields and new types do not bump it. */
export const EVENTS_SCHEMA = 1;

/**
 * One line of `events.jsonl`, the machine-readable twin of hub.log (issue #40). Never a message body: envelopes carry
 * ids, routing and sizes, tasks carry ids and states, so the file can be exported without leaking what agents wrote.
 */
export type HubEvent =
  | { type: "envelope"; id: string; from: string; to?: string[]; priority: string; hop: number; kind?: string; task?: string; bytes?: number; private?: boolean; dropped?: string }
  | { type: "overflow" | "undeliverable"; id: string; from: string; peer: string }
  | { type: "stale"; id: string; from: string; peer: string; task?: string }
  | { type: "quiet"; id: string; from: string; peers: string[] }
  | { type: "fact"; peer: string; id: string; files: number; plans: number; unknown: number; named: number; bytes: number; via: "hook" | "steer" | "done"; ms?: number; hookMs?: number; rttMs?: number; accepted?: boolean; unanswered?: boolean; probe?: boolean; coverage?: boolean }
  | { type: "fact_ack"; peer: string; id: string; via: string; ms: number }
  | ({ type: "route"; peer: string; route: string; tier: string; source: "override" | "dimensions" | "hold" | "classifier" | "default" | "load" | "cooldown"; score: number; ms: number; decision?: string; turn?: string; task?: number; pii?: boolean; severity?: number; spinning?: number; exploring?: number; production?: number } & Partial<SwitchTrace>)
  | { type: "cooldown"; peer: string; alias: string; event: "start" | "end"; failures: number; ms?: number }
  | { type: "route_outcome"; peer: string; decision: string; turnId: string; turn: "completed" | "failed"; task?: number; pii: boolean; latched: boolean; next?: { severity: number; tests: "pass" | "fail" | "none"; repeat: boolean }; advisor?: "approve" | "redo" | "failed" }
  | { type: "advisor"; peer: string; route: string; trigger: string; verdict: "approve" | "redo" | "failed"; discardedChars: number }
  | { type: "progress"; peer: string; task: number; severity: number; spinning: number; exploring: number; production: number }
  | { type: "stuck"; peer: string; task: number; category: "repetition" | "false_progress" | "drift" | "desperation" | "capability_gap"; streak: number; latched: boolean }
  | { type: "capability"; peer: string; state: "verified" | "lost"; via?: string }
  | { type: "split"; task: number; where?: "routing" | "cohort"; verdict: "split" | "single" | "unknown"; single?: string; splitS?: number; singleS?: number; reason?: string; trace?: string[] }
  | { type: "state"; peer: string; state: string }
  | { type: "turn_start"; peer: string; turn: string }
  | ({ type: "turn_end"; peer: string; turn: string; ms: number; tokens?: number; files?: number; snapshotMs?: number } & Partial<TaskAttribution>)
  | { type: "native_turn_end"; peer: string; id?: string }
  | { type: "conduct"; peer: string; action: string; task?: number; target?: string }
  | { type: "agent_cli"; peer: string; command: string; refused: boolean }
  | { type: "permission"; id: string; peer: string; event: "requested" | "answered" | "expired" | "cancelled"; latencyMs?: number; surface?: "console" | "dashboard" | "terminal"; option?: "allow_once" | "allow_always" | "reject_once" | "reject_always" }
  /** Completed native turns that received supervision, not feed enqueues or inferred costs. */
  | { type: "supervision_turn"; peer: string; turn: string; tokens?: number; ms?: number }
  | { type: "hook_stats"; peer: string; n: number; startupMs: number; hubMs: number; maxStartupMs: number }
  | { type: "cohort"; id: number; event: "formed" | "joined" | "lifted"; silent: boolean; tasks: number[]; owners: string[] }
  | ({ type: "tokens"; peer: string; n: number } & Partial<TaskAttribution>)
  | ({ type: "usage"; peer: string; source: "omniroute" | "claude_transcript"; id: string; measuredAt?: string; requestedModel?: string; servedModel?: string; provider?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number } & Partial<TaskAttribution>)
  | { type: "task"; id: number; event: string; by: string; state: string; owner: string | null; reviewer: string | null; class: string; pii: boolean }
  | { type: "overlap"; task: number; owner: string; others: { task: number; owner: string; paths: string[]; symbols?: string[] }[] }
  | { type: "conflict"; peer: string; task?: number; other: number; owner: string; paths: string[]; concurrent: boolean; turns?: [string, string] }
  | { type: "context_pressure"; peer: string; source: string; measuredAt: number; used: number; window: number | null }
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
      const measuredAt = e.type === "usage" && typeof e.measuredAt === "string" ? e.measuredAt : e.at;
      return Date.parse(measuredAt) >= since ? [e] : [];
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
