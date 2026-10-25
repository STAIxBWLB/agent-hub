import { findingsForHead, findingHead, findingTally } from "./review-findings.ts";
import { readMergeQueue, type DeliveryTask, type MergeQueue } from "./sdlc-queue.ts";
import { readSdlcPr, stageDefinition, type AutoMergeMode, type PrEvidence, type SdlcConfig, type SdlcGh, type MergeRecord } from "./sdlc.ts";

/**
 * #786 T1/T2: the one guarded merge. Given a task and the head its reviewer approved, it re-reads the PR (`readSdlcPr`) and the merge queue
 * (`readMergeQueue`) and answers either `{ action: "merge", argv }` or `{ refused: [gate, ...] }` naming every gate that fails. In `on` mode
 * it runs exactly that argv; in `dry-run` it runs nothing. Nothing here writes the board: `Tasks.guardedMerge` owns authority, privacy and notices.
 *
 * The only merge method is `gh pr merge <pr> --repo <repo> --squash --match-head-commit <head>`. Never `--admin` (it bypasses branch protection),
 * and no `--auto` while the repository does not allow auto-merge. The sole ref write is a post-MERGED CAS deletion of that PR's eligible remote head;
 * a ref-update API never performs the merge. Off/dry-run write neither GitHub nor the board; Tasks owns on-mode host result records.
 * `assertMergeArgv` pins that shape right before the call, so a later edit cannot widen it without failing a test.
 */

export interface MergeInput {
  /** The task as the queue sees it: its receipt (repo, PR, reviewed head), findings and dependencies. */
  subject: DeliveryTask;
  /** The board state now. Only `approved` work merges. */
  state: string;
  /** Board state of a dependency task, for "its task dependencies are approved". */
  taskState: (id: number) => string | undefined;
  config: SdlcConfig;
  /** Every board task, as `Tasks.deliveryQueue` builds them: the queue links PRs to tasks through these. */
  tasks: DeliveryTask[];
  run: SdlcGh;
  readableMetadata?: (path: string) => boolean;
  /** Final synchronous authority and queue-input fence, after fresh gates and immediately before the gh call. */
  beforeMerge?: () => string | undefined;
  /** Post-run host fence and durable progress record. False or a throw withholds cleanup. No remote text is supplied. */
  recordMerge?: (record: MergeRecord) => boolean;
  /**
   * The board and the authority to act, read NOW and synchronously: `guardedMerge` calls it once, after the last PR read and in the same synchronous segment as the
   * `gh pr merge` call (nothing is awaited between them), and refuses unless every input still equals what the decision judged. Absent (a library caller): the
   * decision's own snapshot is all there is. `undefined` means the task is gone.
   */
  fresh?: () => FreshBoard | undefined;
}
/** What the board says at the moment of dispatch. `allowed` is the asker's authority and the hub being free to write (no recovery hold). */
export interface FreshBoard { subject: DeliveryTask; state: string; config: SdlcConfig; mode: AutoMergeMode; allowed: boolean }
export type MergeDecision = { action: "merge"; argv: string[]; repo: string; pr: number; head: string } | { refused: string[] };
export interface MergeOutcome {
  mode: AutoMergeMode;
  decision: MergeDecision;
  /** True only when `gh pr merge` was started. A dry-run and every refusal leave it false. */
  ran: boolean;
  /** After a run: what GitHub reports when read back. `merged` is the only success; a nonzero exit can still end merged, so the PR is read again. */
  result?: { exit: number; state: "merged" | "not_merged" | "unknown"; mergeCommit?: string; cleanup?: MergeRecord["cleanup"]; reason?: MergeRecord["reason"] };
}

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/**
 * Queue blockers this decision keeps: order and open-set facts, and the queue's own reading of the gates that can change between reads (checks, review requests,
 * threads, draft). Its other blockers (identity, local gate, GitHub approval) are the lifecycle's, not this merge's, and are not repeated here.
 */
const QUEUE_BLOCKERS = [/^touching PRs require a person order$/, /^dependency /, /^artifact dependency cycle/, /^open PR /, /^PR file coverage is incomplete/,
  /^required check .*: not successful on current head$/, /^review requests pending or unknown$/, /^review threads unresolved or unknown$/, /^PR is draft or draft status unknown$/];

/** The mode that applies to one repository: its own table first, then the top-level key, default off. */
export function mergeModeFor(config: SdlcConfig, repo: string | undefined): AutoMergeMode {
  return (repo ? config.repos?.[repo.toLowerCase()]?.autoMerge : undefined) ?? config.autoMerge ?? "off";
}
/** Required checks of one repository: its table first, then the top-level `required_checks`, each name once. */
export function requiredChecksFor(config: SdlcConfig, repo: string | undefined): string[] {
  return [...new Set([...(repo ? config.repos?.[repo.toLowerCase()]?.requiredChecks ?? [] : []), ...config.requiredChecks])];
}

/** The exact argv `on` mode runs, or an error. A closed shape: anything else is refused before it reaches gh. */
export function mergeArgv(repo: string, pr: number, head: string): string[] {
  if (!REPO.test(repo) || repo.startsWith("-") || !Number.isSafeInteger(pr) || pr <= 0 || !SHA.test(head)) throw new Error("merge argv needs owner/repository, a PR number and a full head");
  return ["pr", "merge", String(pr), "--repo", repo, "--squash", "--match-head-commit", head];
}
export function assertMergeArgv(argv: readonly string[], head: string): void {
  const [verb, sub, pr, flag, repo, ...rest] = argv;
  const shape = verb === "pr" && sub === "merge" && /^[1-9][0-9]*$/.test(pr ?? "") && flag === "--repo" && REPO.test(repo ?? "") && !repo!.startsWith("-")
    && rest.length === 3 && rest[0] === "--squash" && rest[1] === "--match-head-commit" && rest[2] === head && SHA.test(head);
  if (!shape) throw new Error("refusing a merge argv outside the guarded shape");
}

function checkGates(evidence: PrEvidence, required: readonly string[]): string[] {
  if (!required.length) return ["required checks unknown: name them in sdlc.toml"];
  const gates: string[] = [];
  for (const name of required) {
    const matches = evidence.checks.filter(check => check.name === name);
    const state = !matches.length ? "missing" : matches.some(c => c.state === "failed") ? "failing" : matches.some(c => c.state === "pending") ? "pending" : matches.some(c => c.state !== "passed") ? "unknown" : undefined;
    if (state) gates.push(`required check ${name}: ${state}`);
  }
  return gates;
}

function queueGates(queue: MergeQueue | undefined, pr: number): string[] {
  const row = queue?.rows.find(r => r.pr === pr);
  if (!queue || !row) return ["merge queue unavailable: this PR is not in the open snapshot"];
  const gates: string[] = row.blockers.filter(text => QUEUE_BLOCKERS.some(re => re.test(text))).map(text => `queue: ${text}`);
  const place = queue.order.indexOf(pr);
  for (const conflict of queue.conflicts) {
    if (conflict.left !== pr && conflict.right !== pr) continue;
    const other = conflict.left === pr ? conflict.right : conflict.left, before = queue.order.indexOf(other);
    if (before !== -1 && place !== -1 && before < place) gates.push(`not first among touching PRs: #${other} merges first`);
  }
  if (queue.unordered?.includes(pr) && !gates.length) gates.push("queue: touching PR order is unresolved");
  return [...new Set(gates)];
}

/** A queue blocker that only repeats a gate the evidence already named adds nothing: drop it, and keep the ones that say something new (a disagreement between reads). */
function dropEchoes(gates: string[]): string[] {
  const named = (re: RegExp) => gates.some(g => !g.startsWith("queue: ") && re.test(g));
  return gates.filter(gate => {
    if (!gate.startsWith("queue: ")) return true;
    const check = /^queue: required check (.*): not successful on current head$/.exec(gate);
    if (check) return !named(new RegExp(`^required check ${check[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
    if (gate === "queue: review requests pending or unknown") return !named(/review requests? (unknown|pending)|^\d+ review requests? pending$/);
    if (gate === "queue: review threads unresolved or unknown") return !named(/review threads unknown|unresolved review thread/);
    if (gate === "queue: PR is draft or draft status unknown") return !named(/^draft /);
    return true;
  });
}

/** The gates one reading of the PR can fail. Run on every reading this decision takes, so a gate that changes between reads is never judged on the older one. */
function evidenceGates(evidence: PrEvidence, approved: string | undefined, required: readonly string[]): string[] {
  const gates: string[] = [];
  if (approved && evidence.head !== approved) gates.push(`head changed: reviewed ${approved.slice(0, 8)}, PR is at ${evidence.head.slice(0, 8)}`);
  if (evidence.state !== "OPEN") gates.push(`PR is ${evidence.state.toLowerCase()}`);
  if (evidence.draft !== false) gates.push("draft (or draft status unknown)");
  gates.push(...checkGates(evidence, required));
  if (evidence.review === "changes_requested") gates.push("change request pending");
  if (evidence.pendingReviews === null) gates.push("review requests unknown");
  else if (evidence.pendingReviews > 0) gates.push(`${evidence.pendingReviews} review request${evidence.pendingReviews === 1 ? "" : "s"} pending`);
  if (evidence.unresolved === null) gates.push("review threads unknown");
  else if (evidence.unresolved > 0) gates.push(`${evidence.unresolved} unresolved review thread${evidence.unresolved === 1 ? "" : "s"}`);
  // A release goes out with the person's consent, whatever the other gates say (#784 release consent).
  if (/^release[/-]/i.test(evidence.headBranch ?? "")) gates.push("release PR: person consent required");
  return gates;
}

/**
 * The gates that come from the board, not from GitHub: privacy, approval, task dependencies, open Important findings on this head and a release stage. Pure and
 * synchronous on purpose: `decideMerge` runs it on its starting snapshot and `guardedMerge` runs it again on a fresh board read right before `gh pr merge`.
 */
export function localGates(input: { subject: DeliveryTask; state: string; taskState: (id: number) => string | undefined; config: SdlcConfig; head: string | undefined }): string[] {
  const { subject, config } = input, gates: string[] = [];
  if (subject.private) return ["private task: a person merges"];
  if (input.state !== "approved") gates.push(`task not approved (state ${input.state})`);
  for (const id of subject.after) {
    const state = input.taskState(id);
    if (state !== "approved") gates.push(`dependency task #${id} is not approved (${state ?? "unknown"})`);
  }
  if (findingTally(findingsForHead(subject.findings ?? [], findingHead(subject.receipt, input.head ? { head: input.head } : undefined))).openImportant > 0) gates.push("open Important finding");
  if (subject.receipt && stageDefinition(config, subject.receipt.stage)?.base === "release") gates.push("release PR: person consent required");
  return gates;
}

/**
 * Every failing gate, never the first only: a person reading a refusal fixes them in one pass. Unknown evidence is a failing gate, never a pass.
 * `approvedHead` is the head the reviewer's verdict recorded (`receipt.reviewedHead`); a head that moved since is `head changed`.
 */
export async function decideMerge(input: MergeInput): Promise<MergeDecision> {
  const { subject, config, run } = input, receipt = subject.receipt, repo = receipt?.repo, pr = receipt?.pr, approved = receipt?.reviewedHead;
  const gates: string[] = [];
  if (subject.private) return { refused: ["private task: a person merges"] };
  if (!repo || !pr) return { refused: [...gates, "PR identity missing"] };
  if (!approved || !SHA.test(approved)) gates.push("reviewed head not recorded: the approving verdict must name the head");
  const evidence = await readSdlcPr(receipt, run);
  if (!evidence) return { refused: [...gates, "PR evidence unavailable"] };
  const required = requiredChecksFor(config, repo);
  gates.push(...evidenceGates(evidence, approved, required));
  gates.push(...localGates({ subject, state: input.state, taskState: input.taskState, config, head: evidence.head }));
  let queue: MergeQueue | undefined;
  try { queue = await readMergeQueue(repo, config, input.tasks, run, input.readableMetadata); } catch { queue = undefined; }
  gates.push(...queueGates(queue, pr));
  // The queue read newer evidence than the first read. Read the PR once more, last, and judge every gate on it too: a check, review request, thread, draft or
  // head that moved between the reads refuses here. `--match-head-commit` pins the head only, never these gates.
  const last = await readSdlcPr(receipt, run);
  if (!last) gates.push("PR evidence unavailable on the final read");
  else { gates.push(...evidenceGates(last, approved, required)); gates.push(...localGates({ subject, state: input.state, taskState: input.taskState, config, head: last.head })); }
  const row = queue?.rows.find(r => r.pr === pr);
  if (row?.head !== undefined && approved && row.head !== approved && !gates.some(g => g.startsWith("head changed"))) gates.push(`head changed: the queue read ${row.head.slice(0, 8)}`);
  if (gates.length) return { refused: dropEchoes([...new Set(gates)]) };
  return { action: "merge", argv: mergeArgv(repo, pr, approved!), repo, pr, head: approved! };
}

/**
 * Every board-side input the decision rested on, compared with the board as it is at dispatch. Pure and synchronous. The decision's inputs are: the task's state, repo,
 * PR and reviewed head, its privacy, its dependencies (the edges and each one's state), its open Important findings for the head, the merge mode and required checks in
 * force, and the asker's authority. Any difference refuses: a gate checked before an await is never trusted after it.
 */
export function dispatchGates(input: Pick<MergeInput, "subject" | "taskState"> & { config: SdlcConfig; mode: AutoMergeMode }, decision: { repo: string; pr: number; head: string }, now: FreshBoard | undefined): string[] {
  const moved = ["task changed during the merge check: nothing was run"];
  if (!now) return moved;
  const receipt = now.subject.receipt;
  if (receipt?.repo !== decision.repo || receipt?.pr !== decision.pr || receipt?.reviewedHead !== decision.head) return moved;
  if (now.mode !== input.mode) return ["merge mode changed during the merge check: nothing was run"];
  if (JSON.stringify(requiredChecksFor(now.config, decision.repo)) !== JSON.stringify(requiredChecksFor(input.config, decision.repo))) return ["required checks changed during the merge check: nothing was run"];
  if (!now.allowed) return ["authority or hub availability changed during the merge check: nothing was run"];
  if (JSON.stringify([...now.subject.after].sort((x, y) => x - y)) !== JSON.stringify([...input.subject.after].sort((x, y) => x - y))) return ["task dependencies changed during the merge check: nothing was run"];
  return localGates({ subject: now.subject, state: now.state, taskState: input.taskState, config: now.config, head: decision.head });
}

/**
 * Decide, then act by mode: `on` runs the one argv and reads the PR back, `dry-run` reports the same decision and runs nothing, `off` reads nothing.
 * The dispatch segment below has no await: the board is read (`fresh`), every input is compared with the decision, and `run` is called, all in one synchronous
 * stretch that starts after the last PR read.
 */
export async function guardedMerge(input: MergeInput & { mode: AutoMergeMode }): Promise<MergeOutcome> {
  if (input.mode === "off") return { mode: "off", decision: { refused: ["auto_merge is off for this repository"] }, ran: false };
  const decision = await decideMerge(input);
  if (!("action" in decision) || input.mode !== "on") return { mode: input.mode, decision, ran: false };
  // ---- synchronous dispatch segment: no await from here to the call to `run` ----
  assertMergeArgv(decision.argv, decision.head);
  if (input.fresh) {
    const refused = dispatchGates(input, decision, input.fresh());
    if (refused.length) return { mode: input.mode, decision: { refused }, ran: false };
  }
  let started: Promise<{ code: number; stdout: string }>;
  const moved = input.beforeMerge?.();
  if (moved) return { mode: input.mode, decision: { refused: [moved] }, ran: false };
  try { started = Promise.resolve(input.run(decision.argv, 10_000)); } catch { started = Promise.resolve({ code: 1, stdout: "" }); }
  // ---- end of the synchronous segment ----
  let exit = 1;
  try { exit = (await started).code; } catch { exit = 1; }
  // A transport failure can still have merged. Bound lag readback within this one invocation; never repeat the merge.
  const deadline = performance.now() + 6000;
  const bounded: SdlcGh = (args, timeout, cwd, cap) => {
    const left = deadline - performance.now();
    return left > 0 ? input.run(args, Math.min(timeout ?? 2000, left), cwd, Math.min(cap ?? 65536, 65536)) : Promise.resolve({ code: 1, stdout: "" });
  };
  let after: PrEvidence | undefined;
  for (let attempt = 0; attempt < 3 && performance.now() < deadline; attempt++) {
    const observed = await readSdlcPr({ stage: input.subject.receipt!.stage, repo: decision.repo, pr: decision.pr }, bounded).catch(() => undefined);
    // MERGED is terminal evidence. Retry for its commit without losing that fact to a stale or failed read.
    if (observed && (after?.state !== "MERGED" || observed.state === "MERGED" && observed.mergeCommit)) after = observed;
    if (after?.state === "MERGED" && after.mergeCommit || after?.state === "CLOSED") break;
    const left = deadline - performance.now();
    if (attempt < 2 && left > 0) await Bun.sleep(Math.min(100, left));
  }
  const result: NonNullable<MergeOutcome["result"]> = after?.state === "MERGED" ? {exit,state:"merged",...(after.mergeCommit?{mergeCommit:after.mergeCommit}:{})} : after ? {exit,state:"not_merged"} : {exit,state:"unknown"};
  if (input.recordMerge) {
    let record: MergeRecord={repo:decision.repo,pr:decision.pr,head:decision.head,at:Date.now(),...result,cleanup:"not_started",ownerNotice:"not_started"};
    const save = () => {try {return input.recordMerge!({...record});}catch{return false;}};
    if (!save()) {record={...record,cleanup:"skipped",reason:"authority_changed"};save();}
    else if (result.state!=="merged" || !result.mergeCommit) {record={...record,cleanup:"skipped",reason:result.state==="merged"?"missing_commit":"not_merged"};save();}
    else {
      const cleanup=await cleanupMergedBranch(decision,result.mergeCommit,bounded,progress=>{record={...record,...progress};return save();});
      record={...record,...cleanup};save();
    }
    result.cleanup=record.cleanup;
    if(record.reason)result.reason=record.reason;
  }
  return { mode: "on", decision, ran: true, result };
}

/** Only the merged PR's exact same-repository, unprotected nondefault head can be deleted. No local git command is used. */
async function cleanupMergedBranch(decision:{repo:string;pr:number;head:string},mergeCommit:string,run:SdlcGh,claim:(progress:Pick<MergeRecord,"cleanup"> & Partial<Pick<MergeRecord,"reason">>)=>boolean):Promise<Pick<MergeRecord,"cleanup"> & Partial<Pick<MergeRecord,"reason">>> {
  const skip=(reason:NonNullable<MergeRecord["reason"]>)=>({cleanup:"skipped" as const,reason});
  const read=async(args:string[])=>{try{const r=await run(args);if(r.code!==0)return;const data=JSON.parse(r.stdout);return data?.errors?undefined:data;}catch{return;}};
  const [owner,name]=decision.repo.split("/");
  const query="query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){id nameWithOwner defaultBranchRef{name} pullRequest(number:$pr){state headRefName headRefOid headRepository{nameWithOwner} mergeCommit{oid}}}}";
  const args=["api","graphql","-f",`query=${query}`,"-f",`owner=${owner}`,"-f",`name=${name}`,"-F",`pr=${decision.pr}`];
  const initial=(await read(args))?.data?.repository,p=initial?.pullRequest;
  if (!initial) return skip("metadata_unknown");
  if (!initial || p?.state!=="MERGED" || p.mergeCommit?.oid!==mergeCommit || p.headRefOid!==decision.head || p.headRepository?.nameWithOwner?.toLowerCase()!==decision.repo.toLowerCase()) return skip("identity_changed");
  const branch=p.headRefName;
  // ponytail: cleanup accepts only this ASCII 200-character ref subset; use a shared validated Git ref-name parser before widening it. Unknown spelling never reaches a mutation.
  if(typeof branch!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock"))return skip("metadata_unknown");
  if(typeof initial.defaultBranchRef?.name!=="string")return skip("metadata_unknown");
  if(branch===initial.defaultBranchRef.name)return skip("default_branch");
  const lastQuery=query.replace("mergeCommit{oid}}}}","mergeCommit{oid}} ref(qualifiedName:$ref){name prefix target{oid} branchProtectionRule{id}}}}").replace("$pr:Int!","$pr:Int!,$ref:String!");
  const current=(await read(["api","graphql","-f",`query=${lastQuery}`,"-f",`owner=${owner}`,"-f",`name=${name}`,"-F",`pr=${decision.pr}`,"-f",`ref=refs/heads/${branch}`]))?.data?.repository;
  const now=current?.pullRequest;
  if (!current) return skip("metadata_unknown");
  if(typeof current.id!=="string" || !current.id || current.nameWithOwner?.toLowerCase()!==decision.repo.toLowerCase() || now?.state!=="MERGED" || now.mergeCommit?.oid!==mergeCommit || now.headRefName!==branch || now.headRefOid!==decision.head || now.headRepository?.nameWithOwner?.toLowerCase()!==decision.repo.toLowerCase())return skip("identity_changed");
  if(typeof current.defaultBranchRef?.name!=="string")return skip("metadata_unknown");
  if(current.defaultBranchRef.name===branch)return skip("default_branch");
  if(!Object.hasOwn(current,"ref"))return skip("metadata_unknown");
  if(current.ref===null)return {cleanup:"already_gone"};
  if(current.ref?.name!==branch || current.ref?.prefix!=="refs/heads/" || !Object.hasOwn(current.ref,"branchProtectionRule"))return skip("metadata_unknown");
  if(current.ref.branchProtectionRule!==null)return skip("protected_branch");
  if(current.ref.target?.oid!==decision.head)return skip("head_changed");
  // This endpoint includes all active repository/organization rulesets; any active rule conservatively protects the branch.
  const rules=await read(["api",`repos/${decision.repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100`]);
  if(!Array.isArray(rules))return skip("metadata_unknown");
  if(rules.length)return skip("protected_branch");
  // Persist the claim after every await and immediately before the sole ref write. A lost acknowledgement is never retried.
  if(!claim({cleanup:"claimed"}))return skip("authority_changed");
  const mutation='mutation($repo:ID!,$ref:GitRefname!,$before:GitObjectID!,$after:GitObjectID!){updateRefs(input:{repositoryId:$repo,clientMutationId:"agent-hub-post-merge-cleanup",refUpdates:[{name:$ref,beforeOid:$before,afterOid:$after}]}){clientMutationId}}';
  const reply=await read(["api","graphql","-f",`query=${mutation}`,"-f",`repo=${current.id}`,"-f",`ref=refs/heads/${branch}`,"-f",`before=${decision.head}`,"-f",`after=${"0".repeat(40)}`]);
  if(reply?.data?.updateRefs?.clientMutationId==="agent-hub-post-merge-cleanup")return {cleanup:"deleted"};
  const recheck=(await read(["api","graphql","-f",`query=${lastQuery}`,"-f",`owner=${owner}`,"-f",`name=${name}`,"-F",`pr=${decision.pr}`,"-f",`ref=refs/heads/${branch}`]))?.data?.repository;
  if(recheck?.nameWithOwner?.toLowerCase()===decision.repo.toLowerCase() && recheck.ref?.name===branch && recheck.ref?.prefix==="refs/heads/" && typeof recheck.ref.target?.oid==="string" && SHA.test(recheck.ref.target.oid) && recheck.ref.target.oid!==decision.head)return skip("head_changed");
  return {cleanup:"unknown",reason:"delete_unconfirmed"};
}

/** What a caller (the control op, the CLI, a test) sees: the decision and, after a run, GitHub's own readback. No remote text, no titles. */
export interface MergeView { mode: AutoMergeMode; ran: boolean; decision: "merge" | "refused"; argv?: string[]; refused?: string[]; result?: MergeOutcome["result"] }
export function mergeView(outcome: MergeOutcome): MergeView {
  const { decision } = outcome;
  return { mode: outcome.mode, ran: outcome.ran, ...("action" in decision ? { decision: "merge" as const, argv: decision.argv } : { decision: "refused" as const, refused: decision.refused }), ...(outcome.result ? { result: outcome.result } : {}) };
}
