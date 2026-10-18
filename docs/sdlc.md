# Playbook lifecycle for agent-hub (#257, #481)

## Authority and evidence

The issue remains the specification, Tasks remains the sole task mutation boundary, and GitHub remains authoritative for PR heads, required checks, merge commits and releases. The hub stores artifact identities and bounded structured readbacks, never issue/PR bodies. Off is the default. Advise exposes blockers without changing task transitions. Enforce blocks only the review/approval transitions listed below; it never merges, releases, edits GitHub or gives a peer additional capabilities.

A reviewed head is a full lowercase 40-character SHA observed through a successful readback, not an implementer-supplied statement. A check is evidence only for that same head. Unknown/missing required checks, unavailable GitHub, pending reviews or unresolved threads remain blockers in enforce and visible unknowns in advise. A newer head invalidates the derived review and approval readiness. Historical task approval is retained as history, not presented as approval of the new commit. Revalidate after asynchronous readbacks immediately before any board write.

## Default lifecycle

The built-in lifecycle follows the [AI-Native SDLC Playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook). Stage ids describe the hub's artifacts and handoffs; the playbook labels group them into Plan, Design, Build, Test, Deploy and Maintain.

| Stage id | Playbook stage | Acting role | Artifact or exit gate | Current enforcement |
| --- | --- | --- | --- | --- |
| intent | Plan | person/planner | intent or backlog identity | shown; acceptance gate pending S1 |
| spec | Design | person/planner | issue identity and scope | shown; acceptance/drift gate pending S1 |
| plan | Build | planner/owner | plan, branch, existing predecessor gates | existing Tasks rules; conformance pending S2 |
| build | Build | owner | PR identity/current head and local check on that head | entering review, when enabled |
| test | Test | verifier/reviewer | required checks and local gate on the reviewed head | approval, when enabled; integrity/evals pending S4/S5 |
| review | Deploy | assigned reviewer | current head-bound verdict, no pending change request/open thread; AC checklist under Compliance | approval, when enabled; structured findings pending S3 |
| merge | Deploy | person | current-head readiness, ordered touching PRs | shown; no mutation |
| release | Deploy | person | merged commit, version/tag, docs freshness/live receipt checklist | shown; authorization pending S6 |
| maintain | Maintain | person/planner | follow-up intent and operational evidence | shown; metrics/control bands pending S7 |

Stored `implement` and `verify` stage ids read as `build` and `test`. A write that names the old id stores the id the configuration lists, so new enabled-lifecycle receipts use the canonical ids. The default remains off, preserving existing off-mode output, receipt and schema shapes. Status, explain, console and dashboard name the playbook stage beside enabled lifecycle ids.

## Playbook alignment

| Slice | Playbook play | Delivery in this slice |
| --- | --- | --- |
| S0 | Plan, Design, Build, Test, Deploy, Maintain stage model | Nine built-in bases, canonical ids, stored receipt aliases and playbook labels |
| S1 | Accepted intent/spec and spec drift | Pending; issue metadata acceptance is not yet a hub gate |
| S2 | Accepted plan and diff conformance | Pending; existing task plans remain authoritative without a conformance readback |
| S3 | Bugs, Security and Compliance review passes | Pending structured findings; existing reviewer separation and head-bound review remain |
| S4 | Red-first tests and test integrity | Pending receipts/gates; repository test-integrity rules still apply |
| S5 | Continuous evals for agent configuration | Pending gate, dependent on #251/#266; no eval pass claimed |
| S6 | Production approval gate | Pending person-only release authorization; release report stays read-only |
| S7 | Metrics, deterministic control bands and follow-up intent | Pending; no automated metric triage or security baseline claimed |
| S8 | Compliance acceptance-criteria checklist | Head-bound checklist retained; legacy workflow and phase compatibility deprecated; task import removed |

S0/S8 establish vocabulary and checklist compatibility only. Later slices must retain the same authority contract: the issue is the spec, Tasks owns mutations, GitHub owns PR/check/tag facts, and the hub stores bounded identities, timestamps, hashes and counts instead of remote bodies. No slice writes GitHub or grants capabilities. Advise shows readiness without blocking; enforce applies only the named implemented gates. A full live advise cycle through S1, merge, release and S6 authorization remains pending and cannot be certified by S0/S8 source tests.

The repository uses feature branches and PRs. Release PRs require merge commits because documentation stamps name release-branch ancestors. Do not describe squash as a universal release practice. Worktree/branch cleanup follows confirmed merge; installation and native readback are separate live receipts. A successful source gate cannot certify those receipts.

## Configuration and persistence contract

.agenthub/sdlc.toml contains mode off|advise|enforce and a bounded ordered stage list, using the built-in stages above by default. The loader validates built-in mappings and bounded custom stage/gate/actor definitions; custom guidance does not grant authority. Unknown stages/gates, duplicate stages, cycles, unbounded lists and unknown keys are refused with a field-level reason. A project file may define guidance/gates, but it does not expand capabilities or permissions.

Task lifecycle fields store stage, issue/PR identity, observed head, reviewed head, local-gate head/result and bounded check/readback metadata. Legacy rows read with no lifecycle metadata. Every change goes through Tasks and records its actor; adapters/tools/CLI never write Board directly. Readback timestamps identify observations, not a freshness promise. Persist no task text in lifecycle receipts; public output uses the existing PII stub and publicTitle/publicView.

A reviewer records the head it actually reviewed. If GitHub no longer reports that head, a stale verdict refuses before effects. Changes requested does not require green CI. Approval requires a current review and all configured required checks successful on that head; neutral/skipped does not substitute unless explicitly allowed by the project's gate contract. A local check records an exact SHA and its result; it is a claimed local receipt, labelled separately from externally fetched CI.

## Readbacks and presentation

Use structured gh JSON/GraphQL read-only calls with validated repository and numeric artifact identities. No shell interpolation, PR/issue body fetching, token logging or unbounded comment storage. Failure yields unknown. Required checks come from repository rules or explicitly configured names; an empty/unknown set is not silently green. Review-thread status is counted, not copied. Cancellation and task-owner generation fencing prevent a late read from approving reassigned work.

ahub sdlc status and explain expose mode, stage, gate, observed/reviewed/local-check heads, next actor and next action. Console/dashboard derive the same result. Merge ordering compares exact PR path sets, reports intersections and never guesses an automatic landing order where dependencies are unknown. Release readiness lists merged work since the tag, stale/nonancestor documentation stamps and open native/live receipts; each unknown remains visible.

## Composition and measurement

The acceptance-criteria checklist belongs to the Compliance pass over the same board. It creates no second STATE/PLAN/HANDOFF authority and cannot auto-advance. #259 profiles supply project defaults without changing gate authority. #247 records store ids, timings and outcomes, not plan text. #251/#266 provide the separate evaluation work; no effectiveness comparison or native lifecycle experiment is claimed here.

## Delivery and verification state

Head-bound review/approval gates, bounded custom definitions, read-only merge/release reports and the S0/S8 vocabulary/checklist migration are implemented in source. S1-S7 and the native advise-through-merge/release cycle remain pending. Installation, native acceptance and release authorization require separate receipts.

## Initial commands

A per-project `.agenthub/sdlc.toml` may set `mode = "advise"` and `required_checks = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"]`. Omit the file for off. A missing/empty check set is unknown, never a green approval gate. The built-in stage order follows the table above; changing the file applies at the next hub start.

A person records ids and a claimed local receipt with `ahub sdlc record 12 '{"repo":"owner/repo","issue":109,"pr":325,"localHead":"<full SHA>","localResult":"passed","stage":"build"}'`. Owners/reviewers have the bounded `hub_sdlc_record` tool; it accepts no remote bodies or external-check results. Only the assigned reviewer or person records a reviewed head. `ahub review 12 approved --head <full SHA>` rechecks current evidence before approval. Changes requested does not require green CI.

`ahub sdlc status` lists bounded local projections without polling every remote PR. `ahub sdlc explain 12` or `status 12` performs a fresh structured readback, with a console-only boundary and no remote body retention. Shared console/dashboard projections explicitly show unknown external evidence; they do not certify freshness from cached data. Default task rows and contracts remain unchanged when off.

# Acceptance-criteria checklist

- A task's reviewer or the person records a head-bound `criteria` receipt through `hub_sdlc_record` or `ahub sdlc record` (an off or older daemon's tool schema still offers `phase`). Its ids name the issue's acceptance criteria. The board owns the receipt and its actor/history; no writable STATE/PLAN/HANDOFF file is introduced.
- A checklist names a bounded slug `id`, a full `head` and 1..32 criterion records. Each criterion has a bounded `id`, boolean `required`, `result` verified|failed|unverified and up to eight hashed refs. Accepted refs are `sha256:<64-hex>`, or `artifact|check|source:<ASCII-reference>@<64-hex>`. Whole receipt JSON is at most 32 KiB. The hub never fetches those refs or treats a model claim as a deterministic check. Verified outcomes are reviewer claims, separately labelled from fresh GitHub checks.
- Required failed/unverified criteria and missing/stale checklist heads keep readiness false. Advise/off preserve existing transition behavior. Enforce adds criteria blockers only at approval. Entering review remains possible with unverified criteria so the reviewer can inspect and record them. Criteria claims do not replace exact-head local/CI checks.
- Once recorded, a checklist adds its blockers in any enabled lifecycle; off ignores it, as #257 did. The `criteria` entry/exit gate uses the same checklist without a workflow selector, and a missing checklist is a blocker the reviewer clears by recording one. Task dependencies remain with `Tasks.after`, created through `ahub task propose --after`. Checklist task import is removed.
- `ahub sdlc status <id>`, `explain` and console/dashboard projections show the same criteria view. `ahub sdlc export <id>` keeps the #257 schema-1 bytes in plain off (`workflow: "none"`, `phase: null`); an enabled or retired-setting lifecycle emits schema 2, with sanitized state, criteria/hashes and `stateHash`/`sourceHash`: the exact projection hash and normalized effective lifecycle-configuration hash. These are derived hashes, not code/build attestations or import authority. Private exports contain a stub and no checklist refs.

Example reviewer receipt:

```json
{
  "criteria": {
    "id": "delivery-one",
    "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "criteria": [{ "id": "AC0", "required": true, "result": "unverified", "refs": [] }]
  }
}
```

The repeated SHA is syntax only. Replace it with the reviewed head; a verified criterion also requires hashed evidence refs.

## Retired workflow compatibility (#252, #481 S8)

The old `gsd-lite` workflow is retired. Omit `workflow` from `.agenthub/sdlc.toml` and use the criteria checklist above. Until hub 0.13.0, `workflow = "none"` loads silently and `workflow = "gsd-lite"` loads with a migration warning in `hub.log` and makes a criteria checklist required on every task. The `phase` gate and receipt name are compatibility aliases for `criteria` during that same window; use `criteria` for new configuration and writes. From 0.13.0, `workflow`, the `phase` gate and the `phase` receipt name are refused with a field-level reason.

Stored phase receipts remain readable: their criteria are shown, while legacy task lists are ignored with a visible note. Reading historical receipts never imports or edits task edges. [The retired analysis](gsd-collaboration-analysis.md) preserves the original rationale and unrun measurement plan; it is not current workflow guidance.

# Custom lifecycle definition contract (#257)

- The sdlc.toml loader reads a single regular single-link file up to 64 KiB, checks its identity/size across a bounded read and refuses symlinks or changing files.
- Optional `definitions` in sdlc.toml maps a stage id to bounded data: `base`, `actor`, `entry_gates`, `exit_gates` and `after`. `stages` is the explicit ordered list, at most 32 distinct lower-case ASCII ids of at most 48 characters. Built-in names retain their original base; custom ids map to one of the nine semantic bases above. Unknown keys, gates, actors, duplicate gates and references refuse before startup.
- The list must contain a review-base and merge-base stage because existing Tasks done/review transitions need those destinations. Other stages can be renamed, inserted or omitted. `after` has at most eight distinct earlier ids; self, forward, missing and cyclic dependencies refuse. Configuration defines no new task states, runnable commands or capability.
- Actors are owner, reviewer, person or planner (defaulting to the base's existing actor guidance). A configured actor never grants lifecycle write authority to a new caller. Existing task owner/reviewer/person eligibility remains the outer boundary. In enforce, an explicit custom stage change additionally requires its configured actor; a person may record every stage. A planner must already be an eligible task holder with the existing planner flow role. Off/advise preserve their nonblocking claim behavior.
- Gate names are issue, pr, local, review, checks and criteria. The legacy phase gate is accepted only during the deprecation window. They read only the existing artifact identities, exact-head GitHub readback, claimed local receipt or current board-owned acceptance-criteria checklist. Entry/exit readiness is shown separately from approval readiness. Custom gates cannot remove the existing review/approval floor, turn a missing required-check set green or treat a criteria claim as external verification.
- Receipts keep their configured stage id. Tasks validates stage names against the active definition before storing. A definition removed after a restart makes the old stage visibly unknown until an eligible person/holder records a valid one; it is never silently remapped. Existing state-derived completion/approval selects the first configured review/merge base destination, not a hard-coded name; no arbitrary stage auto-advance is added.
- CLI, console and dashboard use the same definition/base/actor and entry/exit blocker projection. Every managed native/local task schema advertises the same active stage ids. Separate MCP processes read authenticated daemon status, not a mutable sdlc.toml; a live older daemon without the optional field retains the seven-stage schema. An unavailable/malformed read withholds hub_sdlc_record until a successful tools-list read rather than inventing stages. Enabled defaults use the nine playbook bases; off-mode config, receipts, schemas and projections retain their prior shapes. Native model ingestion and an actual advise/release cycle remain unverified.

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
base = "build"
actor = "owner"
after = ["question"]
exit_gates = ["local"]

[definitions.fact-check]
base = "test"
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

These ids are guidance/receipt destinations. Publish neither merges nor releases. The read-only source-readiness report is implemented below. Native acceptance/release authorization and research measurements remain unverified or pending.


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

- Runtime doc checker ships explicitly in the npm tarball and package verification asserts its presence. Merge queue criteria readiness derives each holder's current board checklist view; absent or blocked required checklists remain unknown/blocked.

# Planner plan review (#481 S9)

A configured planner reads `hub_planner_groom` (or the person runs `ahub backlog groom`) before choosing build work. The digest reports missing text-only dependencies, repository-scoped duplicate issues and path/symbol overlaps, over-WIP owners, recorded supersession, issue edit/closed-state evidence and capability, queue or offline blockers. It proposes no board mutation. Missing repository or issue evidence stays unknown; the planner still evaluates issue rulings and the person's priorities. Private task text and references are withheld.

The planner records `hub_plan_review` with the task id, current `planningRevision` and a reason. The person's CLI is `ahub sdlc plan-review <task> <revision> <reason...>`. Tasks records the actor, planning revision, observation time and host-read issue identity/edit time. The fixed GraphQL query requests metadata only, never an issue body or comments; comment-only activity does not invalidate the body-edit receipt. Caller-supplied timestamps are refused. A changed revision or issue edit requires another review; unavailable metadata never counts as a current review. The native CLI cannot delegate this person-attributed write through `--live-test`.

For implementation/bulk-edit tasks and an explicit build-base stage, enforce refuses an offer or acceptance without a current receipt. Advise reports the gap and off performs no lifecycle gate. A fresh readback, task-flow recheck and owner/WIP check precede acceptance. The ordinary synchronous acceptance path cannot bypass the enforce readback. A saved planner review can release previously held proposed work; delivery failure leaves that saved receipt intact.

Two board rules apply in every lifecycle mode:

- Acceptance and self-claim respect the owner's effective planner WIP limit. The target task is excluded when checking capacity, and updating an already accepted plan does not consume another slot. A refusal names the owner, limit and open task ids before a board write. The existing planner capacity accounting includes owned open work and active planner-pull reservations.
- A planner or the person can return accepted but untouched work with `hub_backlog_return_untouched`, or `ahub backlog return <task> <revision> <reason...>`. A done/check/review/integration entry or recorded branch, commit, PR or local/review head refuses the return. History and planning fields remain; former role requests are withdrawn through the existing delivery path. A successful return permits replanning and pulling again without erasing historical acceptance. General unassignment and cancellation of accepted work remain person-only. Planner changes to pinned or frozen work remain refused.

Enabled lifecycles send an attached planner one grooming pointer for a changed board revision; a queued pointer is not duplicated. Proposal, approval and planning writes flow through the existing revision and task-sweep notice path. External issue changes are read during grooming, offering and accepting, rather than by a separate watcher.

The digest is bounded to 500 open task rows and 256 findings, with at most eight issue metadata reads sharing four seconds. Truncation and unavailable evidence are explicit. Qualified foreign repositories are compared within their own key. Without a proven repository key an absolute outside-project path remains unknown; the dedicated repository-overlap resolver is tracked in #476.
