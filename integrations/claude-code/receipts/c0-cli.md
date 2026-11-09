# Claude Code C0 isolated CLI evidence

Recorded 2026-11-09; final explicit-environment repetition succeeded with the same read outcomes. Claude Code 2.1.319; hub 0.35.0 at source base `34773d2e40e935a6c05444ae352ec2363be72673`; Bun 1.4.4 macOS arm64.
This receipt proves CLI availability and a scratch daemon's read boundary. It does not prove a mod's `$.process`, channel delivery, a drawing surface, command origin, or an interactive journey.

- Created `$SCRATCH` with `mktemp -d` outside Git, with separate `home`, `config` and `project2` directories; the final clean repetition used a fresh `project3`.
- Every Claude invocation set `HOME=$SCRATCH/home`, `CLAUDE_CONFIG_DIR=$SCRATCH/config`, `AGENTHUB_HOME=$SCRATCH/home/hub`, `AMEM_HOME=$SCRATCH/home/amem`. No Claude credentials were copied and no model turn was requested. The initial scratch environment snapshot retained an unrelated inherited credential variable. Both environment snapshots were deleted, and version, host-kit and all scratch reads were repeated with an explicit allowlist: PATH, TMPDIR, LANG, TERM, HOME, CLAUDE_CONFIG_DIR, AGENTHUB_HOME, AMEM_HOME and GIT_CONFIG_GLOBAL. No credential value was printed, tracked or used for a model turn. Child read probes explicitly set only `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID=c0-isolated-session`, `AGENTHUB_PEER_ID=claude`.
- `claude --version`: exit 0, `2.1.319 (Claude Code)`.
- `claude plugin --help`, `plugin init --help`, `plugin test --help`, `plugin validate --help`: exit 0. Help for test says it runs tests in an environment like mod hooks; that is not a live UI session.
- `claude plugin init c0-probe --with hooks --author fixture --author-email fixture@example.invalid`: exit 0; writes only the isolated config's `skills/c0-probe` and bookkeeping. No plugin installed into a real profile.
- Replaced only the scratch scaffold's hook manifest with `{"modules":["./register.ts"]}` and an empty default-export function. A scratch test imported `test, expect` from `claude-code/testing`, asserted true, and inspected context method names. `claude plugin test <scratch mod>`: 1 pass, 0 fail. This only establishes the kit loads, not that the empty default export registers a real host hook. No synthetic event was promoted to native evidence.
- Root checkout's pre-existing node_modules initially failed source CLI loading with missing `recordsEnabled`; a fresh `bun install --frozen-lockfile` in the dedicated worktree completed under resource admission, without modifying root dependencies or the lockfile.
- The initial scratch root used `/var` while the registry canonicalized to `/private/var`; startup refused on the mismatched journal root. A fresh scratch project was used, with the registry's canonical `project.root` passed unchanged to the daemon. No stale lock or journal was altered.
- A one-shot fixture imported `Registry`, `startDaemon` and `DEFAULT_CONFIG` from that worktree, registered only the scratch root, claimed its own pid and random instance id, and started with random ports. Memory, specs and MLX were disabled; no peer was started. `try/finally` stopped the daemon and closed the fixture registry. This direct embedding fixture created the scratch hub; no person-only CLI startup gate was bypassed.
- Reads used `Bun.spawn([bun, <worktree>/src/cli/main.ts, '--project', canonicalRoot, ...argv], {cwd:canonicalRoot, env:isolatedClaudeMarkers})`, stdout/stderr pipes, a 2000 ms child kill bound, and awaited each child exit. These were real CLI subprocesses, not `$.process` calls.

| Read argv | Exit | Observed result |
| --- | --- | --- |
| `status --json` | 0 | JSON `version=0.35.0`, `cwd` equals canonical scratch root, matching project id, empty tasks; `needs={act:0,watch:0,state:sleeping}` |
| `board --json` | 0 | `[]` |
| `projects --json` | 0 | JSON registrations confined to this scratch home |
| `queue list` | 0 | `no retained deliveries`; this empty scratch result grants no mutation authority |
| `tail` | 1 | `claude cannot run ahub tail; the person runs it in ahub console or a terminal`, due to inherited Claude markers |

`tail` is also unsuitable by source inspection: `src/cli/main.ts` renders event, context, notice and permission free text. The companion excludes it rather than reading bodies or introducing a poller.

Real `~/.claude/settings.json`, read-only SHA-256 at the isolated native-probe boundary only:

- Before: `1935b1c8fb7fa8cc7530f25f472cad87d269b0b6e5e3803aecf41a2b799e1f70`
- After: `1935b1c8fb7fa8cc7530f25f472cad87d269b0b6e5e3803aecf41a2b799e1f70`

A later read-only pre-push audit, independently confirmed at **2026-11-09T08:12:37Z**, observed SHA-256 `0c0243e6a7bc58d814ee26efe4d98469ffddffb013ed5d50dc1e3e6233cc2b2b`. Cause: **UNKNOWN**. The matching before/after hashes above cover the native-probe boundary, not the whole task or PR interval. No settings contents were read, no restore or write was attempted, and no further native probe was run after this observation.

No real `statusLine`, statusline-tee or hub was loaded or edited by this task. Scratch CLI proof is separate from the four NOT RUN surface receipts. No claim of native isolation confinement, supported mod version or UX improvement follows from these probes.
