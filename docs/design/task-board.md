---
id: task-board
type: module
title: Task Board
status: draft
parent: agent-hub-architecture
depends-on: []
references: [bus, adapters]
implements: []
covers: [task-board]
tags: [agent-hub, dogfood]
paths:
  - src/hub/review-budget.ts
  - src/hub/tasks.ts
  - src/hub/sdlc.ts
  - src/hub/build-entry.ts
  - src/hub/sdlc-metrics.ts
  - src/hub/board.ts
  - src/hub/routing.ts
  - src/hub/task-sweep.ts
  - src/hub/settled-roles.ts
  - src/hub/conductor.ts
  - src/hub/supervision.ts
  - src/hub/hub-tools.ts
  - src/hub/tool-refusal.ts
  - src/hub/review-brief.ts
  - src/hub/review-scope.ts
  - src/hub/reviewer-pool.ts
  - src/hub/reviewer-pool-config.ts
  - src/hub/release-admission.ts
  - src/hub/main-checkout.ts
  - src/hub/checks.ts
  - src/hub/task-repository.ts
  - src/hub/no-writes.ts
  - src/hub/review-findings.ts
  - src/hub/review-anchor.ts
  - src/hub/review-comments.ts
  - src/hub/review-material.ts
  - src/hub/workflow.ts
  - src/hub/deliverables.ts
  - src/hub/deliverable-files.ts
  - src/hub/plan-conformance.ts
  - src/hub/audit-source.ts
  - src/hub/sdlc-merge.ts
  - src/hub/sdlc-mirror.ts
  - src/hub/ci-watch.ts
  - src/hub/research-campaign.ts
  - src/hub/research-experiments.ts
  - src/hub/research-evidence.ts
  - src/hub/research-runner.ts
  - src/hub/task-approval.ts
  - src/hub/schedules.ts
  - src/hub/folder-trigger.ts
  - src/hub/handoff.ts
  - src/cli/handoff-args.ts
  - src/cli/handoff-output.ts
  - src/hub/task-list-page.ts
  - src/hub/worktree-shelf.ts
  - src/hub/worktree-prs.ts
---

# Task Board

The task board is the shared record of work and its authority, not a transcript of peer claims. This module refines [[agent-hub-architecture]] and separates task transitions from [[bus]] delivery and [[adapters]] runtime facts. Current operational rules are in the [task area note](../agent-notes/tasks.md); the [historical ledger](../specs/2026-09-19-agent-hub-design.md) retains earlier decisions.

## Authority and state

Visual attachments (#1058) annotate public work without changing a task's state,
outcome or evidence authority. Publication checks current role, turn, task and
privacy admission before record/bus effects and after awaited file reads. A PII
task or private turn refuses publication; a task becoming private also withholds
its retained visual from public reads and assets. A visual id is not a verdict or
deliverable receipt, and visual-only calls do not count as task progress for
no-write detection. Ordinary shared tools and the local worker can publish where
their role permits; isolated fresh-reviewer MCP keeps its exact two-tool contract.


`Tasks` mediates task proposals, planning, owner/reviewer changes, acceptance, completion and review. `Board` persists the rows, history and typed evidence in SQLite; transport, CLI and UI layers do not independently apply task transitions. The issue remains the change spec and GitHub remains authority for PR/check/tag facts. Separating these authorities prevents a chat claim or adapter callback from bypassing task policy ([#481](https://github.com/STAIxBWLB/agent-hub/issues/481)).

A command is authorized against the current actor, role, task state and revision. An asynchronous operation can lose authority while preparing evidence, so write boundaries recheck current scope. Console actions bind the selected task ID and its observed flow revision, rather than an unstable list position. The reason is to keep an approved action attached to the row and state the person actually saw ([#424](https://github.com/STAIxBWLB/agent-hub/issues/424), [#525](https://github.com/STAIxBWLB/agent-hub/issues/525)).

Owner, reviewer and planner are distinct responsibilities. A reservation or offer is not acceptance; a completed delivery is not task completion. A saved assignment and the attempt to notify its recipient also remain separate facts, so failed notification cannot erase a committed role change or manufacture a second one ([#297](https://github.com/STAIxBWLB/agent-hub/issues/297), [#525](https://github.com/STAIxBWLB/agent-hub/issues/525)).

## Selection and admission

`routing.ts` selects candidates as a pure function over declared policy and current facts. `Tasks` applies admission and writes through the same selection rules used by route explanation. Roster, roles, privacy, availability, capability evidence and WIP remain explicit inputs, which prevents explanations and actual offers from becoming separate policies ([#525](https://github.com/STAIxBWLB/agent-hub/issues/525), [#418](https://github.com/STAIxBWLB/agent-hub/issues/418)).

Automatic offer and backlog paths respect `plannedStart`; a future card becomes eligible at its boundary through existing sweep/release passes. Explicit person/planner authority is separate. This avoids offering scheduled work early without taking away deliberate manual control ([#1076](https://github.com/STAIxBWLB/agent-hub/issues/1076)).

Urgent acceptance can reclaim only enough unaccepted, unstarted, non-pinned and non-urgent offers to fit the limit. It does so after other admission checks and immediately before the accept write; if insufficient, it reclaims none. Accepted work is never displaced merely to satisfy a new urgent request, because an offer and an active commitment have different costs ([#1080](https://github.com/STAIxBWLB/agent-hub/issues/1080)).

Untouched returns may atomically update `reserved` while moving eligible proposed or accepted work back to Backlog. `Tasks` retains the existing authority, execution-evidence, pin, release and reservation gates, including post-screen rechecks. An explicit reservation patch advances planning revision and records its prior value in the same state/history write, before capacity publication can trigger auto-pull. Clearing it therefore parks the card; omitting fields preserves its planning. Assignment and auto-pull selection remain the existing rules, with no time-based suppression ([#1154](https://github.com/STAIxBWLB/agent-hub/issues/1154)).

## Source-backed plans and request intake

For a profile that supports `plan.sources`, `Tasks` validates every retained source ID against the source registry at proposal and acceptance, before board writes, admission effects or peer notices. Unknown IDs are refused with the ID and `ahub source list` guidance. Overlap notices compare the registry IDs; private task plans remain withheld by the shared public view.

Natural-language intake from the CLI or dashboard enters the same `Tasks.intake` path and creates held draft Backlog cards, not offers. Dashboard task replies use the public view, and a ticket-bound live-test session cannot create these person-attributed drafts. Approval and discard retain their existing authority. Read-only source snapshots carry only ID, kind, byte size, hash prefix and registration time, with no content or origin paths ([#1144](https://github.com/STAIxBWLB/agent-hub/issues/1144)).

## Completion, review and evidence

Completion binds the submitted full head and any verified deliverable records. It may run a configured check before requesting review. A review records a verdict against that evidence; it does not itself merge a PR. An unmerged approved task can receive a new owner submission, superseding the earlier review binding rather than treating old approval as authority for changed code ([#1047](https://github.com/STAIxBWLB/agent-hub/issues/1047)). A re-file cannot silently inherit an old head after the linked PR moves, and an approval with no supplied head refuses known-stale evidence. Refusals name the recorded and supplied or read heads and direct the owner to re-file `hub_task_done` with the new full SHA in `refs.commit`; summary text is not head evidence. This prevents stale approval from being presented as review of changed code ([#1121](https://github.com/STAIxBWLB/agent-hub/issues/1121)).

Review independence and declared scope are different controls. Selection excludes conflicts using current implementation history; a `code` reviewer supplies code findings, while full test/CI proof belongs to the merger's gate. Evidence-only inability to run tests is not a code defect. This keeps valuable sandboxed review without inventing CI evidence or accepting self-review ([#744](https://github.com/STAIxBWLB/agent-hub/issues/744), [#852](https://github.com/STAIxBWLB/agent-hub/issues/852)).

Task text and private-turn words can reach owners, reviewers, overlap notices and memory. Public views use the host's current privacy projection; PII tasks remain stubs for unauthorized observers, and private turns cannot write ordinary shared task text. The projection belongs at the shared boundary because filtering individual callers would leave another observer exposed ([#198](https://github.com/STAIxBWLB/agent-hub/issues/198), [#230](https://github.com/STAIxBWLB/agent-hub/issues/230)).

## Spec acceptance carry-over (#1328 T4)

`Tasks` may reuse an original person's stored acceptance at existing build-entry gates, using one host `readSpecEdit` observation for carry and the ordinary verdict. Gates return only a virtual receipt and an opaque host proof without a write. `Tasks.acceptSpec` remains USER-only; tools and lifecycle receipt fields cannot create acceptance. `assign()` remains pure and its offer/gate order is unchanged.

The source must be an older cancelled local task whose entire `supersededBy` equals `task #N`, `#N` or `N` for the destination. Both stored identities and cached effective repository scopes must agree, and the host-read `lastEditedAt` must equal the source consent (explicit null is valid; missing metadata is unknown). Caller-provided identity changes cannot authorize a carry before the destination identity is recorded. Private/withheld sources, private destinations or caller turns, ambiguous/foreign references, reverse links, changed source cancellation revision/consent metadata, destination flow/identity, roles/policy or unknown host observations cannot grant consent. Source history is not read, so unrelated historical notes are not a carry-currentness input.

`Board.specAcceptanceCandidates` reads only bounded source metadata: up to 32 rows plus a truncation sentinel, at most 64 KiB per raw JSON field and 256 KiB total. It never hydrates source tasks or scans their text, plans or history. An incomplete or malformed projection fails closed to manual acceptance. `Tasks` rechecks the projection and destination/caller fences after the host read and revalidates the final outer patch's effective issue/repository/refs scope. Only an admitted outer write consumes the opaque proof with the host Symbol capability: `Board.updateWithSpecAcceptance` uses the existing atomic transaction and deferred observers to publish the original acceptance fields, a HUB `spec acceptance carried` history note naming source/original acceptance time/cancellation revision, and the existing outer event together. A failed admission or second write leaves task, history, status revision and observers unchanged. No plan review, PR/head, local gate or review evidence is cloned; virtual admission snapshots retain the stored flow until atomic publication.

## Merged PR adoption (#1328 T3)

The person or the single current configured, rostered conductor can run
`ahub sdlc adopt-merge <task> --pr <n>` for an active task. `Tasks.adoptMerge`
binds a missing PR from the explicit command in the established task repository
(and refuses conflicting bindings), requires a merged PR at the task's last
recorded full head, green configured required checks at that head and no open
Important finding. Complete known-zero review threads and pending requests are
also required, and an explicit change request refuses. No GitHub approving
verdict is invented or required. One capped GraphQL snapshot supplies the
head-commit checks and review coverage; incomplete coverage refuses. Unknown
evidence refuses with a next step. The entire task
flow and identity, current actor/session, privacy and SDLC policy are fenced
before and after each awaited GitHub read and immediately before the write.
Recovery, shutdown and storage holds refuse adoption.

Eligible task states are exactly `in_progress`, `in_review` and
`changes_requested`, with all Important findings dispositioned (an open Important marked `needs_validation` or `pre_existing` under an enabled lifecycle, #1403, is a recorded non-blocker: it is counted apart, does not carry as an obligation, and on approval yields one marker-deduplicated backlog card through `Tasks`; with the lifecycle off these fields are refused). `proposed` and
`backlog` tasks must be assigned and accepted first. `approved` and `cancelled`
are already closed. Each refusal names the state and the next step. The Board
transition is host-only and requires the current flow revision; the generic
state transition table is unchanged.

The state becomes `approved` through Tasks, with the actual actor and the
`merged outside the hub` history event. Ordinary dependent release runs after
the saved approval. Adoption creates no reviewer verdict, review metric,
reviewed-head receipt, guarded-merge result, GitHub mutation or branch cleanup.
A prior withdrawn reviewer approval remains historical and cannot become a
current reviewer binding through adoption. Historical completion time is the first approval or adoption
settlement time, separately from reviewer verdict metrics.
Adoption updates only the GitHub-observed head; existing local and reviewed-head
metadata remain historical and cannot establish a current reviewer binding.
Origin follow-back, supervision's approved milestone, task research recording,
and release/profile settlement timing consume the actual completion. Reviewer
verdict metrics and reviewerless automatic-done counts remain separate. A later
adoption never establishes approval before an earlier release.

Private tasks and private turns refuse before any GitHub read for every actor,
including the person. The person's local review authority does not authorize
sending private task metadata to an external observer. Delegated `--live-test`
commands cannot borrow the person's authority.

## Claim evidence records (#931 T1)

The #901 owner boundary exposes one canonical `taskClaimIdentity(task, slot)`.
`claimId` is `claim:<task id>:<created>:<1-based slot>`, so a reset that reuses a
task number cannot inherit an earlier task's evidence. `claimRevision` is the
existing `claimListId(task.plan?.claims)`, the opaque 16-hex ordered-list hash
already stamped in person verdicts. `recordClaimVerdict` and the evidence writer
use that same helper; neither a second claim/verdict store nor a numeric claim
counter is introduced. Exact-list restoration retains #901's existing verdict
semantics. The list-level ceiling is conservative: any claim edit, reorder or
replacement stales every link bound to the changed list. Per-claim revisions
would be the upgrade path if that over-invalidation becomes a problem.

Existing `hub_task_show` and `ahub task show --json` views expose a research
task's current text-free `claims: [{slot, claimId, claimRevision}]` bindings,
derived only from that canonical helper. PII tasks expose none, and dev views
keep their existing shape. A caller copies the returned binding rather than
reimplementing plan hashing; a changed list requires a fresh view before record.

`EvidenceLinkV1` carries exactly `id`, `claimId`, `claimRevision`, `sourceId`,
`rawSha256`, `projectionSha256`, `projectionVersion`, `locator`, `relation`,
`recordedBy`, `taskId` and `revision`. Relations are `supports`, `contradicts` or
`context`, all declared provenance rather than an entailment decision. `locator`
stores proposed zero-based, half-open Unicode scalar-value `start`/`end` bounds
with a nonempty span of at most 4096. T1 does not convert offsets, resolve text,
accept page/section/excerpt fields or claim a projection is verified.

The flat `hub_evidence_record` input omits host-owned `recordedBy`; `revision`
defaults to 1 and `id` is optional for initial writes. A later revision names
its existing ID and the next revision number. Initial IDs are deterministic for
the same normalized input and actor. Replaying identical canonical bytes at an
existing ID/revision writes nothing; conflicting bytes or an out-of-sequence
revision refuse. Every accepted revision remains in the append-only evidence
table. #901 person-verdict history and scorecard counts remain the sole judgment
record, unaffected by evidence relation labels.

Tasks prechecks sequence and claim association before screening and immediately
before append; the Board transaction repeats them as the race fence. Ordinary
sequence/association refusals are pre-effect and name the expected next revision
when applicable. Invalid stored evidence directs the person to stop the hub,
restore a trusted project `hub.db` backup, restart and retry; T1 does not name an
unimplemented evidence-read command.

`Tasks.evidenceRecord` admits only the current in-progress owner of a stored
research-profile task, with current claim binding and registered source/raw hash.
Standalone tasks do not need a campaign, and role-catalog guidance grants no
authority. Recovery/shutdown holds, private turns, PII tasks, private sources,
unknown sources, stale claims and foreign-task writes refuse before effects.
Every awaited preparation is followed by current task/source/actor checks; the
append transaction also fences task incarnation, owner, flow and claim revision.
Current metadata privacy is checked again after asynchronous screening and immediately before append; a failed or unavailable policy refuses. Successful evidence receipts, including replay, are owner task effects for the existing no-write advisory.
Public receipts contain only link ID, revision and task ID. The tool is excluded
from argument/result capture and from read-only publication; dev-profile tool
lists retain their existing shape.

At recording, projection hashes/version remain caller-declared bindings and the
raw source hash is checked against registry metadata. T2 adds the public
`hub_evidence_read` projection through the existing task-show authority. It
re-resolves the current claim revision and screened, complete registered source
projection on every read, with fresh privacy and authorization fences. Unicode
scalar-value locators are explicitly converted from source-read ranges. Missing,
truncated, legacy-unbound or changed material is unavailable or stale; private
upgrades return IDs only, never a source ID, path/origin, excerpt or narrative.
Resolved excerpts are capped at 4096 UTF-8 bytes and never cached or captured.
Before handing a passage to a peer, the host latches its existing review-input
observer exclusion. Derived answers and completion/review prose stay out of
shared memory and public observer projections; the local worker also excludes
the whole tool batch and its retained history. Ordinary replacement input follows
the existing observer-release rules, without changing private-task authority.

The existing source registry owns an optional projection receipt bound to raw
SHA-256, complete text SHA-256 and the genuine converter fingerprint (or named
UTF-8 decoder). This adds no source registration authority or second source
store. A read does not retrofit a receipt or execute a network fetch. A bounded
latest-link inventory and current screened metadata collapse overlapping origins
into opaque connected groups; unknown/private/overflow evidence gives no group
count. Group counts are provenance, never an independence or truth verdict.
#901 keeps the sole person-judgment record. The explicit synthesis check below
consumes it without deriving a verdict from evidence relations.
Stored evidence adds a conditional `research_evidence` recovery feature and
`{links, revisions, digest}` integrity section. An absent section is the empty
store, preserving older recovery records; an empty database requires no new
feature. Provenance never manufactures a person verdict or readiness result.

### Explicit synthesis readiness (#931 T3)

`ahub study evidence --task <task>` exposes bounded authoring bindings, not
source or claim prose. `ahub study check <task> <manifest.json>` accepts only a
version-1 manifest naming the task incarnation, registered Markdown/BibTeX
deliverable IDs and SHA-256 hashes, current #901 claim identities/revisions,
complete latest-link inventory revision/hash per claim, and selected evidence
IDs/revisions with citation keys. The hash includes every latest inventory row,
including unselected counterevidence and withdrawn links. No second claim or
judgment identity/store is created.
The manifest shape permits at most 64 KiB, 50 claims, 128 selected links total
and 128 ASCII characters per citation key. The existing bounded latest-link
inventory must be complete. Guarded document/bibliography reads use 256 KiB and
4 MiB; one check refuses above 64 MiB of active registered raw source inputs.

`EvidenceLinkV1.status` may be `withdrawn` only on a later append-only revision.
Legacy omission means active and keeps its original canonical bytes/ID;
explicit active input normalizes to omission. Withdrawn rows remain in complete
inventory bindings but supply no active locator. A link that was ever
`contradicts` remains unresolved after withdrawal or reclassification: its state
is `withdrawn`, never silently `none`. Only a person's resolved/qualified
disposition bound to the current manifest clears it, whoever withdrew it. The owner or
console person uses the existing writer for withdrawal; the active task's owner
is fenced separately from the actual recorded actor. Source, claim and privacy
admission stay unchanged. The person exception permits withdrawal, not initial
active-link creation. Historical revisions retain current privacy checks.
Person withdrawal also requires an in-progress public research task. Closed
task evidence stays final: corrections require a follow-up research task and
its own manifest binding, and a refusal names that next step. The earlier task's
manifest cannot be applied to the new task incarnation.
The host verifies each retained revision's canonical hash and contiguous
sequence within 1,024 revisions per claim. Missing, corrupt or over-window
history is unknown and cannot verify readiness. Current privacy also covers
historical source references used by this observation. The history spans claim
revisions of the same claimId and contributes its verified commitment to the
existing inventory revision/hash. Moving a link to another claim revision or
restoring the exact #901 claim list cannot discard its former contradiction
or re-bind an earlier person disposition. #901 identity and verdict restoration
remain unchanged.
Recovery requires `research_evidence_withdrawal` only while a persisted
withdrawal revision needs its newer parser. Active-only legacy stores retain
their existing compatibility requirement.

The existing person-only #901 `ClaimVerdict` may carry optional
`synthesis: {manifestSha256, disposition: resolved|qualified}`. The console
`ahub task claim` takes paired `--manifest <manifest.json>` and `--disposition`
flags. The descriptor is transient. At entry, the hub independently refreshes
current bindings and recomputes its canonical manifest hash; a mismatch names
the current hash and refuses before the existing history write, inside the
final snapshot fence. No changed inventory silently re-binds an earlier
disposition. It records no claim or qualification prose. A disposition closes an open contradiction
only when its manifest hash, claim revision, full inventory and artifact/source
bindings are current. Agent/model relation labels never supply this authority.
The CLI requires `research_synthesis` from the authenticated welcome before
requesting the new study operations or sending an extended `claim_verdict`.
Without it, upgrade/restart is required before any verdict mutation is sent;
an older daemon must never silently turn a requested synthesis disposition into
a plain verdict. Ordinary #901 verdicts retain their earlier compatibility.

Tasks owns both reads. The host obtains current state; callers cannot supply
screened artifacts, provenance resolutions or person authority. Artifact reads
use the guarded #509 path/hash boundary. Every active inventory link resolves
through screened source-read/projection checks. Final raw/projection/converter
and artifact identity/stat fences run after asynchronous reads. Current task,
actor, policy, inventory and privacy are checked again. Any concurrent board
write conservatively stales the batch; a task-scoped evidence generation is the
later narrowing path. A private upgrade returns only a neutral task/status
stub. Incomplete inventories and unavailable observations cannot verify
readiness. The observer latch precedes evidence-derived inputs.

The pure offline checker reports citation resolution, source/locator freshness,
person-judgment presence, contradiction state and unchanged deliverables
separately. The person verdict class (`supported`, `unsupported`, `unclear`)
is shown independently from judgment presence. Any is a recorded assessment
for structural readiness; ready never means the person supported the claim.
Every currently declared claim must be covered. A model's relation
label or matching passage cannot certify semantic support. Offline forbids
document fetching and network source reads, while the existing configured
privacy screen may run. An unavailable or unknown screen is never clear; the
observational read cannot change source privacy because screening did not clear.
Actual source privacy upgrades still suppress the result. No earlier readiness
binding remains current after a claim, artifact, projection or inventory
change. The command runs only explicitly and preserves legacy citation-script
semantics and ordinary dev-profile completion behavior.

## Execution-reference admission (#1220 T2)

`Tasks.linkExecutionReference` admits deduplicated inert metadata using the current
local task id, creation identity, actor role and flow revision. Privacy and role
checks run before reads and again after screening, before the atomic Board write.
An identical reference replay creates no second row; stale authority never becomes
valid because the metadata already exists. Only these admitted references add
persistence. Read models reuse existing task/attempt rows and recorded evidence,
with an explicit owning-task scope for dispatch/output/deliverable roots. They
perform no whole-board scan, native probe, memory write or external resolution.
Foreign producer keys remain declared target metadata in their own namespace.
Review currency retains the exact historical head/hash and never carries to
changed output. The bounds, unavailable equivalence and source-bound cursors are
specified in [the execution-reference contract](execution-reference.md).

## Guidance-variant lifecycle (#1225 T2)

Tasks owns immutable guidance proposals, reads and terminal withdrawal through
its current task-role, actor/session and privacy fences. Snapshot bodies stay
in separate private experiment/variant tables, never on Task, refs, plan or
history. A duplicate never revives stale authority or a withdrawn record; reads
can show authorized history without declaring it currently applicable. These
operations change no live role, ownership, permission, routing or native input.
Controlled recovery retains their conditional feature floor and exact digest.
The closed payload, storage bounds, declared evidence limits and recovery
streaming ceiling are specified in [the guidance contract](guidance-experiments.md).

## Read models and policy extensions

Agent list reads return bounded, newest-updated compact pages built from public rows, with a keyset cursor and explicit detail/ID reads. Console compatibility is separate. Pagination is not a frozen snapshot during concurrent edits; its purpose is bounded communication without bypassing private-row projection ([#1083](https://github.com/STAIxBWLB/agent-hub/issues/1083)).

Lifecycle policy can be off, advisory or enforced; this is separate from always-applicable role and privacy invariants. Plans, cost/check scope, review findings and external evidence retain their own typed provenance. Research campaigns and experiments likewise distinguish declared, host-observed and runner-attested facts instead of promoting prose to a signed result ([#481](https://github.com/STAIxBWLB/agent-hub/issues/481), [#932](https://github.com/STAIxBWLB/agent-hub/issues/932), [#1018](https://github.com/STAIxBWLB/agent-hub/issues/1018)). Detailed research contracts remain in the [campaign design](../specs/2026-11-01-research-campaigns-design.md).


Enabled lifecycle plans may retain a full base commit, excluded literal paths, stop conditions and ordered steps with verification text. Exclusions override broader includes in PR conformance, including the merge queue. Accept drift compares the base with the local remote-tracking default tip resolved through `refs/remotes/origin/HEAD`, without requiring a task head. Done drift compares the base with the unique merge-base of the recorded task head and that default tip, excluding own commits. Require the base to be an ancestor of the selected endpoint, recheck the default tip, and keep missing, shallow, ambiguous, reversed, foreign or incomplete evidence unknown. Use bounded hardened local-only Git and privacy-screened names; never fetch, use checkout HEAD or guess a default branch. Drift is advisory in every lifecycle mode, independent of the existing PR conformance approval gate. Verification text grants no execution authority. Off exposes no new plan schema or drift readback ([#1403](https://github.com/STAIxBWLB/agent-hub/issues/1403)).

When the specs policy is enabled, covering design specs participate in proposal/accept notices and completion/review reports. Report mode informs; require mode needs an updated spec or a recorded acknowledgement for each applicable unchanged spec. Commitless and verified no-change work remains quiet, and private evidence is withheld rather than exposed to satisfy a report. These modes preserve owner choice while making design drift visible ([#1064](https://github.com/STAIxBWLB/agent-hub/issues/1064)).

## Worktree shelf (#1057)

The board stores facts about worktrees and never a verdict. `worktree_override` holds only a person's Park (`settled`) or Pin (`active`) per absolute path and its time; whether a worktree is settled is derived on every read by the pure `partition` from the git facts, the bound task (the open or latest task whose `refs.branch` is the worktree branch, never a PII task), the PR state and those overrides. An override counts only while no newer activity exists, and a later write removes an inert one.

The PR state has two sources and no others. The board's own evidence says `merged` only through the guarded merge's record (`sdlc.merge`); a cancelled task or a task with no record says nothing about its PR and reads `unknown`. The person's explicit refresh (`worktrees_refresh_prs`, `src/hub/worktree-prs.ts`) reads the PR through `readSdlcPr`, bounded and one at a time, and keeps `open`, `merged` or `closed` with GitHub's own change time in the daemon's memory. `worktree-shelf.ts` holds no GitHub access, so a panel read, `ahub worktrees` and the inbox alert make no GitHub call.

A worktree whose activity could not be read is live and never settled. The shelf reads git asynchronously under a total budget and answers `complete: false` when it is cut; the daemon's event loop is never held. The daemon deletes no worktree and no local branch: its git port allows three read argv shapes, and removal exists only in the person's own `ahub worktrees tidy --confirm`, which is console class and issues `git worktree remove` and `git branch -d`, never `--force` or `-D`. Operations: `docs/operations.md`, "The worktree shelf (#1057)".

## Anchored review packages (#1056)

`ReviewFinding.anchor` uses the exact-pinned `@staix/agent-console` 0.1.3 DOM-free `./contract` entry through type-only imports. The generated declaration bridge is removed. `test/acon-review-contract.test.ts` checks the unchanged shared fixtures against both the published acon conformance functions and the hub validator; the project retains its Bun-only TypeScript libraries. Contract conformance and hub writes are separate: hub writes allow 1-4 selectors, 512 UTF-8 bytes for an exact quote, 64 each for prefix and suffix, 256 for a hunk header, 2048 for a comment body and 64 comments per task. The hub additionally caps paths at 4096 bytes, projection name/version and structural scheme at 128 each, structural ref at 512 and verified author identity at 512. These bounds keep each stored thread within its fixed read bound. Quote selector text remains exact in storage; `sanitize()` applies when it is rendered beside hub headers. The hub limits count UTF-8 bytes, independently of acon's character limits: 171 Hangul syllables exceed the 512-byte exact-quote cap. Refusals identify the field, bound and next step. Unknown fields and selectors refuse before effects. A finding path, when present, must equal its anchor path. Findings without anchors retain the existing head buckets and Important carry-over rule.

All person comment writes go through `Tasks`. The console can put or delete a draft without a peer envelope. An explicit send binds the selected immutable anchors and bodies to one package, changes their lifecycle to sent, appends one count-only task history entry and attempts one review envelope. A failed or uncertain notification never retries automatically. Its receipt distinguishes queued from unconfirmed delivery; neither means the owner read it. The saved package retains its immutable body, envelope identity, original visibility binding and versioned publication-evidence contract. Its serialized record must fit 32768 UTF-8 bytes before any sent write. A previously unpublished package is admitted only while every selected comment remains sent and its originally visible text remains public under current policy; a missing binding, dismissal or privacy change refuses without rewriting or publishing the old body. An explicit confirmed Send with `packageId` recovers only that saved package. Durable queue or delivery evidence makes this idempotent, including after restart; failed or discarded deliveries refuse with their actual state and `ahub queue` inspection guidance rather than reporting queued or replaying the effect. Unknown evidence and legacy packages refuse with inspection guidance. Person-package terminal receipts are retained alongside the package rather than pruned with ordinary delivery history. Quote-bearing reviewer requests use a distinct `reviewer-request-` marker and their terminal rows follow ordinary pruning. This retains a full receipt per package; package archival with an IDs-only tombstone is the upgrade path. Deleting a sent comment dismisses it without rewriting its anchor. Only a final successful owner completion may claim resolved comment IDs; a queued or failed check leaves them sent. That claim is not person verification or a review verdict.

The actor is the console person, not a conductor or a peer. acon authorship comes only from the server-built `ActionMeta` argument. Client body fields cannot supply an author, timestamp or authority. The standalone dashboard is read-only; acon's shared `ui.review` kit owns selection and Send. Older acon hosts without the kit retain the read-only view.

Placement is computed before reads and sends, never persisted over the stored anchor. Equal content hashes are anchored; a different hash with a uniquely matching exact quote is moved, with context breaking ties; unresolved changes are outdated. Missing, denied, private or over-budget material is unavailable. Projection identity mismatches are outdated before hash comparison. A display range from moved placement never becomes a new stored selector. An unavailable public comment retains its stored thread in the person view, labelled unavailable. Send refuses before any effect and names each unavailable selected comment. Actual PII/private comments remain count-only. Carried finding placement belongs to one asynchronous review admission. Rare synchronous role re-offers without that material report unavailable until the next refresh, rather than reusing old coordinates.

Periodic dashboard snapshots perform no comment-material Git or GitHub reads. Explicit task open or refresh requests the review section; a failed read marks only that section unavailable. Material uses the recorded task head and never substitutes the worktree HEAD for a missing commit. Material comes only from guarded immutable Git snapshots in the task's declared refs, plan paths or sections, or complete same-head verified PR paths. Every operation shares eight distinct files, eight seconds including head/PR preparation and 12000 serialized presentation bytes. Both sides share the budget. Truncated material cannot establish placement. Raw hashes bind bytes; projected hashes bind only UTF-8 projected text. The projection name is `text-projection:<extension>` and its version is the existing configured converter fingerprint. This is an opaque configuration identity, not an upstream semantic version; a converter version protocol would be the upgrade path.

PII comments remain board-local and public views expose counts only. Private paths retain only supplied lineRange or structural selectors; no coordinate is invented when unsafe selectors are removed. Public review packets carry a host-only opaque package marker so their intended owner receives the packet while logs, operational tails, incoming labels, capture and memory observers receive no quote or body. This marker does not turn an ordinary task into a PII turn. Structured anchored verdicts retain the GitHub verdict mirror with a verdict-only headline when quote provenance is present. Decision metadata, contradiction and safe recurring criteria retain their existing paths; quote-bearing finding proposals remain excluded. The configured PII screen checks reviewer prose before owner-facing publication without receiving source quote selectors. Durable open sent comments and outstanding anchored findings bind shared-memory admission only to the task a note names and its recipient, across restart and intervening chat. Sent comments hold those task-bound writes until resolution or person dismissal; resolved or dismissed comments alone do not retain reviewer history scope. They do not hold notes for an unrelated task or an untagged note after ordinary new input. Anchored-finding scope is conservatively held until the task closes, including later fixed dispositions; a persisted review-package epoch is the path to narrower closure. The metadata scope read is cached against database change stamps and fails closed above 500 role tasks or 16 MiB of UTF-8 history. This exclusion does not hide the owner's summary or check output from its reviewer or owner. Review requests retain trusted observer provenance whenever historical anchors or non-draft comments can be reflected in the completion text, including after comment resolution. Current input provenance separately holds all shared-memory writes and observer sinks for an actually delivered quote-bearing review input or a newly submitted anchored verdict, even if the verdict is refused or immediately closes the task. This exclusion is latched for the input turn until a permitted ordinary next-turn handoff replaces it; restored pull-only sessions instead require a changed native identity. Resolving comments or ending the task alone does not clear it. Bounded ID-only journal receipts preserve held session/input provenance across daemon restart. No matching held record in a complete, intact and readable store is clean; missing expected prior-session records and unreadable, corrupt or unconfirmed session coverage remain unknown. A validated matching release receipt confirms only its own identity. Restored pull-only sessions retain their hold until the native identity changes, regardless of inbox handout. An empty in-memory map alone is not replacement proof. Presence-only traffic and additional inputs within the same active turn cannot clear a latched exclusion. Committed inbox handouts carry the same current-input provenance as push input without claiming a native ACK. Local-worker batches latch before executing any tool, and their final answer and retained history obey the same exclusion. Owner-addressed review outcomes cannot be automatically settled merely because task or reviewer state moved. Original saved-package recipients retain comment scope while comments remain sent, and queued/deferred or unsettled delivery records retain their actual recipients independently of current task roles. A comment dismissal is not a delivery-consumption receipt; any separate uncertainty hold requires explicit disposition. Recovery treats an absent comment section as empty and checks the optional section's counts and digest when present.

## Repository required checks (#1328 T1)

Review admission (fresh and cached), CI watches and guarded merge resolve the same
repository-specific and top-level required names. Only `STAIxBWLB/agent-hub` has a
native fallback including `seeded guards` for fresh/cached review admission and
CI watches. Guarded merge continues to require explicit configured names. Another
repository with no names stays unknown and cannot become ready through an empty
CI set. Init discovers names in
one bounded operation of at most three capped GitHub reads, falling back to bounded
literal workflow metadata on unknown or incomplete evidence. Enforce without names
refuses before writes. Read-only settings expose running and file SDLC values
without adding writable settings or widening caller authority. See
[SDLC required checks](../sdlc.md#required-checks-at-initialization) for bounds and
unsupported workflow shapes.

## Entry diagnostics (#1328 T2)

Build-entry guidance is pure snapshot data, ordered as missing issue identity,
person spec acceptance, then planner review, each with the actor and command.
Routing/explain may display it but never read GitHub or change candidate eligibility
because of it. Existing plan-review holds use the ready-held path, preserving the
plan-only offer gate; live acceptance still checks spec then plan and rechecks its
original authority/snapshot. Workflow holds are not peer-ineligibility stalls.
Private projections withhold issue-specific guidance. Fresh and complete cached
CI diagnostics share named missing/pending/failed/duplicate/unknown check states,
without relaxing required checks, inventory completeness or identical-tree reuse.

Fresh GraphQL review reads retain the original success proof: a CheckRun must be
COMPLETED with conclusion SUCCESS; a StatusContext must have state SUCCESS.
Common normalization cannot turn malformed fresh proof into admission. The shared
parser and cached evidence schema retain their existing contracts.

## Reviewer quota waits (#1446)

Automatic reviewer selection shares `review.gate` (default 0.8) across routing and explain using canonical-account projected headroom. Unknown/no-source readings skip rather than pass. A quota-only exhausted pool may wait only when every declared candidate is actually paused or at the known floor and each has a known reset; other blockers prevent waiting. Persist task incarnation, opaque head/repo binding, first start and deadline in ordinary role history. The first `task_sweep.review_min` deadline is the sole hard cap; reset timestamps only wake a recheck (including Budget's existing reset plus 60-second grace), and later signals/restarts cannot extend the cap. Expiry/unknown returns to existing fallback. Head/private/close/stop changes cancel timers. Quota does not join the permanent per-head failure set. `review.max_minutes` defaults to 20; a child-specific generation fence and existing owned teardown produce a typed timeout without closing the task.

Quota deadline fallback and native input admission are separate: a person fallback needs no native readiness read, and a failed agent readiness read falls to the person under the same incarnation/head/privacy/recovery fence. `reviewer_quota` is required for a controlled recovery target when new wait/accounting history or explicit new policy exists; it is not a blanket version floor.

## Advisor survey and rejection ledger (#1403 T7)

Only Tasks starts a survey or changes its private ledger. The person or current
configured conductor starts one read-only planner task at a pinned repository
commit. Assigned in-progress planner reports contain closed bounded findings
and explicit code-vetting decisions. High/medium vetted confidence yields one
backlog plan card per semantic repository/pass/id key; low yields a read-only
investigation. Candidates do not produce cards. Dedupe lookup, generation/flow
fences, ledger decisions and card creation share one Board transaction after
privacy screens; no source I/O or await occurs inside it.

False-positive review dispositions, rejected audit candidates and survey
rejections retain immutable considered entries. Matching uses the same semantic
id/positional exclusion convention as review recurrence. Repository identity,
source commit and literal affected paths scope suppression. A complete diff
clears only changed paths; unknown evidence never clears rejection. Explicit
planner vetted reason records reconsideration and permits a new card without
deleting historical rejection. Unknown path/ref records remain historical,
never invented unchanged proof. Public projections preserve existing security
and PII boundaries; internal repository keys are not public markers. Survey
arguments/results stay out of capture. Off exposes no new tool/task fields,
and no background scanner, timer or model judge is introduced. Live pilots
require the person's separate instruction.

Survey reports accept at most 64 candidates and 64 KiB per normalized request. A candidate has at most 64 literal paths (512 bytes each) and 2048-byte narrative fields. Historical readback returns at most 16 reasons per key; a 1000-row history window that cannot be read completely remains unknown and suppressed. The bounded 32-key/3072-byte brief is a summary, not a complete rejection inventory. `advisor_surveys` advertises parser/recovery support independently of lifecycle mode, but survey tools and task metadata are published only when enabled. Persisted survey or considered state requires that feature and its conditional integrity proof on recovery; empty legacy stores keep their existing format floor.
