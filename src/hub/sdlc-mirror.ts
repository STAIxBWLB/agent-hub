import { sanitize } from "./envelope.ts";
import type { SdlcGh } from "./sdlc.ts";

/**
 * #786 T3 (AC1): mirror a hub verdict as ONE `COMMENT` review on the head it was given for. One GitHub account authors and merges every PR, and GitHub refuses `APPROVE` and
 * `REQUEST_CHANGES` on your own PR, so a comment is the only review the hub can leave. It is a record for a person reading the PR, never a gate: nothing here reads it back
 * as approval, and a failure never touches the verdict (the caller runs this after the verdict is saved and never awaits it).
 *
 * The call is exactly `gh api repos/<repo>/pulls/<pr>/reviews -f event=COMMENT -f commit_id=<head> -f body=<text>` (`-f` makes it a POST), checked by `assertMirrorArgv` right before
 * it runs. The first line of the body is `agent-hub verdict: approved|changes_requested (task #N, reviewer <peer>)`; the rest is the note's public view, which the caller supplies
 * only when the task is not private and the note was not withheld (a PII task mirrors the first line alone).
 */

export type MirrorMode = "off" | "dry-run" | "on";
export type MirrorVerdict = "approved" | "changes_requested";
export interface MirrorInput {
  repo: string; pr: number;
  /** The head the verdict was given for. A PR that is no longer at it gets nothing. */
  head: string;
  verdict: MirrorVerdict;
  task: number;
  reviewer: string;
  /** The note's public view, already screened by the caller. Absent for a private task or a withheld note. */
  note?: string;
  mode: MirrorMode;
  run: SdlcGh;
}
export type MirrorOutcome =
  | { mode: MirrorMode; posted: false; reason: "off" | "stale head" | "pr not open" | "already mirrored" | "unreadable" | "in flight" | "invalid" }
  | { mode: "dry-run"; posted: false; reason: "dry-run"; argv: string[] }
  | { mode: "on"; posted: boolean; reason: "posted" | "post failed"; argv: string[] };

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PEER = /^[a-z][a-z0-9-]{0,31}$/;
/** GitHub's review body limit is far larger; a mirror is a pointer, so it stays short. */
export const MIRROR_NOTE_MAX = 3000;
const MARK = "agent-hub verdict: ";

/** The first line the mirror starts with. The retry check matches its stable part (verdict and task), so a different reviewer's repeat of the same verdict is not posted twice. */
export const mirrorHeadline = (verdict: MirrorVerdict, task: number, reviewer: string): string => `${MARK}${verdict} (task #${task}, reviewer ${reviewer})`;
const stableHeadline = (verdict: MirrorVerdict, task: number): string => `${MARK}${verdict} (task #${task}, reviewer `;

/** The whole body: the headline, then the note when there is one. The note cannot forge a headline of its own (`sanitize` and a header strip) and is bounded. */
export function mirrorBody(input: { task: number; reviewer: string; verdict: MirrorVerdict; note?: string }): string {
  const head = mirrorHeadline(input.verdict, input.task, input.reviewer);
  const note = (input.note ?? "").replace(/\r/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!note) return head;
  // A line of the note that starts like a verdict headline would read as a second mirror on the PR: keep it, indented, so it cannot.
  const safe = sanitize(note).split("\n").map(line => line.startsWith(MARK) ? ` ${line}` : line).join("\n");
  return `${head}\n\n${safe.length > MIRROR_NOTE_MAX ? `${safe.slice(0, MIRROR_NOTE_MAX)}\n[note cut]` : safe}`;
}

/** The only write this module makes. A closed shape: the endpoint is this PR's reviews, the event is COMMENT, and the commit is the verdict's head. */
export function mirrorArgv(repo: string, pr: number, head: string, body: string): string[] {
  if (!REPO.test(repo) || repo.startsWith("-") || !Number.isSafeInteger(pr) || pr <= 0 || !SHA.test(head)) throw new Error("mirror argv needs owner/repository, a PR number and a full head");
  return ["api", `repos/${repo}/pulls/${pr}/reviews`, "-f", "event=COMMENT", "-f", `commit_id=${head}`, "-f", `body=${body}`];
}
export function assertMirrorArgv(argv: readonly string[], head: string): void {
  const [verb, endpoint, f1, event, f2, commit, f3, body, ...rest] = argv;
  const shape = verb === "api" && /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9][0-9]*\/reviews$/.test(endpoint ?? "") && !endpoint!.startsWith("repos/-")
    && f1 === "-f" && event === "event=COMMENT" && f2 === "-f" && commit === `commit_id=${head}` && SHA.test(head) && f3 === "-f" && typeof body === "string" && body.startsWith(`body=${MARK}`) && rest.length === 0;
  if (!shape) throw new Error("refusing a mirror argv outside the COMMENT review shape");
}

/** One mirror at a time per (task, head, verdict) in this process; the durable check below covers a restart and another process. */
const inFlight = new Set<string>();

/** The PR's current head and state in one bounded read; undefined when GitHub does not answer cleanly (never a pass). */
async function readHead(repo: string, pr: number, run: SdlcGh): Promise<{ head: string; open: boolean } | undefined> {
  try {
    const reply = await run(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,state"]);
    if (reply.code !== 0) return undefined;
    const data = JSON.parse(reply.stdout);
    return typeof data?.headRefOid === "string" && SHA.test(data.headRefOid) && typeof data.state === "string" ? { head: data.headRefOid, open: data.state === "OPEN" } : undefined;
  } catch { return undefined; }
}

/**
 * Did this verdict already get a mirror at this head? Reads the PR's first 100 reviews, reduced by `--jq` to commit and first line only (no body text comes back). A full
 * page, or any read that does not parse, is unknown: unknown posts nothing, because a duplicate on a person's PR is worse than a missing comment.
 */
async function alreadyMirrored(repo: string, pr: number, head: string, verdict: MirrorVerdict, task: number, run: SdlcGh): Promise<boolean | undefined> {
  try {
    const reply = await run(["api", `repos/${repo}/pulls/${pr}/reviews?per_page=100`, "--jq", "[.[] | {c: .commit_id, l: ((.body // \"\") | split(\"\\n\")[0])}]"]);
    if (reply.code !== 0) return undefined;
    const rows = JSON.parse(reply.stdout);
    if (!Array.isArray(rows) || rows.length >= 100) return undefined;
    const stable = stableHeadline(verdict, task);
    return rows.some((row: { c?: unknown; l?: unknown }) => row?.c === head && typeof row.l === "string" && row.l.startsWith(stable));
  } catch { return undefined; }
}

/**
 * The mirror. `off` does nothing and reads nothing. Otherwise: the PR must still be open at the verdict's head (a stale head posts nothing), a mirror of this verdict at this
 * head must not exist yet (read from GitHub, so a restart or a retried verdict does not post twice), the head and state are read once more after that listing, and then
 * `dry-run` reports the argv it would run while `on` posts it. Ceiling: GitHub offers no compare-and-set on a review, so a push that lands after the last read and before the
 * post is not seen; the comment still names H in `commit_id` and in its headline, so it says truthfully which commit the verdict was about.
 */
export async function mirrorVerdict(input: MirrorInput): Promise<MirrorOutcome> {
  if (input.mode === "off") return { mode: "off", posted: false, reason: "off" };
  const { repo, pr, head, verdict, task, reviewer, run } = input;
  if (!REPO.test(repo) || repo.startsWith("-") || !Number.isSafeInteger(pr) || pr <= 0 || !SHA.test(head) || !Number.isSafeInteger(task) || task <= 0 || !PEER.test(reviewer) && reviewer !== "user"
    || verdict !== "approved" && verdict !== "changes_requested") return { mode: input.mode, posted: false, reason: "invalid" };
  const key = JSON.stringify([repo.toLowerCase(), pr, head, verdict, task]);
  if (inFlight.has(key)) return { mode: input.mode, posted: false, reason: "in flight" };
  inFlight.add(key);
  try {
    const current = await readHead(repo, pr, run);
    if (!current) return { mode: input.mode, posted: false, reason: "unreadable" };
    if (current.head !== head) return { mode: input.mode, posted: false, reason: "stale head" };
    if (!current.open) return { mode: input.mode, posted: false, reason: "pr not open" };
    const seen = await alreadyMirrored(repo, pr, head, verdict, task, run);
    if (seen === undefined) return { mode: input.mode, posted: false, reason: "unreadable" };
    if (seen) return { mode: input.mode, posted: false, reason: "already mirrored" };
    // The review list was an await: a push or a close during it makes the first read stale. Read the head and state once more, LAST, and judge on that read; nothing is awaited
    // between it and the post below. `commit_id` pins the comment to H but does not make H still current, so this read is what keeps "a stale head posts nothing" true.
    const last = await readHead(repo, pr, run);
    if (!last) return { mode: input.mode, posted: false, reason: "unreadable" };
    if (last.head !== head) return { mode: input.mode, posted: false, reason: "stale head" };
    if (!last.open) return { mode: input.mode, posted: false, reason: "pr not open" };
    const argv = mirrorArgv(repo, pr, head, mirrorBody({ task, reviewer, verdict, ...(input.note !== undefined ? { note: input.note } : {}) }));
    if (input.mode === "dry-run") return { mode: "dry-run", posted: false, reason: "dry-run", argv };
    assertMirrorArgv(argv, head);
    let exit = 1;
    try { exit = (await run(argv, 10_000)).code; } catch { exit = 1; }
    return { mode: "on", posted: exit === 0, reason: exit === 0 ? "posted" : "post failed", argv };
  } finally { inFlight.delete(key); }
}
