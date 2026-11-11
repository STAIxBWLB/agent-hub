/**
 * #1399: a command the hub hands a person runs as printed. The first relay of `ahub queue resolve <id>` failed on its two required flags, the second on the
 * revision and on which checkout hosts the hub, so every hint is built here with the values the hub already knows.
 */
export interface DeliveryHint { id: string; revision?: number; state?: string; peer?: string; senders?: readonly string[]; kinds?: readonly string[] }

const word = (value: string) => value.replace(/[^\w.,:@~-]/g, "");
const shellPath = (path: string) => /^[\w./@:+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;

/** The other actions the row's state allows, one clause each: the hub cannot tell whether the peer handled an uncertain delivery. */
export const queueResolveChoices = (state?: string): string => state === "failed"
  ? "discard drops it; use --action completed instead if it was already handled"
  : "retry sends it again; use --action completed instead if the peer already handled it, or discard if it is stale";

/** `[cd <project> && ]ahub queue resolve <id> [--revision N] --action <suggested> --reason "<kind> from <sender> to <peer>"`. */
export function queueResolveCommand(row: DeliveryHint, project?: string): string {
  const kinds = [...new Set(row.kinds ?? [])].map(word).filter(Boolean).join(","), senders = [...new Set(row.senders ?? [])].map(word).filter(Boolean).join(",");
  const reason = [kinds, senders && `from ${senders}`, row.peer && `to ${word(row.peer)}`].filter(Boolean).join(" ") || "settled by the person";
  return `${project ? `cd ${shellPath(project)} && ` : ""}ahub queue resolve ${row.id}${Number.isSafeInteger(row.revision) ? ` --revision ${row.revision}` : ""} --action ${row.state === "failed" ? "discard" : "retry"} --reason "${reason}"`;
}

/** The CLI's own argument rule for `ahub queue resolve`, shared with the test that proves a hint passes it. */
export function queueResolveArgsValid(action: string | undefined, reason: string | undefined, revision: string | undefined, extra: readonly string[]): boolean {
  return !extra.length && ["completed", "retry", "discard"].includes(action ?? "") && !!reason?.trim() && (revision === undefined || (/^\d+$/.test(revision) && Number.isSafeInteger(Number(revision))));
}
