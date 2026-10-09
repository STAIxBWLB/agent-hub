import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StampedEvent } from "./events.ts";
import { hubHome } from "./project.ts";

/**
 * #247: opt-in research records of how tasks went, built only from `events.jsonl` (ids, states, counts, tokens), so the
 * live writer and `ahub research backfill` produce the same records. Never a title, detail, plan, note, path, message
 * body or check output: the events carry none of those.
 */
export const RESEARCH_SCHEMA = "agent-hub.research/v1";
export const LABELS = ["ok", "regressed", "reverted", "incomplete", "wrong", "abandoned"] as const;
export type Label = (typeof LABELS)[number];
/** A person's later verdict that turns an approved task into a failure. */
const FAILED: ReadonlySet<string> = new Set(["regressed", "reverted", "incomplete", "wrong", "abandoned"]);

export interface PeerUsage { input: number | null; output: number | null; cacheRead: number | null; total: number | null }
export interface TaskRecord {
  schema: typeof RESEARCH_SCHEMA; kind: "task"; project: string; task: number;
  /** 1 for the first approval; a task approved again after it reopened gets a newer revision. */
  revision: number;
  class: string | null; pii: boolean; outcome: "approved";
  createdAt: string | null; startedAt: string | null; approvedAt: string;
  /** From the first `in_progress` to this approval; null when the start is not in the events. */
  wallMs: number | null;
  /** Sum of the attributed turns' durations. */
  activeMs: number;
  owners: string[]; reviewer: string | null;
  /** Times the task went to review, was sent back, failed its check, was reported done, moved to another peer. */
  reviewRounds: number; changesRequested: number; checkFailed: number; dones: number; reassignments: number;
  /** Approved on its first review with no failed check. */
  firstPass: boolean;
  stuck: number; overlaps: number; conflicts: number;
  tests: { pass: number; fail: number };
  tokens: { total: number; byPeer: Record<string, number> };
  usage: Record<string, PeerUsage>;
  turns: number; filesChanged: number;
  /** Model routes and served models seen for the task's attributed requests. */
  models: string[];
  writer: { version: string; source: "live" | "backfill" };
}
export interface LabelRecord { schema: typeof RESEARCH_SCHEMA; kind: "label"; project: string; task: number; label: Label; at: string }
export type ResearchRecord = TaskRecord | LabelRecord;

/** The store name for a project: a hash of its id, never its path. */
export const projectKey = (projectId: string): string => createHash("sha256").update(projectId).digest("hex").slice(0, 16);
export const researchDir = (home = hubHome()): string => join(home, "research");
export const researchFile = (projectId: string, home = hubHome()): string => join(researchDir(home), `${projectKey(projectId)}.jsonl`);

type Acc = Omit<TaskRecord, "schema" | "kind" | "project" | "revision" | "approvedAt" | "wallMs" | "firstPass" | "outcome" | "writer" | "owners" | "models"> & {
  owners: Set<string>; models: Set<string>; approvals: number; lastState: string | null; failedChecksAtReview: number;
};
const fresh = (task: number): Acc => ({ task, class: null, pii: false, createdAt: null, startedAt: null, activeMs: 0, owners: new Set(), reviewer: null,
  reviewRounds: 0, changesRequested: 0, checkFailed: 0, dones: 0, reassignments: 0, stuck: 0, overlaps: 0, conflicts: 0, tests: { pass: 0, fail: 0 },
  tokens: { total: 0, byPeer: {} }, usage: {}, turns: 0, filesChanged: 0, models: new Set(), approvals: 0, lastState: null, failedChecksAtReview: 0 });
const add = (current: number | null, value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? (current ?? 0) + value : current;

/** One record per approval in `events`, in order; `writer` says which release and path wrote it. */
export function taskRecords(events: StampedEvent[], projectId: string, writer: TaskRecord["writer"]): TaskRecord[] {
  const tasks = new Map<number, Acc>();
  const acc = (id: number) => { let a = tasks.get(id); if (!a) tasks.set(id, a = fresh(id)); return a; };
  const out: TaskRecord[] = [];
  const seenUsage = new Set<string>();
  for (const e of events) {
    if (e.type === "task") {
      const a = acc(e.id);
      a.class = e.class; if (e.pii) a.pii = true;
      if (e.owner) a.owners.add(e.owner);
      if (e.reviewer) a.reviewer = e.reviewer;
      if (e.event === "proposed") a.createdAt ??= e.at;
      if (e.state === "in_progress") a.startedAt ??= e.at;
      if (e.event === "done") a.dones++;
      if (e.event === "check failed") a.checkFailed++;
      if (["declined", "escalated", "reassigned"].includes(e.event)) a.reassignments++;
      if (e.state === "in_review" && a.lastState !== "in_review") a.reviewRounds++;
      if (e.state === "changes_requested" && a.lastState !== "changes_requested") a.changesRequested++;
      if (e.state === "approved" && a.lastState !== "approved") {
        a.approvals++;
        const start = a.startedAt ? Date.parse(a.startedAt) : NaN, end = Date.parse(e.at);
        out.push({ schema: RESEARCH_SCHEMA, kind: "task", project: projectKey(projectId), task: a.task, revision: a.approvals,
          class: a.class, pii: a.pii, outcome: "approved", createdAt: a.createdAt, startedAt: a.startedAt, approvedAt: e.at,
          wallMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null, activeMs: a.activeMs,
          owners: [...a.owners].sort(), reviewer: a.reviewer, reviewRounds: a.reviewRounds, changesRequested: a.changesRequested,
          checkFailed: a.checkFailed, dones: a.dones, reassignments: a.reassignments,
          firstPass: a.changesRequested === 0 && a.checkFailed === 0 && a.reviewRounds <= 1,
          stuck: a.stuck, overlaps: a.overlaps, conflicts: a.conflicts, tests: { ...a.tests },
          tokens: { total: a.tokens.total, byPeer: { ...a.tokens.byPeer } }, usage: structuredClone(a.usage), turns: a.turns,
          filesChanged: a.filesChanged, models: [...a.models].sort(), writer });
      }
      a.lastState = e.state;
      continue;
    }
    const task = "task" in e && typeof e.task === "number" ? e.task : undefined;
    if (task === undefined) continue;
    const a = acc(task);
    if ("pii" in e && e.pii === true) a.pii = true;
    if (e.type === "tokens") { a.tokens.total += e.n; a.tokens.byPeer[e.peer] = (a.tokens.byPeer[e.peer] ?? 0) + e.n; }
    else if (e.type === "turn_end") { a.turns++; a.activeMs += e.ms; a.filesChanged += e.files ?? 0; }
    else if (e.type === "usage") {
      const key = `${e.peer}\0${e.source}\0${e.id}`;
      if (seenUsage.has(key)) continue;
      seenUsage.add(key);
      const u = a.usage[e.peer] ??= { input: null, output: null, cacheRead: null, total: null };
      u.input = add(u.input, e.inputTokens); u.output = add(u.output, e.outputTokens); u.cacheRead = add(u.cacheRead, e.cacheReadTokens); u.total = add(u.total, e.totalTokens);
      if (e.servedModel ?? e.requestedModel) a.models.add(String(e.servedModel ?? e.requestedModel));
    }
    else if (e.type === "route") a.models.add(e.route);
    else if (e.type === "route_outcome") { if (e.next?.tests === "pass") a.tests.pass++; if (e.next?.tests === "fail") a.tests.fail++; }
    else if (e.type === "stuck") a.stuck++;
    else if (e.type === "overlap") a.overlaps++;
    else if (e.type === "conflict") a.conflicts++;
  }
  return out;
}

/** Every record in one store file; a line that does not parse is skipped. */
export function readStore(file: string): ResearchRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { const r = JSON.parse(line); return r?.schema === RESEARCH_SCHEMA ? [r as ResearchRecord] : []; } catch { return []; }
  });
}
/** This project's store, or every project's with `all`. */
export function readStores(projectId: string | undefined, home = hubHome()): ResearchRecord[] {
  if (projectId) return readStore(researchFile(projectId, home));
  const dir = researchDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().flatMap((name) => readStore(join(dir, name)));
}

const same = (a: TaskRecord, b: TaskRecord) => a.task === b.task && a.revision === b.revision && a.approvedAt === b.approvedAt;
/** Append records the store does not hold yet (same task, revision and approval); returns how many were written. */
export function appendRecords(projectId: string, records: ResearchRecord[], home = hubHome()): number {
  if (!records.length) return 0;
  const file = researchFile(projectId, home);
  mkdirSync(researchDir(home), { recursive: true, mode: 0o700 });
  const held = readStore(file).filter((r): r is TaskRecord => r.kind === "task");
  const fresh = records.filter((r) => r.kind === "label" || !held.some((h) => same(h, r)));
  if (!fresh.length) return 0;
  appendFileSync(file, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return fresh.length;
}

const pct = (n: number, d: number) => d ? n / d : null;
function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}
export interface Measures {
  tasks: number; succeeded: number; failedByLabel: number;
  successRate: number | null; firstPassRate: number | null; reworkRate: number | null; checkFailureRate: number | null;
  tokensPerTask: { median: number | null; p90: number | null }; wallMsPerTask: { median: number | null; p90: number | null };
}
function measures(records: TaskRecord[], labels: Map<string, Label>): Measures {
  const failed = records.filter((r) => FAILED.has(labels.get(`${r.project}#${r.task}`) ?? "")).length;
  return { tasks: records.length, succeeded: records.length - failed, failedByLabel: failed,
    successRate: pct(records.length - failed, records.length), firstPassRate: pct(records.filter((r) => r.firstPass).length, records.length),
    reworkRate: pct(records.reduce((n, r) => n + r.changesRequested, 0), records.length),
    checkFailureRate: pct(records.reduce((n, r) => n + r.checkFailed, 0), records.reduce((n, r) => n + r.dones, 0)),
    tokensPerTask: { median: quantile(records.map((r) => r.tokens.total), 0.5), p90: quantile(records.map((r) => r.tokens.total), 0.9) },
    wallMsPerTask: { median: quantile(records.flatMap((r) => r.wallMs ?? []), 0.5), p90: quantile(records.flatMap((r) => r.wallMs ?? []), 0.9) } };
}
export interface ResearchReport { overall: Measures; byClass: Record<string, Measures>; byOwner: Record<string, Measures>; byProject: Record<string, Measures>; byModel: Record<string, Measures> }
/**
 * The derived measures, never stored as truth: each task counts once at its latest revision, and a person's latest
 * label decides whether an approved task later failed. Records older than `since` (ms epoch, by approval) are left out.
 */
export function researchReport(records: ResearchRecord[], since = 0): ResearchReport {
  const latest = new Map<string, TaskRecord>(), labels = new Map<string, Label>();
  for (const r of records) {
    const key = `${r.project}#${r.task}`;
    if (r.kind === "label") { labels.set(key, r.label); continue; }
    if (Date.parse(r.approvedAt) < since) continue;
    const held = latest.get(key);
    if (!held || r.revision >= held.revision) latest.set(key, r);
  }
  const all = [...latest.values()];
  const group = (keys: (r: TaskRecord) => string[]) => {
    const out: Record<string, TaskRecord[]> = {};
    for (const r of all) for (const k of keys(r)) (out[k] ??= []).push(r);
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => [k, measures(rs, labels)]));
  };
  return { overall: measures(all, labels), byClass: group((r) => [r.class ?? "unknown"]), byOwner: group((r) => r.owners.length ? r.owners : ["none"]),
    byProject: group((r) => [r.project]), byModel: group((r) => r.models.length ? r.models : ["unknown"]) };
}

const fmtPct = (v: number | null) => v === null ? "-" : `${Math.round(v * 100)}%`;
const fmtNum = (v: number | null) => v === null ? "-" : String(Math.round(v));
export function formatResearch(r: ResearchReport): string[] {
  const row = (name: string, m: Measures) => `${name.padEnd(24)} ${String(m.tasks).padStart(5)}  ${fmtPct(m.successRate).padStart(7)}  ${fmtPct(m.firstPassRate).padStart(10)}  ${(m.reworkRate === null ? "-" : m.reworkRate.toFixed(2)).padStart(6)}  ${fmtPct(m.checkFailureRate).padStart(11)}  ${fmtNum(m.tokensPerTask.median).padStart(10)}  ${fmtNum(m.tokensPerTask.p90).padStart(10)}  ${(m.wallMsPerTask.median === null ? "-" : `${Math.round(m.wallMsPerTask.median / 60_000)}m`).padStart(8)}`;
  const head = `${"".padEnd(24)} ${"tasks".padStart(5)}  ${"success".padStart(7)}  ${"first pass".padStart(10)}  ${"rework".padStart(6)}  ${"check fails".padStart(11)}  ${"tokens p50".padStart(10)}  ${"tokens p90".padStart(10)}  ${"wall p50".padStart(8)}`;
  const section = (title: string, groups: Record<string, Measures>) => Object.keys(groups).length ? [``, title, head, ...Object.entries(groups).map(([k, m]) => row(k, m))] : [];
  return [head, row("all approved tasks", r.overall), ...section("by class", r.byClass), ...section("by owner", r.byOwner), ...section("by model", r.byModel), ...section("by project", r.byProject)];
}

export const CSV_COLUMNS = ["project", "task", "revision", "class", "pii", "outcome", "createdAt", "startedAt", "approvedAt", "wallMs", "activeMs", "owners",
  "reviewer", "reviewRounds", "changesRequested", "checkFailed", "dones", "reassignments", "firstPass", "stuck", "overlaps", "conflicts", "testsPass",
  "testsFail", "tokens", "turns", "filesChanged", "models", "label", "writerVersion", "writerSource"] as const;
/** Task records as CSV with a header row, one row per record, each with the task's latest label. */
export function toCsv(records: ResearchRecord[]): string {
  const labels = new Map<string, Label>();
  for (const r of records) if (r.kind === "label") labels.set(`${r.project}#${r.task}`, r.label);
  const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = records.filter((r): r is TaskRecord => r.kind === "task").map((r) => [r.project, r.task, r.revision, r.class, r.pii, r.outcome, r.createdAt, r.startedAt,
    r.approvedAt, r.wallMs, r.activeMs, r.owners.join(" "), r.reviewer, r.reviewRounds, r.changesRequested, r.checkFailed, r.dones, r.reassignments, r.firstPass,
    r.stuck, r.overlaps, r.conflicts, r.tests.pass, r.tests.fail, r.tokens.total, r.turns, r.filesChanged, r.models.join(" "),
    labels.get(`${r.project}#${r.task}`) ?? "", r.writer.version, r.writer.source].map(cell).join(","));
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
