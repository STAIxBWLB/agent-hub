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
---

# Roadmap milestones

R1 implements [#1479](https://github.com/STAIxBWLB/agent-hub/issues/1479) of the
[#1478 roadmap](https://github.com/STAIxBWLB/agent-hub/issues/1478). The board is
the source of truth. This slice adds no GitHub writes, roadmap model calls, export,
automatic task assignment, dashboard or console UI.

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
task text or the linked task id.

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
