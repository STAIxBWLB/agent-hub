# SDLC for agent-hub (#257)

## Authority and evidence

The issue remains the specification, Tasks remains the sole task mutation boundary, and GitHub remains authoritative for PR heads, required checks, merge commits and releases. The hub stores artifact identities and bounded structured readbacks, never issue/PR bodies. Off is the default. Advise exposes blockers without changing task transitions. Enforce blocks only the review/approval transitions listed below; it never merges, releases, edits GitHub or gives a peer additional capabilities.

A reviewed head is a full lowercase 40-character SHA observed through a successful readback, not an implementer-supplied statement. A check is evidence only for that same head. Unknown/missing required checks, unavailable GitHub, pending reviews or unresolved threads remain blockers in enforce and visible unknowns in advise. A newer head invalidates the derived review and approval readiness. Historical task approval is retained as history, not presented as approval of the new commit. Revalidate after asynchronous readbacks immediately before any board write.

## Default lifecycle

| Stage | Acting role | Artifact or exit gate | Enforcement |
| --- | --- | --- | --- |
| spec | person/planner | issue identity and scope | shown |
| plan | planner/owner | plan, branch, existing predecessor gates | existing Tasks rules |
| implement | owner | PR identity/current head and local check on that head | entering review, when enabled |
| review | assigned reviewer | current head-bound verdict, no pending change request/open thread | approval, when enabled |
| verify | verifier/reviewer | required checks and local gate on the reviewed head | approval, when enabled |
| merge | person | current-head readiness, ordered touching PRs | shown; no mutation |
| release | person | merged commit, version/tag, docs freshness/live receipt checklist | shown; no mutation |

The repository uses feature branches and PRs. Release PRs require merge commits because documentation stamps name release-branch ancestors. Do not describe squash as a universal release practice. Worktree/branch cleanup follows confirmed merge; installation and native readback are separate live receipts. A successful source gate cannot certify those receipts.

## Configuration and persistence contract

.agenthub/sdlc.toml contains mode off|advise|enforce and a bounded ordered stage list, using the built-in stages above by default. Each gate has a closed evidence type and an explicit actor role. Unknown stages/gates, duplicate stages, cycles, unbounded lists and unknown keys are refused with a field-level reason. A project file may define guidance/gates, but it does not expand capabilities or permissions.

Task lifecycle fields store stage, issue/PR identity, observed head, reviewed head, local-gate head/result and bounded check/readback metadata. Legacy rows read with no lifecycle metadata. Every change goes through Tasks and records its actor; adapters/tools/CLI never write Board directly. Readback timestamps identify observations, not a freshness promise. Persist no task text in lifecycle receipts; public output uses the existing PII stub and publicTitle/publicView.

A reviewer records the head it actually reviewed. If GitHub no longer reports that head, a stale verdict refuses before effects. Changes requested does not require green CI. Approval requires a current review and all configured required checks successful on that head; neutral/skipped does not substitute unless explicitly allowed by the project's gate contract. A local check records an exact SHA and its result; it is a claimed local receipt, labelled separately from externally fetched CI.

## Readbacks and presentation

Use structured gh JSON/GraphQL read-only calls with validated repository and numeric artifact identities. No shell interpolation, PR/issue body fetching, token logging or unbounded comment storage. Failure yields unknown. Required checks come from repository rules or explicitly configured names; an empty/unknown set is not silently green. Review-thread status is counted, not copied. Cancellation and task-owner generation fencing prevent a late read from approving reassigned work.

ahub sdlc status and explain expose mode, stage, gate, observed/reviewed/local-check heads, next actor and next action. Console/dashboard derive the same result. Merge ordering compares exact PR path sets, reports intersections and never guesses an automatic landing order where dependencies are unknown. Release readiness lists merged work since the tag, stale/nonancestor documentation stamps and open native/live receipts; each unknown remains visible.

## Composition and measurement

The #252 gsd-lite option remains guidance, bounded predecessor edges and criterion/evidence-ref checklists over the same board. It creates no second STATE/PLAN/HANDOFF authority and cannot auto-advance. #259 profiles supply project defaults without changing gate authority. #247 records store ids, timings and outcomes, not plan text. #251 compares off/advise/enforce and default/gsd-lite on a sealed common suite, with failures, unknowns, operator interventions and overhead retained. No experiment was run for this design.

## Delivery and verification state

Design only: this note specifies implementation before code. Configuration validation, persistence, fake-gh stale-head/required-check tests, Tasks transition integration, CLI/console/dashboard and a live advise cycle remain pending. A native/account cycle must be recorded separately; no merge or release is implied by this document.
