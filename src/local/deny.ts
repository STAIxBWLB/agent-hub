import { basename, sep } from "node:path";

/**
 * The one denylist. tools.ts checks paths against it, sandbox.ts turns it into seatbelt rules, capture.ts keeps
 * matching calls out of memory. Two lists would drift, and the gap is where a secret leaks.
 */
export const DENY_SEGMENTS = [".maru/secrets", ".agenthub/state"];
/** Regex sources, matched against a file's basename. */
export const DENY_NAMES = ["^\\.env", "\\.pem$", "\\.key$", "^id_rsa", "^id_ed25519", "^credentials(\\.|$)", "^auth\\.json$", "^\\.netrc$", "^\\.npmrc$", "^\\.pypirc$"];

const hasSegment = (rel: string, seg: string) => `/${rel}/`.includes(`/${seg}/`);
export { hasSegment };

/** True when a path names something the worker must never read, write or report. `extra`: substrings from `local.deny`. */
export function isDenied(path: string, extra: string[] = []): boolean {
  const norm = path.split(sep).join("/");
  return DENY_SEGMENTS.some((s) => hasSegment(norm, s)) || DENY_NAMES.some((re) => new RegExp(re).test(basename(norm))) || extra.some((e) => e && norm.includes(e));
}

const sbplEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, '\\"');

/**
 * Seatbelt regex filters equivalent to isDenied. Seatbelt sees absolute paths, so the `local.deny` substrings are
 * anchored under the project root: a bare "private/" would otherwise match /private/var/... and deny the whole temp tree.
 */
export function denyRegexes(root: string, extra: string[] = []): string[] {
  const names = DENY_NAMES.map((re) => {
    const body = re.startsWith("^") ? re.slice(1) : `[^/]*${re}`;
    return `/${body}${body.endsWith("$") ? "" : "[^/]*$"}`;
  });
  return [
    ...DENY_SEGMENTS.map((s) => `/${sbplEscape(s)}(/|$)`),
    ...names,
    ...extra.filter(Boolean).map((e) => `^${sbplEscape(root)}/.*${sbplEscape(e)}`),
  ].map((re) => `(regex #"${re.replace(/"/g, '\\"')}")`);
}
