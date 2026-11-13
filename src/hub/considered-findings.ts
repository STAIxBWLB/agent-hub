import { surveyArray, surveyObject, surveyPass, surveyPath, surveyFindingId, surveyText, type SurveyPass } from "./advisor-survey.ts";
import { positionalFindingId } from "./review-findings.ts";

export interface ConsideredEntry {
  repo: string; id: string; pass: SurveyPass; paths: string[]; reason: string; ref?: string;
  source: { task: number; created: number; kind: "review" | "audit" | "survey" }; withheld?: true;
}
export interface ConsideredDiff { repo: string; base: string; head: string; complete: boolean; paths: readonly string[] }
export interface ConsideredMatch { status: "applicable" | "changed" | "unknown" | "different"; applicablePaths: string[] }
const invalid = (): never => { throw new Error("invalid considered finding"); };
const sha = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : invalid();
const integer = (value: unknown, min: number): number => typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : invalid();
export function parseConsideredEntry(input: unknown): ConsideredEntry {
  const row = surveyObject(input, ["repo", "id", "pass", "paths", "reason", "ref", "source", "withheld"]);
  const source = surveyObject(row.source, ["task", "created", "kind"]), paths = surveyArray(row.paths, 64).map(surveyPath);
  if (new Set(paths).size !== paths.length || row.withheld !== undefined && row.withheld !== true
    || source.kind !== "review" && source.kind !== "audit" && source.kind !== "survey") return invalid();
  const entry: ConsideredEntry = { repo: surveyText(row.repo, 1024), id: surveyFindingId(row.id), pass: surveyPass(row.pass), paths,
    reason: surveyText(row.reason), ...(row.ref === undefined ? {} : { ref: sha(row.ref) }), source: { task: integer(source.task, 1), created: integer(source.created, 0), kind: source.kind },
    ...(row.withheld === true ? { withheld: true } : {}) };
  if (Buffer.byteLength(JSON.stringify(entry)) > 64 * 1024) return invalid();
  return entry;
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
/** Host supplies the complete base-to-current changed-name inventory. Unknown is never unchanged. */
export function consideredFindingMatch(input: unknown, context: { repo: string; id: string; pass: SurveyPass; currentRef: string; diff?: ConsideredDiff }): ConsideredMatch {
  const entry = parseConsideredEntry(input), different: ConsideredMatch = { status: "different", applicablePaths: [] }, unknown: ConsideredMatch = { status: "unknown", applicablePaths: [] };
  if (entry.repo !== context.repo || entry.id !== context.id || entry.pass !== context.pass || positionalFindingId(entry.id) || positionalFindingId(context.id)) return different;
  try {
    sha(context.currentRef);
    if (!entry.ref || !entry.paths.length) return unknown;
    if (entry.ref === context.currentRef) return { status: "applicable", applicablePaths: [...entry.paths] };
    const diff = surveyObject(context.diff, ["repo", "base", "head", "complete", "paths"]);
    if (diff.repo !== entry.repo || diff.base !== entry.ref || diff.head !== context.currentRef || diff.complete !== true) return unknown;
    const paths = surveyArray(diff.paths, 1000).map(surveyPath);
    if (new Set(paths).size !== paths.length) return unknown;
    const applicablePaths = entry.paths.filter(path => !paths.some(changed => overlaps(path, changed)));
    return { status: applicablePaths.length ? "applicable" : "changed", applicablePaths };
  } catch { return unknown; }
}
/** Historical records remain immutable; this projection grants no rejection or admission authority. */
export function publicConsideredEntry(input: unknown, status: ConsideredMatch["status"]) {
  const entry = parseConsideredEntry(input);
  if (entry.withheld || entry.pass === "security") return { id: entry.id, status, rejectedBefore: true as const };
  const { repo: _internalScope, ...publicEntry } = entry;
  return { ...publicEntry, status, rejectedBefore: true as const };
}
