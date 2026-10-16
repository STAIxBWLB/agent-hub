# Agent-mem P0 failure registry

Issue #412 P0 annex. Inventory: `docs/plans/amem-cases.json` (60 cases, 8 modes). Source references were relocated against HEAD `5af9eb9bff85f4705a351441ea7d3ff1553cf121`; case status is the inventory status, not a new verification claim. This document records retained source assertions and declared ceilings; tests and live legs were not executed for the mapping.

Evidence scope is repo-only: all mechanism and regression references below come from this checkout; external historical outcomes are retained as inventory status, not newly verified.

## Table A

Owner names describe the mechanism after the split. P4 ports core regressions; P5 retains hub integration regressions. Mixed rows can cite both. A `ceiling` citation records the first words of a current `ponytail:` comment and does not claim the limitation is fixed. S04 has no planned phase because a consensus broker is out of scope. I06 preserves the exact template source, including substitutions, for its 12 parameterized tests.

| id | mode | status | owner module | phase | retained regression or declared ceiling |
| --- | --- | --- | --- | --- | --- |
| T01 | Truth/lifecycle | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review fixes: deadlines are fixed when written, ids resolve within the project's view, and a cut-short settlement finishes at the next start` |
| T02 | Truth/lifecycle | regression-covered | agent-hub: tasks.ts | P5 | `test/memory-native.test.ts` :: `a late note on an already approved task starts its clock at once (review of #352)`; `test/memory-store.test.ts` :: `review of #352: a late short-term note on a settled task gets its own clock, and a forgotten replacement shows the old entry again` |
| T03 | Truth/lifecycle | regression-covered | agent-hub: tasks.ts | P5 | `test/memory-native.test.ts` :: `an explicit short horizon on an open task is never promoted, and a bad short_ttl_days fails the config (review of #352)`; `test/memory-store.test.ts` :: `review of #352: an explicit short note on an open task keeps its own deadline through approval` |
| T04 | Truth/lifecycle | regression-covered | agent-hub: tasks.ts | P5 | `test/memory-native.test.ts` :: `an approval a stop cut off before its settle entry is settled when the hub starts again (review of #352)`; `test/memory-store.test.ts` :: `review fixes: deadlines are fixed when written, ids resolve within the project's view, and a cut-short settlement finishes at the next start` |
| T05 | Truth/lifecycle | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a demoted copy takes its hidden original with it, and malformed synced lines are skipped`; `test/memory-store.test.ts` :: `review of #352: twice-promoted chains, non-string metadata and provenance nodes` |
| T06 | Truth/lifecycle | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a superseded source of a settled task is kept for when its replacement goes, and a corrupt machine id fails the store`; `test/memory-store.test.ts` :: `review of #352: a held source moves to long-term as soon as its replacement is forgotten`; `test/memory-store.test.ts` :: `review of #352: a held source is promoted when its replacement expires while the store is idle, and an unreadable expiry is skipped` |
| T07 | Truth/lifecycle | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a promoted replacement keeps its supersession, and a promotion is dated as its source`; `test/memory-store.test.ts` :: `review of #352: promoting a replaced entry keeps it replaced, and a non-UTC at is skipped` |
| T08 | Truth/lifecycle | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a supersession that would close a cycle is refused, and an undated settle is skipped`; `test/memory-store.test.ts` :: `review of #352: a cycle made by supersessions written apart drops its earliest relation` |
| T09 | Truth/lifecycle | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a later supersede op wins over an earlier note's own supersedes` |
| T10 | Truth/lifecycle | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a note on a task never approved leaves after the fixed backstop, and the CLI screens what it prints` |
| T11 | Truth/lifecycle | guard/design | agent-mem: import.ts | P4 | `test/memory-phase3.test.ts` :: `claude-mem import copies the hub's notes of this project once, never model answers, PII or secrets, and never writes claude-mem`; `test/memory-phase3.test.ts` :: `model-suggested edges are drawn but are not evidence until a person confirms them; a rejected one disappears` |
| D01 | Duplicate/identity | fixed-source | agent-mem: import.ts | P4 | `test/memory-sync.test.ts` :: `CLI claude-mem imports use text-only nodes across checkouts and local deny policies, then converge in either sync order` |
| D02 | Duplicate/identity | fixed-source | agent-mem: store.ts | P4 | `test/memory-dedupe.test.ts` :: `legacy dedupe lists without writes, applies append-only, repeats without writes, and forget removes the whole tuple`; `test/memory-dedupe.test.ts` :: `dedupe sends a single remaining head to the newest valid outside terminal, preserving both personal replacements`; `test/memory-sync.test.ts` :: `legacy duplicate dedupe syncs append-only and divergent prior relations converge after a re-run` |
| D03 | Duplicate/identity | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: two machines promoting the same demoted entry write one copy` |
| D04 | Duplicate/identity | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a short-term id kept past its task's approval reaches the promoted copy`; `test/memory-store.test.ts` :: `review of #352: another machine with only the synced copy resolves the original short-term id` |
| R01 | Retrieval/capture | guard/design | agent-mem: recall.ts | P4 | `test/recall.test.ts` :: `kimi gets every platform in one call; codex gets the other platforms only, without the repeated legend` |
| R02 | Retrieval/capture | regression-covered | agent-mem: recall.ts | P4 | `test/recall.test.ts` :: `the token budget is split per platform so the first one cannot crowd out the rest` |
| R03 | Retrieval/capture | guard/design | agent-mem: client.ts | P4 | `test/memory.test.ts` :: `fail-open: a stopped worker, an unknown endpoint and a hang all yield undefined with one log line` |
| R04 | Retrieval/capture | historical-fixed | agent-hub: capture.ts | P5 | `test/local-worker.test.ts` :: `claude-mem capture: init, one observation per tool call, summarize, session-end; skip list and denylisted paths stay out; a down worker blocks nothing` |
| R05 | Retrieval/capture | historical-fixed | agent-hub: capture.ts | P5 | gap |
| R06 | Retrieval/capture | historical-fixed | agent-hub: bus.ts | P5 | `test/bus.test.ts` :: `shared notes ride in the preface after recall, never as a delivery of their own; the newest ten are kept` |
| R07 | Retrieval/capture | historical-fixed | agent-hub: bus.ts | P5 | `test/bus.test.ts` :: `a preface made while a delivery is in flight survives that delivery's failure, and both go out once` |
| R08 | Retrieval/capture | historical-fixed | agent-hub: templates/AGENTS.block.md | P5 | gap |
| R09 | Retrieval/capture | historical-partial | external: claude-mem | external | gap |
| R10 | Retrieval/capture | historical-partial | external: claude-mem | external | gap |
| R11 | Retrieval/capture | historical-partial | external: claude-mem | external | gap |
| R12 | Retrieval/capture | historical-fixed | external: claude-mem | external | gap |
| R13 | Retrieval/capture | fixed-source | agent-mem: import.ts | P4 | `test/memory-phase3.test.ts` :: `claude-mem project filtering prevents starvation and the local cursor advances bounded windows, including skipped rows`; `test/memory-phase3.test.ts` :: `claude-mem cursor survives reopen and resets a recreated project source even when unrelated rows have higher ids`; `test/memory-phase3.test.ts` :: `claude-mem cursor records completed rows after a callback error and restart reconsiders earlier privacy skips` |
| X01 | Project isolation | open-ceiling | external: claude-mem | external | ceiling `src/memory/import.ts` :: `ponytail: claude-mem keys projects by` |
| X02 | Project isolation | regression-covered | agent-mem: import.ts | P4 | `test/memory-phase3.test.ts` :: `claude-mem import copies the hub's notes of this project once, never model answers, PII or secrets, and never writes claude-mem` |
| X03 | Project isolation | regression-covered | agent-mem: recall.ts | P4 | `test/memory-store.test.ts` :: `review fixes: deadlines are fixed when written, ids resolve within the project's view, and a cut-short settlement finishes at the next start`; `test/memory-store.test.ts` :: `review of #352: projects are keyed by their origin remote, or by name and directory without one`; `test/recall.test.ts` :: `worktrees use the native parent and parent/worktree aliases` |
| X04 | Project isolation | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a replacement never narrows who sees an entry` |
| P01 | Privacy | fixed-source | agent-hub: tasks.ts | P5 | `test/tasks.test.ts` :: `a done summary, review note or unmet item matching a PII pattern reaches neither claude-mem nor a cloud peer`; `test/tasks.test.ts` :: `the completed-change notice leaves out a summary line and file names that match a PII pattern` |
| P02 | Privacy | fixed-source | agent-hub: adapters/local-worker.ts | P5 | `test/local-worker.test.ts` :: `hub tool capture cannot leak refused notes, withheld summaries or PII proposals`; `test/local-worker.test.ts` :: `refused hub_send text is not captured while ordinary file tools still are` |
| P03 | Privacy | fixed-source | agent-hub: daemon.ts | P5 | `test/local-worker.test.ts` :: `daemon local board lists expose PII rows only in a PII turn, never ordinary history or answers` |
| P04 | Privacy | regression-covered | agent-hub: tasks.ts | P5 | `test/memory-native.test.ts` :: `a note about a private path is refused before either memory sees it (review of #352)`; `test/memory-store.test.ts` :: `review of #352: notes leaving for a model are screened under the current PII policy, and a replaced promoted copy stays replaced elsewhere` |
| P05 | Privacy | regression-covered | agent-mem: recall.ts | P4 | `test/memory-store.test.ts` :: `review of #352: notes leaving for a model are screened under the current PII policy, and a replaced promoted copy stays replaced elsewhere` |
| P06 | Privacy | regression-covered | agent-hub: cli/memory.ts | P5 | `test/memory-store.test.ts` :: `review of #352: a note on a task never approved leaves after the fixed backstop, and the CLI screens what it prints` |
| P07 | Privacy | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: every promotion goes through the screen: a note it keeps stays short-term, another project's waits`; `test/memory-store.test.ts` :: `review of #352: the promotion screen ignores a task key's numbers, sees the task's current paths, and a refused promote says why` |
| P08 | Privacy | guard/design | agent-mem: sync.ts | P4 | `test/memory-sync.test.ts` :: `a public remote is refused, an unknown one warns, and a store with no remote creates nothing` |
| P09 | Privacy | fixed-source | agent-hub: config-trust.ts | P5 | `test/config-trust.test.ts` :: `a committed config keeps the defaults for every machine-local field, logs them, and still applies the rest` |
| I01 | Index integrity/freshness | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `an incremental index equals a rebuild from the logs, in any order, and bad lines are skipped`; `test/memory-store.test.ts` :: `review of #352: a demoted copy takes its hidden original with it, and malformed synced lines are skipped`; `test/memory-store.test.ts` :: `review of #352: promoting a replaced entry keeps it replaced, and a non-UTC at is skipped`; `test/memory-sync.test.ts` :: `review of #354: a lock a killed git left behind never hides this machine's entries, a poisoned goal line is skipped, and goals pass the PII screen` |
| I02 | Index integrity/freshness | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a segment that shrinks rebuilds the index, and two hops pass through provenance`; `test/memory-store.test.ts` :: `review of #352: a segment rewritten in place without shrinking rebuilds the index`; `test/memory-store.test.ts` :: `review of #352: a rewrite past the first 4 KiB is caught, and mem: ids resolve` |
| I03 | Index integrity/freshness | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a note written while the index is locked shows on the next read` |
| I04 | Index integrity/freshness | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a note written while the index is locked shows on the next read` |
| I05 | Index integrity/freshness | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a long-lived store reads what another process wrote, with no write of its own` |
| I06 | Index integrity/freshness | fixed-source | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #378: deferred ${change} is indexed by the next ${anotherReader ? "other store's" : "writer's"} relevant read` |
| I07 | Index integrity/freshness | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a read prunes what expired while the store sat idle, so the index equals a rebuild` |
| S01 | Sync/concurrency | regression-covered | agent-mem: store.ts | P4 | `test/memory-store.test.ts` :: `review of #352: a newer entry's graph shows what it supersedes, and a fresh home gets one machine id`; `test/memory-store.test.ts` :: `review of #352: a superseded source of a settled task is kept for when its replacement goes, and a corrupt machine id fails the store` |
| S02 | Sync/concurrency | regression-covered | agent-mem: sync.ts | P4 | `test/memory-sync.test.ts` :: `review of #354: a lock a killed git left behind never hides this machine's entries, a poisoned goal line is skipped, and goals pass the PII screen` |
| S03 | Sync/concurrency | guard/design | agent-mem: sync.ts | P4 | `test/memory-sync.test.ts` :: `two machines sync through a private remote: each sees the other's long-term entries, short-term ones stay home, writes never conflict and a forget propagates`; `test/memory-sync.test.ts` :: `a public remote is refused, an unknown one warns, and a store with no remote creates nothing` |
| S04 | Sync/concurrency | open-ceiling | agent-mem: store.ts | none (declared ceiling) | ceiling `src/memory/store.ts` :: `ponytail: advisory, eventually consistent through` |
| C01 | Scale/cost/measurement | open-ceiling | agent-mem: store.ts | P6 | ceiling `src/memory/store.ts` :: `ponytail: the check and the append are not one step across processes` |
| C02 | Scale/cost/measurement | open-ceiling | agent-mem: store.ts | P6 | ceiling `src/memory/store.ts` :: `ponytail: hashes the whole indexed prefix on every read` |
| C03 | Scale/cost/measurement | open-ceiling | agent-mem: store.ts | P6 | ceiling `src/memory/store.ts` :: `ponytail: a few retries; a store with more writers racing on one segment` |
| C04 | Scale/cost/measurement | open-ceiling | agent-mem: store.ts | P6 | ceiling `src/memory/store.ts` :: `ponytail: computed in memory over all rows` |
| C05 | Scale/cost/measurement | open-ceiling | agent-mem: store.ts | P9 | ceiling `src/memory/store.ts` :: `ponytail: pruning trusts the wall clock` |
| C06 | Scale/cost/measurement | open-ceiling | agent-mem: recall.ts | P1 | ceiling `src/memory/recall.ts` :: `ponytail: 3 characters per token` |
| C07 | Scale/cost/measurement | open-ceiling | agent-hub: daemon.ts | P6 | ceiling `src/hub/daemon.ts` :: `ponytail: recomputed on every poll from the whole index` |
| C08 | Scale/cost/measurement | open-measurement | agent-hub: research.ts | P10 | gap |

## Gaps

A gap is an absent regression for the specific failure, not an assertion that its mechanism is absent. External gaps require upstream or provider evidence; no agent-mem phase can establish them alone.

- R05 (P5): The capture integration checks receipt after stop, but does not assert shutdown awaits the bounded end request before process exit. Add the regression in P5.
- R08 (P5): Rendering tests check workflow kinds, but do not assert generated instructions interpret only presence as reference. Add the regression in P5.
- R09 (external): No repository test reproduces observer prose instead of XML or establishes dropped-data recovery. Obtain an upstream/provider retained regression; ownership remains external.
- R10 (external): No repository test establishes real observer allowance/provider recovery. Obtain an upstream/provider retained regression; ownership remains external.
- R11 (external): No repository test establishes installed plugin/cache/home readiness for the external worker. Obtain an upstream/provider retained regression; ownership remains external.
- R12 (external): No repository test reproduces the launcher compilation versus SessionStart race. Obtain an upstream/provider retained regression; ownership remains external.
- C08 (P10): Counts/report plumbing does not encode causal adoption effectiveness, manual retry labels, or the field window. Add the regression in P10.

## Table B

All live legs are **unrun**. Fixture assertions and this validator cannot close the claims below. Line citations point to the unchecked live requirements in `docs/smoke.md` at the HEAD above.

| id | live leg | owner | phase | status | claim blocked |
| --- | --- | --- | --- | --- | --- |
| L01 | Two physical Macs, private GitHub SSH remote; entries, forget, lease and conflict read back on both | person, claude records | before #258 closes | unrun | Physical cross-machine sync and conflict behavior, `docs/smoke.md:63` |
| L02 | gh reports an actual public test remote and sync refuses it | person | before #258 closes | unrun | Actual public-remote refusal, `docs/smoke.md:64` |
| L03 | Import the real local claude-mem with counts/skips; source DB unchanged | claude | P5 | unrun | Real import and source immutability, `docs/smoke.md:65` |
| L04 | A reachable real model emits dashed suggestions; briefs exclude them until confirmation | claude, person looks at the dashboard | P5 | unrun | Live suggestions and evidence exclusion, `docs/smoke.md:66` |
| L05 | Memory and Long-term tasks tabs, light/dark, phone width, browser | person | P5 | unrun | Human browser inspection, `docs/smoke.md:67` |
| L06 | off / claude-mem / native memory arms, five repeats, plus two weeks of field records (#258 AC11) | claude runs the arms by hand | P10 | unrun | Controlled memory-arm and field effectiveness, `docs/smoke.md:68` |
| L07 | Native Claude/Codex attach with tooling event and installed add-ons (#248) | claude | P10 | unrun | Actual installed runtime fingerprint, `docs/smoke.md:97` |
| L08 | Interleaved randomized add-on arms for claude-mem, ponytail, ripwire, five repeats (#248 AC2/3) | claude | P10 | unrun | Controlled add-on comparisons, `docs/smoke.md:98` |
| L09 | Two weeks of research.enabled, then the add-ons report (#248) | person enables, claude reports | P10 | unrun | Field observation window and report, `docs/smoke.md:99` |
| L10 | Revise the add-on decisions from measured results | person | after P10 | unrun | Evidence-backed adoption decisions, `docs/smoke.md:100` |
