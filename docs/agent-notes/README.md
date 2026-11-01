# Agent note background

Human explanation. Agent instructions: the area notes in this directory.

On 2026-10-13, two PR #368 reviews found that a missing delivery id or a missing visible row could select another Queue row. The console navigation rule in daemon.md records the exact-row contract. The missing-row and ID-less secondary-delivery regression tests demonstrate both cases.

Background behind some of the rules, moved from the top-level README on 2026-10-16:

- Benchmark trust entry: the review rounds of #115 kept finding paths that broke
  the runner's settlement of the Claude trust entry.
- Reply addressing: leaving `to` empty fanned a reply out to every peer, which is
  what made one directed question cost every agent a turn.
- Bun test hang: the stacks of two local hangs show a test timeout starting the next
  test inside `Bun.spawnSync`'s own event loop (#115,
  `docs/verification/2026-10-03-0.12.6.md`); minimal reproductions did not hang, so
  the full trigger is not pinned down. On Bun 1.4.2 the next test still starts there
  (#121, checked directly); the spin was not reproduced on demand on either version.

The #451 predicate and identity-lookup moves exposed unbound names in a VM fixture
that extracts daemon closures. Reconnecting imported helpers and deterministic
identity ports preserved the fixture's existing assertions; changing the asserted
behavior would have hidden the missing dependency.

Background moved out of the area notes for 0.12.45:

- Instance execution git budget (#225, daemon.md): `resolveInstanceExecutionCwd` runs synchronously on the daemon's event loop (an extra-instance start, `turn_revert`) with up to four git calls, measured at about 15 ms on a warm local repository. One shared 5 s allowance holds the loop at most 5 s, not 4 x 5 s. It stays synchronous because the CLI and recovery callers are; an async twin for the two daemon call sites is the upgrade if a typical resolution ever costs more than a few ms.
- Claude steer version gate (#493, #221, daemon.md): mid-turn consumption of a steered important message was proven only on Claude Code 2.1.302 (`docs/verification/2026-10-18-493-claude-busy-channel.md`); on an older client a dropped mid-turn notification stays `accepted` until a person resolves it. The hello does not carry the client version, and the oldest working version is unknown, so a gate would be a guess that could disable a working path.
- Planner reservation and done gates (tasks.md): in #378 a same-value planner write laundered a person's reservation; in #382 advise recorded overlapping dones, and an owner could neither relink a PR nor be stopped from carrying a head to a new PR.
- Process-tree stops (adapters.md): three review rounds of #113 found snapshot gaps while the tree ran (groups of its own, an unreadable first read, a child started during the grace period).
- Local worker (local-worker.md): a bare `private/` deny entry once denied all of `/private/var`; `existsSync` made a dangling link look like a new file, so a write landed at its target.
- Suite watchdog (tests.md): macOS CI hit `AHUB_CHECK_HANG_S` while tests still passed (#378, #593).

Background moved out of the area notes for 0.13.0:

- Jcode MCP entry (#685, adapters.md): jcode gives an MCP entry's own env precedence over the process env (probed on 0.99.0), so a peer id in the shared `.jcode/mcp.json` entry would make every extra instance act as `jcode`.
- Bulk queue discard (#713, bus.md): a queued row with no journal record of its own carries the journal's global revision, which every discard moves, so a revision read once at the start goes stale after the first discard.
- Usage roll-up (#683 U2, budget.md): a pass cap smaller than one log line once hung the fold.

Background moved out of the area notes for 0.15.0:

- I-2 as the last reviewer check (#744, tasks.md): placed earlier, it refused an offline former implementer as "implemented this task" instead of "offline", which turned a task that used to approve directly into a blocked person review.

Background moved out of the area notes for 0.16.0:

- Closing-refs negation list (#760, tests.md): agent-mem PR #36 said "Does not close #15", GitHub read `close #15` as a closing keyword, and the design issue closed with T3 open. The list errs toward flagging: a false positive costs a rewrite of the PR text, a false negative closes a design issue, and a body that really means a qualified close is the author's to reword. A keyword typed into a comment or the merge dialog is out of the check's reach. At 0.16.0 `closing-refs` is not a required status check (branch rules require `check (ubuntu-latest)`, `check (macos-latest)` and `seeded guards`).

Background behind the 0.18.0 rules:

- CLI print guards (#814, tests.md): a command that printed JSON by default made scripts the only reader; each converted command keeps `--json` byte-identical to the old output, and the guard scans for both a bare `JSON.stringify` print and a bare print of a hub tool's text so a new unlisted command cannot slip back.
- Agent shell authority (#812, adapters.md): reading public state is allowed for every agent, the conductor gets a closed operational family, and every other form stays the person's. An allowed read form is added only when the daemon admits it for an ordinary tools connection too.

Background behind the 0.19.0 rules:

- Code-scope verdicts (#852, tasks.md): two review rounds showed that any classifier reading a `code` reviewer's unmet text files real defects, such as "the CI workflow is missing the trigger", as verification-only, so the evidence-only rule reads only the structured findings.
- Policy-table fixtures (#843, tests.md): a fixture with a fixed list of keys or versions, which a planned `COMPAT` entry was not in, was reported twice in #843.
- Suite watchdog (#516, tests.md): a total-time kill cut suites that were still passing tests line by line (hosted ubuntu runs at 1080 s, the macOS leg of PR #857 at 1440 s), so a lost-progress bound became the hang detector and the total bound only its backstop.

Background moved out of the area notes for 0.21.0:

- Cold shim exec (#519, tests.md): the first exec of a newly written executable cost about 250 ms on macOS against 6 to 8 ms afterwards, the whole of a 250 ms product bound; `test/memory-code-head-684.test.ts` failed 24 of 30 isolated runs until it warmed the shim. The real probe with a plain `git` measured 10 ms at worst over 600 calls under CPU load.
- Held snapshot clock (#550, #554, tests.md): `test/settings-reload-daemon.test.ts` without `snapshotClock` failed 138 of 150 single-test runs at 50 parallel, 0 of 150 with it. Before #554 a held clock still left each git child 250 ms, so a loaded runner turned a slow git into unknown evidence (3 of 100 at 100 parallel in `owner-write-evidence-daemon`); the fix landed in `src/hub/snapshots.ts`, outside the planned paths, with the planner's approval.
- macOS shards (#548, tests.md): counting the shard names in `gateJob()` was planner-approved outside the card's paths. In the first hosted run of PR #954 a cold `/usr/bin/git` took over a second, and 8 tests that run it with `PATH=/usr/bin:/bin` and a 1000 ms timeout were killed at about 1000 ms, against about 140 ms in an unsharded leg that had run git earlier. Without the `AHUB_CHECK_SHARD` unset, any shard but 1 skipped the docs step `test/check-lock.test.ts` expects.
- Status ordering (#531, tests.md): the slow-snapshot status test took 0.52 s idle and failed 17 of 20 runs with 64 CPU spinners on 4 cores at a 1 s bound.
- Config watcher off (#546, tests.md): the pet reload test failed 8 of 200 runs at 40 parallel on 18 cores until the watcher was off, and 0 of 200 after.
- Web fetch transport (#553, tests.md): the daemon test's answer waited on iana.org for 99 percent of its time and failed about 3 of 100 runs at 30 parallel on a 4 s bound; a longer wait would only have measured the network.
- Jcode usage (#801, budget.md): Jcode's `totalTokens` adds the cached read on top of an input that already holds it for OpenAI-style providers, and `jcode usage --json` names its limit with free text and no window length.
- Claim verdicts (#901, tasks.md): review of #937 found `factCheck.agreement` counting person-verdict frequencies, which is why a person verdict alone is never an agreement.

- Registered runner integration (#600, daemon.md): the frozen runner contract narrowed issue #1018 from person-or-conductor registration to person-only trust-root changes. Generic machine-local stripping would silently ignore shared/tracked runner keys instead of refusing them, and recursive declaration discovery omitted whole-map scoped replacements after registration existed. The config/recovery fixtures exercise explicit source refusal, atomic whole-block publication, pending raw edits versus accepted revocation, and the separate recovery floor and integrity binding.

Issue #1047 records approved tasks that could not accept a new head or a withdrawn verdict on hub 0.23.1. The prior in-review-only rule left the board bound to an older commit while reviewers handled later PR heads in comments. The approval reopening rules in tasks.md replace that restriction; fixture coverage includes a legacy receipt-only approval, a configured check without a prior reviewer, and a PR merged while a screen is pending.

Review of PR #1050 found that including accepted runner configuration and raw-key presence in release-equality integrity made pending config edits and legacy no-receipt snapshots fail the release step. Runner configuration is mutable startup policy; receipt rows are retained board state. The runner integrity rule now separates those roles, with two-daemon prepare/commit/release fixtures covering both transitions.
