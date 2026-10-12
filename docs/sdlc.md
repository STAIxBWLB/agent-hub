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

.agenthub/sdlc.toml contains mode off|advise|enforce and a bounded ordered stage list, using the built-in stages above by default. The initial loader fixes the built-in stage, gate and actor mapping; custom stage/gate definitions remain pending. Unknown stages/gates, duplicate stages, cycles, unbounded lists and unknown keys are refused with a field-level reason. A project file may define guidance/gates, but it does not expand capabilities or permissions.

Task lifecycle fields store stage, issue/PR identity, observed head, reviewed head, local-gate head/result and bounded check/readback metadata. Legacy rows read with no lifecycle metadata. Every change goes through Tasks and records its actor; adapters/tools/CLI never write Board directly. Readback timestamps identify observations, not a freshness promise. Persist no task text in lifecycle receipts; public output uses the existing PII stub and publicTitle/publicView.

A reviewer records the head it actually reviewed. If GitHub no longer reports that head, a stale verdict refuses before effects. Changes requested does not require green CI. Approval requires a current review and all configured required checks successful on that head; neutral/skipped does not substitute unless explicitly allowed by the project's gate contract. A local check records an exact SHA and its result; it is a claimed local receipt, labelled separately from externally fetched CI.

## Readbacks and presentation

Use structured gh JSON/GraphQL read-only calls with validated repository and numeric artifact identities. No shell interpolation, PR/issue body fetching, token logging or unbounded comment storage. Failure yields unknown. Required checks come from repository rules or explicitly configured names; an empty/unknown set is not silently green. Review-thread status is counted, not copied. Cancellation and task-owner generation fencing prevent a late read from approving reassigned work.

ahub sdlc status and explain expose mode, stage, gate, observed/reviewed/local-check heads, next actor and next action. Console/dashboard derive the same result. Merge ordering compares exact PR path sets, reports intersections and never guesses an automatic landing order where dependencies are unknown. Release readiness lists merged work since the tag, stale/nonancestor documentation stamps and open native/live receipts; each unknown remains visible.

## Composition and measurement

The #252 gsd-lite option remains guidance, bounded predecessor edges and criterion/evidence-ref checklists over the same board. It creates no second STATE/PLAN/HANDOFF authority and cannot auto-advance. #259 profiles supply project defaults without changing gate authority. #247 records store ids, timings and outcomes, not plan text. #251 compares off/advise/enforce and default/gsd-lite on a sealed common suite, with failures, unknowns, operator interventions and overhead retained. No experiment was run for this design.

## Delivery and verification state

The initial implementation adds built-in configuration validation, optional board receipts, fake-gh stale-head/required-check tests, Tasks transition gates and CLI/console/dashboard projections. Custom stage/gate definitions, full merge-queue and release-readiness presentation, a dependency-editing/import workflow and a live advise cycle remain pending. The bounded checklist guidance slice below is implemented separately. A native/account cycle must be recorded separately; no merge or release is implied by this document.

## Initial commands

A per-project `.agenthub/sdlc.toml` may set `mode = "advise"` and `required_checks = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"]`. Omit the file for off. A missing/empty check set is unknown, never a green approval gate. The built-in stage order is fixed in this slice; changing the file applies at the next hub start.

A person records ids and a claimed local receipt with `ahub sdlc record 12 '{"repo":"owner/repo","issue":109,"pr":325,"localHead":"<full SHA>","localResult":"passed","stage":"implement"}'`. Owners/reviewers have the bounded `hub_sdlc_record` tool; it accepts no remote bodies or external-check results. Only the assigned reviewer or person records a reviewed head. `ahub review 12 approved --head <full SHA>` rechecks current evidence before approval. Changes requested does not require green CI.

`ahub sdlc status` lists bounded local projections without polling every remote PR. `ahub sdlc explain 12` or `status 12` performs a fresh structured readback, with a console-only boundary and no remote body retention. Shared console/dashboard projections explicitly show unknown external evidence; they do not certify freshness from cached data. Default task rows and contracts remain unchanged when off.

# gsd-lite checklist guidance

- Select `workflow = "none" | "gsd-lite"` in `.agenthub/sdlc.toml`; none is the default and preserves existing receipts, contracts and traces. Like the SDLC mode, this file is loaded at daemon start. Workflow choice adds guidance; it does not select enforcement.
- A task's reviewer or the person records `phase` through `hub_sdlc_record` or `ahub sdlc record`. The board owns the receipt, with its actor/history. No writable STATE/PLAN/HANDOFF file is introduced.
- A phase names a bounded slug `id`, a full `head`, up to 64 existing task/predecessor records and 1..32 criterion records. `tasks` entries use `{ "id": 2, "after": [1] }`; after must match current Tasks.after edges exactly. Imports refuse missing ids, cycles, closures above 256 tasks and ordinary-parent references to private work. They do not edit dependencies, accepted owners or reservations. Create dependencies through the existing `ahub task propose --after` flow.
- Each criterion has a bounded `id`, boolean `required`, `result` verified|failed|unverified and up to eight hashed refs. Accepted refs are `sha256:<64-hex>`, or `artifact|check|source:<ASCII-reference>@<64-hex>`. Whole phase JSON is at most 32 KiB. The hub never fetches those refs or treats a model's claim as a deterministic check. Verified outcomes are reviewer claims, separately labelled from fresh GitHub checks.
- Required failed/unverified criteria, unfinished child tasks, changed/unavailable dependencies and missing/stale checklist heads make phase readiness false. In advise/off, board transitions retain their existing behavior; readiness can remain false after a historical approval. Enforce adds phase blockers only to the existing approval transition. Entering review remains possible while criteria are unverified, so the reviewer can inspect and record them.
- `ahub sdlc status <id>` and `explain` expose the same workflow/phase projection used by the console and dashboard; `ahub route explain` names active workflow guidance. `ahub sdlc export <id>` emits sanitized ids, states, criteria/hashes and two SHA-256 values: `stateHash` hashes that exact projection, `sourceHash` hashes the normalized effective lifecycle configuration (not a code/build attestation). Private exports contain a stub and no phase refs. Exports are read-only derived views and cannot be imported as task authority.
- Full GSD import, dependency editing, custom lifecycle gates, release readiness and the native advise cycle remain pending. No automatic advance, merge, release, permission change or experiment is included. The default versus gsd-lite #251 comparison is not run during the solo implementation.

Example reviewer receipt (task 2 already depends on task 1):

```json
{
  "phase": {
    "id": "delivery-one",
    "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "tasks": [{ "id": 2, "after": [1] }],
    "criteria": [{ "id": "native-smoke", "required": true, "result": "unverified", "refs": [] }]
  }
}
```

The repeated SHA is a syntax example, not verification evidence. Replace it with the head actually reviewed. A verified criterion requires hashed evidence refs and still does not replace the configured exact-head local/CI gates.

# Custom lifecycle definition contract (#257)

- The sdlc.toml loader reads a single regular single-link file up to 64 KiB, checks its identity/size across a bounded read and refuses symlinks or changing files.
- Optional `definitions` in sdlc.toml maps a stage id to bounded data: `base`, `actor`, `entry_gates`, `exit_gates` and `after`. `stages` is the explicit ordered list, at most 32 distinct lower-case ASCII ids of at most 48 characters. Built-in names retain their original base; custom ids map to one of the seven existing semantic stages. Unknown keys, gates, actors, duplicate gates and references refuse before startup.
- The list must contain a review-base and merge-base stage because existing Tasks done/review transitions need those destinations. Other stages can be renamed, inserted or omitted. `after` has at most eight distinct earlier ids; self, forward, missing and cyclic dependencies refuse. Configuration defines no new task states, runnable commands or capability.
- Actors are owner, reviewer, person or planner (defaulting to the base's existing actor guidance). A configured actor never grants lifecycle write authority to a new caller. Existing task owner/reviewer/person eligibility remains the outer boundary. In enforce, an explicit custom stage change additionally requires its configured actor; a person may record every stage. A planner must already be an eligible task holder with the existing planner flow role. Off/advise preserve their nonblocking claim behavior.
- Gate names are issue, pr, local, review, checks and phase. A phase gate requires workflow = "gsd-lite"; otherwise configuration refuses before startup. They read only the existing artifact identities, exact-head GitHub readback, claimed local receipt or current board-owned phase checklist. Entry/exit readiness is shown separately from approval readiness. Custom gates cannot remove the existing review/approval floor, turn a missing required-check set green or treat a phase claim as external verification.
- Receipts keep their configured stage id. Tasks validates stage names against the active definition before storing. A definition removed after a restart makes the old stage visibly unknown until an eligible person/holder records a valid one; it is never silently remapped. Existing state-derived completion/approval selects the first configured review/merge base destination, not a hard-coded name; no arbitrary stage auto-advance is added.
- CLI, console and dashboard use the same definition/base/actor and entry/exit blocker projection. Every managed native/local task schema advertises the same active stage ids. Separate MCP processes read authenticated daemon status, not a mutable sdlc.toml; a live older daemon without the optional field retains the seven-stage schema. An unavailable/malformed read withholds hub_sdlc_record until a successful tools-list read rather than inventing stages. The default definition produces the old seven-stage config, receipts, schemas and projections unchanged. Native model ingestion and an actual advise/release cycle remain unverified.

Example:

```toml
mode = "advise"
required_checks = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"]
stages = ["question", "draft", "fact-check", "approve", "publish"]

[definitions.question]
base = "plan"
actor = "planner"
entry_gates = ["issue"]

[definitions.draft]
base = "implement"
actor = "owner"
after = ["question"]
exit_gates = ["local"]

[definitions.fact-check]
base = "verify"
actor = "reviewer"
after = ["draft"]
exit_gates = ["checks"]

[definitions.approve]
base = "review"
actor = "reviewer"
after = ["fact-check"]
exit_gates = ["review"]

[definitions.publish]
base = "merge"
actor = "person"
after = ["approve"]
```

These ids are guidance/receipt destinations. Publish neither merges nor releases. Full release readiness, bidirectional GSD import and research measurements remain separate slices.


# Structured documentation readiness evidence (#257)

The package-owned scripts/check-docs.mjs accepts --json with the same normal/--require-fresh verdict as its human output. Metadata includes the observed head, validated package version and sorted document identities with fresh/stale/nonancestor/unknown state, stamp, covered commit count and dirty flag when known. Invalid/error payload text is excluded from machine output; an error count and fresh=false retain uncertainty. Git readbacks disable repository-configured helpers and bound subprocess time/output. No stamp, version, tag or release is written. This evidence is a release-readiness input, not proof of prose review or native acceptance.

The release reader additionally requests --committed: manifest, README and package metadata come from the captured HEAD, and dirty documentation/evidence files block freshness. A working-tree restamp cannot certify a commit that still contains stale stamps. The ordinary checker continues to support working-tree review before those stamps are committed.

# Read-only merge queue contract (#257)

Queue reads fetch PR numbers and bounded head/check/review/thread/file-count metadata, never remote titles or bodies. Up to16 open PRs and8 external dependency reads share a20second budget. Every linked local receipt must satisfy the existing approval floor on that current head; draft/unknown status, missing file coverage and unlinked/private work remain blocked. Same-target path intersections return counts without names. Task after edges provide the only dependency order; open predecessor PRs block current readiness, unresolved touching order asks the person, cycles/truncation remain incomplete. A board approval never substitutes for a merged-commit receipt. No queue operation changes dependencies, owns work, merges or writes GitHub.

A truncated open-PR list blocks every row because omitted PRs may change the touching order. Version advancement uses SemVer precedence, including prereleases; build metadata alone is not an advance.

Missing/incomplete file evidence, an unknown target branch or a private PR also prevents conflict coverage for other rows. Their readiness stays blocked without reading the private PR.

Queue completeness requires both full file coverage and verified target branches, even when all file pages have been returned.

Touching PRs without explicit task dependency order, and their dependent PRs, appear in unordered rather than the ordered result until the person resolves them. Independent disjoint work can still be ordered. Truncated or unknown touching coverage supplies no order; a late board revision also discards the entire previously derived order.

After intervening remote PR reads, a final bounded identity-list read must match the initial open set; changes or unavailable readback invalidate readiness and order. Empty/private-only snapshots perform no intervening remote evidence reads. Repository identity matching is case-insensitive for both holders and dependencies.

Those snapshots include every PR head, which must remain unchanged and match its observed evidence. Documentation dirtiness uses staged-tree metadata, untracked names and raw blob hashing rather than git status, so clean/process filters are never invoked. Gitlinks, large files or unsupported filesystem evidence remain unverified; transformed bytes are not declared equivalent by executing a configured helper.

Snapshot target branch names and target commit identities must also stay unchanged and match the evidence used to compute file conflicts. A retarget or advancing base invalidates the report even with an unchanged PR head.

# Read-only release report contract (#257)

Report reads bind the observed local head, committed package version, published release tag and matching local/remote commit identity. Only a verified tag ancestor defines the bounded first-parent commit list. The package-owned JSON doc checker must report freshness at that same head; open/unknown native issue metadata remains a blocker. Source readiness never certifies native acceptance or permits publication, and a changed head invalidates the report. No body, issue title, task text, version bump, restamp, tag or release mutation is included.

Merged PR identities are resolved from those post-tag commits in batches of at most 100, with at most 10 associated PRs per commit and the same shared read deadline. Repository lifetime PR counts cannot truncate the report. Missing, mismatched or paginated associations remain unknown; direct commits may have no associated PR.

The predecessor is the newest non-draft entry from GitHub's descending release list, which includes prereleases. The stable-only "latest release" endpoint is not used; an RC can anchor the next RC's tag and commit coverage.


# Delivery readback commands and surfaces (#257)

`ahub sdlc queue <owner/repository>` and `ahub sdlc release <owner/repository> [live-issue...]` issue console-only readbacks. They also run through the existing console command path. The dashboard's Delivery evidence section uses labelled inputs and read-only buttons, textContent output and existing project/instance/generation fences; switching projects discards old reports and input. The report never changes task state or grants a permission. Private document names are removed at the Tasks public projection. Ledger issue state remains metadata, never native-success proof or release permission.

The all-project manager forwards both delivery reads through the same scoped console connection with a 30-second cap, beyond their shared 20-second read budget. Stale/unknown project or instance identities and unknown operations remain refused.

After dashboard authentication, those two delivery operations get a 35-second HTTP idle limit so Bun's ordinary 10-second limit cannot cut the report early. Other actions keep the ordinary limit.

The connection idle setting is not a guaranteed 10-second deadline for an active handler. The actual HTTP fixture records that an ordinary action also completes after 11.5 seconds; that legacy behavior is retained. The owner approved correcting only the newly added test's mistaken ordinary-action failure expectation. Manager control request caps are separate from HTTP connection idle behavior. Delivery HTTP results omit the internal control-request rid.

- Runtime doc checker ships explicitly in the npm tarball and package verification asserts its presence. Merge queue phase readiness derives each holder's current board phase view under gsd-lite; absent or blocked phases remain unknown/blocked.
