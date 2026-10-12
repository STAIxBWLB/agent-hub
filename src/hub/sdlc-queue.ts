import type { PhaseView } from "./workflow.ts";
import { readSdlcPr, sdlcGh, sdlcStatus, type PrEvidence, type SdlcConfig, type SdlcGh, type SdlcReceipt } from "./sdlc.ts";
export interface DeliveryTask { id: number; after: number[]; private: boolean; receipt?: SdlcReceipt; phase?: PhaseView; }
export interface MergeQueueRow { pr: number; tasks: number[]; head?: string; private?: true; ready: boolean; blockers: string[]; after: number[]; }
export interface MergeConflict { left: number; right: number; files: number; order: "dependency" | "person_required"; }
export interface MergeQueue { repo: string; rows: MergeQueueRow[]; order: number[]; conflicts: MergeConflict[]; complete: boolean; truncated: boolean; }
const validRepo = (value: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith("-");
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** Fixed metadata-only reads; local claims and unknown dependency evidence never become merge approval. */
export async function readMergeQueue(repo: string, config: SdlcConfig, tasks: DeliveryTask[], run: SdlcGh = sdlcGh): Promise<MergeQueue> {
  if (!validRepo(repo)) throw new Error("merge queue requires owner/repository");
  const result: MergeQueue = { repo, rows: [], order: [], conflicts: [], complete: false, truncated: false };
  const deadline = performance.now() + 20_000;
  const bounded: SdlcGh = args => { const remaining = deadline - performance.now(); return remaining > 0 ? run(args, Math.min(10_000, remaining)) : Promise.resolve({ code: 1, stdout: "" }); };
  const list = await bounded(["pr", "list", "--repo", repo, "--state", "open", "--limit", "17", "--json", "number"]);
  let ids: number[];
  try { const data = JSON.parse(list.stdout); if (list.code !== 0 || !Array.isArray(data) || data.length > 17 || data.some(p => !validId(p?.number)) || new Set(data.map(p => p.number)).size !== data.length) return result; ids = data.map(p => p.number).sort((a, b) => a - b); }
  catch { return result; }
  result.truncated = ids.length > 16; ids = ids.slice(0, 16);
  const evidence = new Map<number, PrEvidence>(), links = new Map<number, DeliveryTask[]>();
  for (const pr of ids) {
    const holders = tasks.filter(t => t.receipt?.repo === repo && t.receipt.pr === pr); links.set(pr, holders);
    const row: MergeQueueRow = { pr, tasks: holders.map(t => t.id), ready: false, blockers: [], after: [] }; result.rows.push(row);
    if (holders.some(t => t.private)) { row.private = true; row.blockers.push("private lifecycle evidence unavailable"); continue; }
    const read = await readSdlcPr(holders[0]?.receipt ?? { stage: config.stages[0] ?? "spec", repo, pr }, bounded);
    if (!read || read.state !== "OPEN") { row.blockers.push("current PR evidence unknown or no longer open"); continue; }
    evidence.set(pr, read); row.head = read.head;
    if (!read.pathsComplete) row.blockers.push("PR file coverage is incomplete or unknown");
    if (read.draft !== false) row.blockers.push("PR is draft or draft status is unknown");
    if (!read.base) row.blockers.push("PR target branch is unknown");
    const linked = holders.length ? holders : [undefined];
    for (const holder of linked) row.blockers.push(...sdlcStatus(config, holder?.receipt, read, holder?.phase).blockers);
  }
  const dependencyEvidence = new Map<number, PrEvidence | undefined>(); let dependencyReads = 0;
  for (const row of result.rows) {
    if (row.private) continue;
    for (const holder of links.get(row.pr) ?? []) for (const id of holder.after) {
      const dependency = tasks.find(t => t.id === id);
      if (!dependency || dependency.private || dependency.receipt?.repo !== repo || !validId(dependency.receipt.pr)) { row.blockers.push("dependency merge evidence unknown or private"); continue; }
      const pr = dependency.receipt.pr;
      if (pr === row.pr) continue; // task dependency within this same artifact
      if (ids.includes(pr)) { row.after.push(pr); row.blockers.push("dependency PR is still open"); continue; }
      if (!dependencyEvidence.has(pr) && dependencyReads < 8) { dependencyReads++; dependencyEvidence.set(pr, await readSdlcPr(dependency.receipt, bounded)); }
      const read = dependencyEvidence.get(pr);
      if (!read || read.state !== "MERGED" || !read.mergeCommit) row.blockers.push("dependency PR merge is not verified");
    }
    row.after = [...new Set(row.after)].sort((a, b) => a - b);
  }
  const reaches = (from: number, target: number, seen = new Set<number>()): boolean => {
    if (seen.has(from)) return false; seen.add(from);
    return (result.rows.find(r => r.pr === from)?.after ?? []).some(before => before === target || reaches(before, target, seen));
  };
  for (let i = 0; i < result.rows.length; i++) for (const right of result.rows.slice(i + 1)) {
    const left = result.rows[i]!, a = evidence.get(left.pr), b = evidence.get(right.pr); if (!a || !b || !a.base || a.base !== b.base) continue;
    const files = new Set(a.paths.filter(path => b.paths.includes(path))).size; if (!files) continue;
    const ordered = reaches(left.pr, right.pr) || reaches(right.pr, left.pr);
    result.conflicts.push({ left: left.pr, right: right.pr, files, order: ordered ? "dependency" : "person_required" });
    if (!ordered) { left.blockers.push("touching PRs require a person order"); right.blockers.push("touching PRs require a person order"); }
  }
  const remaining = new Set(ids);
  while (remaining.size) {
    const next = result.rows.filter(r => remaining.has(r.pr) && r.after.every(pr => !remaining.has(pr))).map(r => r.pr).sort((a, b) => a - b);
    if (!next.length) { for (const row of result.rows.filter(r => remaining.has(r.pr))) row.blockers.push("artifact dependency cycle requires a person"); break; }
    for (const pr of next) { remaining.delete(pr); result.order.push(pr); }
  }
  const touchingCoverageUnknown = result.rows.some(row => evidence.get(row.pr)?.pathsComplete !== true || !evidence.get(row.pr)?.base);
  for (const row of result.rows) { if (result.truncated) row.blockers.push("open PR coverage truncated; touching order unknown"); if (touchingCoverageUnknown) row.blockers.push("open PR file coverage incomplete; touching order unknown"); row.blockers = [...new Set(row.blockers)]; row.ready = !row.private && !row.blockers.length; }
  result.complete = !result.truncated && !remaining.size && result.rows.every(r => evidence.get(r.pr)?.pathsComplete === true);
  return result;
}
