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
  - src/hub/github-import.ts
  - src/hub/specs-task.ts
  - src/hub/board.ts
  - src/hub/tasks.ts
  - src/hub/hub-tools.ts
  - src/hub/daemon.ts
  - src/hub/restart.ts
  - src/cli/roadmap.ts
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
  - test/roadmap-r3-cli.test.ts
  - test/roadmap-r3-daemon.test.ts
---

# Roadmap milestones

R1 implements [#1479](https://github.com/STAIxBWLB/agent-hub/issues/1479) of the
[#1478 roadmap](https://github.com/STAIxBWLB/agent-hub/issues/1478). The board is
the source of truth. R1 adds no GitHub writes, roadmap model calls, export,
automatic task assignment, dashboard or console UI. R3 ([#1481](https://github.com/STAIxBWLB/agent-hub/issues/1481),
"Bottom-up placement" below) adds the first roadmap model call and read-only GitHub
reads, and still adds no GitHub write.

R1 adds no generation, triage or decomposition call; those belong to R2 and R3.
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
