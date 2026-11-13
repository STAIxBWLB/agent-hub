/**
 * #1054 T4: `ahub results [--unread] [--read <id> | --read-all | --unread-last]`. Pure: argv to one closed request, never a decision about whether it applies (the hub checks
 * that a result exists and is unread). At most one action flag; `--unread` only narrows the list and takes no action.
 */
export const RESULT_ID = /^cmp-[a-f0-9]{12}$/;
export type ResultsRequest = { action: "list"; unread: boolean } | { action: "read"; id: string } | { action: "read-all" } | { action: "unread-last" };
export type ResultsArgs = { ok: true; value: ResultsRequest } | { ok: false; error: string };
export const RESULTS_USAGE = "usage: ahub results [--unread] [--read <id> | --read-all | --unread-last] [--json] [--color=auto|always|never]";

export function parseResultsArgs(args: readonly string[]): ResultsArgs {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error: `${RESULTS_USAGE}; ${error}` });
  let unread = false;
  const actions: ResultsRequest[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (word === "--unread") { unread = true; continue; }
    if (word === "--read-all") { actions.push({ action: "read-all" }); continue; }
    if (word === "--unread-last") { actions.push({ action: "unread-last" }); continue; }
    if (word === "--read" || word.startsWith("--read=")) {
      const id = word === "--read" ? args[++index] : word.slice("--read=".length);
      if (id === undefined || !RESULT_ID.test(id)) return fail("--read needs a result id like cmp-0123456789ab (ahub results lists them)");
      actions.push({ action: "read", id });
      continue;
    }
    return fail(word.startsWith("--") ? `unknown flag ${word.split("=")[0]}` : `unexpected operand ${word.slice(0, 40)}`);
  }
  if (actions.length > 1) return fail("give one of --read, --read-all and --unread-last");
  if (actions.length === 1) { if (unread) return fail("--unread only narrows the list; it does not combine with an action"); return { ok: true, value: actions[0]! }; }
  return { ok: true, value: { action: "list", unread } };
}
