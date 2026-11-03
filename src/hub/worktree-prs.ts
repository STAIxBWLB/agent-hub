import { readSdlcPr, type SdlcGh } from "./sdlc.ts";
import type { PrObserver, WorktreeFact } from "./worktree-shelf.ts";

/**
 * #1057 D1: the explicit "refresh PR states" action. It is the ONLY code that lets the worktree shelf learn a PR state from GitHub, through `readSdlcPr`
 * (the same readback the guarded merge uses), and it runs only when a person asks. A panel refresh, `ahub worktrees` and the inbox alert never reach it, so
 * they make no GitHub call (AC5): `worktree-shelf.ts` imports nothing from here and holds no GitHub access.
 *
 * What it reads is kept in memory, keyed by repository and PR number, and offered back to the shelf as a `PrObserver`.
 * ponytail: the observations live in the daemon's memory, so a restart forgets them and those rows read `unknown` again until the next refresh; the upgrade is a
 * `worktree_pr` table beside `worktree_override`, which is not worth a schema change before live use shows people refresh often.
 */
export const REFRESH_MAX_PRS = 8, REFRESH_CALL_MS = 8_000, REFRESH_TOTAL_MS = 25_000, OBSERVATIONS_MAX = 512;

export interface PrObservation { state: "open" | "merged" | "closed"; changedAt?: number; at: number }
export interface RefreshResult {
  /** PRs read and stored. */
  read: number;
  /** PRs GitHub could not answer for (unreadable, no access, a gh failure): their state stays what it was. */
  failed: number;
  /** PRs not asked about because the cap or the time budget was reached. */
  skipped: number;
}

/** A bounded, insertion-ordered map of what the last refreshes read. */
export class PrObservations {
  private readonly seen = new Map<string, PrObservation>();
  record(repo: string, pr: number, observation: PrObservation): void {
    const key = `${repo}#${pr}`;
    this.seen.delete(key); this.seen.set(key, observation);
    while (this.seen.size > OBSERVATIONS_MAX) this.seen.delete(this.seen.keys().next().value!);
  }
  /** The shelf's view of it: state and change time only. */
  observer: PrObserver = (repo, pr) => {
    const found = this.seen.get(`${repo}#${pr}`);
    return found ? { state: found.state, ...(found.changedAt !== undefined ? { changedAt: found.changedAt } : {}) } : undefined;
  };
  /** When the newest observation was read, or undefined when none was. */
  get lastAt(): number | undefined { let at: number | undefined; for (const value of this.seen.values()) at = Math.max(at ?? 0, value.at); return at; }
  get size(): number { return this.seen.size; }
}

/** The PRs a refresh would ask about: bound tasks with a repository and a PR that the board does not already show as merged, oldest activity first. */
export function refreshTargets(facts: readonly WorktreeFact[], limit = REFRESH_MAX_PRS): { repo: string; pr: number }[] {
  const seen = new Set<string>(), out: { repo: string; pr: number }[] = [];
  const candidates = facts.filter(f => !f.main && !f.instance && f.task?.repo !== undefined && f.task.pr !== undefined && f.pr.state !== "merged")
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  for (const fact of candidates) {
    const key = `${fact.task!.repo}#${fact.task!.pr}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ repo: fact.task!.repo!, pr: fact.task!.pr! });
  }
  return out.slice(0, limit);
}

/**
 * Read each target once, one at a time, under one total budget. `gh` is the host's runner (`sdlcGh` bound to the project), never an argument a request supplies.
 * `readSdlcPr` validates the repository and PR number itself and builds a fixed read-only argv. Every failure is counted and the old state stands.
 */
export async function refreshPrStates(
  targets: readonly { repo: string; pr: number }[],
  gh: SdlcGh,
  store: PrObservations,
  options: { now?: () => number; totalMs?: number; callMs?: number; max?: number } = {},
): Promise<RefreshResult> {
  const now = options.now ?? Date.now, started = now(), total = options.totalMs ?? REFRESH_TOTAL_MS, perCall = options.callMs ?? REFRESH_CALL_MS;
  const left = () => Math.max(0, started + total - now());
  const bounded: SdlcGh = async (args, timeoutMs, cwd, maxOutputBytes) => left() <= 0 ? { code: 1, stdout: "" } : gh(args, Math.max(1, Math.min(timeoutMs ?? perCall, perCall, left())), cwd, maxOutputBytes);
  const asked = targets.slice(0, options.max ?? REFRESH_MAX_PRS);
  let read = 0, failed = 0, done = 0;
  for (const target of asked) {
    if (left() <= 0) break;
    done++;
    const evidence = await readSdlcPr({ stage: "pr", repo: target.repo, pr: target.pr }, bounded).catch(() => undefined);
    if (!evidence) { failed++; continue; }
    const state = evidence.state === "MERGED" ? "merged" : evidence.state === "CLOSED" ? "closed" : "open";
    store.record(target.repo, target.pr, { state, ...(state !== "open" && evidence.changedAt !== undefined ? { changedAt: evidence.changedAt } : {}), at: now() });
    read++;
  }
  return { read, failed, skipped: targets.length - done };
}
