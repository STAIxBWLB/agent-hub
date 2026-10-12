import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleIdentity, StampedEvent } from "./events.ts";
import { hubHome } from "./project.ts";
import { ADDONS, addonState, type Addon, type AddonName } from "./tooling.ts";
import { MIN_ATTEMPTS, mulberry32 } from "./bench.ts";

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
  profile?: string; profileClass?: string;
  role?: string; roleIdentity?: { id: string; layer: "shipped" | "project"; hash: string };
  /** Native preamble preparations frozen at each attributed turn's start, never proof of model consumption. */
  sessionRoles?: { peer: string; turn: string; roles: RoleIdentity[] | null }[];
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
  /** #248: the add-ons each peer that worked on the task had at its latest attach; a peer missing here is unknown. */
  tooling?: Record<string, Addon[]>;
  /** #248, with `tooling`: every peer with an event attributed to the task, fingerprinted or not. */
  peers?: string[];
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

type Acc = Omit<TaskRecord, "schema" | "kind" | "project" | "approvedAt" | "wallMs" | "firstPass" | "outcome" | "writer" | "models" | "tooling" | "peers"> & {
  models: Set<string>; approvedAt: string | null; lastState: string | null; tooling: Record<string, Addon[]>; peers: Set<string>;
};
/** Keyed by peer ids, model names and reasons, any of which may be `constructor` or `__proto__`: no prototype to inherit from. */
const keyed = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const blank = (task: number): Acc => ({ task, class: null, pii: false, createdAt: null, startedAt: null, activeMs: 0, owners: [], reviewer: null,
  reviewRounds: 0, changesRequested: 0, checkPassed: 0, checkFailed: 0, dones: 0, reassignments: 0, reassignedBy: keyed(), stuck: 0, overlaps: 0, conflicts: 0,
  tests: { pass: 0, fail: 0 }, tokens: { total: 0, byPeer: keyed(), byAttribution: keyed() }, usage: keyed(), usageByModel: keyed(), turns: 0, filesChanged: 0, models: new Set(),
  approvedAt: null, lastState: null, tooling: keyed(), peers: new Set() });
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
  const tooling = new Map<string, Addon[]>();
  /** A peer that worked on the task carries its latest fingerprint into the record. */
  const involve = (a: Acc, peer: string | null | undefined) => { if (!peer) return; a.peers.add(peer); const f = tooling.get(peer); if (f) a.tooling[peer] = f; };
  for (const e of events) {
    if (e.type === "tooling") {
      tooling.set(e.peer, e.addons);
      // Detection settles in the background, so a peer may have worked on a task before its fingerprint was written.
      for (const a of tasks.values()) if (a.peers.has(e.peer) && !Object.hasOwn(a.tooling, e.peer)) a.tooling[e.peer] = e.addons;
      continue;
    }
    if (e.type === "task") {
      const proposed = e.event === "proposed" || e.event === "backlog pulled";
      // Ids restart after `ahub reset --all` archives the events, but a file that kept both starts the task anew.
      if ((e.event === "proposed" && tasks.get(e.id)?.createdAt) || (e.event === "backlogged" && tasks.has(e.id))) { earlier.push(tasks.get(e.id)!); tasks.delete(e.id); }
      const a = acc(e.id);
      a.class = e.class; if (e.role && a.role === undefined) { a.role = e.role; if (e.event === "proposed" && e.roleIdentity) a.roleIdentity = e.roleIdentity; } if (e.profile) { a.profile = e.profile; a.profileClass = e.profileClass; } if (e.pii) a.pii = true;
      if (proposed && e.role === a.role && e.roleIdentity && a.roleIdentity === undefined) a.roleIdentity = e.roleIdentity;
      if (e.owner && e.owner !== a.owners.at(-1)) {
        if (a.owners.length) { a.reassignments++; bump(a.reassignedBy, e.reason ?? "none"); }
        a.owners.push(e.owner);
      }
      if (e.reviewer) a.reviewer = e.reviewer;
      if (proposed) a.createdAt ??= e.at;
      if (e.state === "in_progress") a.startedAt ??= e.at;
      if (e.event === "done") a.dones++;
      if (e.event === "check passed") a.checkPassed++;
      if (e.event === "check failed") a.checkFailed++;
      if (e.state === "in_review" && a.lastState !== "in_review") a.reviewRounds++;
      if (e.state === "changes_requested" && a.lastState !== "changes_requested") a.changesRequested++;
      if (e.state === "approved") a.approvedAt ??= e.at;
      a.lastState = e.state;
      involve(a, e.owner); involve(a, e.reviewer);
      continue;
    }
    const task = "task" in e && typeof e.task === "number" ? e.task : undefined;
    if (task === undefined) continue;
    const a = acc(task);
    if ("pii" in e && e.pii === true) a.pii = true;
    if ("peer" in e && typeof e.peer === "string") involve(a, e.peer);
    if (e.type === "tokens") { a.tokens.total += e.n; bump(a.tokens.byPeer, e.peer, e.n); bump(a.tokens.byAttribution, e.attribution ?? "unknown", e.n); }
    else if (e.type === "turn_end") {
      a.turns++; a.activeMs += e.ms; a.filesChanged += e.files ?? 0;
      if (e.preparedRoles !== undefined) (a.sessionRoles ??= []).push({ peer: e.peer, turn: e.turn, roles: e.preparedRoles?.map(role => ({ id: role.id, layer: role.layer, hash: role.hash })) ?? null });
    }
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
    const { approvedAt, lastState: _state, models, tooling: fingerprints, peers, ...rest } = a;
    const start = a.startedAt ? Date.parse(a.startedAt) : NaN, end = Date.parse(approvedAt);
    out.push({ schema: RESEARCH_SCHEMA, kind: "task", project: projectKey(projectId), ...rest, outcome: "approved", approvedAt,
      wallMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
      firstPass: a.changesRequested === 0 && a.checkFailed === 0 && a.reviewRounds <= 1, models: [...models].sort(), writer,
      ...(Object.keys(fingerprints).length ? { tooling: fingerprints, peers: [...peers].sort() } : {}) });
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
  const creation = events.findLast(e => e.type === "task" && e.id === task && ["proposed", "backlogged"].includes(e.event));
  const proposed = creation?.type === "task" && creation.event === "backlogged"
    ? events.slice(events.indexOf(creation) + 1).find(e => e.type === "task" && e.id === task && e.event === "backlog pulled")
    : creation;
  if (creation?.type === "task" && creation.event === "backlogged" && !proposed) fail(`task #${task} is backlog and has no execution proposal; name an earlier record with --created`);
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
  const { all, labels } = latestRecords(records, since);
  const group = (keys: (r: TaskRecord) => string[]) => {
    // A Map: a peer or model may be named `constructor`, which a plain object answers with an inherited value.
    const out = new Map<string, TaskRecord[]>();
    for (const r of all) for (const k of keys(r)) out.set(k, [...(out.get(k) ?? []), r]);
    return Object.fromEntries([...out].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => [k, measures(rs, labels)]));
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

/** Each approved task once, its last record, and every task's latest label: what both reports count. */
function latestRecords(records: ResearchRecord[], since: number): { all: TaskRecord[]; labels: Map<string, Label> } {
  const latest = new Map<string, TaskRecord>(), labels = new Map<string, Label>();
  for (const r of records) {
    const key = recordKey(r);
    if (r.kind === "label") { labels.set(key, r.label); continue; }
    if (Date.parse(r.approvedAt) >= since) latest.set(key, r);
  }
  return { all: [...latest.values()], labels };
}

/** The peers that worked on a task: every peer with an attributed event, else (older records) owners, reviewer and token peers. */
const involved = (r: TaskRecord): string[] => [...new Set([...(r.peers ?? []), ...r.owners, ...(r.reviewer ? [r.reviewer] : []), ...Object.keys(r.tokens.byPeer)])].filter((p) => p !== "user");
/** Own properties only: a peer may be named `constructor`, and a parsed record's object would answer with an inherited one. */
const fingerprintOf = (r: TaskRecord, peer: string): Addon[] | undefined => r.tooling && Object.hasOwn(r.tooling, peer) ? r.tooling[peer] : undefined;

type AddonMeasure = "successRate" | "firstPassRate" | "reworkRate" | "checkFailureRate" | "tokensMedian" | "wallMsMedian" | "collisionRate";
const ADDON_MEASURES: AddonMeasure[] = ["successRate", "firstPassRate", "reworkRate", "checkFailureRate", "tokensMedian", "wallMsMedian", "collisionRate"];
/** Every add-on measure of one set of tasks, computed once (a bootstrap calls this per resample). */
function addonValues(rs: TaskRecord[], labels: Map<string, Label>): Record<AddonMeasure, number | null> {
  const x = measures(rs, labels);
  return { successRate: x.successRate, firstPassRate: x.firstPassRate, reworkRate: x.reworkRate, checkFailureRate: x.checkFailureRate,
    tokensMedian: x.tokensPerTask.median, wallMsMedian: x.wallMsPerTask.median, collisionRate: pct(rs.reduce((n, r) => n + r.overlaps + r.conflicts, 0), rs.length) };
}
export interface AddonComparison {
  addon: AddonName;
  /** Tasks where a peer that worked on it had the add-on, where every such peer is known not to, and the rest. */
  on: number; off: number; unknown: number;
  measures: { measure: AddonMeasure; on: number | null; off: number | null; diff: number | null; low: number | null; high: number | null; inconclusive: boolean }[];
}
/**
 * #248, observational: approved tasks with each add-on on against those with it off, by the tooling fingerprint each
 * record carries. The difference is on minus off with a 95% bootstrap interval (seeded, so the same records give the
 * same interval); below MIN_ATTEMPTS tasks on either side it is inconclusive. Field data shows association only: the
 * peers, task mix and time differ between the sides. The causal side is `ahub bench` arms (docs/bench.md).
 */
export function addonReport(records: ResearchRecord[], since = 0, resamples = 1000, seed = 248): AddonComparison[] {
  const { all, labels } = latestRecords(records, since);
  return ADDONS.map((addon) => {
    const side = { on: [] as TaskRecord[], off: [] as TaskRecord[], unknown: [] as TaskRecord[] };
    for (const r of all) side[addonState(addon, involved(r).map((p) => fingerprintOf(r, p)))].push(r);
    const random = mulberry32(seed);
    const pick = (xs: TaskRecord[]) => Array.from({ length: xs.length }, () => xs[Math.floor(random() * xs.length)]!);
    const samples = new Map<AddonMeasure, number[]>(ADDON_MEASURES.map((m) => [m, []]));
    if (side.on.length && side.off.length) for (let i = 0; i < resamples; i++) {
      const a = addonValues(pick(side.on), labels), b = addonValues(pick(side.off), labels);
      for (const m of ADDON_MEASURES) { const x = a[m], y = b[m]; if (x !== null && y !== null) samples.get(m)!.push(x - y); }
    }
    const onValues = addonValues(side.on, labels), offValues = addonValues(side.off, labels);
    return { addon, on: side.on.length, off: side.off.length, unknown: side.unknown.length, measures: ADDON_MEASURES.map((measure) => {
      const on = onValues[measure], off = offValues[measure];
      const s = samples.get(measure)!.sort((x, y) => x - y);
      const rank = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
      const diff = on !== null && off !== null ? on - off : null;
      return { measure, on, off, diff, low: s.length ? rank(0.025) : null, high: s.length ? rank(0.975) : null,
        inconclusive: diff === null || side.on.length < MIN_ATTEMPTS || side.off.length < MIN_ATTEMPTS };
    }) };
  });
}
export function formatAddons(rows: AddonComparison[]): string[] {
  const fmt = (m: AddonMeasure, v: number | null) => v === null ? "-" : m === "tokensMedian" ? String(Math.round(v)) : m === "wallMsMedian" ? `${Math.round(v / 60_000)}m` : m === "reworkRate" || m === "collisionRate" ? v.toFixed(2) : `${Math.round(v * 100)}%`;
  const out = ["add-on tasks with it on / off / unknown; on minus off with a 95% bootstrap interval (association, not cause)"];
  for (const r of rows) {
    out.push("", `${r.addon}: ${r.on} on, ${r.off} off, ${r.unknown} unknown`);
    for (const m of r.measures) out.push(`  ${m.measure.padEnd(16)} on ${fmt(m.measure, m.on).padStart(6)}  off ${fmt(m.measure, m.off).padStart(6)}  diff ${fmt(m.measure, m.diff).padStart(6)} (${fmt(m.measure, m.low)} to ${fmt(m.measure, m.high)})${m.inconclusive ? `  inconclusive (fewer than ${MIN_ATTEMPTS} tasks on a side)` : ""}`);
  }
  return out;
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
