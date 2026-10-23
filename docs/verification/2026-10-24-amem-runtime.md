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
