// Human output for `ahub worktrees` and `ahub worktrees tidy` (#1057). Pure: data in, spans out, no I/O. `--json` is the caller's branch and prints the same data.
import { blank, grid, heading, pair, s } from "./sdlc-output.ts";
import { moment } from "./sdlc-output.ts";
import type { Span } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const reasonLabel = (row: any): string => row?.reason === "merged" ? "PR merged" : row?.reason === "closed" ? "PR closed" : row?.reason === "quiet" ? "quiet" : row?.reason === "parked" ? "parked" : row?.reason === "settled" ? "settled" : "";
const taskLabel = (row: any): string => row?.private === true ? "task: private" : typeof row?.task === "number" ? `#${row.task}${typeof row.pr === "number" ? ` PR ${row.pr}` : ""}` : "";

/** `ahub worktrees`: live rows, then the shelf with each settled row's reason. */
export function renderWorktrees(reply: unknown, columns?: number, now = Date.now()): Span[][] {
  const r = reply as any, live = list(r?.live), settled = list(r?.settled);
  const rows = (items: any[], withReason: boolean) => items.map((row: any) => [
    s(row.path), s(row.branch ?? "(detached)", "muted"), s(taskLabel(row), "issueRef"), ...(withReason ? [s(reasonLabel(row), "attention")] : []), s(moment(row.lastActiveAt, now), "muted"),
  ]);
  const out: Span[][] = [...heading(`Worktrees: ${live.length} live, ${settled.length} settled`, columns)];
  if (live.length) out.push(...grid(["PATH", "BRANCH", "TASK", "ACTIVE"], rows(live, false), columns));
  if (settled.length) out.push(blank, ...heading("Shelf (settled)", columns), ...grid(["PATH", "BRANCH", "TASK", "WHY", "ACTIVE"], rows(settled, true), columns));
  if (!live.length && !settled.length) out.push([s("no worktrees", "muted")]);
  if (r?.complete === false) out.push(blank, [s("the list was cut off at its bound; some worktrees are not shown", "attention")]);
  if (settled.length) out.push(blank, [s("preview what could be removed with ahub worktrees tidy; nothing is removed until you confirm", "muted")]);
  return out;
}

/** `ahub worktrees tidy`: each settled row that is safe to remove, each refused row with its reasons, and the fingerprint to confirm. */
export function renderTidyPreview(plan: unknown, columns?: number): Span[][] {
  const p = plan as any, entries = list(p?.entries), removable = list(p?.removable), refused = entries.filter((e: any) => list(e.refused).length);
  const out: Span[][] = [...heading(`Tidy preview: ${removable.length} safe to remove, ${refused.length} refused`, columns)];
  if (removable.length) out.push(...grid(["PATH", "BRANCH", "WHY SETTLED"], removable.map((e: any) => [s(e.shown), s(e.branch ?? ""), s(reasonLabel(e))]), columns));
  if (refused.length) out.push(blank, ...heading("Refused", columns), ...grid(["PATH", "BRANCH", "REFUSED BECAUSE"], refused.map((e: any) => [s(e.shown), s(e.branch ?? ""), s(list(e.refused).join("; "), "attention")]), columns));
  if (!entries.length) out.push([s("nothing is on the shelf", "muted")]);
  if (removable.length) out.push(blank, ...pair("fingerprint", String(p.fingerprint), columns, 12), [s(`confirm with: ahub worktrees tidy --confirm ${p.fingerprint}`, "muted")], [s("each removal runs git worktree remove and git branch -d, without force; git keeps anything it considers unsafe", "muted")]);
  return out;
}

/** `ahub worktrees tidy --confirm`: what happened to each row. */
export function renderTidyResult(outcomes: unknown, columns?: number): Span[][] {
  const rows = list(outcomes);
  const out: Span[][] = [...heading(`Tidy: ${rows.filter((o: any) => o.worktreeRemoved).length} of ${rows.length} removed`, columns)];
  out.push(...grid(["PATH", "BRANCH", "WORKTREE", "BRANCH"], rows.map((o: any) => [s(o.shown), s(o.branch), s(o.worktreeRemoved ? "removed" : "kept", o.worktreeRemoved ? "muted" : "attention"), s(o.branchDeleted ? "deleted" : "kept", o.branchDeleted ? "muted" : "attention")]), columns));
  for (const o of rows.filter((x: any) => x.note)) out.push([s(`${o.shown}: ${o.note}`, "muted")]);
  return out;
}
