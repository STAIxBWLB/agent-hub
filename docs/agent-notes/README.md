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
