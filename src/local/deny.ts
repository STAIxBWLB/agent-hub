import { basename, dirname, sep } from "node:path";

/**
 * The one denylist. tools.ts checks paths against it, sandbox.ts turns it into seatbelt rules, capture.ts keeps
 * matching calls out of memory. Two lists would drift, and the gap is where a secret leaks.
 */
// `.agenthub/archive` holds the state directories `ahub reset --all` moved there: hub.db with task text, PII included.
export const DENY_SEGMENTS = [".maru/secrets", ".agenthub/state", ".agenthub/archive"];
/** Regex sources, matched against a file's basename. */
export const DENY_NAMES = ["^\\.env", "\\.pem$", "\\.key$", "^id_rsa", "^id_ed25519", "^credentials(\\.|$)", "^auth\\.json$", "^\\.netrc$", "^\\.npmrc$", "^\\.pypirc$"];

const hasSegment = (rel: string, seg: string) => `/${rel}/`.includes(`/${seg}/`);

/** True when a path names something the worker must never read, write or report. `extra`: substrings from `local.deny`. */
export function isDenied(path: string, extra: string[] = []): boolean {
  const norm = path.split(sep).join("/");
  return DENY_SEGMENTS.some((s) => hasSegment(norm, s)) || DENY_NAMES.some((re) => new RegExp(re).test(basename(norm))) || extra.some((e) => e && norm.includes(e));
}

/** Regex metacharacters only; `sbplString` quotes the finished regex. */
const sbplEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An SBPL string literal. Only the plain `"..."` form can hold a quote: in the raw `#"..."` form a backslash escapes
 * nothing, so a `"` in a path ended the literal and broke the whole profile (issue #23).
 */
export const sbplString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The 16 code points HFS+ ignores in file names: U+200C-200F, U+202A-202E, U+206A-206F, U+FEFF (a probe found
 * case-insensitive APFS ignores none). `mkdir .g<U+200D>it` on HFS+ makes what everything afterwards opens as
 * `.git` (#270). One source for the seatbelt profile's folded patterns; the file tools' `foldSegment` removes
 * every default-ignorable, a superset of these.
 */
export const HFS_IGNORABLE_POINTS = ["\u200C", "\u200D", "\u200E", "\u200F", "\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u206A", "\u206B", "\u206C", "\u206D", "\u206E", "\u206F", "\uFEFF"];

/**
 * One HFS+-ignorable code point as a seatbelt regex atom. A group alternation, not a character class: the
 * seatbelt regex engine is byte-oriented, so a quantifier after a multi-byte class member binds to its last
 * byte and a class never matches the plain name (verified with the real sandbox-exec, #270).
 */
const HFS_IGNORABLE = `(${HFS_IGNORABLE_POINTS.join("|")})`;

/** A regex source matching `name` with any number of HFS+-ignorable code points interleaved, at the ends included. */
const hfsFoldedName = (name: string) => `${HFS_IGNORABLE}*${[...name].map((c) => sbplEscape(c)).join(`${HFS_IGNORABLE}*`)}${HFS_IGNORABLE}*`;

/**
 * Seatbelt rules for the hub's and git's own names (#270). `.agenthub` is refused anywhere under the project root.
 * `.git` is refused at any depth, the name itself included, so a planted repository cannot arrive by creation,
 * rename, symlink or gitfile, and `config` and `hooks` directly under it are folded too; the cost is that
 * `git init`, `git clone` and `git worktree add` no longer run inside the sandbox. `commondir` is refused at any
 * depth below a `.git` and below each external git dir: that is where git keeps it for linked worktrees and
 * submodules. A submodule's git dir under `.git/modules/` gets the same `config`/`hooks` refusal at whatever depth
 * submodules nest (a nested one lives under `.git/modules/<a>/modules/<b>`, #281), anchored at the discovered
 * modules root so a directory named `refs`, `config` or `hooks` ABOVE the project neither disables the rule nor
 * trips it; a `/refs/` or `/logs/` segment below the root keeps a branch or tag named `config` or `hooks` writable
 * (the round-3 regression of #277), at the price of leaving a submodule whose own path holds a `refs` or `logs`
 * segment unprotected. The basenames are folded; a folded INTERMEDIATE component on HFS+ (a spelling of `modules`)
 * is a known residual, the same one the external git dir rules carry. The directory entries above those files are
 * protected as the `.git` name is: the discovered git dirs, the modules root and every component in between are
 * refused as targets (rename, replace, symlink, recreate). An external git dir's `config`/`hooks` rules cover only
 * its own children (plus the hooks directory's contents): at any depth they would deny refs named `config` or
 * `hooks` in a worktree or submodule project (`git branch fix/config` fails on `.git/logs/refs/heads/fix/config`).
 * Every pattern keeps its `^` anchor (an unanchored starred alternation does not match in this engine) and no
 * folded literal contains the root: an SBPL string literal dies at 1024 bytes ("Error reading string"), which a
 * long project path would trip. ponytail: the modules rules do contain the (plain) modules root; a project path
 * over roughly 600 bytes with submodules would exceed the limit — fold the root's segments if one ever shows up.
 */
export function hubWriteRegexes(root: string, gitDirs: string[] = [], moduleGit?: { root: string; entries: string[] }): string[] {
  const git = hfsFoldedName(".git");
  const re = (s: string) => `(regex ${sbplString(s)})`;
  const external = gitDirs.flatMap((d) => [
    `(require-all ${re(`^${sbplEscape(d)}/[^/]+$`)} ${re(`^.*/(${hfsFoldedName("config")}|${hfsFoldedName("hooks")})$`)})`,
    `(subpath ${sbplString(`${d}/hooks`)})`,
    `(require-all (subpath ${sbplString(d)}) ${re(`^.*/${hfsFoldedName("commondir")}$`)})`,
  ]);
  const modules = moduleGit
    ? [
        // Every name matches whole components only: `(.*/)?` forces a boundary, so a submodule named `catalogs`
        // or `prefs` keeps the refusal and one named `webhooks` keeps its ordinary writes (#281 round 2).
        `(require-all ${re(`^${sbplEscape(moduleGit.root)}/(.*/)?${hfsFoldedName("config")}$`)} (require-not ${re(`^${sbplEscape(moduleGit.root)}/(.*/)?(refs|logs)/`)}))`,
        `(require-all ${re(`^${sbplEscape(moduleGit.root)}/(.*/)?${hfsFoldedName("hooks")}(/|$)`)} (require-not ${re(`^${sbplEscape(moduleGit.root)}/(.*/)?(refs|logs)/`)}))`,
        // A submodule git dir as a directory entry: no rename, replace, symlink or recreate. The basename is
        // folded (HFS+ opens the folded spelling as the real entry); the plain prefix is the path as discovered.
        ...moduleGit.entries.map((d) => re(`^${sbplEscape(dirname(d))}/${hfsFoldedName(basename(d))}$`)),
      ]
    : [];
  return [
    `(require-all (subpath ${sbplString(root)}) ${re(`^.*/${hfsFoldedName(".agenthub")}(/|$)`)})`,
    re(`^.*/${git}$`),
    re(`^.*/${git}/${hfsFoldedName("config")}$`),
    re(`^.*/${git}/${hfsFoldedName("hooks")}(/|$)`),
    `(require-all ${re(`^.*/${git}/.*$`)} ${re(`^.*/${hfsFoldedName("commondir")}$`)})`,
    ...modules,
    ...external,
  ];
}

/**
 * Seatbelt regex filters equivalent to isDenied. Seatbelt sees absolute paths, so the `local.deny` substrings are
 * anchored under the project root: a bare "private/" would otherwise match /private/var/... and deny the whole temp tree.
 */
export function denyRegexes(root: string, extra: string[] = [], withNames = true): string[] {
  const names = DENY_NAMES.map((re) => {
    const body = re.startsWith("^") ? re.slice(1) : `[^/]*${re}`;
    return `/${body}${body.endsWith("$") ? "" : "[^/]*$"}`;
  });
  return [
    ...DENY_SEGMENTS.map((s) => `/${sbplEscape(s)}(/|$)`),
    ...(withNames ? names : []),
    ...extra.filter(Boolean).map((e) => `^${sbplEscape(root)}/.*${sbplEscape(e)}`),
  ].map((re) => `(regex ${sbplString(re)})`);
}
