import { findingsForHead, findingHead, findingTally } from "./review-findings.ts";
import { readMergeQueue, type DeliveryTask, type MergeQueue } from "./sdlc-queue.ts";
import { readSdlcPr, stageDefinition, type AutoMergeMode, type PrEvidence, type SdlcConfig, type SdlcGh } from "./sdlc.ts";

/**
 * #786 T1: the one guarded merge. Given a task and the head its reviewer approved, it re-reads the PR (`readSdlcPr`) and the merge queue
 * (`readMergeQueue`) and answers either `{ action: "merge", argv }` or `{ refused: [gate, ...] }` naming every gate that fails. In `on` mode
 * it runs exactly that argv; in `dry-run` it runs nothing. Nothing here writes the board: `Tasks.guardedMerge` owns authority, privacy and notices.
 *
 * The only GitHub write the hub makes is `gh pr merge <pr> --repo <repo> --squash --match-head-commit <head>`. Never `--admin` (it bypasses branch
 * protection), never a ref-update API, and no `--auto` while the repository does not allow auto-merge (a person's repository setting, #786 Out of scope).
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
  /** Called right before `gh pr merge` runs: a returned reason means the board moved during the reads and nothing runs. */
  beforeMerge?: () => string | undefined;
}
export type MergeDecision = { action: "merge"; argv: string[]; repo: string; pr: number; head: string } | { refused: string[] };
export interface MergeOutcome {
  mode: AutoMergeMode;
  decision: MergeDecision;
  /** True only when `gh pr merge` was started. A dry-run and every refusal leave it false. */
  ran: boolean;
  /** After a run: what GitHub reports when read back. `merged` is the only success; a nonzero exit can still end merged, so the PR is read again. */
  result?: { exit: number; state: "merged" | "not_merged" | "unknown"; mergeCommit?: string };
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
function evidenceGates(evidence: PrEvidence, approved: string | undefined, required: readonly string[], subject: DeliveryTask): string[] {
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
  if (findingTally(findingsForHead(subject.findings ?? [], findingHead(subject.receipt, evidence))).openImportant > 0) gates.push("open Important finding");
  // A release goes out with the person's consent, whatever the other gates say (#784 release consent).
  if (/^release[/-]/i.test(evidence.headBranch ?? "")) gates.push("release PR: person consent required");
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
  if (input.state !== "approved") gates.push(`task not approved (state ${input.state})`);
  if (!repo || !pr) return { refused: [...gates, "PR identity missing"] };
  if (!approved || !SHA.test(approved)) gates.push("reviewed head not recorded: the approving verdict must name the head");
  const evidence = await readSdlcPr(receipt, run);
  if (!evidence) return { refused: [...gates, "PR evidence unavailable"] };
  const required = requiredChecksFor(config, repo);
  gates.push(...evidenceGates(evidence, approved, required, subject));
  for (const id of subject.after) {
    const state = input.taskState(id);
    if (state !== "approved") gates.push(`dependency task #${id} is not approved (${state ?? "unknown"})`);
  }
  if (stageDefinition(config, receipt.stage)?.base === "release") gates.push("release PR: person consent required");
  let queue: MergeQueue | undefined;
  try { queue = await readMergeQueue(repo, config, input.tasks, run, input.readableMetadata); } catch { queue = undefined; }
  gates.push(...queueGates(queue, pr));
  // The queue read newer evidence than the first read. Read the PR once more, last, and judge every gate on it too: a check, review request, thread, draft or
  // head that moved between the reads refuses here. `--match-head-commit` pins the head only, never these gates.
  const last = await readSdlcPr(receipt, run);
  if (!last) gates.push("PR evidence unavailable on the final read");
  else gates.push(...evidenceGates(last, approved, required, subject));
  const row = queue?.rows.find(r => r.pr === pr);
  if (row?.head !== undefined && approved && row.head !== approved && !gates.some(g => g.startsWith("head changed"))) gates.push(`head changed: the queue read ${row.head.slice(0, 8)}`);
  if (gates.length) return { refused: dropEchoes([...new Set(gates)]) };
  return { action: "merge", argv: mergeArgv(repo, pr, approved!), repo, pr, head: approved! };
}

/** Decide, then act by mode: `on` runs the one argv and reads the PR back, `dry-run` reports the same decision and runs nothing, `off` reads nothing. */
export async function guardedMerge(input: MergeInput & { mode: AutoMergeMode }): Promise<MergeOutcome> {
  if (input.mode === "off") return { mode: "off", decision: { refused: ["auto_merge is off for this repository"] }, ran: false };
  const decision = await decideMerge(input);
  if (!("action" in decision) || input.mode !== "on") return { mode: input.mode, decision, ran: false };
  const moved = input.beforeMerge?.();
  if (moved) return { mode: input.mode, decision: { refused: [moved] }, ran: false };
  assertMergeArgv(decision.argv, decision.head);
  let exit = 1;
  try { exit = (await input.run(decision.argv, 10_000)).code; } catch { exit = 1; }
  // The exit code alone is not the result: a timed-out call may still have merged, and a refused one has not.
  const after = await readSdlcPr({ stage: input.subject.receipt!.stage, repo: decision.repo, pr: decision.pr }, input.run).catch(() => undefined);
  const result: NonNullable<MergeOutcome["result"]> = after?.state === "MERGED" ? { exit, state: "merged", ...(after.mergeCommit ? { mergeCommit: after.mergeCommit } : {}) } : after ? { exit, state: "not_merged" } : { exit, state: "unknown" };
  return { mode: "on", decision, ran: true, result };
}

/** What a caller (the control op, the CLI, a test) sees: the decision and, after a run, GitHub's own readback. No remote text, no titles. */
export interface MergeView { mode: AutoMergeMode; ran: boolean; decision: "merge" | "refused"; argv?: string[]; refused?: string[]; result?: MergeOutcome["result"] }
export function mergeView(outcome: MergeOutcome): MergeView {
  const { decision } = outcome;
  return { mode: outcome.mode, ran: outcome.ran, ...("action" in decision ? { decision: "merge" as const, argv: decision.argv } : { decision: "refused" as const, refused: decision.refused }), ...(outcome.result ? { result: outcome.result } : {}) };
}
