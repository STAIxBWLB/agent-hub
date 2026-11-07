import type { Counter, View } from "@staix/agent-mem";

/**
 * #1279: the `memory` block's counter figures for one task, derived from agent-mem's own machine-local counter rows (`CandidateStore.counters`) and the entries they name. The hub stores nothing for
 * them: the sidecar already holds `rendered`, `delivered` and `cited` per `{entry, task, delivery}`. A figure is a number of distinct entries, never a note id or text.
 *
 * Unknown is null, never 0:
 * - With no counter row for the task at all, nothing was observed (the sidecar was off or unreadable, the task was private, or the rows aged out), and every figure is null. "None rendered" and
 *   "never observed" cannot be told apart from rows alone, so the first is not claimed.
 * - `rendered`: distinct entries put into a delivery attributed to the task (briefs, recall prefaces).
 * - `delivered`: of those, the ones whose delivery completed (journal acknowledgement). Null while none is known to have completed: a brief that never completes leaves it null.
 * - `cited`: of the rendered entries, the ones a hub-screened done summary, message or `hub_remember` text named by `mem:<id>`. An id that was not rendered for the task is not counted. 0 is known
 *   once something was rendered, because the citation paths ran over the same task.
 * - `failsExposed`, `failsCited`: the same two over entries of kind `fail`; null when a rendered entry can no longer be read, since its kind is then unknown.
 * - `failRetrySignal`: exposed fail notes whose `about` intersects the task's plan and that were not cited by approval. A signal for a reviewer to read, never an outcome: it does not say the
 *   approach was retried.
 * Ceiling: the sidecar keeps 10,000 counters per project for 90 days, so an old task can have lost rows (read as unknown); a citation outside the screened paths is not seen.
 */
export interface MemoryFigures {
  rendered: number | null; delivered: number | null; cited: number | null;
  failsExposed: number | null; failsCited: number | null; failRetrySignal: number | null;
}
export const UNKNOWN_MEMORY_FIGURES: Readonly<MemoryFigures> = Object.freeze({ rendered: null, delivered: null, cited: null, failsExposed: null, failsCited: null, failRetrySignal: null });

export interface MemoryFigurePorts {
  /** The counter rows of the project. */
  counters: readonly Pick<Counter, "key" | "rendered" | "delivered" | "cited">[];
  /** The task's key as the rows carry it (`taskKey(project, task)`). */
  taskKey: string;
  /** One entry's view, or undefined when it is hidden, gone or unreadable. */
  view: (entryId: string) => Pick<View, "id" | "kind" | "about" | "supersededBy"> | undefined;
  /** Of these fail notes, the ones whose `about` intersects the task's plan: the library's own `matchingPlanFails`. */
  matchingPlan: <T extends Pick<View, "kind" | "about" | "supersededBy">>(fails: readonly T[]) => readonly T[];
}

const positive = (n: number | null | undefined): boolean => typeof n === "number" && n > 0;

export function memoryFigures(ports: MemoryFigurePorts): MemoryFigures {
  const mine = ports.counters.filter(row => row.key.task === ports.taskKey);
  const entries = (field: "rendered" | "delivered" | "cited") => new Set(mine.filter(row => positive(row[field])).map(row => row.key.entryId));
  const rendered = entries("rendered");
  if (!rendered.size) return { ...UNKNOWN_MEMORY_FIGURES };
  // A delivery or a citation of an entry the task was never shown is not part of the task's exposure.
  const delivered = [...entries("delivered")].filter(id => rendered.has(id)).length;
  const cited = new Set([...entries("cited")].filter(id => rendered.has(id)));
  const views = [...rendered].map(id => ({ id, view: ports.view(id) }));
  const readable = views.filter((v): v is { id: string; view: NonNullable<typeof v.view> } => v.view !== undefined);
  const complete = readable.length === views.length;
  const fails = readable.filter(v => v.view.kind === "fail");
  const uncited = fails.filter(v => !cited.has(v.id)).map(v => v.view);
  return {
    rendered: rendered.size,
    delivered: delivered || null,
    cited: cited.size,
    failsExposed: complete ? fails.length : null,
    failsCited: complete ? fails.filter(v => cited.has(v.id)).length : null,
    failRetrySignal: complete ? ports.matchingPlan(uncited).length : null,
  };
}
