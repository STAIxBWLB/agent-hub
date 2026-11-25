// Human output for `ahub study draft|revise|approve|approve-protocol|close|show`. Pure: the hub's parsed JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
// A campaign is named by ids, revisions, states and counts. The hub already stubs private campaigns, tasks and sources; this file never asks for a question, scope, path or excerpt.
import { grid, s } from "./sdlc-output.ts";
import { Report, terminalText, wrap, type Span, type Tone } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const STATUS_TONE: Record<string, Tone | undefined> = { approved: undefined, draft: "attention", superseded: "muted", closed: "muted" };

/** `ahub study show` with no id: one page of campaigns of this project, with the command that continues it when the hub says there is more. */
export function renderStudyList(page: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const campaigns = list((page as any)?.campaigns), next = typeof (page as any)?.next === "string" ? (page as any).next as string : undefined;
  if (!campaigns.length) return [[s("no research campaigns in this project; a planner or you draft one with `ahub study draft <parent> <contract.json>`", "muted")]];
  const out = new Report(columns, ascii).titled("ahub", `Research campaigns (${campaigns.length}${next ? ", more follow" : ""})`);
  out.section("Campaigns", String(campaigns.length)).append(grid(["ID", "REV", "STATUS", "PARENT", "UNITS"], campaigns.map((row: any) => [
    s(row.id, "issueRef"), s(`r${count(row.revision)}`), s(row.status, STATUS_TONE[row.status]), s(`#${count(row.parentTaskId)}`, "taskRef"), s(count(row.unitCount)),
  ]), columns));
  if (next) out.note(`more campaigns: ahub study show --after ${next}`);
  return out.lines();
}

const SUPPORT_TONE: Record<string, Tone | undefined> = { enforceable: undefined, supported: undefined, advisory: "muted", unavailable: "attention", unsupported: "attention", unknown: "attention" };

/** `ahub study show <id>`: the coverage and stop projection the hub computed. Held work is said first, with every reason. */
export function renderStudyShow(projection: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const p = projection as any, units = list(p?.units), rounds = list(p?.discoveryRounds), reasons = list(p?.reasons);
  const out = new Report(columns, ascii).titled("ahub", `Research campaign ${p?.id ?? "?"}, revision ${count(p?.revision)}${p?.held ? ", dispatch HELD" : ""}`);
  for (const reason of reasons) out.bullet("warn", `held: ${terminalText(reason)}`);
  const facts: [string, unknown][] = [];
  if (p?.sharedPeerLedger) facts.push(["budget", "one run ledger is shared by the peers"]);
  if (rounds.length) facts.push(["rounds", rounds.map((round: any) => `${count(round.round)}: ${round.complete ? "discovery complete" : "discovery open"}`).join(", ")]);
  if (facts.length) out.section("Campaign").kv(facts);
  if (!units.length) return out.note("no units").lines();
  out.section("Units", String(units.length)).append(grid(["UNIT", "ROUND", "TASK", "STATE", "PURPOSE", "HANDOFF", "SOURCES"], units.map((unit: any) => {
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
    out.section("Budget", String(budgeted.length)).append(grid(["UNIT", "RESOURCE", "SUPPORT", "USED", "LIMIT"], budgeted.map(({ unit, name, value }) => [
      s(unit, "issueRef"), s(name), s(value.support, SUPPORT_TONE[value.support]), s(value.used === null || value.used === undefined ? "-" : value.used), s(value.limit === null || value.limit === undefined ? "-" : value.limit),
    ]), columns));
  }
  return out.lines();
}

const VERB: Record<string, string> = { draft: "drafted", revise: "drafted as the next revision", approve: "approved", close: "closed" };

/** The receipt of a draft, revision, approval or close. */
export function renderStudyReceipt(op: string, receipt: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const r = receipt as any, units = list(r?.units);
  if (op === "approve_protocol") {
    const hash = (value: unknown) => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value) ? value : "unknown";
    const by = typeof r?.approvedBy === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(r.approvedBy) ? r.approvedBy : "unknown";
    const at = typeof r?.approvedAt === "number" && Number.isFinite(r.approvedAt) && r.approvedAt >= 0 && r.approvedAt <= 8_640_000_000_000_000
      ? new Date(r.approvedAt).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "unknown";
    return new Report(columns, ascii).titled("ahub", "Research protocol approval").section("Approval").kv([["protocol hash", hash(r?.protocolHash)], ["evaluator hash", hash(r?.evaluatorHash)], ["approved by", by], ["approved at", at]]).lines();
  }
  const out = new Report(columns, ascii).titled("ahub", `Research campaign ${r?.id ?? "?"} revision ${count(r?.revision)} ${VERB[op] ?? op}`);
  out.section("Campaign").kv([["status", terminalText(r?.status ?? "")], ["parent", `#${count(r?.parentTaskId)}`], ["units", count(r?.unitCount)]]);
  if (units.length) out.section("Units", String(units.length)).append(grid(["UNIT", "TASK", "ROUND"], units.map((unit: any) => [s(unit.unitId, "issueRef"), s(`#${count(unit.taskId)}`, "taskRef"), s(count(unit.round))]), columns));
  if (op === "draft" || op === "revise") out.note(`nothing is dispatched until you approve: ahub study approve ${r?.id} ${count(r?.revision)}`);
  return out.lines();
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
export function renderExperiments(view: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const v = view as any, attempts = list(v?.attempts), counts = v?.counts ?? {}, statuses = counts.statuses ?? {};
  const out = new Report(columns, ascii).titled("ahub", `Experiment attempts (${attempts.length} of ${count(counts.all)} in this campaign${v?.nextCursor !== undefined ? ", more follow" : ""})`);
  const order = ["declared", "running", "succeeded", "failed", "cancelled", "unknown"];
  out.section("Counts").kv([["all", order.map(name => `${name} ${count(statuses[name])}`).join(", ")]]);
  if (v?.comparison) {
    const c = v.comparison, compat = c.projection?.compatibility;
    out.section("Comparison");
    const rows: [string, unknown][] = [];
    if (c.projection === "[pii]") rows.push(["plan", `${String(c.planHash).slice(0, 12)}: withheld (a private source or record)`]);
    else {
      rows.push(["plan", String(c.planHash).slice(0, 12)]);
      rows.push(["compatible", compat?.compatible ? "yes, under this plan" : `no: ${compat?.field ?? "unknown"} differs (${compat?.side ?? "pair"}); shown, not ranked together`]);
    }
    rows.push(["approved", c.approved ? "both protocols bound to a person's approval" : "not both approved"], ["pair", `${c.baselineAttemptId} (baseline) and ${c.variantAttemptId} (variant)`]);
    out.kv(rows);
    if (c.projection === "[pii]") out.bullet("warn", "comparison withheld");
    else if (!compat?.compatible) out.bullet("warn", "not compatible: shown, not ranked together");
    if (!c.approved) out.bullet("warn", "not both approved");
  }
  if (!attempts.length) return out.note("no attempts recorded").lines();
  out.section("Attempts", String(attempts.length)).append(grid(["ATTEMPT", "TASK", "PHASE", "STATUS", "APPROVAL", "POST-HOC", "NOTE"], attempts.map((row: any) => [
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
    out.section(`Evidence of ${row.id}`, String(lines.length)).append(grid(["FIELD", "VALUE", "SOURCE"], lines.map(([field, value, from]) => [s(field), s(value), s(from, PROVENANCE_TONE[from] ?? (from.startsWith("declared") ? "muted" : undefined))]), columns));
  }
  // A flush-left paragraph, as before: the fixture tests filter it out by its first words, because it names the stronger sources it warns about.
  out.append(wrap(`declared values are an agent's own words; only host-observed, runner-attested or person-attested rows are evidence, and none of them proves the science. A repeat is never an independent reproduction.`, columns ?? Infinity, 0).map(line => [s(line, "muted")]));
  if (v?.nextCursor !== undefined) out.note(`more attempts: ahub study experiments --campaign <id> --after ${v.nextCursor}`);
  for (const row of attempts) if (row.eventsComplete === false && row.nextEventCursor !== undefined) { out.bullet("warn", `more events of ${row.id}: ahub study experiments --attempt ${row.id} --events-after ${row.nextEventCursor}`); out.note("the values above come from the events shown so far", "value"); }
  return out.lines();
}


/** Screened passage or declared manifest-authoring metadata, never an entailment/quality claim. */
export function renderStudyEvidence(value: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const v = value as any;
  if (v?.status !== "resolved" && v?.status !== "available") return new Report(columns, ascii).header("ahub", "Evidence").bullet("warn", `Evidence ${v?.status ?? "unavailable"}; use a visible research task and current public evidence`).lines();
  const out = new Report(columns, ascii).titled("ahub", v.status === "resolved" ? `Evidence ${v.id} r${v.revision}` : `Declared evidence inventory, task ${v.taskId}`);
  if (v.status === "resolved") {
    out.section("Evidence").kv([["status", "resolved provenance only; no entailment or source-quality certification"], ["source", v.link?.sourceId], ["scalars", `${v.locator?.start}..${v.locator?.end}`], ["passage", v.excerpt]]);
  } else {
    out.section("Inventory").kv([["incarnation", v.taskCreated], ...list(v.deliverables).map((artifact: any): [string, unknown] => ["artifact", `${artifact.id} ${artifact.format} ${artifact.sha256}`])]);
    for (const claim of list(v.claims)) {
      out.section(`Claim ${terminalText(claim.claimId)}`).kv([["claim", `${claim.claimId} @ ${claim.claimRevision}`],
        ["inventory", claim.complete && claim.inventory ? `r${claim.inventory.revision} ${claim.inventory.sha256}` : "unknown/incomplete: obtain complete inventory before checking"],
        ...list(claim.evidence).map((link: any): [string, unknown] => ["link", `${link.id} r${link.revision} ${link.status}`])]);
    }
    out.note("Declared bindings only. Select citation mappings in a synthesis manifest; invoke ahub study check explicitly.");
  }
  return out.lines();
}

const SYNTHESIS_NEXT: Record<string, string> = {
  refresh_manifest: "refresh claim, link, inventory and artifact bindings in the manifest",
  provide_artifact: "register unchanged public Markdown/BibTeX deliverables through the existing deliverable workflow",
  repair_citations: "repair declared Markdown citation keys and their BibTeX entries",
  record_evidence: "record current claim evidence with hub_evidence_record",
  resolve_locator: "inspect ahub study evidence for current public registered projection/locator provenance",
  record_person_judgment: "a person records the claim's verdict with ahub task claim; model labels do not count",
  resolve_contradiction: "a person adjudicates or explicitly qualifies the current manifest-bound conclusion",
  read_complete_inventory: "obtain a complete readable inventory; split oversized tasks or repair stored evidence before retrying",
  complete_manifest_claims: "include every current declared task claim in the manifest",
};
export function renderSynthesisReadiness(value: unknown, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const v = value as any;
  const out = new Report(columns, ascii).titled("ahub", `Synthesis ${v?.status ?? "unavailable"}`);
  if (v?.status === "private") return out.bullet("warn", "Readiness withheld by current task/source/artifact privacy; no research content is disclosed.").lines();
  if (!v?.scope) {
    const reason = v?.cause === "source_input_limit" ? "Source input exceeds this bounded check; split the synthesis into smaller tasks."
      : "Inputs or policy changed/unavailable; refresh current public bindings and run ahub study check again.";
    return out.bullet("warn", reason).lines();
  }
  out.section("Readiness").kv([["scope", "structural/provenance only; not truth, entailment or source-quality verification"], ...["manifestSha256", "binding", "claimCoverage", "deliverable", "bibliography"].map((key): [string, unknown] => [key, v[key]]),
    ["citations", `${v.citations?.state} (cited ${v.citations?.cited ?? "unknown"}, missing ${v.citations?.missing ?? "unknown"})`]]);
  for (const claim of list(v.claims)) out.section(`Claim ${terminalText(claim.claimId)}`).kv(["claim", "inventory", "citationKey", "evidenceLink", "locator", "provenance", "judgment", "personVerdict", "contradictionHistory", "contradiction"].map((key): [string, unknown] => [key, claim[key]]));
  for (const next of list(v.next)) out.bullet("warn", `next: ${SYNTHESIS_NEXT[next] ?? "inspect the current manifest bindings"}`);
  return out.lines();
}
