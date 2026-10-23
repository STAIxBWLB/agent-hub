# amem runtime integration receipt

Task #392, agent-mem#13 Design F and AC7. The branch consumes the published first-party library, without vendoring it. This receipt describes fixture evidence, not a personal-memory migration or a live provider/model run.

## Publication

A cache-busting npm registry read on 2026-10-24 reported latest 0.6.0, published 2026-10-23T19:15:25.981Z, gitHead `2a182f2f23b7744a746b6854f9fb920df627a99f`. It contains P3 squash `0df2cf91`. The manifest and lock exact-pin 0.6.0; Bun 1.4.2 installed it before bundle generation.

## AC7 mapping

- Recall: actual temporary MemoryStore rows supply bounded curated recall; canonical project scope ignores the old caller's basename chain. Complete-row host screens exclude another project and private rows before selection. Native long-term/fails-first recall remains; supplemental short-term context replaces model-produced worker observations.
- Capture: real published CaptureStore receives deterministic lifecycle/tool records, closes per append, and owns cap, retention and contention replay. A duplicate tool call is captured once; repeated Stop events at the same clock still remain distinct. Complete input/output is screened before the excerpt bound. Denied paths and memory bookkeeping are excluded. Capture rows never become curated ask/brief evidence.
- Ask: genuine full `mem:` ids survive evidence generation and citation validation. A fake model's correctly cited answer is accepted using only actual stored evidence. Model answers/checkpoints are pending candidates; candidate text retains submitted metadata and kind. Old model-answer titles are excluded from curated projections.
- Briefs: actual library rows supply search and neighbourhood results using published SearchIndex after screening. Native graph/fails-first presentation stays authoritative. Full ids do not invent legacy observation numbers.
- No worker: the actual-client integration runs with fetch blocked and a worker tripwire listener that receives zero requests. Runtime client/capture expose no URL or worker endpoint dispatch. HTTP retained in test/fakes/mem-worker.ts is an explicitly injected host-only fake for historical ordering/privacy tests.
- Privacy/profile: a real daemon with malformed selected-profile metadata completes two public local read turns and answers status while no capture database or spool is created, including SessionEnd. Selector bytes remain unchanged. Private turns remain suppressed by LocalPeer before capture; existing PII/secret/path tests retain their assertions.
- Gate: required full `scripts/check.sh` and its exact head/check tail are recorded in the task handoff. Both OS CI is a separate reviewer check.

## Validation and boundaries

Pinned typecheck, bundle generation and 309 focused tests (1940 assertions) pass. A further 19 tests (265 assertions) verify the privacy change and profile fence. Reverting full-id citation support and bypassing complete-event capture screening each causes a named actual-store test to fail; original source is restored afterward. Final full-gate results supersede these focused checks.

OCR delegation selected 11 reviewable files. Independent source review covered the eight production modules and manifest; generated bundle is checked by regeneration/freshness, and the test-only HTTP fixture is classified separately. It found three concrete issues (citation grammar, event identity/time and unavailable-profile capture), all fixed and rechecked, plus a misleading successful-save suffix, removed. Excluded tests/docs/lock are not claimed as OCR-covered. No reviewer verdict or CI result is inferred from this local review.

Accepted behavior changes and ceilings are in docs/memory.md. Supplemental reads refuse above 4096 curated rows; policy-aware paging is the upgrade path. Duplicate-call timestamps retain 1024 newest ids; older repeated ids can capture again, and a host-supplied source-event timestamp is the upgrade path. Candidate text including provenance must fit the package's complete 4000-character bound or save is unavailable. `memory.native=false` deliberately disables curated reads/writes; enabled capture still requires its own selected-profile binding. `memory.worker_url` is ignored. Doctor reports installed library availability, not a store health proof. Historical benchmark arm labels are not evidence of a live worker or comparable new collection.

No personal memory bytes were migrated, no claude-mem worker was stopped, and no release or publication is performed by this PR. The person-run cutover, real device sync and P6 resource/retrieval week remain separate.


## Full-gate contract refresh

The first full gate at `eb35d8b6` completed 6712 tests: 6708 pass, three obsolete contract assertions failed, one installed legacy/new consumer-parity leg skipped, and no current-invocation daemon leaks. The failed assertions expected the retired doctor worker row and duplicate auxiliary saves after a native write. Their replacements assert the exact-pinned library row, no worker row, native payload/kind preservation and zero auxiliary copies. A further 15 tests (133 assertions) pass, including a valid production daemon with a legacy worker tripwire URL: curated recall and control ask work, deterministic lifecycle/tool capture persists, raw capture is absent from evidence, and the listener receives zero requests. Reverting the unavailable-profile capture fence fails its actual daemon test on capture artifacts. Source is restored after each mutation.

New memory_brief events identify source amem while retaining the old scalar claudeMem count for log-reader compatibility. Doctor attests the installed version against the exact pin without opening a memory store. The installed legacy/new consumer-parity skip is retained as unverified; this environment did not provide an installed ahub for that leg. Final required full-gate results are in the handoff, not inferred from focused checks.


## Capture invocation identity

The e90388b3 full suite passed 6712 tests with one installed-consumer skip and no leaks, but a separate actual-store probe found a missing case: two real turns reusing provider id call_0 produced only one tool row. A red-first real daemon test then executed four identical reads using call_0 twice per turn over two turns; all provider/control assertions passed before the capture count failed (expected 4, got 1).

Capture now receives the existing LocalPeer session/turn/step plus a host invocation counter as sourceId. Its timestamp cache and published-store receipt bind that identity, while the original provider toolUseId remains metadata. A same-clock direct test separately proves that one observation replays once and different host invocations remain distinct. The real daemon test and prior local-worker/privacy tests pass together (31 tests, 222 assertions). The modified host path retains its private-turn gate and tool exclusions. The final full gate and exact fixed head are recorded in the handoff; the earlier green head is not claimed as proof of this fix.


## Structured write-policy boundary

The invocation-fixed 8b8b2025 full gate passed 6713 tests with one installed-consumer skip, no failures and no leaks (882.56 s). A later write-boundary probe found that JSON-escaped strings could bypass a whitespace PII pattern. The first probe used an inadmissible newline pii.paths entry and is not counted as production evidence. The corrected red-first tests use the valid routing pattern private\s+folder; raw path/value/key/title and a private JSON output tail beyond character 4000 are refused. A valid space-containing private-path policy also exposed cwd metadata falsely suppressing public events. These tests and complete custom-deny-path checks failed seven named assertions against 8b8b2025, without timeouts.

Write policy now sees literal structured keys/values (including key: value secret pairs) and encoded actual data. Known tool input/output JSON is decoded once from full source text; storage bounding follows screening. Non-persisted host cwd/session/source identifiers are separated from content while canonical project/profile fences remain. The published store still owns final normalization. Public controls prevent a deny-all implementation from passing; the old fake HTTP response alone retains its legacy 4000 cap. Focused typecheck and 39 tests/276 assertions pass. A follow-up red-first numeric-password case fails on the string-only projection and passes when finite JSON scalars also contribute key: value pairs; the failed assertion received a stored capture id. The red-proof wrapper initially expected an error label Bun did not print, so its exit was not treated as the test result; the named assertion and restored source were checked directly. The earlier green full heads are not claimed as proof of this final privacy delta; the handoff records its own exact full-gate head/result.


## PR 752 first-review corrections

The obsolete worker-platform whitelist is removed from both the client and recall caller. Actual-store notes by local, jcode, Claude and Codex are delivered to every receiving peer, including its own notes; privacy and canonical-project exclusions stay before rendering. Supplemental reads now use the public bounded exact-project keyset pages, keep the newest candidates, and report truncation in recall/brief text and control status. Other projects' shared rows no longer displace these supplemental rows; native shared long-term recall remains. Relation metadata folding is a core cost still outside the row-body bound.

The production native ask source now emits full memory ids, matching the client before dedupe and evidence budgeting. Legacy short-id host fixtures canonicalize only when one full id uniquely matches the prefix. Colliding full ids remain distinct. Capture reuses its profile-bound handle, reopens on changed effective R6 config before the next append, releases it on refusal/shutdown, and persists relative file paths instead of commands or absolute paths. The substring fallback matches separate terms. The legacy fallback invocation ceiling is explicit; live LocalPeer always supplies its own invocation identity. Stale agent-facing worker text and the identical-branch ternary are removed. Final exact-head test and CI state belong to the handoff; earlier green heads do not establish this delta.


First-review validation before the final gate: pinned Bun 1.4.2 typecheck and bundle rebuild pass; 153 focused tests across nine files pass with 6644 assertions. Four restored-old-behavior probes each fail a named assertion for all-author recall, bounded page reads, ask id dedupe and relative-only path metadata, then restore source byte-for-byte. The cached-handle regression also changes home R6 bounds from 512 MB/90 days to 1 MB/1 day and proves the next append reopens the handle and removes the expired row. A real daemon control response and the person's status renderer both expose truncation. The required full-gate result and its exact head follow in the task handoff, not inferred from this focused run.


## PR 752 second-review CI correction

At `e288b1a4`, run 40028391482 failed Ubuntu's cancellation-permission fixture. macOS job 120670470231 had no failing assertion: the cancellation test and both document-baseline tests passed, and the suite was still passing benchmark tests when the 1260-second whole-suite watchdog terminated it (exit 143, no invocation daemon leaks). No snapshot fixture change was needed for that run.

Only the cancellation late-answer fixture now holds the existing Bun fake-clock/timer ports after live child setup and before the permission request. It awaits a native WebSocket permission push instead of polling a fake clock, then cancels and answers allow while expiry and heartbeat remain held. The existing permit acknowledgement and final deny assertions are unchanged, with extra held-clock/timer/restoration controls. Real timers are restored in finally before daemon cleanup; ordinary expiry and stop tests retain real timers. A native WebSocket probe shows I/O remains live with both timer paths held. All 15 permission/projection tests pass (172 assertions). Removing the current-task cancellation guard fails the named final deny assertion, then the exact source is restored.

Per the progressing-cutoff rule in tests.md, hosted macOS alone gets a 1440-second whole-suite watchdog and a 30-minute job ceiling. Ubuntu remains at 1080 seconds and 25 minutes, and every individual test keeps its 20-second limit. Production permission, snapshot and P3 resource limits are unchanged. Exact-head full-gate and CI status are recorded in the handoff.

Pinned typecheck passes. The installed actionlint parser rejects the pre-existing concurrency.queue key identically on the baseline and modified workflow; it reports no additional diagnostic, and a successful actionlint run is not claimed. GitHub CI remains the workflow execution proof.
