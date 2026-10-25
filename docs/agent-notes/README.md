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
