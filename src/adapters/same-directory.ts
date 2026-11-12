import { realPath } from "../hub/project.ts";

/**
 * #1423: whether a path a hub-written config names is this directory, also after the project moved (a rename that left the old path as a symlink). Compared by real path, never by text alone, and through
 * `realPath` (project.ts), so a typed name is not rebuilt from its parts. A path that does not resolve (the old name is gone, not left as a link) is not the same directory: the caller then refuses
 * with a next step. Never throws, never writes.
 */
export function sameDirectory(named: unknown, directory: string): boolean {
  if (typeof named !== "string" || !named || named.length > 4096 || /[\u0000-\u001f\u007f]/.test(named)) return false;
  if (named === directory) return true;
  try { return realPath(named) === realPath(directory); } catch { return false; }
}
/** A foreign value shown in a refusal: printable and short, or not shown at all (the field name is the clue then). */
export function shownValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
