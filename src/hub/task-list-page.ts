import { PreEffectToolRefusal } from "./tool-refusal.ts";

/** #1083: `hub_task_list` pages. 628 tasks were 2.4 MB, over every agent tool-output limit. */
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

export interface ListQuery {
  limit: number;
  /** Keyset position: the `updated` and `id` of the last row of the previous page. */
  after?: { updated: number; id: number };
  /** Exactly these tasks, full rows, no paging. */
  ids?: number[];
  /** Full rows instead of the compact id/state/owner/reviewer/title row. */
  detail: boolean;
}

const PAGING_KEYS = ["limit", "cursor", "ids", "detail"] as const;

/** True when the caller named any paging argument, whoever it is. */
export const hasPagingArgs = (args: Record<string, unknown>): boolean => PAGING_KEYS.some(key => args[key] !== undefined);

/**
 * Read and validate the paging arguments. Every refusal names the cause and the next step, because it is the only signal a model gets for a rejected call.
 * `agent` callers always page; the person's console keeps the full array unless it names a paging argument, so `ahub tasks` output stays stable.
 */
export function parseListQuery(args: Record<string, unknown>, agent: boolean): ListQuery | undefined {
  if (!agent && !hasPagingArgs(args)) return undefined;
  const { limit, cursor, ids, detail } = args;
  if (detail !== undefined && typeof detail !== "boolean") throw new PreEffectToolRefusal("detail must be true or false; omit it for compact rows (id, state, owner, reviewer, title)");
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.length || ids.length > LIST_MAX_LIMIT || ids.some(id => !Number.isSafeInteger(id) || (id as number) < 1) || new Set(ids).size !== ids.length) {
      throw new PreEffectToolRefusal(`ids must be 1 to ${LIST_MAX_LIMIT} distinct positive task numbers; page with limit and cursor to read more than ${LIST_MAX_LIMIT} tasks`);
    }
    if (limit !== undefined || cursor !== undefined) throw new PreEffectToolRefusal("ids returns every task you list; drop limit and cursor, or drop ids to page the board");
    return { limit: ids.length, ids: ids as number[], detail: true };
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > LIST_MAX_LIMIT)) {
    throw new PreEffectToolRefusal(`limit must be a whole number from 1 to ${LIST_MAX_LIMIT} (default ${LIST_DEFAULT_LIMIT}); read the rest with the cursor the reply gives`);
  }
  let after: ListQuery["after"];
  if (cursor !== undefined) {
    const match = typeof cursor === "string" && cursor.length <= 40 ? /^([0-9]{1,16})\.([1-9][0-9]{0,15})$/.exec(cursor) : null;
    if (!match) throw new PreEffectToolRefusal("cursor must be the `next` value from the previous hub_task_list reply, unchanged; start again without a cursor");
    after = { updated: Number(match[1]), id: Number(match[2]) };
  }
  return { limit: (limit as number | undefined) ?? LIST_DEFAULT_LIMIT, ...(after ? { after } : {}), detail: detail === true };
}

export interface ListPage<T> {
  rows: T[];
  /** Rows that matched the filters, before the cursor and the limit. */
  total: number;
  /** Pass as `cursor` for the next page; absent on the last page. */
  next?: string;
}

/** Newest updated first, ties by id descending, so a cursor stays valid while other tasks change. */
export function pageTasks<T extends { id: number; updated: number }>(rows: readonly T[], query: ListQuery): ListPage<T> {
  const total = rows.length;
  if (query.ids) {
    const wanted = new Set(query.ids);
    const found = rows.filter(row => wanted.has(row.id)).sort((a, b) => query.ids!.indexOf(a.id) - query.ids!.indexOf(b.id));
    return { rows: found, total: found.length };
  }
  const ordered = [...rows].sort((a, b) => b.updated - a.updated || b.id - a.id);
  const after = query.after;
  const rest = after ? ordered.filter(row => row.updated < after.updated || row.updated === after.updated && row.id < after.id) : ordered;
  const page = rest.slice(0, query.limit), last = page[page.length - 1];
  return { rows: page, total, ...(rest.length > page.length && last ? { next: `${last.updated}.${last.id}` } : {}) };
}

/** What a compact row keeps: enough to choose a task, never a body, plan or history. */
export function compactRow(view: Record<string, unknown>): Record<string, unknown> {
  return { id: view.id, state: view.state, owner: view.owner ?? null, reviewer: view.reviewer ?? null, title: view.title };
}
