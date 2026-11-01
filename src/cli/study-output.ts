// Human output for `ahub study draft|revise|approve|approve-protocol|close|show`. Pure: the hub's parsed JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
// A campaign is named by ids, revisions, states and counts. The hub already stubs private campaigns, tasks and sources; this file never asks for a question, scope, path or excerpt.
import { blank, grid, heading, pair, s } from "./sdlc-output.ts";
import type { Span, Tone } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const STATUS_TONE: Record<string, Tone | undefined> = { approved: undefined, draft: "attention", superseded: "muted", closed: "muted" };

/** `ahub study show` with no id: one page of campaigns of this project, with the command that continues it when the hub says there is more. */
export function renderStudyList(page: unknown, columns?: number): Span[][] {
  const campaigns = list((page as any)?.campaigns), next = typeof (page as any)?.next === "string" ? (page as any).next as string : undefined;
  if (!campaigns.length) return [[s("no research campaigns in this project; a planner or you draft one with `ahub study draft <parent> <contract.json>`", "muted")]];
  const out: Span[][] = [...heading(`Research campaigns (${campaigns.length}${next ? ", more follow" : ""})`, columns)];
  out.push(...grid(["ID", "REV", "STATUS", "PARENT", "UNITS"], campaigns.map((row: any) => [
    s(row.id, "issueRef"), s(`r${count(row.revision)}`), s(row.status, STATUS_TONE[row.status]), s(`#${count(row.parentTaskId)}`, "taskRef"), s(count(row.unitCount)),
  ]), columns));
  if (next) out.push(blank, [s(`more campaigns: ahub study show --after ${next}`, "muted")]);
  return out;
}

const SUPPORT_TONE: Record<string, Tone | undefined> = { enforceable: undefined, supported: undefined, advisory: "muted", unavailable: "attention", unsupported: "attention", unknown: "attention" };

/** `ahub study show <id>`: the coverage and stop projection the hub computed. Held work is said first, with every reason. */
export function renderStudyShow(projection: unknown, columns?: number): Span[][] {
  const p = projection as any, units = list(p?.units), rounds = list(p?.discoveryRounds), reasons = list(p?.reasons);
  const out: Span[][] = [...heading(`Research campaign ${p?.id ?? "?"}, revision ${count(p?.revision)}${p?.held ? ", dispatch HELD" : ""}`, columns)];
  for (const reason of reasons) out.push(...pair("held", reason, columns, 8, "attention"));
  if (p?.sharedPeerLedger) out.push(...pair("budget", "one run ledger is shared by the peers", columns, 8, "muted"));
  if (rounds.length) out.push(...pair("rounds", rounds.map((round: any) => `${count(round.round)}: ${round.complete ? "discovery complete" : "discovery open"}`).join(", "), columns, 8));
  out.push(blank);
  if (!units.length) return [...out, [s("no units", "muted")]];
  out.push(...grid(["UNIT", "ROUND", "TASK", "STATE", "PURPOSE", "HANDOFF", "SOURCES"], units.map((unit: any) => {
    const handoff = unit.handoff ?? {};
    const evidence = handoff.insufficientEvidence ? "insufficient evidence" : handoff.complete ? "complete" : handoff.present ? "incomplete" : "none";
    const covered = list(unit.sourceIds).length;
    const note = [unit.intentionalIndependentCheck ? "independent check" : "", list(unit.duplicateSourceIds).length ? `${list(unit.duplicateSourceIds).length} duplicated` : ""].filter(Boolean).join(", ");
    return [s(unit.unitId, "issueRef"), s(count(unit.round)), s(unit.taskId == null ? "-" : `#${unit.taskId}`, "taskRef"), s(unit.state), s(unit.purpose), s(evidence, handoff.complete || handoff.insufficientEvidence ? undefined : "attention"),
      s(covered ? `${list(handoff.coveredSourceIds).length}/${covered} covered${note ? `, ${note}` : ""}` : note || "-", "muted")];
  }), columns));
  // Every resource of a unit is shown whenever the campaign names a budget, with its support state: a limit the ledger does not carry (`null`) is a placeholder, not a reason to hide a row that says
  // `unavailable` or `advisory`. A campaign that names no budget has nothing to say (its `tokens` row reads `unavailable` whatever the ledger is), so the hub's `budgetNamed` decides, not the values.
  const budgeted = units.flatMap((unit: any) => Object.entries(unit.budget ?? {}).filter(([, value]: [string, any]) => value && typeof value === "object").map(([name, value]: [string, any]) => ({ unit: unit.unitId, name, value })));
  if (budgeted.length && p?.budgetNamed === true) {
    out.push(blank, ...heading("Budget", columns));
    out.push(...grid(["UNIT", "RESOURCE", "SUPPORT", "USED", "LIMIT"], budgeted.map(({ unit, name, value }) => [
      s(unit, "issueRef"), s(name), s(value.support, SUPPORT_TONE[value.support]), s(value.used === null || value.used === undefined ? "-" : value.used), s(value.limit === null || value.limit === undefined ? "-" : value.limit),
    ]), columns));
  }
  return out;
}

const VERB: Record<string, string> = { draft: "drafted", revise: "drafted as the next revision", approve: "approved", close: "closed" };

/** The receipt of a draft, revision, approval or close. */
export function renderStudyReceipt(op: string, receipt: unknown, columns?: number): Span[][] {
  const r = receipt as any, units = list(r?.units);
  if (op === "approve_protocol") {
    const hash = (value: unknown) => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value) ? value : "unknown";
    const by = typeof r?.approvedBy === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(r.approvedBy) ? r.approvedBy : "unknown";
    const at = typeof r?.approvedAt === "number" && Number.isFinite(r.approvedAt) && r.approvedAt >= 0 && r.approvedAt <= 8_640_000_000_000_000
      ? new Date(r.approvedAt).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "unknown";
    return [...heading("Research protocol approval", columns), ...pair("protocol hash", hash(r?.protocolHash), columns, 16),
      ...pair("evaluator hash", hash(r?.evaluatorHash), columns, 16), ...pair("approved by", by, columns, 16), ...pair("approved at", at, columns, 16)];
  }
  const out: Span[][] = [...heading(`Research campaign ${r?.id ?? "?"} revision ${count(r?.revision)} ${VERB[op] ?? op}`, columns)];
  out.push(...pair("status", r?.status, columns, 8, STATUS_TONE[r?.status]), ...pair("parent", `#${count(r?.parentTaskId)}`, columns, 8, "taskRef"), ...pair("units", count(r?.unitCount), columns, 8));
  if (units.length) out.push(blank, ...grid(["UNIT", "TASK", "ROUND"], units.map((unit: any) => [s(unit.unitId, "issueRef"), s(`#${count(unit.taskId)}`, "taskRef"), s(count(unit.round))]), columns));
  if (op === "draft" || op === "revise") out.push(blank, [s(`nothing is dispatched until you approve: ahub study approve ${r?.id} ${count(r?.revision)}`, "muted")]);
  return out;
}

const ATTEMPT_TONE: Record<string, Tone | undefined> = { succeeded: undefined, running: undefined, declared: "muted", failed: "attention", cancelled: "attention", unknown: "attention" };
const PROVENANCE_TONE: Record<string, Tone | undefined> = { declared: "muted", unknown: "attention" };
const clip = (text: string, max = 48) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
/** A value cell: the value and where it came from, so a declared number never reads as an observed one. Anything the hub withheld prints as the hub wrote it. */
const sourced = (cell: any): [string, string] => {
  if (cell === "[pii]") return ["[pii]", "withheld"];
  if (!cell || typeof cell !== "object" || !("provenance" in cell)) return ["-", "unknown"];
  const value = cell.value === null || cell.value === undefined ? "-" : typeof cell.value === "object" ? "(structured)" : String(cell.value);
  return [clip(value), String(cell.provenance)];
};

/**
 * `ahub study experiments`: the attempts of one campaign, one attempt, or one baseline/variant comparison, as the hub's `Tasks.experimentShow` returned them. Pure: it reads no file, runs
 * no command and asks for no protocol text. Every row says whether it is approved, post-hoc or predeclared and that a repeat is not an independent reproduction; every value says where it
 * came from; failed, cancelled and unknown attempts are in the counts. A private record arrives from the hub already as ids, counts and states.
 */
export function renderExperiments(view: unknown, columns?: number): Span[][] {
  const v = view as any, attempts = list(v?.attempts), counts = v?.counts ?? {}, statuses = counts.statuses ?? {};
  const out: Span[][] = [...heading(`Experiment attempts (${attempts.length} of ${count(counts.all)} in this campaign${v?.nextCursor !== undefined ? ", more follow" : ""})`, columns)];
  const order = ["declared", "running", "succeeded", "failed", "cancelled", "unknown"];
  out.push(...pair("all", order.map(name => `${name} ${count(statuses[name])}`).join(", "), columns, 8, "muted"));
  if (v?.comparison) {
    const c = v.comparison, compat = c.projection?.compatibility;
    out.push(blank, ...heading("Comparison", columns));
    if (c.projection === "[pii]") out.push(...pair("plan", `${String(c.planHash).slice(0, 12)}: withheld (a private source or record)`, columns, 8, "attention"));
    else {
      out.push(...pair("plan", String(c.planHash).slice(0, 12), columns, 8));
      out.push(...pair("compatible", compat?.compatible ? "yes, under this plan" : `no: ${compat?.field ?? "unknown"} differs (${compat?.side ?? "pair"}); shown, not ranked together`, columns, 8, compat?.compatible ? undefined : "attention"));
    }
    out.push(...pair("approved", c.approved ? "both protocols bound to a person's approval" : "not both approved", columns, 8, c.approved ? undefined : "attention"));
    out.push(...pair("pair", `${c.baselineAttemptId} (baseline) and ${c.variantAttemptId} (variant)`, columns, 8, "muted"));
  }
  if (!attempts.length) return [...out, blank, [s("no attempts recorded", "muted")]];
  out.push(blank, ...grid(["ATTEMPT", "TASK", "PHASE", "STATUS", "APPROVAL", "POST-HOC", "NOTE"], attempts.map((row: any) => [
    s(row.id, "issueRef"), s(`#${count(row.taskId)}`, "taskRef"), s(row.phase), s(row.status, ATTEMPT_TONE[row.status]), s(row.approval, row.approval === "approved" ? undefined : "attention"), s(row.postHoc, row.postHoc === "post-hoc" ? "attention" : "muted"),
    s([row.private ? "private, details withheld" : "", row.retryOf ? `retry of ${row.retryOf}` : "", row.reproducesAttemptId ? `repeat of ${row.reproducesAttemptId}, not independent` : "", row.eventsComplete === false ? "events continue" : ""].filter(Boolean).join("; ") || "-", "muted"),
  ]), columns));
  for (const row of attempts) {
    if (row.private) continue;
    const declared = row.evidence?.declared, metrics = list(declared?.metrics), measured = list(row.evidence?.measured), runners = list(row.evidence?.runnerAttested);
    const lines: [string, string, string][] = [];
    for (const metric of metrics) { const [value, from] = sourced(metric.latest); lines.push([`${metric.name} (${metric.unit})`, value, from]); }
    for (const field of ["exitStatus", "startedAt"]) { const [value, from] = sourced(declared?.[field]); if (value !== "-") lines.push([field, value, from]); }
    for (const m of measured) for (const [field, cell] of Object.entries(m.values ?? {})) { const [value, from] = sourced(cell); lines.push([`${field} (${m.source})`, value, from]); }
    for (const r of runners) { const [value, from] = sourced(r.sealing); lines.push([`sealed (runner ${clip(String(r.runner), 24)})`, value, from]); const [match, matchFrom] = sourced(r.codeMatch); lines.push(["code matches protocol", match, matchFrom]); }
    const [sealed, sealedFrom] = sourced(declared?.sealed);
    if (!runners.length) lines.push(["sealed", sealed, `${sealedFrom}; isolation unverified`]);
    if (!lines.length) continue;
    out.push(blank, ...heading(`Evidence of ${row.id}`, columns), ...grid(["FIELD", "VALUE", "SOURCE"], lines.map(([field, value, from]) => [s(field), s(value), s(from, PROVENANCE_TONE[from] ?? (from.startsWith("declared") ? "muted" : undefined))]), columns));
  }
  out.push(blank, [s(`declared values are an agent's own words; only host-observed, runner-attested or person-attested rows are evidence, and none of them proves the science. A repeat is never an independent reproduction.`, "muted")]);
  if (v?.nextCursor !== undefined) out.push([s(`more attempts: ahub study experiments --campaign <id> --after ${v.nextCursor}`, "muted")]);
  for (const row of attempts) if (row.eventsComplete === false && row.nextEventCursor !== undefined) out.push([s(`more events of ${row.id}: ahub study experiments --attempt ${row.id} --events-after ${row.nextEventCursor}; the values above come from the events shown so far`, "attention")]);
  return out;
}
