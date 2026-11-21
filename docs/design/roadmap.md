---
id: roadmap
type: module
title: Roadmap Milestones
status: active
parent: agent-hub-architecture
depends-on: [task-board]
paths:
  - src/hub/roadmap.ts
  - src/hub/roadmap-view.ts
  - src/hub/roadmap-unplaced.ts
  - src/hub/roadmap-triage.ts
  - src/hub/roadmap-decompose.ts
  - src/hub/roadmap-check.ts
  - src/hub/roadmap-sync.ts
  - src/hub/roadmap-export.ts
  - src/hub/github-import.ts
  - src/hub/specs-task.ts
  - src/hub/board.ts
  - src/hub/tasks.ts
  - src/hub/hub-tools.ts
  - src/hub/daemon.ts
  - src/hub/restart.ts
  - src/cli/roadmap.ts
  - src/cli/roadmap-write.ts
  - src/cli/main.ts
  - src/cli/help.ts
  - src/cli/identity.ts
  - test/roadmap.test.ts
  - test/roadmap-board.test.ts
  - test/roadmap-daemon.test.ts
  - test/roadmap-cli.test.ts
  - test/roadmap-recovery.test.ts
  - test/roadmap-unplaced.test.ts
  - test/roadmap-triage-tasks.test.ts
  - test/roadmap-decompose.test.ts
  - test/roadmap-r3-cli.test.ts
  - test/roadmap-r3-daemon.test.ts
  - test/roadmap-check.test.ts
  - test/roadmap-sync.test.ts
  - test/roadmap-export.test.ts
  - test/roadmap-write.test.ts
  - test/roadmap-r4-daemon.test.ts
  - test/check-roadmap.test.ts
  - scripts/check-roadmap.mjs
---

# Roadmap milestones

R1 implements [#1479](https://github.com/STAIxBWLB/agent-hub/issues/1479) of the
[#1478 roadmap](https://github.com/STAIxBWLB/agent-hub/issues/1478). The board is
the source of truth. R1 adds no GitHub writes, roadmap model calls, export,
automatic task assignment, dashboard or console UI. R3 ([#1481](https://github.com/STAIxBWLB/agent-hub/issues/1481),
"Bottom-up placement" below) adds the first roadmap model call and read-only GitHub
reads; R2 part 1 ([#1480](https://github.com/STAIxBWLB/agent-hub/issues/1480), "Decomposition" below)
adds a second model call over the same read-only path. Neither adds a GitHub write.

R1 adds no generation, triage or decomposition call; those belong to R2 and R3. R2
part 1 is the read-only proposal only: nothing is intaken, linked or published, and
accepting a part or writing to GitHub is a later part.
The existing mandatory privacy screen on planner-written text stays exactly as
`Tasks.newRelease` applies it, including on milestone title and outcome. It fails
closed where newRelease does and is never bypassed.

## Storage and writes

The additive `milestones` table keeps id, title, outcome, state, horizon,
`milestone_order`, optional target date and parent, revision, history and
creation/update times. `milestone_links` records milestone, kind, ref, actor and
time, unique on milestone/kind/ref. No existing task or release column changes.

States are proposed, planned, active, done and dropped; horizons are now, next
and later. A new row defaults to proposed/later/order 0. Target dates are actual
YYYY-MM-DD calendar dates. A parent must exist at the top level; self-links,
cycles, grandchildren and moving an existing parent under another parent refuse
atomically. Parent links organize milestones; they do not silently copy child
membership into the parent's roll-up.

Every external write goes through Tasks. The configured planners, the unique
configured conductor and the person may create, edit, link, unlink and order.
Only the person records done or dropped, including through create/edit fields.
Settled milestones are final. Private turns, held review input, recovery,
shutdown, storage failure and changed caller authority refuse writes before any
effect. Text screening is followed by current role, privacy and revision checks.

Edits require the revision returned by show. Every write uses a transactional
revision compare-and-set. Link changes and their history/revision update commit
together. An identical link/unlink replay changes nothing. History contains at
most 256 metadata events: actor, time, event, field names and link kind, never
task text or the linked task id. Ordinary mutations reserve the last event slot
for the person's done/dropped settlement, so reaching the ordinary-write ceiling
cannot strand an active milestone. Duplicate link/unlink replays consume no slot.

## Membership and computed progress

An explicit task link takes precedence over issue inheritance across the whole
roadmap. Without an explicit placement, a task belongs to each milestone linked
to its canonical source issue. Readbacks identify explicit placement or
`source-issue` placement with the qualified issue ref (the person renderer says
"inherited from #N"). GitHub-import identity is the existing `Task.external`;
otherwise Tasks reuses its canonical plan-issue identity, including `sdlc`.
No parallel `refs.source` field is introduced.

Progress is computed at read time, never persisted or inferred from prose:

- Tasks: approved and total public members, plus a separate withheld count.
- Issues: closed and total linked public issues; state comes only from matching
  persisted plan-review issue metadata, with its cache time. The newest matching
  receipt wins; missing evidence or conflicting equally recent receipts are
  unknown. A task's approval does not prove its issue closed. Reads do not call
  GitHub.
- Specs: fresh, stale, unverified or unknown from the existing spec graph. An
  unavailable, erroneous or truncated graph supplies no complete proof. Missing,
  ambiguous and nonancestor entries stay unknown; nonancestor provenance is
  retained. The internal host report is used without the public hub_specs
  presentation cap.
- Releases: shipped and total linked delivery trains, unknown for a missing row.
  Milestones do not alter release train scope or state rules.

Private tasks appear only in the withheld count, even for the person's roadmap
view. Task ids, titles, direct links and provenance are omitted. Current metadata
screens apply to links and inherited provenance as well as titles. A ref that
becomes private cannot remain in a task's placement. Staged backlog text stays
hidden from non-planner agents. Reads refuse private and held review contexts.
No roadmap writer emits task text to logs, events, notices or memory.

## Tools and CLI

The three tools are `hub_roadmap_list`, `hub_roadmap_show {id}` and
`hub_roadmap_edit {op, ...}`. The edit operations are new, edit, link, unlink,
order and state; fields and operands are closed per operation. A schema grants
no authority: Tasks and the daemon enforce current caller and read-only limits.
Every control rid gets a response, including unknown roadmap operations.

`ahub roadmap` defaults to list. `list` and `show <id>` support `--json`; default
output is for a person. Mutations are:

- `new --title <text> --outcome <text>` with optional horizon/order/target/parent.
- `edit <id> --revision <n>` with those optional fields; target/parent `none`
  clears the field.
- `link|unlink <id> <spec|issue|task|release> <ref>`.
- `order <id> <n>` and `state <id> <state>`.

Issue refs are qualified owner/repo#N, task/train refs are positive ids, and spec
refs are spec ids. Parsing refuses unknown flags and extra operands before a
connection. Normal agent shells keep peer identity; terminal states stay
person-only, and live-test delegation cannot write milestone content.

## Recovery

Rows are preserved in the same hub database through restart. Retained milestone
state requires the roadmap capability on a controlled recovery target and adds
its ordered row/link digest to integrity. Empty databases retain the existing
format floor and integrity shape; the additive tables do not advance the database
format marker.

## Decomposition (R2)

R2 turns a milestone into the parts of work that deliver it. Part 1 is the read-only proposal: nothing is intaken, linked,
proposed as a task or published, and it changes no board row except the saved model answer.

**Proposal.** `ahub roadmap decompose <id> [--json]` and `hub_roadmap_decompose {id}` (configured planner or unique conductor,
never during a PII or private turn) ask the hub's model how one milestone decomposes. The model sees that milestone's own title
and outcome and what the milestone already links: the summaries of its `goal` and `architecture` specs (or, when it links neither
type, of whatever spec types it links) and its linked issue refs with the titles from one bounded `readGitHubIssuePages` read.
Every spec id, title, path and issue title must pass `publicMetadataText` first: a spec that fails is not offered at all, an issue
title that fails or cannot be read is offered by its ref alone, and a milestone whose own title or outcome is withheld refuses
before any model call. The prompt asks for one JSON array of at most eight and at least one part in the `hub_backlog_split` parts
schema (`title`, `detail`, `class`) plus `needs_spec` (true: a feature or behaviour change that needs its own spec issue; false: a
mechanical chore that goes straight to a task) and `cites`.

**Reader and storage.** `parseDecomposition` (`src/hub/roadmap-decompose.ts`) keeps a part only when its title and detail are
bounded, its `class` is a `hub_task_propose` class, `needs_spec` is a boolean and at least one cite names an id the model was
shown; the answer is capped at eight parts and a repeated title is dropped. `intake` records the `needs_spec` decision as `spec`
or `task`. Each kept part is screened again at the write and stored as a pending row of `milestone_decompositions`, attributed to
`hub` as a model's answer. One pending row per milestone, so a newer run supersedes the older one in the same transaction, and
settled rows keep the newest 200. An answer that cites nothing it was shown saves nothing and is reported in `dropped`. No model,
a dead one, or a milestone that links nothing to decompose from reports `unavailable`, never a silent empty result.

**Held intake draft.** `ahub roadmap decompose <id> --accept <part>` and `hub_roadmap_decompose {id, accept}` (the same configured
planner or unique conductor, refused during a PII or private turn) accept one part of the pending answer, named by the 1-based
position the proposal printed. Accepting creates the existing intake hold rather than a new board state: a backlog task with
`draft`, so nothing offers, pulls or routes it, and the draft's text carries the part's `spec`/`task` kind and the milestone id a
person reads before releasing it. The draft is linked to the milestone as a `task` link, and every board write goes through
`Tasks`. `milestone_decomposition_accepts` keys each accepted part by its answer row and position, so accepting the same part
twice returns the draft the first accept made and the board gains no row; a superseded answer is not pending, so an accept cannot
land on it. An accept needs a pending answer and a part inside it, both refused before any write, and a milestone settled to
`done` or `dropped` while the answer waits refuses there too. One accept of a part runs at a time, so two concurrent accepts of
the same part make one draft and read the same task, and once the draft is saved the accept record, the link and the notice are
best-effort: the caller is never refused after a board write, and a retry records a link an interrupted tail lost. Release stays
the existing `ahub intake approve` by the person or the conductor acting for them, so no part reaches a peer before that approval
and this command grants no release authority of its own. The reply and its notice carry the draft's id and the part's kind only:
the result is a public view, so a part whose draft carries a PII signal reads `[withheld]` and no stored text is repeated.

**Publish.** `ahub roadmap decompose <id> --publish` and `hub_roadmap_decompose {id, publish}` (the same configured planner or
unique conductor, refused during a PII or private turn) preview what the milestone's held drafts would create on GitHub, and
write nothing: no `gh` call, no board row and no link. Only a held `spec` part creates an issue, because it is the one that needs
its own spec issue before implementation; a `task` part is already its own held draft, a draft the person already released is
skipped, and a private part is counted and never published. The plan is one `POST repos/<repo>/issues` per
held spec part, carrying the part's title, its detail, the ids it cites and a `<!-- ahub-roadmap-decompose:<project>:<milestone>:<task> -->`
marker, built by the pure `planPartPublish` (`src/hub/roadmap-decompose.ts`). The repository is the host-sampled origin
(`Tasks.roadmapRepository`), never an argument, and a part whose answer is no longer stored is counted instead of published.
The preview returns every planned `gh` argv and a fingerprint over the repository, the milestone, the GitHub milestone and those
calls. `--apply --confirm <fingerprint>` runs that exact plan and is admitted only through the existing `github_write` gate
(`Tasks.roadmapApplyAuthority`: the person, or the unique configured conductor with `roadmap.github_write = "conductor"`), the
same gate `ahub roadmap sync` uses. Each created issue is recorded in `milestone_decomposition_publishes` and added to the
milestone as an `issue` link through R1's own `linkMilestone`, so `ahub roadmap sync` keeps it in the GitHub milestone
instead of detaching it. When the mirror has a binding for the milestone, the create itself carries the R4 membership field
(`milestoneMembershipField`, the one construction `planRoadmapMirror` also uses), so the issue joins the GitHub milestone in the
same call and no second link path exists; with the mirror off or no binding, the preview says the issue will join none. A `gh`
call that fails, or an answer that is not the issue it claims, refuses and names the failure: no publish row and no link are
written, the draft stays held, and the same preview applies again once GitHub answers.

`milestone_decompositions` is additive and outside the roadmap integrity digest like a suggestion: a lost answer is asked for
again, and no recovery format changes. `milestone_decomposition_accepts` is additive the same way: a lost accept row files the
part again as a second draft rather than breaking a read. `milestone_decomposition_publishes` is additive too, so a lost publish
row files the issue again; the issue's own marker names the draft it came from.

## Bottom-up placement (R3)

R3 starts from the work that exists (open GitHub issues, open board tasks, `active` and `draft` specs) and places it on the
roadmap. It adds three reads and writes through R1's own writers only.

**Unplaced work.** `ahub roadmap unplaced [--repo owner/name] [--json]` and `hub_roadmap_unplaced {repo?}` list what no live
milestone places, each row with its reason (`UNPLACED_REASONS`). A link into a `dropped` milestone does not place; a link into a
`done` one does. A task is placed by an explicit link or by its source issue through R1's inheritance, so linking an issue drops
the issue and every task that inherits from it. An issue whose imported task is open is reported once, as that task. Private tasks
are a count (`privateTasks`), never a row, and an issue behind one is not a row either. The result is a lower bound and says so:
`partial: true` when the GitHub read stopped early or a list passed its cap of 100 (`more` counts the rest), and `unavailable`
names a source that could not be read (`issues`, `specs`), so an empty list is never read as "all placed".

**GitHub reads.** `readGitHubIssuePages` and `readGitHubMilestonePages` (`src/hub/github-import.ts`) page `gh api repos/<r>/issues|milestones?state=open&per_page=100&page=N`
up to 10 pages under one 20 s deadline that also covers repository resolution. They are fixed argv GETs through `SdlcGh`; there is
no write verb, method flag or body. The first page failing is an error; a later page failing, the deadline, or a full last page
under the page limit is `partial: true` with what was read. Pull requests are left out and every row's URL must equal its
canonical identity. `readGitHubImport` (the one-page Backlog intake) is unchanged.

**Triage.** `ahub roadmap triage [--repo] [--list]` and `hub_roadmap_triage {repo?, list?}` (configured planner or unique
conductor, never during a PII or private turn) ask the hub's model, in one call for at most 25 unplaced items, where each belongs.
The model sees only text that passed `publicMetadataText`, and everything it reads is labelled data. `parseTriage`
(`src/hub/roadmap-triage.ts`) keeps an answer only when it names an item and a milestone it was shown (or a bounded new
milestone), gives exactly one of them, and quotes words (4 to 200 characters) that occur in the item text and in the milestone
title or outcome. Each kept answer is screened again before it is stored as a pending row of `milestone_suggestions`, attributed to
`hub` as a model's answer; nothing else reads that table, so a suggestion never enters `ahub ask` evidence or memory. A repeat triage
skips an item that already has a pending suggestion. `list: true` reads the pending public suggestions with no model call, for any
agent. No model, a dead one or an answer with nothing supportable reports `unavailable` or `dropped`, never a silent empty result.

`hub_roadmap_edit {op: accept|reject, suggestion}` (`ahub roadmap accept|reject <id>`) settle one suggestion. Accept applies
exactly its one link through `Board.linkMilestone` under the R1 revision compare-and-set, creating the suggested `proposed`
milestone first for "new milestone" and remembering it (`created_milestone`), so a retry after a failed link never makes a
second. A suggestion settles once: a repeat reject replays, and any other change of a settled suggestion (a second accept, an
accept after a reject) refuses naming its state. A suggestion whose text is no
longer public refuses accept and can be rejected. Nothing is linked without an accept.

**Roll-up and ready to close.** `milestoneList` and `milestoneShow` add `tree` (the milestone and its children, a task, issue,
spec or release linked twice counted once; `rollup` stays R1's own figure) and `readyToClose {ready, reasons}`. Ready needs
something linked, every task approved or cancelled, every issue closed, every release shipped or dropped, no withheld private
task, and every child `done` or `dropped`; spec freshness is not a condition. It is advice for the person: `done` and `dropped`
stay person-only and nothing sets a state from it.

**GitHub milestone import.** `ahub roadmap import-github [--repo] [--apply] [--json]` is the person's alone (console op
`roadmap_import_github`, not in `CONDUCTOR_TASK_OPS`; refused for agent shells and live-test). Without `--apply` it lists what it
would create and link. With it, each open GitHub milestone becomes one `proposed` milestone (outcome is its description, target its
due day) in one transaction with its `milestone_imports` mark, and its open issues are linked; a repeat finds the mark and each
link and changes nothing, a milestone that has since settled is not relinked, and text that fails the public screen is counted
in `withheld`. Nothing is written to GitHub.

`milestone_suggestions` and `milestone_imports` are additive tables outside the roadmap integrity digest: a lost suggestion is
triaged again and an import mark only prevents a duplicate, so neither changes the recovery format.

## Drift, mirror and export (R4)

`hub_roadmap_check` and `ahub roadmap check` report the eight rules in #1482. Issue state is fresh bounded GitHub metadata, never inferred from a task verdict. At most 100 issue reads share a 20-second deadline; unreadable or unvisited evidence remains unknown. A merged issue is reported open only after 24 hours, so GitHub's closing lag does not become a false finding. A public `feat:` or `feat(...)` task with no recorded spec issue is a feature finding. Missing issue identity is a separate finding. The result has at most 100 findings and says `truncated` when more exist.

`roadmap.github_mirror` defaults to false and `roadmap.github_write` to `off`; both are machine-local. The only other write value is `conductor`. `ahub roadmap sync` reads complete bounded all-state GitHub milestone and issue metadata, without issue bodies, and previews fixed `gh api` argument arrays. `--apply --confirm <fingerprint>` re-reads and rechecks the exact plan. The person may apply; the current rostered unique conductor may apply only with `github_write: "conductor"`. The operational audit and current caller, task, configuration, privacy and recovery fences remain in force. Incomplete pages, conflicting identity or withheld milestone membership refuse a plan. GitHub writes never delete a milestone, and a write whose effect cannot be confirmed is reported as uncertain rather than a safe retry.

The current full issue inventory has a ceiling of 1000 rows including pull requests. At or above that ceiling it fails closed, so mirror sync is unavailable and drift rule 7 stays unknown. A future scoped read of each bound milestone's members and desired issues removes this ceiling.

A local milestone has at most one remote number per repository. R3's `milestone_imports` marks are the durable binding, including for an imported milestone. A creation includes `<!-- ahub-roadmap:<project>:<local milestone id> -->` in its description; the response must confirm the number, repository URL, title, state and marker before binding. After a lost response, exactly one marked milestone is offered as a local binding in a new confirmed preview. Duplicate markers or a title match without the marker are refused for inspection. A new milestone's first preview creates only the milestone; a later preview binds its server-assigned number and plans issue membership. Moving an issue directly to another known milestone never follows the move with a stale unassignment.

`ahub roadmap export` renders deterministic JSON and Markdown from screened milestone views. `--write` writes only `docs/roadmap.md` and `docs/roadmap.json` in the caller's Git worktree after proving it shares the selected repository, enforcing its current deny, read-only and PII path policy and refusing symlinks or hardlinks. A partially completed two-file write is reported. `--issue <n> --apply --confirm <fingerprint>` updates that issue body only after a matching preview, under the same person/conductor policy. The fingerprint binds repository, issue and rendered body.

Task state and merge changes schedule affected public milestones for an ids-only supervision notice. The existing five-minute merge-readback sweep rechecks unresolved findings, including the close-lag boundary. A durable marker suppresses a finding already delivered; an unavailable feed or evidence is retried on a later change or sweep. Private tasks are never named. `scripts/check-roadmap.mjs` is a standalone Node validator: it checks the generated JSON's schema, linked spec IDs and tracked spec paths, and checks known issue states when a GitHub token is available. `scripts/check.sh` and the hosted docs step run it. Only `docs/roadmap.md` is exempt from the documentation stamp because this validation covers the generated page; the standalone release docs checker retains its Node-only contract.
