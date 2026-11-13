/**
 * #1177: `ahub backlog return <task> <revision> <reason...> [--reserved <peer> | --unreserve]`. Pure: argv to the `hub_backlog_return_untouched` arguments, and never a
 * decision about whether the return applies (the hub checks authority, the revision and the reservation). With neither flag the arguments are exactly what the command
 * sent before, so today's behaviour is unchanged.
 *
 * The flags are the two reservation edits the tool already takes as `fields.reserved` (a peer id, or null to clear). They are read wherever they stand among the reason's
 * words, are removed from the reason, and at most one of them may be given: a reason is free text, so the only way to tell a flag from a word of it is that it is one of
 * these exact tokens. `--reserved=<peer>` is the same as `--reserved <peer>`.
 */
const PEER = /^[a-z][a-z0-9-]{0,31}$/;
export type BacklogReturn = { ok: true; value: { reason: string; fields?: { reserved: string | null } } } | { ok: false; error: string };
export const BACKLOG_RETURN_USAGE = "usage: ahub backlog return <task> <revision> <reason...> [--reserved <peer> | --unreserve]";

export function parseBacklogReturn(words: readonly string[]): BacklogReturn {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error: `${BACKLOG_RETURN_USAGE}; ${error}` });
  const reason: string[] = [];
  let reserved: string | null | undefined;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === "--unreserve") {
      if (reserved !== undefined) return fail("give one of --reserved and --unreserve, once");
      reserved = null;
      continue;
    }
    if (word === "--reserved" || word.startsWith("--reserved=")) {
      if (reserved !== undefined) return fail("give one of --reserved and --unreserve, once");
      const peer = word === "--reserved" ? words[++index] : word.slice("--reserved=".length);
      if (peer === undefined || !PEER.test(peer)) return fail("--reserved needs a peer id like codex");
      reserved = peer;
      continue;
    }
    reason.push(word);
  }
  const text = reason.join(" ").trim();
  if (!text) return fail("a reason is required");
  return { ok: true, value: { reason: text, ...(reserved !== undefined ? { fields: { reserved } } : {}) } };
}
