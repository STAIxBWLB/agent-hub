# Audit: policy decisions made from a realpath-derived name alone (#552, the #541 class)

Date: 2026-10-28. Base: origin/main fa6ef818. Follow-up to #541 (PR #943).

## The class

On macOS APFS, Bun's `realpathSync` (1.4.3, and `.native`) can return another hardlink of the same file: about 1 call in 100 when the file has a second name in a different directory, and never in the 4000 calls where the system `/bin/realpath` was run on the same layout. A decision that tests a name against a name-based policy (the secrets denylist, `.git` and `.agenthub` names, `pii.paths`, `data.readonly`) after resolving the path with `realPath` can therefore judge a different name than the one the caller used. Both names name the same bytes, so the decision is only wrong when the two names are judged differently by the policy. It needs a hardlink to a file inside the project to exist first.

## Method

1. `grep -rn "realPath(\|realpathSync(" src` found 47 files with callers. Every caller was read; the ones that feed a name-based policy check were measured with a loop on this Mac (Bun 1.4.3, APFS, the unmodified callers from origin/main).
2. The reverse search covered every caller of `isDenied`, `isHubWritePath`, `isAgentConfigPath`, `matchesPolicy` and `matchesPolicyLexically` for a resolved name reaching it.
3. A caller is **reachable** when a resolved name alone decides a refusal and the typed name is not also judged.

## Findings

| # | Caller | Policy | Typed name available | Reachable | Result |
|---|---|---|---|---|---|
| 1 | `Facts.rel` (`src/hub/facts.ts`) | secrets denylist, `.git` names, hub-owned names (shadow repository) | yes (`path`, `abs`) | yes: 17 of 3000 calls named a denied `.env` that is the later link of an innocent file | fixed: both names judged |
| 2 | `locate` in `src/hub/deliverable-files.ts` | hub-owned names (`.agenthub`, `.git`), secrets denylist | yes (`path`) | yes: 29 of 3000 calls hashed a hub-owned name, 29 of 3000 a denied name | fixed: both names judged, and the denylist is checked here directly so the fix does not depend on `guardPath` |
| 3 | `ahub source add` (`src/cli/main.ts`) with `screenRegistration` (`src/hub/sources.ts`) | `pii.paths` | yes (`target`) | yes: 63 of 4000 registrations of a `pii.paths` name were recorded as not private | fixed: `screenRegistration` takes the typed name too and either name under `pii.paths` makes it private |
| 4 | `guardPath` (`src/local/tools.ts`) | denylist, hub-owned names | yes | yes | fixed in #541 (PR #943), not touched here |
| 5 | `registerScanned` (`src/hub/folder-trigger.ts`) | `pii.paths` | no: the scan walks a listing and `file.real` is built from `join(folder, name)` of a `readdir` entry, never from `realPath` of a file | no | not reachable: the name is the listing's own, and a symlink is skipped before this point |
| 6 | `scanFolder` denylist check (`src/hub/folder-trigger.ts`) | secrets denylist | yes | no | the name tested is `join(folder, name)` from `readdir`, not a resolved name |
| 7 | `checkCorpusRoot`, the corpus walk (`src/hub/corpus.ts`) | denylist, `pii.paths`, vault | root only | no | the object is a configured folder, not a file with several names; the walk joins directory entries and skips symlinks, so no resolved file name reaches the check |
| 8 | `doc_read` (`src/local/doc-read.ts`) | `pii.paths` | yes | no | refuses any file with `nlink !== 1` before the check, and it is reached through `guardPath` |
| 9 | `facts-hook` `safe` (`src/cli/facts-hook.ts`) | hub-owned and agent-config names, `data.readonly` | yes | no | checks the lexical name first, then the resolved one, and refuses `hardLinked(real)` |
| 10 | `matchesPolicy` and `matchesPolicyLexically` (`src/hub/path-policy.ts`) | `pii.paths`, `data.readonly`, deny | yes | no | compares the declared spelling, the real target and aliases; it is the pattern the fixes above follow |
| 11 | `text-projection` `project` (`src/hub/text-projection.ts`) | containment only | n/a | no | no name-based policy: containment under the project root and `O_NOFOLLOW`; the callers decide privacy before it is called |
| 12 | `ahub check-path` (`src/cli/main.ts`, `realPath(abs)`) | overlap warnings only | n/a | no | advisory text, not a refusal |
| 13 | `hostExecutable`, `hostShellPath`, `task-shell-*`, `read-only-shell-proof`, `claude-shell-wrapper`, `instance-execution`, `snapshots`, `external-instance` | executable and directory containment | n/a | no | decide on directories and executables, compared by identity or by containment against a root, never by file name policy |
| 14 | `daemon.ts` (`realPath(opts.cwd)`, transcript paths, state dir) | containment of project, state and transcript roots | n/a | no | directories, not files with a second name |
| 15 | `tasks.ts`, `task-repository.ts`, `code-facts.ts`, `memory-*`, `registry.ts`, `instances.ts`, `tooling.ts` | project identity and repository roots | n/a | no | root identity comparisons |

Rows 1 to 3 are fixed in this change. Row 4 was fixed by #541. Everything else reads a directory or compares a root, or already judges the typed name.

## Not covered

- Callers outside `src/` (scripts, tests) were not audited.
- The measurement is on APFS with Bun 1.4.3. On other filesystems the behavior was not measured; the fixes only add refusals, so they are safe there.
- Whether a hardlink to a file inside the project can be created by the actors the policies protect against was not examined; each row is reachable as a function call, not shown to be reachable by an agent.
