/** Older same-protocol daemons may ignore newly added filter arguments. */
export function supportsBoardReleaseFilter(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  const capability = (status as Record<string,unknown>).boardReadCapabilities;
  return !!capability && typeof capability === "object" && (capability as Record<string,unknown>).releaseFilter === true;
}

export function supportsBoardColumnMetadata(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  const capability = (status as Record<string,unknown>).boardReadCapabilities;
  return !!capability && typeof capability === "object" && (capability as Record<string,unknown>).columnMetadata === true;
}

/** The most pages `ahub board` follows (200 rows each): a board larger than this is refused with a cause instead of read forever. */
export const BOARD_MAX_PAGES = 100;

/**
 * #1083: `hub_task_list` answers an agent with `{tasks, total, next?}` and the person's console, or a hub from before the change, with the bare array.
 * Read the whole board either way: ask for full rows in the largest page, follow `next` until it is absent, and return one flat array of rows.
 * A person's console answers the bare array to a request that names no paging argument, but this reader names them, so it reads both shapes.
 */
export async function readAllTasks(call: (args: Record<string, unknown>) => Promise<string>, args: Record<string, unknown>): Promise<any[]> {
  const rows: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < BOARD_MAX_PAGES; page++) {
    const parsed: unknown = JSON.parse(await call({ ...args, detail: true, limit: 200, ...(cursor ? { cursor } : {}) }));
    if (Array.isArray(parsed)) return parsed; // an older hub ignores the paging arguments and answers the whole board
    const body = parsed as { tasks?: unknown; next?: unknown };
    if (!body || !Array.isArray(body.tasks)) throw new Error("the hub's task list reply has neither rows nor a task array; upgrade or restart the hub (ahub status)");
    rows.push(...body.tasks);
    if (typeof body.next !== "string" || !body.next) return rows.sort((a, b) => a.id - b.id); // the bare array was in id order and the renderers print rows as given
    if (body.next === cursor) throw new Error("the hub's task list cursor did not advance; run ahub status and retry");
    cursor = body.next;
  }
  throw new Error(`the board is larger than ${BOARD_MAX_PAGES * 200} tasks, more than ahub board reads; filter it with a state or --release`);
}
