import { findingsForHead, findingTally, type ReviewFindingSet, type ReviewFindingTally } from "./review-findings.ts";
import type { CriteriaView } from "./workflow.ts";
import { parsePrEvidence, readSdlcPr, sdlcGh, sdlcStatus, type PrEvidence, type SdlcConfig, type SdlcGh, type SdlcReceipt } from "./sdlc.ts";
export interface DeliveryTask { findings?: readonly ReviewFindingSet[]; id: number; after: number[]; private: boolean; receipt?: SdlcReceipt; phase?: CriteriaView; }
export interface MergeQueueRow { findings?: ReviewFindingTally; pr: number; tasks: number[]; head?: string; private?: true; ready: boolean; blockers: string[]; after: number[]; }
export interface MergeConflict { left: number; right: number; files: number; order: "dependency" | "person_required"; }
export interface MergeQueue { repo: string; rows: MergeQueueRow[]; order: number[]; unordered?: number[]; conflicts: MergeConflict[]; complete: boolean; truncated: boolean; }
const validRepo = (value: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith("-");
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const parseSnapshot = (reply: { code: number; stdout: string }): { number: number; head: string; base: string; baseHead: string }[] | undefined => {
  try { const data = JSON.parse(reply.stdout); if (reply.code !== 0 || !Array.isArray(data) || data.length > 17 || data.some(p => !validId(p?.number) || typeof p.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(p.headRefOid) || typeof p.baseRefName !== "string" || !p.baseRefName || p.baseRefName.length > 200 || /[\x00-\x1f\x7f]/.test(p.baseRefName) || typeof p.baseRefOid !== "string" || !/^[0-9a-f]{40}$/.test(p.baseRefOid)) || new Set(data.map(p => p.number)).size !== data.length) return; return data.map(p => ({ number: p.number, head: p.headRefOid, base: p.baseRefName, baseHead: p.baseRefOid })).sort((a, b) => a.number - b.number); }
  catch { return; }
};
const gateIdentity = (p: PrEvidence) => JSON.stringify({ head: p.head, state: p.state, checks: [...p.checks].sort((a, b) => a.name.localeCompare(b.name) || a.state.localeCompare(b.state)), review: p.review, pending: p.pendingReviews, unresolved: p.unresolved, draft: p.draft, base: p.base, baseHead: p.baseHead, pathsComplete: p.pathsComplete });
/** The last remote read gathers both open identities and mutable gates in one bounded request. */
async function finalSnapshot(repo: string, evidence: Map<number, PrEvidence>, run: SdlcGh): Promise<{ gatesStable: boolean; prs?: ReturnType<typeof parseSnapshot> }> {
  const [owner, name] = repo.split("/");
  const fields = "headRefOid state isDraft baseRefName baseRefOid changedFiles reviewDecision reviewRequests(first:100){nodes{requestedReviewer{__typename}} pageInfo{hasNextPage}} reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}} statusCheckRollup{contexts(first:100){nodes{... on CheckRun{name conclusion status} ... on StatusContext{context state}} pageInfo{hasNextPage}}}";
  const entries = [...evidence.entries()];
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:17,states:OPEN){nodes{number headRefOid baseRefName baseRefOid} pageInfo{hasNextPage}} ${entries.map(([id]) => `queue_p${id}:pullRequest(number:${id}){${fields}}`).join(" ")}}}`;
  try {
    const reply = await run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`]);
    if (reply.code !== 0) return { gatesStable: false };
    const data = JSON.parse(reply.stdout);
    if (data.errors || !data.data?.repository) return { gatesStable: false };
    const open = data.data.repository.pullRequests;
    const prs = parseSnapshot({ code: 0, stdout: JSON.stringify(open?.nodes) });
    if (!prs || open?.pageInfo?.hasNextPage !== false) return { gatesStable: false, prs };
    for (const [id, before] of entries) {
      const p = data.data.repository[`queue_p${id}`];
      const threads = p?.reviewThreads, reviews = p?.reviewRequests, checks = p?.statusCheckRollup === null ? { nodes: [], pageInfo: { hasNextPage: false } } : p?.statusCheckRollup?.contexts;
      if (threads?.pageInfo?.hasNextPage !== false || reviews?.pageInfo?.hasNextPage !== false || checks?.pageInfo?.hasNextPage !== false || !Array.isArray(threads.nodes) || threads.nodes.length > 100 || threads.nodes.some((n: { isResolved?: unknown }) => typeof n?.isResolved !== "boolean") || !Array.isArray(reviews.nodes) || !Array.isArray(checks.nodes) || checks.nodes.length > 100) return { gatesStable: false, prs };
      const after = parsePrEvidence({ ...p, files: before.paths.map(path => ({ path })), statusCheckRollup: checks.nodes, reviewRequests: reviews.nodes, unresolvedThreads: threads.nodes.filter((n: { isResolved: boolean }) => !n.isResolved).length });
      if (gateIdentity(before) !== gateIdentity(after)) return { gatesStable: false, prs };
    }
    return { gatesStable: true, prs };
  } catch { return { gatesStable: false }; }
}
/** Fixed metadata-only reads; local claims and unknown dependency evidence never become merge approval. */
export async function readMergeQueue(repo: string, config: SdlcConfig, tasks: DeliveryTask[], run: SdlcGh = sdlcGh): Promise<MergeQueue> {
  if (!validRepo(repo)) throw new Error("merge queue requires owner/repository");
  const result: MergeQueue = { repo, rows: [], order: [], conflicts: [], complete: false, truncated: false };
  const deadline = performance.now() + 20_000;
  const bounded: SdlcGh = args => { const remaining = deadline - performance.now(); return remaining > 0 ? run(args, Math.min(10_000, remaining)) : Promise.resolve({ code: 1, stdout: "" }); };
  const listArgs = ["pr", "list", "--repo", repo, "--state", "open", "--limit", "17", "--json", "number,headRefOid,baseRefName,baseRefOid"];
  const initialPrs = parseSnapshot(await bounded(listArgs)); if (!initialPrs) return result;
  result.truncated = initialPrs.length > 16; const ids = initialPrs.slice(0, 16).map(pr => pr.number);
  const sameRepo = (value: unknown) => typeof value === "string" && value.toLowerCase() === repo.toLowerCase();
  const evidence = new Map<number, PrEvidence>(), links = new Map<number, DeliveryTask[]>();
  for (const pr of ids) {
    const holders = tasks.filter(t => sameRepo(t.receipt?.repo) && t.receipt?.pr === pr); links.set(pr, holders);
    const row: MergeQueueRow = { pr, tasks: holders.some(t => t.private) ? [] : holders.map(t => t.id), ready: false, blockers: [], after: [] }; result.rows.push(row);
    if (holders.some(t => t.private)) { row.private = true; row.blockers.push("private lifecycle evidence unavailable"); continue; }
    const read = await readSdlcPr(holders[0]?.receipt ?? { stage: config.stages[0] ?? "spec", repo, pr }, bounded);
    if (!read || read.state !== "OPEN") { row.blockers.push("current PR evidence unknown or no longer open"); continue; }
    evidence.set(pr, read); row.head = read.head;
    for (const holder of holders) {
      const items = findingsForHead(holder.findings ?? [], read.head);
      if (!items.length) continue;
      const tally = findingTally(items);
      row.findings ??= findingTally([]);
      for (const key of Object.keys(tally) as (keyof ReviewFindingTally)[]) row.findings[key] += tally[key];
    }
    if (!read.pathsComplete) row.blockers.push("PR file coverage is incomplete or unknown");
    if (read.draft !== false) row.blockers.push("PR is draft or draft status is unknown");
    if (!read.base) row.blockers.push("PR target branch is unknown");
    const linked = holders.length ? holders : [undefined];
    if (config.mode === "enforce" && row.findings?.openImportant) row.blockers.push("open important review findings: " + row.findings.openImportant);
    for (const holder of linked) row.blockers.push(...sdlcStatus(config, holder?.receipt, read, holder?.phase).blockers);
  }
  const dependencyEvidence = new Map<number, PrEvidence | undefined>(); let dependencyReads = 0;
  for (const row of result.rows) {
    if (row.private) continue;
    for (const holder of links.get(row.pr) ?? []) for (const id of holder.after) {
      const dependency = tasks.find(t => t.id === id);
      if (!dependency || dependency.private || !dependency.receipt || !sameRepo(dependency.receipt.repo) || !validId(dependency.receipt.pr)) { row.blockers.push("dependency merge evidence unknown or private"); continue; }
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
  const personOrder = new Set(result.conflicts.filter(conflict => conflict.order === "person_required").flatMap(conflict => [conflict.left, conflict.right]));
  const unresolvedOrder = new Set([...remaining, ...personOrder]);
  for (const row of result.rows) if (result.truncated || touchingCoverageUnknown || [...personOrder].some(pr => reaches(row.pr, pr))) unresolvedOrder.add(row.pr);
  if (unresolvedOrder.size) { result.unordered = ids.filter(pr => unresolvedOrder.has(pr)); result.order = result.order.filter(pr => !unresolvedOrder.has(pr)); }
  for (const row of result.rows) { if (result.truncated) row.blockers.push("open PR coverage truncated; touching order unknown"); if (touchingCoverageUnknown) row.blockers.push("open PR file coverage incomplete; touching order unknown"); row.blockers = [...new Set(row.blockers)]; row.ready = !row.private && !row.blockers.length; }
  result.complete = !result.truncated && !remaining.size && !touchingCoverageUnknown && !personOrder.size;
  // Empty/private-only snapshots have no intervening remote reads and offer no private PR evidence.
  if (evidence.size) {
    const finalRead = await finalSnapshot(repo, evidence, bounded);
    const gatesStable = finalRead.gatesStable;
    const finalPrs = finalRead.prs;
    if (!gatesStable || !finalPrs || JSON.stringify(finalPrs) !== JSON.stringify(initialPrs) || finalPrs.some(pr => evidence.has(pr.number) && (evidence.get(pr.number)?.head !== pr.head || evidence.get(pr.number)?.base !== pr.base || evidence.get(pr.number)?.baseHead !== pr.baseHead))) {
      result.complete = false; result.order = []; result.unordered = ids;
      for (const row of result.rows) { row.ready = false; row.blockers.push("open PR set changed or could not be reverified"); }
    }
  }
  return result;
}
