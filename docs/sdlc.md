# Playbook lifecycle for agent-hub (#257, #481)

## Authority and evidence

The issue remains the specification, Tasks remains the sole task mutation boundary, and GitHub remains authoritative for PR heads, required checks, merge commits and releases. The hub stores artifact identities and bounded structured readbacks, never issue/PR bodies. Off is the default. Advise exposes blockers without changing task transitions. Enforce blocks only the review/approval transitions listed below; it never merges, releases, edits GitHub or gives a peer additional capabilities.

A reviewed head is a full lowercase 40-character SHA observed through a successful readback, not an implementer-supplied statement. A check is evidence only for that same head. Unknown/missing required checks, unavailable GitHub, pending reviews or unresolved threads remain blockers in enforce and visible unknowns in advise. A newer head invalidates the derived review and approval readiness. Historical task approval is retained as history, not presented as approval of the new commit. Revalidate after asynchronous readbacks immediately before any board write.

## Default lifecycle

The built-in lifecycle follows the [AI-Native SDLC Playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook). Stage ids describe the hub's artifacts and handoffs; the playbook labels group them into Plan, Design, Build, Test, Deploy and Maintain.

| Stage id | Playbook stage | Acting role | Artifact or exit gate | Current enforcement |
| --- | --- | --- | --- | --- |
| intent | Plan | person/planner | intent or backlog identity | person spec acceptance required at build entry in enforce |
| spec | Design | person/planner | issue identity and scope | spec acceptance/body drift checked at build entry |
| plan | Build | planner/owner | plan, branch, existing predecessor gates | current planner review required at build admission; conformance pending S2 |
| build | Build | owner | PR identity/current head and local check on that head | entering review, when enabled |
| test | Test | verifier/reviewer | required checks and local gate on the reviewed head | approval, when enabled; integrity/evals pending S4/S5 |
| review | Deploy | assigned reviewer | current head-bound verdict, no pending change request/open thread; AC checklist under Compliance | approval, when enabled; open Important findings block in enforce |
| merge | Deploy | person | current-head readiness, ordered touching PRs | shown; no mutation |
| release | Deploy | person | merged commit, version/tag, docs freshness/live receipt checklist | shown; authorization pending S6 |
| maintain | Maintain | person/planner | follow-up intent and operational evidence | shown; metrics/control bands pending S7 |

Stored `implement` and `verify` stage ids read as `build` and `test`. A write that names the old id stores the id the configuration lists, so new enabled-lifecycle receipts use the canonical ids. The default remains off, preserving existing off-mode output, receipt and schema shapes. Status, explain, console and dashboard name the playbook stage beside enabled lifecycle ids.

## Playbook alignment

| Slice | Playbook play | Delivery in this slice |
| --- | --- | --- |
| S0 | Plan, Design, Build, Test, Deploy, Maintain stage model | Nine built-in bases, canonical ids, stored receipt aliases and playbook labels |
| S1 | Accepted intent/spec and spec drift | Person-only `ahub sdlc accept`, bound to the issue's body edit time; build entry needs it in enforce (see Spec acceptance below) |
| S2 | Accepted plan and diff conformance | Pending; existing task plans remain authoritative without a conformance readback |
| S3 | Bugs, Security and Compliance review passes | Head-bound findings, configured nit cap, Important approval gate and recurring-finding amendment proposals |
| S4 | Red-first tests and test integrity | Pending receipts/gates; repository test-integrity rules still apply |
| S5 | Continuous evals for agent configuration | Pending gate, dependent on #251/#266; no eval pass claimed |
| S6 | Production approval gate | Pending person-only release authorization; release report stays read-only |
| S7 | Metrics, deterministic control bands and follow-up intent | Pending; no automated metric triage or security baseline claimed |
| S8 | Compliance acceptance-criteria checklist | Head-bound checklist retained; legacy workflow and phase compatibility deprecated; task import removed |
| S9 | Planner grooming and plan review | Read-only digest, current plan-review receipt at build admission, all-mode WIP and accepted-untouched return |
| S10 | Planner cost governance | Typed review/CI scope, premature-review admission, identical-tree CI reuse and read-only cost report |

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

Head-bound review/approval gates, bounded custom definitions, read-only merge/release reports, S0/S8 vocabulary/checklist migration, S1 spec acceptance and S9 planner admission and S10 cost governance are implemented in source. S11 release-train governance ships in 0.12.37. S2-S7 and the native advise-through-merge/release cycle remain pending. Installation, native acceptance and release authorization require separate receipts.

## Initial commands

A per-project `.agenthub/sdlc.toml` may set `mode = "advise"` and `required_checks = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"]`. Omit the file for off. A missing/empty check set is unknown, never a green approval gate. The built-in stage order follows the table above; changing the file applies at the next hub start.

A person records ids and a claimed local receipt with `ahub sdlc record 12 '{"repo":"owner/repo","issue":109,"pr":325,"localHead":"<full SHA>","localResult":"passed","stage":"build"}'`. Owners/reviewers have the bounded `hub_sdlc_record` tool; it accepts no remote bodies or external-check results. Only the assigned reviewer or person records a reviewed head. `ahub review 12 approved --head <full SHA>` rechecks current evidence before approval. Changes requested does not require green CI.

`ahub sdlc status` lists bounded local projections without polling every remote PR. `ahub sdlc explain 12` or `status 12` performs a fresh structured readback, with a console-only boundary and no remote body retention. Shared console/dashboard projections explicitly show unknown external evidence; they do not certify freshness from cached data. Default task rows and contracts remain unchanged when off.

# Spec acceptance (#481 S1)

- The person accepts a task's spec issue with `ahub sdlc accept <task> --issue <n> [--repo owner/repository]` (the repository defaults to the task's receipt). Agent shells and live tests are refused. The hub reads the issue's `lastEditedAt` and `updatedAt` through a fixed GraphQL query and stores them with the issue identity and the time of acceptance; it never reads or stores the body. `hub_sdlc_record` cannot write an acceptance, and relinking the receipt to another repository or issue drops it.
- Build entry is the `implement` or `bulk_edit` task's acceptance (`hub_task_accept`), or a recorded stage change into a build stage by anyone but the person. In enforce, build entry needs a current acceptance: the hub rereads the issue and refuses with `spec acceptance missing`, `spec changed after acceptance` (the body was edited; comments only move `updatedAt` and do not count), `spec edit time unknown` (the readback failed) or `spec issue unknown` (the receipt names no issue). Advise posts the same text as a notice and lets the work start; off reads nothing.
- `ahub sdlc status <task>` and `explain` show `spec: {issue, state}` (`missing`, `current`, `changed` or `unknown`) when the lifecycle is enabled and the receipt names an issue. The spec state is not a merge-readiness blocker: its gate is build entry.

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

The planner records `hub_plan_review` with the task id, current `planningRevision` and a reason. The person's CLI is `ahub sdlc plan-review <task> <revision> <reason...>`. Tasks records the actor, planning revision, observation time and host-read issue identity/edit time. The fixed GraphQL query requests metadata only, never an issue body or comments; comment-only activity does not invalidate the body-edit receipt. Caller-supplied timestamps are refused. A changed revision requires another review except for the complete contiguous release-only history described under S11; issue identity/edit and cost-scope checks still apply. An issue edit requires another review; unavailable metadata never counts as a current review. The native CLI cannot delegate this person-attributed write through `--live-test`.

For implementation/bulk-edit tasks and an explicit build-base stage, enforce refuses an offer or acceptance without a current receipt. Advise reports the gap and off performs no lifecycle gate. Spec acceptance and planner review are independent readbacks bound to one task snapshot before acceptance. The ordinary synchronous acceptance path cannot bypass the enforce readback. A self-claim can remain assigned and proposed while its prerequisites are missing, with no offer or accepted event. A saved planner review can release previously held proposed work; delivery failure leaves that saved receipt intact.

Two board rules apply in every lifecycle mode:

- Acceptance and self-claim, including a `done` that implicitly accepts proposed work, respect the owner's effective planner WIP limit. The target task is excluded when checking capacity, and updating an already accepted plan or resubmitting changes_requested work does not consume another slot, provided its current owner accepted it after the latest ownership change. Another unaccepted offer cannot block that redo. In enforce, a changes_requested resubmission still revalidates spec acceptance and the plan review; an issue body edit requires the person to accept the revised spec and the planner to review it again before re-acceptance or done. A refusal names the owner, limit and open task ids before a board write. The existing planner capacity accounting includes owned open work and active planner-pull reservations.
- A planner or the person can return accepted but untouched work with `hub_backlog_return_untouched`, or `ahub backlog return <task> <revision> <reason...>`. A done/check/review/integration entry or recorded branch, commit, PR or local/review head refuses the return. History and planning fields remain; former role requests are withdrawn through the existing delivery path. A successful return permits replanning and pulling again without erasing historical acceptance. General unassignment and cancellation of accepted work remain person-only. Planner changes to pinned or frozen work remain refused.

Enabled lifecycles send an attached planner one grooming pointer for a changed board revision; a queued pointer is not duplicated. Proposal, approval and planning writes flow through the existing revision and task-sweep notice path. External issue changes are read during grooming, offering and accepting, rather than by a separate watcher.

The digest is bounded to 500 task rows (open work plus structured cancelled supersession evidence) and 256 findings, with at most eight issue metadata reads sharing four seconds. Spec acceptance and planner-review staleness are compared independently. Truncation and unavailable evidence are explicit. Qualified foreign repositories are compared within their own key. Without a proven repository key an absolute outside-project path remains unknown; the dedicated repository-overlap resolver is tracked in #476.

S9 ceilings: a private build task with an issue reference cannot satisfy enforce admission: privacy forbids the external issue metadata read, and no person override for a metadata-free plan receipt exists. Grooming pointers are coalesced only while queued, per board revision; there is no minimum time interval after delivery, so a busy board may produce one delivered pointer per revision.

# Planner review and CI cost governance (#481 S10)

At plan review, batch small related fixes into one area branch and PR; keep release preparation separate from feature work. A plan can name `review: {scope: "none" | "delta" | "full", reviewers: N}` and `ci: "focused" | "full" | "reuse"`. None requires zero reviewers; delta/full require one to eight. These are expected costs, not permission to bypass the task's reviewer, CI or privacy gates. Use one reviewer for a small change; split a large review by area with one receipt owner. After a fix, review the delta against the previous findings. S2 will compare planned scope with completed coverage.

The planner can provide scope with `hub_plan_review`; the person can run `ahub sdlc plan-review <task> <revision> <reason...> --review full --reviewers 1 --ci full`. Tasks records the explicit scope on the plan and its revision-bound receipt. A file-list update retains omitted cost fields; an explicit scope change cannot replace a reviewed scope during enforce acceptance. Old plans and receipts remain unspecified and are never filled by guessing. Advise reports missing scope. In enforce, every newly recorded receipt needs both scopes; an existing scope-less receipt remains valid until a non-release planning revision changes, with the same complete-history exception under S11. Enforce acceptance cannot add owner-supplied cost keys to that legacy receipt; the planner must record an explicit scope first.

A review request is premature if its task head does not match the PR head, configured required checks are not green, or a pending bot thread is unanswered. A resolved thread is settled; an unresolved one needs a user reply after its last bot comment. The hub reads identity, timestamps, authorship type and resolution only, never comment bodies. Without explicit required checks the native floor is both OS checks plus `seeded guards`. Advise reports the gap; enforce refuses before the requesting done/cohort writes. If only quiet task-history events arrive during an advise readback, the evidence is discarded and review continues with unknown readiness, without another external read. A reviewer change is allowed because the reviewer is re-derived before the write; it is not an authority or readiness receipt. Mode, owner, privacy, receipt, authority and other history drift still refuse; enforce remains unchanged. A private turn may finish its own PII task in advise with a generic unknown-readiness notice and no remote metadata read; the private-turn refusal for ordinary work remains. Delayed checks revalidate before completing; a refused completion sends a private-aware notice to call `hub_task_done` again only while the task is still in progress with the owner that started the check. Otherwise only the console notice is recorded. Background roster/quota role changes remain fact, but enforce holds a new review envelope without an admission readback; refresh it through a manual reviewer assignment after CI and replies are ready. The brief and verdict coverage belong to #520, separate from this admission.

CI controllers are serialized per pull request (`check-pr-<number>`) and for main pushes and ordinary dispatches (`check-main`), for the entire workflow and without canceling an admitted controller (#609); macOS timing dispatches use their own macos-timing group. Within a PR `queue: single` lets a newer pending run replace the older pending one; main keeps `queue: max`, which preserves up to 100 waiting controllers ([GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)). Different PRs run side by side: a repository-wide lock serialized every PR (17-18 min alone, 40-54 min with 4-5 PRs in flight on 2026-10-20). Two groups admitting the same tree at the same instant can run it twice; that duplicate costs one run and never a false green. Required job names and read-only token permissions are unchanged. Before PR or push gates, `scripts/ci-reuse.mjs` reuses successful full proof for the identical Git tree, including its workflow. On reuse the two OS matrix jobs still expand and report their exact required names, while the seeded aggregate reports its exact name. They run only a `Reuse verified identical-tree full gate` marker step naming the original proof; full setup and gates are skipped. Skipped jobs and successful reuse-reporting jobs never count as fresh full proof. A running identical-tree gate refuses duplicate admission; unknown active coverage refuses safely. Only a 404, a timeout on the individual read limit, or malformed successful proof is dropped: a failed successful-run list drops that proof phase, while a failed commit or jobs read drops only that candidate and continues the bounded search. Other failures (5xx, 403, 429, response size bounds, authentication and unclassified errors) remain unknown. Exhausting the overall deadline or request budget stays unknown even when a request reports a timeout. Without verified proof, a complete empty active scan requires a fresh gate. An unreadable, truncated or unidentifiable active inventory, or exhaustion of the shared request budget or deadline, stays unknown and refuses admission. The release reader (`--require`) still refuses without verified identical-tree full proof. Metadata reads are bounded to 100 recent successes/active runs and 240 calls within 60 seconds. Pending serialized controllers are not admitted gates. Run focused tests and `scripts/check.sh --changed` locally; CI carries the full-suite gate; a known flake warrants only one rerun of its failed job with recorded evidence.

`hub_sdlc_costs` and the person's `ahub sdlc costs [owner/repo]` report linked merged PRs without changing the board. A review round is a board done-to-verdict handoff, not each reviewer in a multi-reviewer round. An observed handoff still counts when its declared scope was none. The report counts distinct check-workflow run ids, extra attempts (`run_attempt - 1`), full re-reviews, delta rounds and summed review intervals, with GitHub review counts alongside them. Unspecified scope and unavailable evidence stay unknown/incomplete. Only current public links are projected; a private counterpart withholds the whole PR. Up to 16 linked PR reads share 20 seconds; each PR covers at most 100 commits, reviews and recent check-workflow runs, and the pure aggregator bounds 500 tasks, 200 PRs and 10,000 history entries. Truncation is explicit. S10 exposes pure band-breach proposal data; S7 owns rolling baselines, band configuration, automatic scheduling and board-card creation.

The S10 policy ceilings are settled in the spec: hub task #284 implements the lost-proof admission rule, #285 owns thread-author classification, and #286 implements quiet-only advise drift and delayed refusal notices to the same check owner while the task remains in progress. The per-PR queue is already in place (#609).

# Planner release trains (S11)

Release scope stays on each task's existing `release` planning field. `hub_release_new` creates a future planning row; `hub_release_configure` activates it, sets its planned cut date, or records an enumerated hotfix cause. Only one train may be active or frozen. Future planning rows remain available so unfinished work has a next-train destination.

`hub_release_assign` changes only a task's release, including approved or in-flight work. It retains execution state, owner, reservations and dependencies. It requires the current planning revision and a reason. Public reasons are screened; private or pinned work requires the person. A private reason stays on the board with a withheld history marker and never goes to the model screen, including when approved work is rolled out of a train. Public readiness/cut still refuses a scope containing private work; frozen or settled scope cannot move through this operation. Release-only planning revisions retain the S9 plan review only when the complete intervening planning history changes exactly the release field; other planning changes still invalidate it. The existing general backlog planning rules remain unchanged.

Use `ahub sdlc train report <release-id>` to see planned task identities, approval readiness, due trigger and recorded release metrics. `ahub sdlc release-assign <task> <revision> <release-id|none> <reason...>` is the person's CLI for assignment. A planner uses the corresponding hub tools under its own identity. `ahub sdlc train configure <release-id> <revision> '{"state":"active","cut":1792500000000}'` activates a future train and optionally sets the UTC epoch-millisecond cut date.

A train becomes due when its tasks are approved or its cut date arrives. A date never clears an unfinished task: move it to the next planning row with a reason before cutting. `hub_release_cut`, or the person's `ahub sdlc train cut <release-id> <revision>`, freezes a nonempty, fully approved scope. Scope and authority are checked again after cost/admission reads and in the final database transaction. Cancellation does not count as approval.

The cut obtains a short repository lease through the installed host `dot admit` controller, checks the shared gate lock, and retains the lease until scope freeze. The controller is resolved outside the project, its command is fixed, and missing/expired/unknown admission defers. The daemon checks fresh account quota headroom for attached peers with a real source (a registered `budget.reader`, or an enabled soft-token limit), including shared instance accounts; unknown/stale readings from those sources defer. Registered accounts without a configured source report `no quota source` rather than deferring on absent readings; an unknown external account still requires evidence. Budget-record and manual pauses still defer for every attached peer. This metadata lease does not authorize a build. Each later heavy preparation step needs its own admission. The cut neither publishes nor tags, and it never substitutes for S6's person authorization or native verification.

A hotfix records one cause and why it cannot wait: `loss`, `security_privacy`, `upgrade_start_blocked`, or `core_flow_no_workaround`. These mean data/message loss, a security/privacy defect, blocked upgrade/start, or a broken core flow without a workaround. Hotfixes keep every scope, quota, resource, review and CI gate. Their branch starts at main and contains the fix and regression only; unrelated work belongs in a future train.

Release history records the frozen task ids and actual cut/shipment times. CI resource counts read only the planned scope's PRs at cut (at most 16 distinct PRs in one repository, run attempts included); failed reads or a larger/mixed-repository scope leave the count unknown; board review verdict counts are recorded separately. Missing PR links, incomplete reads and legacy history remain unknown. Metrics derive shipment intervals, approval-to-shipment lead time, hotfix fraction among shipped releases, and recorded resource counts. They do not infer success from an absent record. Release-preparation PR costs and future S7 band automation are separate evidence, not guessed counts. The per-release "gates run" record is deferred to S6/S7; frozen scope and resource counts do not prove that gates ran.

Legacy release rows omit train metadata. The old off-mode planning APIs keep their shape; explicit train operations always enforce their stated board/resource rules. Enabled lifecycle freeze, and any configured train freeze, must use the admitted cut path. Ship/drop remain person-only. The existing person-selected upgrade/recovery operation and its readiness/completion checks remain separate from a cut; a source gate is not an upgrade receipt.

Person ruling 2026-10-19 supersedes the earlier S11 upgrade-admission ruling: upgrades remain outside S11 host-admission, quota and additional all-idle gates. Recovery uses its pre-S11 `recoveryReady()` checks: no busy peers, pending approvals resolved and completion checks settled, with the existing operation-identity and lifecycle fences. A quota/manual pause, missing or shadowed `dot`, or an outer same-repository admission lease adds no S11 upgrade refusal. The person-selected operation remains the confirmation; no extra receipt or agent upgrade authority is added. Release-cut host and quota admission remains unchanged.

Configured cut dates must be positive safe UTC millisecond timestamps; the train tool does not accept null to clear a date. A configured active/frozen train also requires a recovery target advertising `release_trains`, so an older daemon cannot silently drop the safeguards after restart. Target proof is checked before preparation and again before commit; queued future planning rows and legacy rows retain their existing compatibility.

Release-cut refusals name the applicable exits: stop or resume a paused peer, adjust `ahub budget set`, or drop the train with `ahub release drop`. Install the resource controller or fix PATH when `dot` is unavailable or shadowed; retry the cut outside an outer admission lease when nested admission is refused.

Train history retains at most 256 events. Configuration no-ops retain the revision and history; meaningful configuration reserves the final two slots for cut and shipment. Capacity refusals occur before effects; an already exhausted legacy train requires a person-selected replacement.

## Structured review findings (#481 S3)

`hub_review` accepts optional `findings`, or the person can pass JSON with `ahub review <id> <verdict> --findings '<json>'`. Each item has a stable `id`, `pass` (`bugs`, `security`, `compliance`), `severity` (`important`, `nit`) and `disposition` (`open`, `fixed`, `false_positive`, `accepted`), with optional `path` and `rationale`. Only the person can use `accepted`, with a non-empty rationale. Reports have at most 64 findings and 64 KiB; ids, paths and rationale have bounded lengths. `max_nits = 5` in `.agenthub/sdlc.toml` sets the report's nit cap (0..64), including in off mode.

Verdict history retains each report and its reviewed head. Within a task, the semantic id remains the finding identity when its pass is reclassified; a disposition for that id settles the same finding across passes. Open Important findings carry forward across heads until a reviewer explicitly sets fixed or false_positive, or the person sets accepted with a rationale. Omitting an id never settles it; nits stay on their original head. Review requests list carried public ids, pass, severity and optional path; private finding details stay withheld. Head selection uses the first valid full SHA from the PR head, reviewed head, local head, then commit metadata; unresolved non-empty reports refuse in enforce. A supplied head must match the resolved task head when one exists, and that resolution is rechecked after asynchronous screening. Status and the merge queue show counts for the current head. In enforce, approval refuses while any Important finding remains open; advise exposes the count without blocking. Existing verdicts without structured findings stay compatible.

Finding text passes through the task privacy boundary. PII tasks remain stubs; withheld reports expose only counts on ordinary tasks. When the same public, non-withheld semantic pass/id pair appears on a second distinct task, Tasks proposes one durable, marker-deduplicated backlog plan (excluding false positives) to amend AGENTS.md or an area note. Only hub-proposed plan cards supply dedupe markers. The proposal grants no editing or acceptance authority.
