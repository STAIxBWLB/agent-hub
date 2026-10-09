import type { StampedEvent } from "./events.ts";

export interface Report {
  from?: string;
  to?: string;
  peers: Record<string, { turns: number | null; busyMinutes: number; tokens: number; turnSource?: "native-stop" | "logical-state" | "unknown" }>;
  usage: { peers: Record<string, UsageCoverage>; totals: UsageTotals; unknownPeers: string[]; completeCoverage: boolean; estimatedUsd?: number; measuredSpendUsd?: number };
  messages: { total: number; dropped: Record<string, number>; overflow: number; undeliverable: number; perTask: number };
  overlaps: { warnings: number; pairs: number };
  /** Files one agent changed after another owner's open task had changed them (issue #32). */
  conflicts: number;
  tasks: Record<string, number>;
  quota: { readings: number; hard: number };
  conduct: Record<string, Record<string, number>>;
  supervision: Record<string, { turns: number | null; tokens: number | null; measuredTokens: number | null; knownTokenTurns: number; unknownTokenTurns: number }>;
  /** Per "peer route": model changes between consecutive decisions of a session, and the planner's verdicts (#197). */
  routes: Record<string, RouteSwitches>;
}

export interface RouteSwitches {
  decisions: number;
  /** Pins the planner started; 0 while stay_switch is off, when session boundaries are not recorded. */
  sessions: number;
  /** Decisions made without a session key: each looks like a new session, so sessions are unknown. */
  stateless: number;
  switches: number;
  toolLoopSwitches: number;
  planned: number;
  plannedInToolLoops: number;
  modes: string[];
}

export interface UsageCoverage {
  records: number;
  withUsage: number;
  withoutUsage: number;
  inputTokens: number;
  inputRecords: number;
  outputTokens: number;
  outputRecords: number;
  cacheReadTokens: number;
  cacheReadRecords: number;
  cacheWriteTokens: number;
  cacheWriteRecords: number;
  totalTokens: number;
  totalRecords: number;
}

export type UsageTotals = Omit<UsageCoverage, "records" | "withUsage" | "withoutUsage">;

const emptyUsage = (): UsageCoverage => ({ records: 0, withUsage: 0, withoutUsage: 0, inputTokens: 0, inputRecords: 0, outputTokens: 0, outputRecords: 0, cacheReadTokens: 0, cacheReadRecords: 0, cacheWriteTokens: 0, cacheWriteRecords: 0, totalTokens: 0, totalRecords: 0 });

function recordUsage(coverage: UsageCoverage, e: Extract<StampedEvent, { type: "usage" }>): void {
  coverage.records++;
  const fields = [e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens, e.totalTokens];
  if (fields.some((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) coverage.withUsage++;
  else coverage.withoutUsage++;
  const add = (field: keyof UsageTotals, n: number | undefined, countField: keyof UsageTotals) => {
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) {
      coverage[field] += n;
      coverage[countField]++;
    }
  };
  add("inputTokens", e.inputTokens, "inputRecords");
  add("outputTokens", e.outputTokens, "outputRecords");
  add("cacheReadTokens", e.cacheReadTokens, "cacheReadRecords");
  add("cacheWriteTokens", e.cacheWriteTokens, "cacheWriteRecords");
  add("totalTokens", e.totalTokens, "totalRecords");
}

function finalizeUsage(report: Report): void {
  for (const id of Object.keys(report.peers)) {
    if (!report.usage.peers[id]) {
      report.usage.peers[id] = emptyUsage();
      report.usage.unknownPeers.push(id);
    }
  }
  for (const p of Object.values(report.usage.peers)) {
    const out = report.usage.totals;
    for (const field of ["inputTokens", "inputRecords", "outputTokens", "outputRecords", "cacheReadTokens", "cacheReadRecords", "cacheWriteTokens", "cacheWriteRecords", "totalTokens", "totalRecords"] as const) out[field] += p[field];
    if (p.withoutUsage || p.inputRecords < p.withUsage || p.outputRecords < p.withUsage || p.cacheReadRecords < p.withUsage || p.cacheWriteRecords < p.withUsage || p.totalRecords < p.withUsage) report.usage.completeCoverage = false;
  }
  if (report.usage.unknownPeers.length) report.usage.completeCoverage = false;
}

function formatUsage(usage: Report["usage"]): string[] {
  const lines: string[] = [];
  for (const [id, u] of Object.entries(usage.peers).sort(([a], [b]) => a.localeCompare(b))) {
    const coverage = `${u.withUsage}/${u.records} records with usage`;
    const value = (name: string, count: number, records: number) => records ? `${name} ${count} (${records} known)` : `${name} unknown (0 known)`;
    const known = [value("input", u.inputTokens, u.inputRecords), value("output", u.outputTokens, u.outputRecords), value("cache read", u.cacheReadTokens, u.cacheReadRecords), value("cache write", u.cacheWriteTokens, u.cacheWriteRecords), value("reported total", u.totalTokens, u.totalRecords)].join(", ");
    const incomplete = u.withoutUsage || u.inputRecords < u.withUsage || u.outputRecords < u.withUsage || u.cacheReadRecords < u.withUsage || u.cacheWriteRecords < u.withUsage || u.totalRecords < u.withUsage;
    lines.push(`usage ${id}: ${u.records ? coverage : "no usage records"}; ${known}; coverage ${incomplete ? "incomplete" : u.records ? "complete for recorded calls" : "unknown"}`);
  }
  const total = usage.totals.totalRecords ? `${usage.totals.totalTokens} reported tokens (${usage.totals.totalRecords} known records)` : "reported token total unknown (0 known records)";
  const coverage = usage.completeCoverage ? "recorded-call coverage complete" : `incomplete or unknown peer coverage${usage.unknownPeers.length ? ` (${usage.unknownPeers.join(", ")})` : ""}`;
  lines.push(`usage team totals: ${total}; ${coverage}; estimated price unknown; measured spend unknown`);
  return lines;
}

/** The numbers `ahub report` prints, from `events.jsonl` alone (issue #40). */
export function summarize(events: StampedEvent[]): Report {
  const r: Report = { peers: {}, conduct: {}, supervision: {}, routes: {}, usage: { peers: {}, totals: { inputTokens: 0, inputRecords: 0, outputTokens: 0, outputRecords: 0, cacheReadTokens: 0, cacheReadRecords: 0, cacheWriteTokens: 0, cacheWriteRecords: 0, totalTokens: 0, totalRecords: 0 }, unknownPeers: [], completeCoverage: true }, messages: { total: 0, dropped: {}, overflow: 0, undeliverable: 0, perTask: 0 }, overlaps: { warnings: 0, pairs: 0 }, conflicts: 0, tasks: {}, quota: { readings: 0, hard: 0 } };
  const supervisor = (id: string) => (r.supervision[id] ??= { turns: null, tokens: null, measuredTokens: null, knownTokenTurns: 0, unknownTokenTurns: 0 });
  const peer = (id: string) => (r.peers[id] ??= { turns: 0, busyMinutes: 0, tokens: 0 });
  const claudeNativeStops = events.some(event => event.type === "native_turn_end" && event.peer === "claude" && !!event.id);
  const seenNativeStops = new Set<string>();
  const usagePeer = (id: string) => (r.usage.peers[id] ??= emptyUsage());
  const pairs = new Set<string>();
  const taskMessages = new Map<string, number>();
  const seenUsage = new Set<string>();
  const seenSupervision = new Set<string>();
  const lastTier = new Map<string, string>();
  for (const e of events) {
    r.from ??= e.at;
    r.to = e.at;
    switch (e.type) {
      case "conduct": {
        const actions = r.conduct[e.peer] ??= {};
        actions[e.action] = (actions[e.action] ?? 0) + 1;
        supervisor(e.peer);
        break;
      }
      case "supervision_turn": {
        const key = `${e.peer}\0${e.turn}`;
        if (seenSupervision.has(key)) break;
        seenSupervision.add(key);
        const s = supervisor(e.peer);
        s.turns = (s.turns ?? 0) + 1;
        if (typeof e.tokens === "number" && Number.isSafeInteger(e.tokens) && e.tokens >= 0) {
          s.measuredTokens = (s.measuredTokens ?? 0) + e.tokens;
          s.tokens = s.unknownTokenTurns ? null : s.measuredTokens;
          s.knownTokenTurns++;
        } else { s.unknownTokenTurns++; s.tokens = null; }
        break;
      }
      case "envelope":
        r.messages.total++;
        if (e.dropped) r.messages.dropped[e.dropped] = (r.messages.dropped[e.dropped] ?? 0) + 1;
        if (e.task) taskMessages.set(e.task, (taskMessages.get(e.task) ?? 0) + 1);
        break;
      case "overflow":
      case "undeliverable":
        r.messages[e.type]++;
        break;
      case "stale": // published, then dropped before delivery (issue #106)
        r.messages.dropped.stale = (r.messages.dropped.stale ?? 0) + 1;
        break;
      case "turn_end":
        if (e.peer !== "claude" || !claudeNativeStops) peer(e.peer).turns = (peer(e.peer).turns ?? 0) + 1;
        peer(e.peer).busyMinutes += e.ms / 60_000;
        break;
      case "native_turn_end":
        if (e.peer === "claude" && e.id) {
          if (seenNativeStops.has(e.id)) break;
          seenNativeStops.add(e.id);
          peer(e.peer).turns = (peer(e.peer).turns ?? 0) + 1;
        }
        break;
      case "state":
        peer(e.peer);
        break;
      case "tokens":
        peer(e.peer).tokens += e.n;
        break;
      case "usage": {
        const key = `${e.peer}\0${e.source}\0${e.id}`;
        if (seenUsage.has(key)) break;
        seenUsage.add(key);
        recordUsage(usagePeer(e.peer), e);
        break;
      }
      case "task":
        r.tasks[e.event] = (r.tasks[e.event] ?? 0) + 1;
        break;
      case "overlap":
        r.overlaps.warnings++;
        for (const o of e.others) pairs.add([e.task, o.task].sort((a, b) => a - b).join("-"));
        break;
      case "conflict":
        r.conflicts++;
        break;
      case "quota":
        r.quota.readings++;
        if (e.hard) r.quota.hard++;
        break;
      case "route": {
        // ponytail: consecutive decisions of one peer and route are taken as one session between pins; that holds while each
        // peer runs one session at a time (Pi, and local outside PII turns). An opaque session ordinal is the upgrade path.
        const key = `${e.peer} ${e.route}`;
        const s = (r.routes[key] ??= { decisions: 0, sessions: 0, stateless: 0, switches: 0, toolLoopSwitches: 0, planned: 0, plannedInToolLoops: 0, modes: [] });
        s.decisions++;
        if (e.staySwitch && !s.modes.includes(e.staySwitch)) s.modes.push(e.staySwitch);
        if (e.stateless) s.stateless++;
        if (e.reason === "new_pin" && !e.stateless) s.sessions++;
        else if (lastTier.has(key) && lastTier.get(key) !== e.tier) {
          s.switches++;
          if (e.turnType === "tool_result") s.toolLoopSwitches++;
        }
        lastTier.set(key, e.tier);
        if (e.plan === "switch") {
          s.planned++;
          if (e.turnType === "tool_result") s.plannedInToolLoops++;
        }
        break;
      }
    }
  }
  r.overlaps.pairs = pairs.size;
  finalizeUsage(r);
  // Pricing is intentionally absent: a token count is neither an estimated price nor provider-reported spend.
  r.messages.perTask = taskMessages.size ? Number(([...taskMessages.values()].reduce((a, b) => a + b, 0) / taskMessages.size).toFixed(1)) : 0;
  for (const p of Object.values(r.peers)) p.busyMinutes = Number(p.busyMinutes.toFixed(1));
  if (r.peers.claude) {
    const logical = events.some(event => event.type === "turn_end" && event.peer === "claude");
    r.peers.claude.turnSource = claudeNativeStops ? "native-stop" : logical ? "logical-state" : "unknown";
    if (!claudeNativeStops && !logical) r.peers.claude.turns = null;
  }
  return r;
}

export function formatReport(r: Report): string[] {
  const lines = [`period: ${r.from ?? "-"} .. ${r.to ?? "-"}`];
  for (const [id, p] of Object.entries(r.peers).sort(([a], [b]) => a.localeCompare(b))) {
    const turns = p.turns === null ? "turns unknown" : `${p.turns} turn${p.turns === 1 ? "" : "s"}${p.turnSource === "native-stop" ? " (native Stop)" : p.turnSource === "logical-state" ? " (logical state, native completion unobserved)" : ""}`;
    lines.push(`peer ${id}: ${turns}, ${p.busyMinutes} busy minutes, ${p.tokens ? `${p.tokens} tokens` : id === "pi" ? "tokens not reported" : "- tokens"}`);
  }
  if (Object.keys(r.usage.peers).length) lines.push(...formatUsage(r.usage));
  for (const [id, s] of Object.entries(r.supervision).sort(([a], [b]) => a.localeCompare(b))) {
    const turns = s.turns === null ? "turns unknown" : `${s.turns} completed native turns`;
    const tokens = s.tokens === null ? "tokens unknown" : `${s.tokens} tokens`;
    const measured = s.measuredTokens === null ? "measured subset unknown" : `${s.measuredTokens} measured tokens (${s.knownTokenTurns} known turns)`;
    lines.push(`supervision ${id}: ${turns}; ${tokens}; ${measured}; ${s.unknownTokenTurns} completed turns with unknown tokens; whole native turns containing supervision, including other work; estimated price unknown; measured spend unknown`);
  }
  for (const [id, actions] of Object.entries(r.conduct).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`conductor ${id}: ${Object.entries(actions).sort(([a], [b]) => a.localeCompare(b)).map(([action, n]) => `${action} ${n}`).join(", ")}`);
  }
  const dropped = Object.entries(r.messages.dropped).map(([k, n]) => `${n} ${k}`).join(", ");
  lines.push(`messages: ${r.messages.total} (dropped: ${dropped || "none"}; overflow ${r.messages.overflow}; undeliverable ${r.messages.undeliverable}); ${r.messages.perTask} per task that had any`);
  lines.push(`overlap warnings: ${r.overlaps.warnings}, task pairs: ${r.overlaps.pairs}; edit conflicts: ${r.conflicts}`);
  const tasks = Object.entries(r.tasks).sort().map(([k, n]) => `${k} ${n}`).join(", ");
  lines.push(`task events: ${tasks || "none"}`);
  lines.push(`quota readings: ${r.quota.readings} (${r.quota.hard} hard limits)`);
  for (const [key, s] of Object.entries(r.routes).sort(([a], [b]) => a.localeCompare(b))) {
    const sessions = s.stateless ? `sessions unknown (${s.stateless} decision${s.stateless === 1 ? "" : "s"} without a session key)`
      : s.sessions ? `${s.sessions} session${s.sessions === 1 ? "" : "s"}, ${(s.switches / s.sessions).toFixed(1)} model changes per session` : "sessions unknown (stay_switch off)";
    const planner = s.modes.length ? `; planner (${s.modes.join(", ")}): ${s.planned} switches, ${s.plannedInToolLoops} inside tool loops` : "";
    lines.push(`route ${key}: ${s.decisions} decisions, ${sessions}; ${s.switches} model change${s.switches === 1 ? "" : "s"}, ${s.toolLoopSwitches} inside tool loops${planner}`);
  }
  return lines;
}

const usageCounters = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;
const usageCounts = ["inputRecords", "outputRecords", "cacheReadRecords", "cacheWriteRecords", "totalRecords"] as const;
type TaskUsage = Omit<UsageCoverage, typeof usageCounters[number]> & Record<typeof usageCounters[number], number | null>;
export interface TaskPeerReport { tokens: number | null; usage: TaskUsage }
export interface TaskTotals { turns: number; peers: Record<string, TaskPeerReport> }
export interface TaskSummary extends TaskTotals { class: string | null; outcome: string | null; wallMs: number | null; pii?: true }
export interface TaskReport {
  from?: string;
  to?: string;
  tasks: Record<string, TaskSummary>;
  classes: Record<string, TaskTotals>;
  totals: { tokens: number; usageRecords: number };
  unattributed: TaskTotals & { tokens: number; usageRecords: number; tokenShare: number | null; usageShare: number | null };
  beforeAttribution: TaskTotals & { tokens: number; usageRecords: number };
}

const taskTotals = (): TaskTotals => ({ turns: 0, peers: {} });
const taskPeer = (group: TaskTotals, id: string): TaskPeerReport => group.peers[id] ??= {
  tokens: null, usage: { ...emptyUsage(), inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null },
};

function addTaskUsage(peer: TaskPeerReport, e: Extract<StampedEvent, { type: "usage" }>): void {
  const known = emptyUsage();
  recordUsage(known, e);
  const u = peer.usage;
  u.records += known.records; u.withUsage += known.withUsage; u.withoutUsage += known.withoutUsage;
  for (let i = 0; i < usageCounters.length; i++) {
    const field = usageCounters[i]!, count = usageCounts[i]!;
    if (known[count]) u[field] = (u[field] ?? 0) + known[field];
    u[count] += known[count];
  }
}

/** Task identities and history come only from telemetry. Historical usage is never reassigned. */
export function summarizeByTask(events: StampedEvent[]): TaskReport {
  const r: TaskReport = { tasks: {}, classes: {}, totals: { tokens: 0, usageRecords: 0 },
    unattributed: { ...taskTotals(), tokens: 0, usageRecords: 0, tokenShare: null, usageShare: null },
    beforeAttribution: { ...taskTotals(), tokens: 0, usageRecords: 0 } };
  const task = (id: number) => r.tasks[String(id)] ??= { ...taskTotals(), class: null, outcome: null, wallMs: null };
  const starts = new Map<number, number>(), approvals = new Map<number, number>();
  const seenUsage = new Set<string>();
  // Resolve latest class/outcome before rolling usage up: usage may precede the task's history in a slice.
  for (const e of events) {
    r.from ??= e.at; r.to = e.at;
    if (e.type !== "task") continue;
    const t = task(e.id);
    t.class = e.class; t.outcome = e.state;
    if (e.pii) t.pii = true;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    if (e.state === "in_progress" && !starts.has(e.id)) starts.set(e.id, at);
    if (e.state === "approved" && !approvals.has(e.id)) approvals.set(e.id, at);
  }
  for (const [id, t] of Object.entries(r.tasks)) {
    const start = starts.get(Number(id)), end = approvals.get(Number(id));
    if (t.outcome === "approved" && start !== undefined && end !== undefined && end >= start) t.wallMs = end - start;
    r.classes[t.class ?? "unknown"] ??= taskTotals();
  }
  for (const e of events) {
    if (e.type !== "tokens" && e.type !== "usage" && e.type !== "turn_end") continue;
    if (e.type === "usage") {
      const key = `${e.peer}\0${e.source}\0${e.id}`;
      if (seenUsage.has(key)) continue;
      seenUsage.add(key);
      r.totals.usageRecords++;
    } else if (e.type === "tokens") r.totals.tokens += e.n;
    let groups: TaskTotals[];
    if (e.attribution === undefined) {
      groups = [r.beforeAttribution];
      if (e.type === "tokens") r.beforeAttribution.tokens += e.n;
      if (e.type === "usage") r.beforeAttribution.usageRecords++;
    } else if (e.attribution === "unattributed" || e.task === undefined) {
      groups = [r.unattributed];
      if (e.type === "tokens") r.unattributed.tokens += e.n;
      if (e.type === "usage") r.unattributed.usageRecords++;
    } else {
      const t = task(e.task);
      if (e.pii) t.pii = true;
      groups = [t, r.classes[t.class ?? "unknown"] ??= taskTotals()];
    }
    for (const group of groups) {
      const p = taskPeer(group, e.peer);
      if (e.type === "turn_end") group.turns++;
      else if (e.type === "tokens") p.tokens = (p.tokens ?? 0) + e.n;
      else addTaskUsage(p, e);
    }
  }
  r.unattributed.tokenShare = r.totals.tokens ? r.unattributed.tokens / r.totals.tokens : null;
  r.unattributed.usageShare = r.totals.usageRecords ? r.unattributed.usageRecords / r.totals.usageRecords : null;
  return r;
}

export function formatTaskReport(r: TaskReport): string[] {
  const lines = [`period: ${r.from ?? "-"} .. ${r.to ?? "-"}`];
  const peers = (group: TaskTotals) => Object.entries(group.peers).sort(([a], [b]) => a.localeCompare(b)).map(([id, p]) => {
    const u = p.usage;
    const counts = usageCounters.map((field, i) => `${field} ${u[field] ?? "unknown"} (${u[usageCounts[i]!]}/${u.records} known)`).join(", ");
    return `  peer ${id}: tokens ${p.tokens ?? "unknown"}; ${counts}`;
  });
  for (const [id, t] of Object.entries(r.tasks).sort(([a], [b]) => Number(a) - Number(b))) {
    lines.push(`task #${id}${t.pii ? " [pii]" : ""}: class ${t.class ?? "unknown"}, outcome ${t.outcome ?? "unknown"}, turns ${t.turns}, wall ${t.wallMs === null ? "unknown" : `${t.wallMs} ms`}`, ...peers(t));
  }
  for (const [name, group] of Object.entries(r.classes).sort(([a], [b]) => a.localeCompare(b))) lines.push(`class ${name}: turns ${group.turns}`, ...peers(group));
  const share = (value: number | null) => value === null ? "unknown" : `${(value * 100).toFixed(1)}%`;
  lines.push(`unattributed: tokens ${r.unattributed.tokens}/${r.totals.tokens} (${share(r.unattributed.tokenShare)}), usage records ${r.unattributed.usageRecords}/${r.totals.usageRecords} (${share(r.unattributed.usageShare)}), turns ${r.unattributed.turns}`, ...peers(r.unattributed));
  lines.push(`before attribution: tokens ${r.beforeAttribution.tokens}, usage records ${r.beforeAttribution.usageRecords}, turns ${r.beforeAttribution.turns}`, ...peers(r.beforeAttribution));
  return lines;
}
