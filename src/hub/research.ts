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
  class: string | null; pii: boolean; outcome: "approved";
  /** The proposal time also tells a task from an earlier one with the same id after `ahub reset --all`. */
  createdAt: string | null; startedAt: string | null; approvedAt: string;
  /** From the first `in_progress` to the approval; null when the start is not in the events. */
  wallMs: number | null;
  /** Sum of the attributed turns' durations, the turns still open at the approval included. */
  activeMs: number;
  /** Owners in the order they held the task. */
  owners: string[]; reviewer: string | null;
  /** Times the task went to review, was sent back, passed or failed its check, was reported done. */
  reviewRounds: number; changesRequested: number; checkPassed: number; checkFailed: number; dones: number;
  /** Owner changes after the first owner, and the same counted by the board's move reason. */
  reassignments: number; reassignedBy: Record<string, number>;
  /** Approved on its first review with no failed check. */
  firstPass: boolean;
  stuck: number; overlaps: number; conflicts: number;
  tests: { pass: number; fail: number };
  /** Attributed tokens per peer and per #200 attribution rule; unattributed tokens are in no record. */
  tokens: { total: number; byPeer: Record<string, number>; byAttribution: Record<string, number> };
  usage: Record<string, PeerUsage>;
  /** Provider-reported total tokens per served (else requested) model. */
  usageByModel: Record<string, number>;
  turns: number; filesChanged: number;
  /** Model routes and served models seen for the task's attributed requests. */
  models: string[];
  writer: { version: string; source: "live" | "backfill" };
}
/** A person's later verdict on one task record: `createdAt` binds it to that task, not a later one with the same id. */
export interface LabelRecord { schema: typeof RESEARCH_SCHEMA; kind: "label"; project: string; task: number; createdAt: string; label: Label; at: string }
export type ResearchRecord = TaskRecord | LabelRecord;

/** The store name for a project: a hash of its id, never its path. */
export const projectKey = (projectId: string): string => createHash("sha256").update(projectId).digest("hex").slice(0, 16);
export const researchDir = (home = hubHome()): string => join(home, "research");
export const researchFile = (projectId: string, home = hubHome()): string => join(researchDir(home), `${projectKey(projectId)}.jsonl`);
/** One task across every record about it: a task id is reused after `ahub reset --all`, its proposal time is not. */
export const recordKey = (r: { project: string; task: number; createdAt: string | null; approvedAt?: string }): string => `${r.project}#${r.task}@${r.createdAt ?? r.approvedAt ?? ""}`;

type Acc = Omit<TaskRecord, "schema" | "kind" | "project" | "approvedAt" | "wallMs" | "firstPass" | "outcome" | "writer" | "models"> & {
  models: Set<string>; approvedAt: string | null; lastState: string | null;
};
const blank = (task: number): Acc => ({ task, class: null, pii: false, createdAt: null, startedAt: null, activeMs: 0, owners: [], reviewer: null,
  reviewRounds: 0, changesRequested: 0, checkPassed: 0, checkFailed: 0, dones: 0, reassignments: 0, reassignedBy: {}, stuck: 0, overlaps: 0, conflicts: 0,
  tests: { pass: 0, fail: 0 }, tokens: { total: 0, byPeer: {}, byAttribution: {} }, usage: {}, usageByModel: {}, turns: 0, filesChanged: 0, models: new Set(),
  approvedAt: null, lastState: null });
const add = (current: number | null, value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? (current ?? 0) + value : current;
const bump = (counts: Record<string, number>, key: string, n = 1) => { counts[key] = (counts[key] ?? 0) + n; };

/**
 * One record per approved task in `events`. Approval is final on the board, so everything attributed to the task
 * counts, also after the approval: the turn that approved it ends later, and its usage arrives after that. The live
 * writer therefore waits for those turns (daemon `recordResearch`); backfill reads to the end of the file.
 */
export function taskRecords(events: StampedEvent[], projectId: string, writer: TaskRecord["writer"]): TaskRecord[] {
  const tasks = new Map<number, Acc>(), earlier: Acc[] = [];
  const acc = (id: number) => { let a = tasks.get(id); if (!a) tasks.set(id, a = blank(id)); return a; };
  const seenUsage = new Set<string>();
  for (const e of events) {
    if (e.type === "task") {
      // Ids restart after `ahub reset --all` archives the events, but a file that kept both starts the task anew.
      if (e.event === "proposed" && tasks.get(e.id)?.createdAt) { earlier.push(tasks.get(e.id)!); tasks.delete(e.id); }
      const a = acc(e.id);
      a.class = e.class; if (e.pii) a.pii = true;
      if (e.owner && e.owner !== a.owners.at(-1)) {
        if (a.owners.length) { a.reassignments++; bump(a.reassignedBy, e.reason ?? "none"); }
        a.owners.push(e.owner);
      }
      if (e.reviewer) a.reviewer = e.reviewer;
      if (e.event === "proposed") a.createdAt ??= e.at;
      if (e.state === "in_progress") a.startedAt ??= e.at;
      if (e.event === "done") a.dones++;
      if (e.event === "check passed") a.checkPassed++;
      if (e.event === "check failed") a.checkFailed++;
      if (e.state === "in_review" && a.lastState !== "in_review") a.reviewRounds++;
      if (e.state === "changes_requested" && a.lastState !== "changes_requested") a.changesRequested++;
      if (e.state === "approved") a.approvedAt ??= e.at;
      a.lastState = e.state;
      continue;
    }
    const task = "task" in e && typeof e.task === "number" ? e.task : undefined;
    if (task === undefined) continue;
    const a = acc(task);
    if ("pii" in e && e.pii === true) a.pii = true;
    if (e.type === "tokens") { a.tokens.total += e.n; bump(a.tokens.byPeer, e.peer, e.n); bump(a.tokens.byAttribution, e.attribution ?? "unknown", e.n); }
    else if (e.type === "turn_end") { a.turns++; a.activeMs += e.ms; a.filesChanged += e.files ?? 0; }
    else if (e.type === "usage") {
      const key = `${e.peer}\0${e.source}\0${e.id}`;
      if (seenUsage.has(key)) continue;
      seenUsage.add(key);
      const u = a.usage[e.peer] ??= { input: null, output: null, cacheRead: null, total: null };
      u.input = add(u.input, e.inputTokens); u.output = add(u.output, e.outputTokens); u.cacheRead = add(u.cacheRead, e.cacheReadTokens); u.total = add(u.total, e.totalTokens);
      const model = e.servedModel ?? e.requestedModel;
      if (model) a.models.add(String(model));
      if (typeof e.totalTokens === "number" && Number.isFinite(e.totalTokens)) bump(a.usageByModel, String(model ?? "unknown"), e.totalTokens);
    }
    else if (e.type === "route") a.models.add(e.route);
    else if (e.type === "route_outcome") { if (e.next?.tests === "pass") a.tests.pass++; if (e.next?.tests === "fail") a.tests.fail++; }
    else if (e.type === "stuck") a.stuck++;
    else if (e.type === "overlap") a.overlaps++;
    else if (e.type === "conflict") a.conflicts++;
  }
  const out: TaskRecord[] = [];
  for (const a of [...earlier, ...tasks.values()]) {
    if (!a.approvedAt) continue;
    const { approvedAt, lastState: _state, models, ...rest } = a;
    const start = a.startedAt ? Date.parse(a.startedAt) : NaN, end = Date.parse(approvedAt);
    out.push({ schema: RESEARCH_SCHEMA, kind: "task", project: projectKey(projectId), ...rest, outcome: "approved", approvedAt,
      wallMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
      firstPass: a.changesRequested === 0 && a.checkFailed === 0 && a.reviewRounds <= 1, models: [...models].sort(), writer });
  }
  return out.sort((x, y) => x.approvedAt.localeCompare(y.approvedAt) || x.task - y.task);
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

/** Append task records the store does not hold yet (same task, by `recordKey`), and labels; returns how many were written. */
export function appendRecords(projectId: string, records: ResearchRecord[], home = hubHome()): number {
  if (!records.length) return 0;
  const file = researchFile(projectId, home);
  mkdirSync(researchDir(home), { recursive: true, mode: 0o700 });
  chmodSync(researchDir(home), 0o700); // mkdir's mode applies only when it creates the directory
  const held = new Set(readStore(file).flatMap((r) => r.kind === "task" ? [recordKey(r)] : []));
  const added = records.filter((r) => r.kind === "label" || !held.has(recordKey(r)));
  if (!added.length) return 0;
  appendFileSync(file, added.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return added.length;
}

/**
 * The record a person's label is for. `created` (a record's `createdAt`, from `ahub research export`) names one exactly.
 * Otherwise the current board's task with that id, found by its proposal in `events`, so a label never lands on an
 * earlier task with the same id; an id this hub's events do not have (a task from before `ahub reset --all`) is the
 * store's only record with that id. Throws why there is none, or which ones to choose from.
 */
export function labelTarget(records: ResearchRecord[], events: StampedEvent[], task: number, created?: string): TaskRecord {
  // A record without a proposal time (its proposal was not in the events) cannot be told apart, so it takes no label.
  const mine = records.filter((r): r is TaskRecord => r.kind === "task" && r.task === task && r.createdAt !== null);
  if (created !== undefined) {
    return mine.find((r) => r.createdAt === created) ?? fail(`no research record for task #${task} proposed at ${created}${mine.length ? ` (it has: ${mine.map((r) => r.createdAt).join(", ")})` : ""}`);
  }
  const proposed = events.filter((e) => e.type === "task" && e.id === task && e.event === "proposed").at(-1);
  if (proposed) {
    return mine.find((r) => r.createdAt === proposed.at)
      ?? fail(`task #${task} has no research record yet: it is not approved, its record still waits for the turns that approved it, or it was approved while research was off (ahub research backfill builds that one)${mine.length ? `; an earlier task #${task} from before a reset is labelled with --created ${mine.map((r) => r.createdAt).join(" or ")}` : ""}`);
  }
  if (mine.length === 1) return mine[0]!;
  if (!mine.length) throw new Error(records.some((r) => r.kind === "task" && r.task === task) ? `task #${task}'s research record has no proposal time (its proposal was not in the events), so it takes no label` : `no research record for task #${task}`);
  throw new Error(`task #${task} is not on this hub's board and the store has ${mine.length} records with that id; name one with --created <time>: ${mine.map((r) => r.createdAt).join(", ")}`);
}
const fail = (message: string): never => { throw new Error(message); };

const pct = (n: number, d: number) => d ? n / d : null;
/** Linear interpolation between the closest ranks: the median of [100, 300] is 200. */
function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), at = q * (sorted.length - 1), low = Math.floor(at);
  return sorted[low]! + (sorted[Math.min(low + 1, sorted.length - 1)]! - sorted[low]!) * (at - low);
}
export interface Measures {
  tasks: number; succeeded: number; failedByLabel: number;
  successRate: number | null; firstPassRate: number | null; reworkRate: number | null; checkFailureRate: number | null;
  tokensPerTask: { median: number | null; p90: number | null }; wallMsPerTask: { median: number | null; p90: number | null };
}
function measures(records: TaskRecord[], labels: Map<string, Label>): Measures {
  const failed = records.filter((r) => FAILED.has(labels.get(recordKey(r)) ?? "")).length;
  return { tasks: records.length, succeeded: records.length - failed, failedByLabel: failed,
    successRate: pct(records.length - failed, records.length), firstPassRate: pct(records.filter((r) => r.firstPass).length, records.length),
    reworkRate: pct(records.reduce((n, r) => n + r.changesRequested, 0), records.length),
    checkFailureRate: pct(records.reduce((n, r) => n + r.checkFailed, 0), records.reduce((n, r) => n + r.checkFailed + r.checkPassed, 0)),
    tokensPerTask: { median: quantile(records.map((r) => r.tokens.total), 0.5), p90: quantile(records.map((r) => r.tokens.total), 0.9) },
    wallMsPerTask: { median: quantile(records.flatMap((r) => r.wallMs ?? []), 0.5), p90: quantile(records.flatMap((r) => r.wallMs ?? []), 0.9) } };
}
export interface ResearchReport { overall: Measures; byClass: Record<string, Measures>; byOwner: Record<string, Measures>; byProject: Record<string, Measures>; byModel: Record<string, Measures> }
/**
 * The derived measures, never stored as truth: each task counts once (its last record), and a person's latest label
 * decides whether an approved task later failed. Records older than `since` (ms epoch, by approval) are left out.
 */
export function researchReport(records: ResearchRecord[], since = 0): ResearchReport {
  const latest = new Map<string, TaskRecord>(), labels = new Map<string, Label>();
  for (const r of records) {
    const key = recordKey(r);
    if (r.kind === "label") { labels.set(key, r.label); continue; }
    if (Date.parse(r.approvedAt) >= since) latest.set(key, r);
  }
  const all = [...latest.values()];
  const group = (keys: (r: TaskRecord) => string[]) => {
    const out: Record<string, TaskRecord[]> = {};
    for (const r of all) for (const k of keys(r)) (out[k] ??= []).push(r);
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => [k, measures(rs, labels)]));
  };
  return { overall: measures(all, labels), byClass: group((r) => [r.class ?? "unknown"]), byOwner: group((r) => r.owners.length ? [...new Set(r.owners)] : ["none"]),
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

export const CSV_COLUMNS = ["project", "task", "class", "pii", "outcome", "createdAt", "startedAt", "approvedAt", "wallMs", "activeMs", "owners",
  "reviewer", "reviewRounds", "changesRequested", "checkPassed", "checkFailed", "dones", "reassignments", "firstPass", "stuck", "overlaps", "conflicts",
  "testsPass", "testsFail", "tokens", "turns", "filesChanged", "models", "label", "writerVersion", "writerSource"] as const;
/** Task records as CSV with a header row, one row per record, each with the task's latest label; JSONL has every field. */
export function toCsv(records: ResearchRecord[]): string {
  const labels = new Map<string, Label>();
  for (const r of records) if (r.kind === "label") labels.set(recordKey(r), r.label);
  const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = records.filter((r): r is TaskRecord => r.kind === "task").map((r) => [r.project, r.task, r.class, r.pii, r.outcome, r.createdAt, r.startedAt,
    r.approvedAt, r.wallMs, r.activeMs, r.owners.join(" "), r.reviewer, r.reviewRounds, r.changesRequested, r.checkPassed, r.checkFailed, r.dones,
    r.reassignments, r.firstPass, r.stuck, r.overlaps, r.conflicts, r.tests.pass, r.tests.fail, r.tokens.total, r.turns, r.filesChanged, r.models.join(" "),
    labels.get(recordKey(r)) ?? "", r.writer.version, r.writer.source].map(cell).join(","));
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
