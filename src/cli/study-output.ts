// Human output for `ahub study draft|revise|approve|close|show` (#601). Pure: the hub's parsed JSON in, spans out, no I/O. `--json` is the caller's branch and prints the same text.
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
  const out: Span[][] = [...heading(`Research campaign ${r?.id ?? "?"} revision ${count(r?.revision)} ${VERB[op] ?? op}`, columns)];
  out.push(...pair("status", r?.status, columns, 8, STATUS_TONE[r?.status]), ...pair("parent", `#${count(r?.parentTaskId)}`, columns, 8, "taskRef"), ...pair("units", count(r?.unitCount), columns, 8));
  if (units.length) out.push(blank, ...grid(["UNIT", "TASK", "ROUND"], units.map((unit: any) => [s(unit.unitId, "issueRef"), s(`#${count(unit.taskId)}`, "taskRef"), s(count(unit.round))]), columns));
  if (op === "draft" || op === "revise") out.push(blank, [s(`nothing is dispatched until you approve: ahub study approve ${r?.id} ${count(r?.revision)}`, "muted")]);
  return out;
}
