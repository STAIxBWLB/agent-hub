import { profileScorecard, type ProfileTaskMetadata } from "./dogfood-profile.ts";
import type { ProfileName } from "./profiles.ts";
import { costMetrics, type CostPr, type CostTask } from "./cost-governance.ts";
import type { HistoryEntry } from "./board.ts";
import { parseSince } from "./events.ts";
import type { StampedEvent } from "./events.ts";
import { summarize, summarizeByTask, type TaskPeerReport } from "./report.ts";


export function dogfoodSince(args: string[], now = Date.now()): number {
  let since: number | undefined, dogfood = false, json = false;
  const fail = (): never => {throw new Error("usage: ahub report --dogfood [--since 7d|<iso>] [--json]");};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==="--dogfood" && !dogfood) dogfood=true;
    else if(arg==="--json" && !json) json=true;
    else if(arg==="--since" && since===undefined) {const value=parseSince(args[++i] ?? "",now);if(value===undefined)fail();since=value;}
    else fail();
  }
  if(!dogfood)fail();
  return since ?? now-7*86400000;
}

export interface Source<T> { data: T; complete: boolean; available: boolean }
export const source = <T>(data: T, complete = true): Source<T> => ({ data, complete, available: true });
export const missing = <T>(data: T): Source<T> => ({ data, complete: false, available: false });
export interface DogfoodTask { id: number; repo?: string; pr?: number; pii: boolean; history: HistoryEntry[]; profileMetadata?: ProfileTaskMetadata }
export interface DogfoodPr extends CostPr {
  firstPassCi?: boolean;
  sameHeadReruns?: number;
  connectorThreads?: number[];
  bugIssues?: { id: number; at: number }[];
}
export interface FeatureEvidence { id: number; types: string[] | null; taskEvents?: string[] }
export interface DogfoodInput {
  since: number; until: number;
  projectProfile?: Source<ProfileName | null>;
  events: Source<StampedEvent[]>; tasks: Source<DogfoodTask[]>; prs: Source<DogfoodPr[]>;
  journal?: Source<{ digests: number; held: number; rows: number }>;
  log: Source<string[]>; features: Source<FeatureEvidence[]>;
}
export interface Metric { value: number | null; samples: number }
const metric = (value: number, known: boolean, samples = 1): Metric => ({ value: known ? value : null, samples });
const known = (s: Source<unknown>) => s.available && s.complete;
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const identity = (repo: string, pr: number) => `${repo.toLowerCase()}#${pr}`;
const validPeer = (peer: string) => /^[a-z][a-z0-9-]{0,63}$/.test(peer) && !Object.hasOwn(Object.prototype, peer);
function peers(input: Record<string, TaskPeerReport>) {
  return Object.fromEntries(Object.entries(input).filter(([id]) => validPeer(id)).map(([id, p]) => [id, {
    tokens: p.tokens, input: p.usage.inputTokens, output: p.usage.outputTokens,
    cacheRead: p.usage.cacheReadTokens, cacheWrite: p.usage.cacheWriteTokens, total: p.usage.totalTokens,
    records: p.usage.records, inputRecords: p.usage.inputRecords, outputRecords: p.usage.outputRecords,
    cacheReadRecords: p.usage.cacheReadRecords, cacheWriteRecords: p.usage.cacheWriteRecords, totalRecords: p.usage.totalRecords,
  }]));
}
function percentiles(values: number[]) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const at = (q: number) => sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]! : null;
  return { samples: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99) };
}

/** Metadata projections only: never return task titles, notes, model/provider names or log fragments. */
export function dogfoodScorecard(input: DogfoodInput) {
  const events = input.events.data.filter(e => Date.parse(e.at) >= input.since && Date.parse(e.at) <= input.until);
  const inWindow = (at: number) => at >= input.since && at <= input.until;
  const tasks = input.tasks.data;
  const hidden = new Set(tasks.filter(t => t.pii && t.repo && positive(t.pr)).map(t => identity(t.repo!, t.pr!)));
  const prs = input.prs.data.filter(p => p.state === "MERGED" && finite(p.mergedAt) && inWindow(p.mergedAt)
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repo) && positive(p.pr) && !hidden.has(identity(p.repo, p.pr)));
  const costTasks: CostTask[] = tasks.flatMap(t => t.repo && positive(t.pr) ? [{ repo: t.repo, pr: t.pr, private: t.pii, history: t.history }] : []);
  const costs = costMetrics(costTasks, prs);
  const rows = prs.map(pr => {
    const linked = tasks.filter(t => !t.pii && t.repo && positive(t.pr) && identity(t.repo, t.pr!) === identity(pr.repo, pr.pr));
    const histories = linked.flatMap(t => t.history).filter(h => h.at <= pr.mergedAt!).sort((a,b) => a.at - b.at);
    const timelines = linked.map(t => {
      const history=t.history.filter(h=>h.at<=pr.mergedAt!).sort((a,b)=>a.at-b.at);
      return {approval:history.findLast(h=>h.event==="approved")?.at,
        proposed:history.find(h=>h.event==="proposed" || h.event==="backlog pulled")?.at,
        done:history.findLast(h=>h.event==="done")?.at,
        first:history.find(h=>h.event==="approved" || h.event==="changes_requested")?.event};
    });
    // PR readiness requires every linked task; an earlier member's approval is not the PR approval.
    const all = (key:"approval"|"proposed"|"done") => timelines.length && timelines.every(t=>t[key]!==undefined);
    const firstApproval = all("approval") ? Math.max(...timelines.map(t=>t.approval!)) : undefined;
    const proposed = all("proposed") ? Math.min(...timelines.map(t=>t.proposed!)) : undefined;
    const done = all("done") ? Math.max(...timelines.map(t=>t.done!)) : undefined;
    const findings = new Set(histories.flatMap(h => h.reviewFindings?.items.filter(f => f.severity === "important").map(f => f.id) ?? []));
    const cost = costs.rows.find(c => identity(c.repo, c.pr) === identity(pr.repo, pr.pr));
    const ciCost = cost ?? costMetrics([{repo:pr.repo,pr:pr.pr,history:[]}],[pr]).rows[0];
    const boardKnown = known(input.tasks) && linked.length > 0;
    const delta = (end: number | undefined, start: number | undefined) => end !== undefined && start !== undefined && end >= start ? end - start : null;
    return { repo: pr.repo.toLowerCase(), pr: pr.pr, tasks: linked.map(t => t.id).sort((a,b) => a-b), mergedAt: pr.mergedAt!,
      proposeToApproveMs: boardKnown ? delta(firstApproval, proposed) : null,
      doneToMergeMs: boardKnown ? delta(pr.mergedAt, done) : null,
      reviewRounds: boardKnown ? cost?.reviewRounds ?? null : null,
      firstPassApproval: boardKnown && timelines.every(t=>t.first) ? Number(timelines.every(t=>t.first === "approved")) : null,
      escalations: boardKnown ? histories.filter(h => h.event === "escalated").length : null,
      importantFindings: boardKnown ? findings.size : null,
      connectorThreadsAfterApproval: firstApproval !== undefined && pr.connectorThreads !== undefined ? pr.connectorThreads.filter(at => at > firstApproval && at <= input.until).length : null,
      bugIssuesWithin14d: pr.bugIssues?.filter(issue => issue.at >= pr.mergedAt! && issue.at <= Math.min(input.until,pr.mergedAt! + 14 * 86400000)).length ?? null,
      bugObservationDays: Math.min(14, Math.max(0, (input.until - pr.mergedAt!) / 86400000)),
      firstPassCi: pr.firstPassCi === undefined ? null : Number(pr.firstPassCi),
      ciRuns: pr.complete ? ciCost?.ciRuns ?? null : null,
      ciReruns: pr.complete ? ciCost?.ciReruns ?? null : null,
      sameHeadReruns: pr.sameHeadReruns ?? null,
    };
  });
  const accounting = events.filter(e => {
    if (e.type === "task") return positive(e.id) && /^[a-z_]{1,32}$/.test(e.class) && !Object.hasOwn(Object.prototype,e.class);
    if (e.type !== "tokens" && e.type !== "usage" && e.type !== "turn_end") return false;
    if (!validPeer(e.peer) || e.task !== undefined && !positive(e.task)) return false;
    if (e.type === "tokens") return finite(e.n);
    if (e.type === "turn_end") return finite(e.ms);
    return typeof e.id === "string" && typeof e.source === "string";
  });
  const taskReport = summarizeByTask(accounting);
  const costPerTask = Object.entries(taskReport.tasks).filter(([id]) => positive(Number(id))).map(([id,t]) => ({ task: Number(id), pii: Number(!!t.pii || !!tasks.find(x => x.id === Number(id))?.pii), peers: peers(t.peers) }));
  const costPerPr = rows.map(row => {
    const linked = new Set(row.tasks);
    const selected = accounting.filter(e => "task" in e && typeof e.task === "number" && linked.has(e.task));
    const summary = summarizeByTask(selected);
    const merged: Record<string, TaskPeerReport> = {};
    // Reuse the report's class grouping solely as an accumulator, never expose the class text.
    for (const [id,p] of Object.entries(summary.classes).flatMap(([,c]) => Object.entries(c.peers))) {
      const previous = merged[id];
      if (!previous) merged[id] = structuredClone(p);
      else {
        previous.tokens = previous.tokens === null || p.tokens === null ? null : previous.tokens + p.tokens;
        for (const k of Object.keys(previous.usage) as (keyof TaskPeerReport["usage"])[]) {
          const a = previous.usage[k], b = p.usage[k];
          previous.usage[k] = (a === null || b === null ? null : a + b) as never;
        }
      }
    }
    return { repo: row.repo, pr: row.pr, peers: row.tasks.length && known(input.tasks) ? peers(merged) : null };
  });
  const logs = input.log.data;
  const countLog = (pattern: RegExp) => logs.filter(line => pattern.test(line)).length;
  const eventCount = (type: string) => events.filter(e => e.type === type).length;
  const eventMetric = (type: string) => metric(eventCount(type), known(input.events), events.length);
  const logMetric = (pattern: RegExp) => metric(countLog(pattern), known(input.log), logs.length);
  const gates = {
    S1: /spec acceptance|spec.*(?:missing|changed|unknown|accepted|edited)/i, S2: /plan conformance/i,
    S3: /important finding/i, S4: /test integrity:/i, S9: /plan not reviewed|plan review issue|planner plan/i,
  };
  const advice = logs.filter(line => /SDLC .* advice:|premature review:|plan.*advice:|task .*: (?:plan not reviewed since |plan review issue )/.test(line));
  return {
    schemaVersion: 1, since: input.since, until: input.until,
    sources: Object.fromEntries((["events","tasks","prs","log","features"] as const).map(key => [key, { available: input[key].available, complete: input[key].complete, records: input[key].data.length }])),
    flow: { prs: rows, coverage: { mergedPrs: rows.length, linkedPrs: rows.filter(r => r.tasks.length).length } },
    quality: { adviseBlockers: Object.fromEntries(Object.entries(gates).map(([gate,re]) => [gate, metric(advice.filter(line => re.test(line)).length, known(input.log), advice.length)])), realBlockers: null },
    cost: { eventSourceComplete: known(input.events), usageComplete: known(input.events) && accounting.some(e=>e.type === "usage") && summarize(accounting).usage.completeCoverage, attributionComplete: known(input.events) && accounting.filter(e=>e.type === "tokens" || e.type === "usage").every(e=>e.attribution !== undefined && e.attribution !== "unattributed" && e.task !== undefined), perTask: costPerTask, perPr: costPerPr, unattributed: peers(taskReport.unattributed.peers), beforeAttribution: peers(taskReport.beforeAttribution.peers) },
    delivery: { envelopeToDeliveryMs: percentiles([]), digests: {value: input.journal && known(input.journal) ? input.journal.data.digests : null, scope: "retained_journal"}, overflow: eventMetric("overflow"), undeliverable: eventMetric("undeliverable"), held: {value: input.journal && known(input.journal) ? input.journal.data.held : null, scope: "retained_journal"}, emptyInboxPollingStreaks: logMetric(/is polling an empty inbox with no task \(\d+ empty reads in \d+ min\)/) },
    performance: { controlRequestMs: percentiles([]), connectionTimeouts: null, snapshotBudgetExhaustions: null, snapshotBudgetNotices: logMetric(/snapshot unavailable:.*budget/i), cpu: percentiles([]), rss: percentiles([]),
      errors: { database: logMetric(/database contention|SQLITE_BUSY/), storage: logMetric(/delivery storage|journal unavailable/), transport: logMetric(/transport.*(?:failed|error)|connection.*(?:failed|error)/i) } },
    adoption: input.features.data.map(feature => ({ id: feature.id, events: feature.types && known(input.events) ? events.filter(e => feature.types!.includes(e.type) && (!feature.taskEvents || e.type === "task" && feature.taskEvents.includes(e.event))).length : null })),
    journalSource: input.journal ? {available:input.journal.available,complete:input.journal.complete,rows:input.journal.data.rows} : {available:false,complete:false,rows:0},
    piiTasks: known(input.tasks) ? tasks.filter(t => t.pii).length : null,
    ...profileScorecard(input),
  };
}
export type DogfoodScorecard = ReturnType<typeof dogfoodScorecard>;
/** A stable readable receipt; null is explicitly unknown in both formats. */
export function formatDogfood(report: DogfoodScorecard): string[] {
  return JSON.stringify(report, (_key,value) => value === null ? "unknown" : value, 2).split("\n");
}
