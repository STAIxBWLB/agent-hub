import { basename, dirname } from "node:path";
import { DENY_NAMES, DENY_SEGMENTS } from "@staix/agent-mem/platform";

// One core deny policy for path guards, sandbox rules, capture and memory extraction.
export { DENY_NAMES, DENY_SEGMENTS, isDenied } from "@staix/agent-mem/platform";

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
 * `config.worktree`, the per-worktree config git reads beside `config` (#518), folded in BOTH halves as two NAME-only regex sources that a rule must both match. One SBPL regex
 * literal dies at 1024 bytes in UTF-8 and every folded character costs about 65 bytes, so the whole name (1071) cannot be one literal, and a byte class cannot hold the
 * multi-byte code points (the engine is byte-oriented, verified), so the fold stays an alternation. The first source pins the front (a folded `config`, a dot, then the rest of
 * the name), the second the end (a folded `worktree`). Together they match every spelling of `config.worktree` with ignorable code points anywhere in it, and also
 * `config.<anything>worktree` in the same directory, which is over-refused on purpose and names no file git uses.
 * The root a rule is scoped to is NEVER part of these literals: it goes in its own `require-all` filter, so a long project or git path cannot push a folded name over the limit
 * (#518 review: a 450-byte path made a 1083-byte literal when the root and the name shared one).
 */
const CONFIG_WORKTREE_NAME: readonly [string, string] = [`^.*/${hfsFoldedName("config")}\\.[^/]*$`, `^.*/[^/]*${hfsFoldedName("worktree")}$`];

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
export function hubWriteRegexes(root: string, gitDirs: string[] = [], moduleGit: readonly { root: string; entries: string[] }[] = [], worktreesRoot?: string): string[] {
  const git = hfsFoldedName(".git");
  const re = (s: string) => `(regex ${sbplString(s)})`;
  const external = gitDirs.flatMap((d) => [
    `(require-all ${re(`^${sbplEscape(d)}/[^/]+$`)} ${re(`^.*/(${hfsFoldedName("config")}|${hfsFoldedName("hooks")})$`)})`,
    `(require-all ${re(`^${sbplEscape(d)}/[^/]+$`)} ${CONFIG_WORKTREE_NAME.map(re).join(" ")})`,
    `(subpath ${sbplString(`${d}/hooks`)})`,
    `(require-all (subpath ${sbplString(d)}) ${re(`^.*/${hfsFoldedName("commondir")}$`)})`,
  ]);
  // One set of rules for every modules tree (#518): the common dir's, a linked worktree's own, and each sibling's that has one.
  const modules = moduleGit.flatMap((tree) => [
    // Every name matches whole components only: `(.*/)?` forces a boundary, so a submodule named `catalogs`
    // or `prefs` keeps the refusal and one named `webhooks` keeps its ordinary writes (#281 round 2).
    // `config.worktree` is the per-worktree config git reads next to `config`, so it gets the same refusal.
    `(require-all ${re(`^${sbplEscape(tree.root)}/`)} ${re(`^.*/${hfsFoldedName("config")}$`)} (require-not ${re(`^${sbplEscape(tree.root)}/(.*/)?(refs|logs)/`)}))`,
    `(require-all ${re(`^${sbplEscape(tree.root)}/`)} ${CONFIG_WORKTREE_NAME.map(re).join(" ")} (require-not ${re(`^${sbplEscape(tree.root)}/(.*/)?(refs|logs)/`)}))`,
    `(require-all ${re(`^${sbplEscape(tree.root)}/`)} ${re(`^.*/${hfsFoldedName("hooks")}(/|$)`)} (require-not ${re(`^${sbplEscape(tree.root)}/(.*/)?(refs|logs)/`)}))`,
    // A submodule git dir as a directory entry: no rename, replace, symlink or recreate. The basename is
    // folded (HFS+ opens the folded spelling as the real entry); the plain prefix is the path as discovered.
    // The directory and the folded name are separate filters: one literal holding both grows with the path and dies at 1024 bytes (a ~520-byte git path did on main, #518 review).
    ...tree.entries.map((d) => `(require-all ${re(`^${sbplEscape(dirname(d))}/[^/]+$`)} ${re(`^.*/${hfsFoldedName(basename(d))}$`)})`),
  ]);
  // Every linked worktree's git dir under `<common>/worktrees/` by pattern, not by discovery (#518): a sibling's `modules/` tree that does not exist yet, or a sibling created
  // after this profile was built, is as protected as one that does. The sandbox can write the common dir, so it could otherwise pre-create them. The worktree name is one
  // plain component (a folded spelling of `worktrees` or of a sibling's name on HFS+ is the same residual as the folded `modules` component above).
  const siblings = worktreesRoot
    ? (() => {
        const w = sbplEscape(worktreesRoot), notRefs = `(require-not ${re(`^${w}/[^/]+/modules/(.*/)?(refs|logs)/`)})`;
        return [
          // A worktree git dir's own `config` and `config.worktree`: direct children only.
          `(require-all ${re(`^${w}/[^/]+/[^/]+$`)} ${re(`^.*/${hfsFoldedName("config")}$`)})`,
          `(require-all ${re(`^${w}/[^/]+/[^/]+$`)} ${CONFIG_WORKTREE_NAME.map(re).join(" ")})`,
          // A worktree git dir's own `hooks` directory and everything in it, which git runs for that worktree.
          // The name filter alone is not anchored to the first component, so what lives deeper is excluded: a submodule's own tree has its rule above, and a ref or log named `hooks` stays writable.
          `(require-all ${re(`^${w}/[^/]+/`)} ${re(`^.*/${hfsFoldedName("hooks")}(/|$)`)} (require-not ${re(`^${w}/[^/]+/(modules|refs|logs)/`)}))`,
          // Its submodule git dirs: config, config.worktree and hooks at any depth, refs and logs excepted, and the `modules` entry itself (no create, rename or replace).
          `(require-all ${re(`^${w}/[^/]+/modules/`)} ${re(`^.*/${hfsFoldedName("config")}$`)} ${notRefs})`,
          `(require-all ${re(`^${w}/[^/]+/modules/`)} ${CONFIG_WORKTREE_NAME.map(re).join(" ")} ${notRefs})`,
          `(require-all ${re(`^${w}/[^/]+/modules/`)} ${re(`^.*/${hfsFoldedName("hooks")}(/|$)`)} ${notRefs})`,
          `(require-all ${re(`^${w}/[^/]+/[^/]+$`)} ${re(`^.*/${hfsFoldedName("modules")}$`)})`,
        ];
      })()
    : [];
  return [
    `(require-all (subpath ${sbplString(root)}) ${re(`^.*/${hfsFoldedName(".agenthub")}(/|$)`)})`,
    re(`^.*/${git}$`),
    re(`^.*/${git}/${hfsFoldedName("config")}$`),
    `(require-all ${re(`^.*/${git}/[^/]+$`)} ${CONFIG_WORKTREE_NAME.map(re).join(" ")})`,
    re(`^.*/${git}/${hfsFoldedName("hooks")}(/|$)`),
    `(require-all ${re(`^.*/${git}/.*$`)} ${re(`^.*/${hfsFoldedName("commondir")}$`)})`,
    ...modules,
    ...siblings,
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
