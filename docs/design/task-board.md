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
  - src/hub/tasks.ts
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

Projection hashes/version are caller-declared T1 bindings; only the raw source
hash is checked against registry metadata. Locator resolution, Unicode offset
conversion and current-privacy public revalidation are T2. Evidence read/CLI
surfaces, complete inventory bindings and synthesis readiness remain later work.
Stored evidence adds a conditional `research_evidence` recovery feature and
`{links, revisions, digest}` integrity section. An absent section is the empty
store, preserving older recovery records; an empty database requires no new
feature. Provenance never manufactures a person verdict or readiness result.

## Read models and policy extensions

Agent list reads return bounded, newest-updated compact pages built from public rows, with a keyset cursor and explicit detail/ID reads. Console compatibility is separate. Pagination is not a frozen snapshot during concurrent edits; its purpose is bounded communication without bypassing private-row projection ([#1083](https://github.com/STAIxBWLB/agent-hub/issues/1083)).

Lifecycle policy can be off, advisory or enforced; this is separate from always-applicable role and privacy invariants. Plans, cost/check scope, review findings and external evidence retain their own typed provenance. Research campaigns and experiments likewise distinguish declared, host-observed and runner-attested facts instead of promoting prose to a signed result ([#481](https://github.com/STAIxBWLB/agent-hub/issues/481), [#932](https://github.com/STAIxBWLB/agent-hub/issues/932), [#1018](https://github.com/STAIxBWLB/agent-hub/issues/1018)). Detailed research contracts remain in the [campaign design](../specs/2026-11-01-research-campaigns-design.md).

When the specs policy is enabled, covering design specs participate in proposal/accept notices and completion/review reports. Report mode informs; require mode needs an updated spec or a recorded acknowledgement for each applicable unchanged spec. Commitless and verified no-change work remains quiet, and private evidence is withheld rather than exposed to satisfy a report. These modes preserve owner choice while making design drift visible ([#1064](https://github.com/STAIxBWLB/agent-hub/issues/1064)).

## Worktree shelf (#1057)

The board stores facts about worktrees and never a verdict. `worktree_override` holds only a person's Park (`settled`) or Pin (`active`) per absolute path and its time; whether a worktree is settled is derived on every read by the pure `partition` from the git facts, the bound task (the open or latest task whose `refs.branch` is the worktree branch, never a PII task), the PR state and those overrides. An override counts only while no newer activity exists, and a later write removes an inert one.

The PR state has two sources and no others. The board's own evidence says `merged` only through the guarded merge's record (`sdlc.merge`); a cancelled task or a task with no record says nothing about its PR and reads `unknown`. The person's explicit refresh (`worktrees_refresh_prs`, `src/hub/worktree-prs.ts`) reads the PR through `readSdlcPr`, bounded and one at a time, and keeps `open`, `merged` or `closed` with GitHub's own change time in the daemon's memory. `worktree-shelf.ts` holds no GitHub access, so a panel read, `ahub worktrees` and the inbox alert make no GitHub call.

A worktree whose activity could not be read is live and never settled. The shelf reads git asynchronously under a total budget and answers `complete: false` when it is cut; the daemon's event loop is never held. The daemon deletes no worktree and no local branch: its git port allows three read argv shapes, and removal exists only in the person's own `ahub worktrees tidy --confirm`, which is console class and issues `git worktree remove` and `git branch -d`, never `--force` or `-D`. Operations: `docs/operations.md`, "The worktree shelf (#1057)".

## Anchored review packages (#1056)

`ReviewFinding.anchor` uses the published `@staix/agent-console` 0.1.0 contract. Its DOM-free declaration bridge is `src/hub/acon-review-contract.d.ts`, generated mechanically from the installed canonical declarations by `scripts/acon-review-types.ts`. `test/acon-review-contract.test.ts` regenerates and compares every byte; imports are type-only. The bridge exists because the published contract entry forces DOM globals into Bun-only consumers. It is deleted in favor of direct type imports once acon publishes a DOM-free entry. No contract shape is hand-maintained. The exact shared review fixtures remain unchanged. Contract conformance and hub writes are separate: hub writes allow 1-4 selectors, 512 UTF-8 bytes for an exact quote, 64 each for prefix and suffix, 256 for a hunk header, 2048 for a comment body and 64 comments per task. The hub additionally caps paths at 4096 bytes, projection name/version and structural scheme at 128 each, structural ref at 512 and verified author identity at 512. These bounds keep each stored thread within its fixed read bound. Unknown fields and selectors refuse before effects. A finding path, when present, must equal its anchor path. Findings without anchors retain the existing head buckets and Important carry-over rule.

All person comment writes go through `Tasks`. The console can put or delete a draft without a peer envelope. An explicit send binds the selected immutable anchors and bodies to one package, changes their lifecycle to sent, appends one count-only task history entry and attempts one review envelope. A failed or uncertain notification never retries automatically. Its receipt distinguishes queued from unconfirmed delivery; neither means the owner read it. Deleting a sent comment dismisses it without rewriting its anchor. An admitted owner completion may claim resolved comment IDs; that claim is not person verification or a review verdict.

The actor is the console person, not a conductor or a peer. acon authorship comes only from the server-built `ActionMeta` argument. Client body fields cannot supply an author, timestamp or authority. The standalone dashboard is read-only; acon's shared `ui.review` kit owns selection and Send. Older acon hosts without the kit retain the read-only view.

Placement is computed before reads and sends, never persisted over the stored anchor. Equal content hashes are anchored; a different hash with a uniquely matching exact quote is moved, with context breaking ties; unresolved changes are outdated. Missing, denied, private or over-budget material is unavailable. Projection identity mismatches are outdated before hash comparison. A display range from moved placement never becomes a new stored selector. An unavailable public comment is an IDs-only view stub, without a thread, path, body or selectors; actual PII/private comments remain count-only. Carried finding placement belongs to one asynchronous review admission. Rare synchronous role re-offers without that material report unavailable until the next refresh, rather than reusing old coordinates.

Material comes only from guarded immutable Git snapshots in the task's declared refs, plan paths or sections, or complete same-head verified PR paths. Every operation shares eight distinct files, eight seconds including head/PR preparation and 12000 serialized presentation bytes. Both sides share the budget. Truncated material cannot establish placement. Raw hashes bind bytes; projected hashes bind only UTF-8 projected text. The projection name is `text-projection:<extension>` and its version is the existing configured converter fingerprint. This is an opaque configuration identity, not an upstream semantic version; a converter version protocol would be the upgrade path.

PII comments remain board-local and public views expose counts only. Private paths retain only supplied lineRange or structural selectors; no coordinate is invented when unsafe selectors are removed. Public review packets carry a host-only opaque package marker so their intended owner receives the packet while logs, operational tails, incoming labels, capture and memory observers receive no quote or body. This marker does not turn an ordinary task into a PII turn. Structured anchored verdicts bypass quote-bearing memory notes, candidate screening and the GitHub verdict mirror. Completion summaries submitted during a review turn are withheld from observer sinks, including delayed check output; they remain on the Board. Recovery treats an absent comment section as empty and checks the optional section's counts and digest when present.
