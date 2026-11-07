# Research records

Opt-in records of how each task went, kept across projects for management and research (#247). They are built from a
project's `events.jsonl` and, since schema v2 (#1277), from read-only views of its board history and delivery journal
that are reduced to closed values on the way in, so they hold ids, states, counts, tokens, times and closed vocabularies,
never a title, detail, plan, note, path, message body or check output.

## Turning them on

In a project's `.agenthub/config.json`:

```json
{ "research": { "enabled": true } }
```

Off by default; anything but `true` is off. While it is off the hub writes nothing and creates no file. The setting is
applied live: a config reload takes it without a restart.

## Where they go

`~/.agenthub/research/<project key>.jsonl` (the directory 0700, the file 0600), where the key is the first 16 hex
characters of the SHA-256 of the project's registry id. Every project on the machine that opts in writes to the same
directory, so `ahub research --all` can compare them. `ahub reset --all` does not touch it.

## When a record is written

When a task reaches a terminal board state (a review approves it, its owner reports a task without a reviewer done, or it is cancelled), the hub waits
until no open turn is attributed to the task (the turn that approved it ends after the approval, and its usage arrives
later still), checking every 10 s for at most 30 minutes, then appends one task record built from that project's
events and the board. A hub that stops first writes it once its peers have stopped. A terminal state is final on the
board, so each task has one record, and the first record written for a task is final with one exception: the guarded merge
writes its receipt after the approval, so a later pass appends the same task once more when it brings merge figures the
held record lacked (readers keep the latest row of a task). A v2 row also replaces a held v1 row of the same task. A failing write is one `hub.log` line per hub run and
never changes the task flow.

`ahub research backfill` builds the same records from a project's existing `events.jsonl` (marked
`writer.source: "backfill"`), reading every event attributed to a task, and appends those the store does not hold yet.
It is for tasks approved before research was on: a record it writes is final, so running it while a live record still
waits for its turns freezes that record without them.
A task is identified by project, id and proposal time (`createdAt`), because `ahub reset --all` starts the ids again
while the store keeps the older records.

## Task record (`agent-hub.research/v2`, `kind: "task"`)

Schema v2 is additive: a v1 file still loads (a v1 row reads as `outcome: "approved"`, and the file is never rewritten), and
`ahub research` and `ahub research addons` read both. Every statistic about approved tasks filters on `outcome`.

| Field | Meaning |
| --- | --- |
| `project` | the project key above |
| `task` | the board's task id |
| `class`, `pii` | the task's class; whether it was a PII task (its record holds counts only, like any other) |
| `outcome` | `approved` or `cancelled` (v2): every task in a terminal board state has a record; a v1 row is always `approved` |
| `createdAt`, `startedAt`, `approvedAt` | proposal, first `in_progress`, approval (ISO); `approvedAt` is null on a cancelled record |
| `closedAt` | v2: when the task reached its terminal state (the approval or the cancellation) |
| `wallMs` | from `startedAt` to the terminal state, null when the start is not in the events |
| `activeMs`, `turns`, `filesChanged` | sums over the turns attributed to the task (`turn_end`), the ones ending after the approval included |
| `sessionRoles` | optional attributed-turn preamble preparations: peer, turn id, role ids/layers/hashes; `roles: []` means prepared without catalog guidance, `roles: null` means unknown; older events leave the field absent. No role bodies or proof of model consumption |
| `owners`, `reviewer` | the owners in the order they held the task (an owner who gets it back appears again; reports by owner count the task once per owner); the last reviewer |
| `reviewRounds`, `changesRequested`, `dones` | times it went to review, was sent back, was reported done |
| `checkPassed`, `checkFailed` | check results; a check that fails produces no done, so dones without a check are `dones - checkPassed` |
| `reassignments`, `reassignedBy` | owner changes after the first owner, and the same by the board's move reason (`declined`, `idle`, `offline`, `budget`, `rejections`, `manual`, ...; `none` when the board recorded no reason) |
| `firstPass` | approved on its first review with no failed check and no changes requested |
| `stuck`, `overlaps`, `conflicts` | escalation verdicts, overlap warnings and file conflicts about the task |
| `tests` | route outcomes that ran tests: `pass`, `fail` counts |
| `tokens` | attributed tokens: `total`, `byPeer`, and `byAttribution` (`delivery`, `single_open`, the #200 rules); unattributed tokens are in no record |
| `usage` | provider usage per peer: `input`, `output`, `cacheRead`, `total` (null when never reported) |
| `usageByModel` | provider-reported total tokens per served (else requested) model |
| `models` | model routes and served models of the attributed requests |
| `writer` | the release and `live` or `backfill` |
| `tooling` | #248: for each peer that worked on the task (owner, reviewer, a peer with attributed turns or tokens), the add-ons from the `tooling` event of the attachment it last worked in (an attachment runs from a `state` event that brings the peer online to the next `offline`; detection may settle after the work started): `{ name, version }` from the closed list `claude-mem`, `ponytail`, `ripwire`, `open-code-review`, `codex-plugin`, `dot-admit`; version null when unknown. A peer missing here is unknown; records built from events written before #248 have no field |
| `briefs` | #258: task briefs handed over for the task (`delivered`) and how many carried a hub-memory fail note (`withFail`), from `memory_brief` events; absent when none was recorded |
| `peers` | with `tooling`: every peer with an event attributed to the task (a turn, tokens, a route), fingerprinted or not, so a peer without a fingerprint makes the task unknown for an add-on rather than off |

### v2 blocks (#1277)

Every value is a count, a duration or a member of a closed vocabulary. A value that cannot be derived is `null`, never 0,
and `quality.json` counts it as unknown. Journal-derived fields are null unless the journal is known to hold every delivery from the
task's proposal on: the journal prunes its oldest-updated terminal rows beyond a cap and keeps unresolved rows, review-package receipts and retry parents, so the
oldest surviving row proves nothing. The record uses the oldest-updated unprotected terminal row that survived as its bound (every pruned row is no newer than it, and a
delivery is created no later than it is updated), and treats the journal as unknown when its own review-input coverage is incomplete; board-derived fields are null when `hub.db` could not be read.

| Field | Meaning |
| --- | --- |
| `cancelCause` | only on a cancelled record: `cancelled`, `declined`, `escalated`, `stale` or `unknown`, taken only from an explicit closed `cause` the board retains on the cancellation. The board keeps only a free-text note today, so it reads `unknown`; a cause is never inferred from the note, from an earlier decline or escalation, or from who cancelled |
| `declines`, `escalations` | intermediate declines and escalations (history events, not terminal), counted next to `reassignments` |
| `review` | `rounds` (verdicts that are not evidence-only), `firstPass`, `findings` by pass (`bugs`, `security`, `compliance`) each with `important`, `nit`, `open`, `fixed`, `falsePositive`, `accepted` (distinct findings at their last disposition; null when no verdict carried a structured report or the task is `[pii]`), `reviewerFamily`, `ownerFamily`, `scope` (`code`, `full`, `delta`, `none`, `unknown`), `evidenceOnly`, `context` (`fresh`, `continuing`, `unknown`), `staleHeadReReviews` |
| `delivery` | `count` (envelopes that named the task), `firstDeliveryMs` (`p50`, `p95` of the journal's completed deliveries), `needsReview`, `failed`, `discarded` (journal states), `dropped` (`fyi`, `hop`) |
| `merge` | `ciRuns`, `ciReruns`, `githubReviews` and `approvedToMergedMs` from the receipt the guarded merge wrote, `doneToApprovedMs` from the events' own times |
| `specs` | `covering`, `unchanged`, `acked`, `errors` from the latest done's spec report; an incomplete report is unknown |
| `memory` | `briefs`, `briefNotes`, `fails` from `memory_brief` events (a known 0 when briefs were being reported in the log and the task got none, null when the log shows none at all); `rendered`, `delivered`, `cited`, `failsExposed`, `failsCited`, `failRetrySignal` (#1279) are counts of distinct entries from agent-mem's own machine-local counters for the task, never an id: `rendered` entries put into a delivery attributed to the task, `delivered` of those whose delivery the journal acknowledged, `cited` of those that a hub-screened done summary, review note, `spec_ack` reason, message or `hub_remember` text named by `mem:<id>` (exact match, no judgment), `failsExposed` and `failsCited` the same over fail notes, `failRetrySignal` the exposed fail notes the plan's paths or symbols touch that were not cited by approval: a signal for a reviewer to read, never an outcome, since it does not say the approach was retried. All six are null with no counter row for the task (sidecar off, a private task, rows aged out of the sidecar's 90 days), `delivered` is null while no delivery is known to have completed, and the fail figures are null when a rendered entry can no longer be read |
| `person` | #1278: what the person was asked and did for the task, from the four events above. `permissions` (`asked`, `allowed`, `denied`, `expired`), `questions` (`asked`, `answered`, `expired`), `completions`, `cliRefusals`, `latencyMs` (`sum`, `n`, `unknown`) and `consoleConfirmations`. An interaction counts for a task only when its event names one; `unattributed` is counted apart (in `ahub report --by task`) and never folded into a task. `latencyMs.sum` adds only recorded latencies of PERSON-answered permissions and questions (an answer with a `surface`); a person answer without a latency reading raises `n` and `unknown` and adds nothing to `sum`, and an automatic answer, an expiry and a cancellation are not the person's minutes. Every part is null for a task that began before the first `hub_start` with `personAttribution` (the log cannot say), and a known 0 after it when no interaction happened, in the record and in `ahub report --by task` alike (one function decides, `src/hub/person-figures.ts`). `consoleConfirmations` stays null: the hub records no event for a console confirmation, whose approval arrives as the permission's `answered`. Not observed: an interaction inside a vendor TUI the hub cannot see |
| `stalls` | persisted idle-ladder entries on the task's history (the stall table itself is cleared when a task closes); null without the board |
| `handoffs` | `in`, `out` from the handoff tables |
| `cohort` | `silent`, `advisory` or `none` |

The record reads the board through a read-only handle (`readEvidence`): titles, details, plans, refs and notes are never
decoded, and the journal's envelope bodies are never read.

## Dataset export (`ahub research export --dataset <dir> [--since] [--all]`)

Writes `<dir>/<project key>/tasks.jsonl`, `manifest.json` and `quality.json` for this project, or for every registered
project that has research records with `--all` (read-only, on this machine, with the same project-key hashing as the
record file names). It is built to leave the machine, so it is an allowlist:

- a peer is only a family name (`claude`, `codex`, `kimi`, ...), resolved through the project's own config for an instance
  id, and `unknown` when none is known (never guessed from the id's spelling); `profile`, `role`, `roleIdentity` and
  `sessionRoles`, which carry project-chosen names, are dropped;
- the target must be inside your home directory, not the home itself, and outside every registered project and its state
  directory (compared as real paths, so a symlink out of the home or into a project does not pass); a project directory
  that is a symbolic link is refused;
- files are written whole (a temporary file, then a rename), owner-only, and the manifest last, so a directory with a
  manifest is complete.

`manifest.json`: `schema`, `hubVersion`, `projectKeyHash`, `window` (`since`, `until`), `peers` (families), `counts`
(`tasks`, `approved`, `cancelled`, `labels`), `recordedAt`. `--format` and `--dataset` exclude each other.

`quality.json` (#44 AC0, `agent-hub.research-quality/v1`): `fields` (per v2 field: `n` records and how many are
`unknown`, null or the vocabulary's own `unknown`), `quota` per family (`readings`, `gaps` over one hour, their total
`gapMs`, `stalenessP95Ms` between readings, and `clock`: how many readings used the event's time or their own
`measuredAt`), `budget` (pauses and resumes, per family), `outcomes` per family of the last owner and class, `events`
(the types present with counts, and the ones the report expects that did not occur), and `tokenAttribution` (`total` and the
share by `delivery`, `single_open`, `unattributed`; null shares when nothing was counted). The 2026-10-21 field analysis found
40.2% of token increments unattributed: a dataset now says so itself.

## Label record (`kind: "label"`)

`ahub task label <id> ok|regressed|reverted|incomplete|wrong|abandoned [--created <time>]` appends
`{ project, task, createdAt, label, at }`: a person's later verdict (a revert next week, a regression found later, work
given up). It labels the current board's task with that id (its proposal in `events.jsonl` pins `createdAt`), so a
later task with the same id after a reset does not inherit it. A task from before `ahub reset --all` is not on the board
any more: it is the store's only record with that id, or, when there are several or the id is in use again, the one
`--created` names (the `createdAt` that `ahub research export` shows; a record without one takes no label). A task with no record yet (not approved, its record still waiting for
the turns that approved it, or approved while research was off) is refused; labels mark approved tasks only. A person
labels any task; an agent labels only a task it owns, the hub checks that by role, and its record carries `by: <peer>`
(#933). Only while research is on. A person's latest label for a record always wins, whatever an agent labelled
after it; an agent's latest label counts only where the person never labelled that record. The CSV's `labelBy` column
names the agent (empty for the person).

## Measures

`ahub research [--since 30d] [--all] [--json]` reports, overall and by class, owner, model and project:

- success rate: approved tasks whose latest label is none or `ok`, over approved tasks;
- first-pass rate: `firstPass` over approved tasks;
- rework: changes requested per approved task;
- check-failure rate: failed checks over checks run (`checkFailed / (checkFailed + checkPassed)`);
- tokens and wall time per approved task, median and p90 (linear interpolation between ranks);
- by memory brief (#258): the same measures for tasks whose brief carried a hub-memory fail note, a brief without one,
  and no brief recorded (shown once any record has a brief).

They are computed each time from the records; nothing derived is stored. `ahub research export [--format jsonl|csv]
[--since] [--all]` writes the records for outside analysis (`--dataset <dir>` writes the per-project dataset below); the CSV columns are, in order: project, task, class, pii,
outcome, createdAt, startedAt, approvedAt, wallMs, activeMs, owners, reviewer, reviewRounds, changesRequested, checkPassed,
checkFailed, dones, reassignments, firstPass, stuck, overlaps, conflicts, testsPass, testsFail, tokens, turns,
filesChanged, models, label, labelBy, writerVersion, writerSource. The CSV is a flat subset; JSONL carries every field.
Another project's measures: `ahub --project <dir> research`.

## Add-ons (#248)

The hub writes a `tooling` event each time a peer attaches: the add-ons it works with, by name and version only, read
from this machine's inventory (Claude Code's root is `CLAUDE_CONFIG_DIR` when the hub's environment sets it, else
`~/.claude`; Codex's is `CODEX_HOME`, else `~/.codex`). Claude Code: `enabledPlugins` in its `settings.json` and the project's
`.claude/settings.json` and `.claude/settings.local.json` (later wins), with the version from
`plugins/installed_plugins.json` (a user install, or one for this project). Codex: `[plugins."<name>@..."]`
sections in its `config.toml` that are not `enabled = false`, and plugins whose hooks it trusts, with the version
from its plugin cache when there is exactly one. Every peer: `ripwire` on PATH (version unknown), and the first `dot` on PATH
when `dot --version` answers as the dotfiles CLI (`dot version X`, resource admission; Graphviz's `dot` does not count),
asked once per binary per process, without input, in the background (the hub never waits on it), and killed if it
has not answered within 2 s. The probe runs with a minimal environment: PATH (its absolute entries outside the project), HOME and the C locale,
no keys, tokens or agent markers, and a `dot`
inside the project is never run: opening a checkout must not execute its files, so such a `dot` does not count. Nothing else is read into the event: no plugin content, settings values, hook commands or paths. The inventory
is the machine's, not the session's: a session started with its own settings or plugin flags can differ.

`ahub research addons [--since 30d] [--all] [--json]` splits approved tasks per add-on: `on` when a peer that worked on
the task had it, `off` when every such peer's fingerprint is known and none had it, `unknown` otherwise. For success,
first-pass, rework and check-failure rates, tokens and wall time (medians) and collisions (overlaps plus conflicts per
task) it gives on, off, the difference and a 95% bootstrap interval (1000 resamples, fixed seed); below 5 tasks on
either side a difference is inconclusive. This is field data: the sides differ in peers, task mix and time, so it shows
association, not cause. Controlled arms are `ahub bench run --addon <name>=on|off` (docs/bench.md), and the decisions
taken from both are in `docs/addons/`.

Agents may read the measures and export (ids and counts only), `--dataset` included; `backfill` is the person's or the configured conductor's (#933), and an agent labels only its own task.
