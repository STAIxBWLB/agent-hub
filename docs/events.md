# Hub events (`events.jsonl`)

Schema version 1. The hub appends one JSON object per line to
`.agenthub/state/events.jsonl`, next to `hub.log`. `hub.log` is for people; this
file is for tools (`ahub export`, `ahub report`, research measurements). The
version is bumped only when a field changes meaning or goes away; new fields and
new event types do not bump it.

Every event has `v` (schema version), `at` (ISO time) and `type`. No event ever
carries a message body or a task title or detail. Private (PII) envelopes are
marked `private: true`, and PII tasks `pii: true`.

| type | fields |
|---|---|
| `envelope` | `id`, `from`, `to` (absent for broadcast), `priority`, `hop`, `kind`, `task` (task id from refs), `bytes` (UTF-8 size of the body; absent on a private envelope, whose size would say something about the PII text), `private`, `dropped` (`hop` or `fyi` when not delivered) |
| `overflow`, `undeliverable` | `id`, `from`, `peer` |
| `stale` | `id`, `from`, `peer`, `task`: a notice about the recipient's open task, dropped unsent because, right before it would have been handed over, that task was closed, had another owner or was gone (issue #106) |
| `quiet` | `id`, `from`, `peers`: an agent message held back from these members of a silent turn-free cohort; its other recipients got it (issue #107) |
| `fact` | `peer`, `id` (the offer), `files` (files whose diff it carried), `plans`, `unknown` (files whose change it showed with attribution unknown), `named` (files under a named directory it named without a diff, those counted as "N more" or held back by the PII filter included), `bytes` (the injected text), `via` (`hook` for Claude, `steer` for Codex, `done` with an integration request), `ms` (the hub's time to build it), `hookMs` (the hook process's own start-up and connect time), `accepted` (whether app-server took the steer), `unanswered` (app-server did not answer it within 10 s: it may have gone in), `rttMs` (an accepted steer: from sending it to app-server's answer), `probe` (a context check), `coverage` (it named files earlier changes are not covered for): one fact offer (issue #108) |
| `fact_ack` | `peer`, `id`, `via` (`hook` and `steer`: a readback found the offer in the native session; `done`: the next `hub_task_done`), `ms` (from the offer): an acknowledged offer, the only thing that moves a peer's view |
| `route` | `peer`, `route`, `tier`, `source` (`override`, `dimensions`, `hold`, `classifier`, `default`; for `hub/auto` also `load`: a busy MLX slot moved it to `dgx/fast` (opt-in, `[pi] efficient_wait_ms`), `cooldown`: a cooling MLX went to its fallback first, and `pin`: an enforced tool loop went to the backend it is pinned to, issue #199), `score`, `ms`. Local decisions also carry `decision`, `turn`, optional numeric `task`, `pii`, and decision-time `severity`, `spinning`, `exploring`, `production`. A `hub/auto` decision for a request without a session key carries `stateless: true` (`ahub report` then counts its sessions as unknown). `hub/auto` and hub stage decisions carry `turnType` (`tool_result`, `user`, `compaction`: what the call answers) and `prefillTokens` (estimated input a backend would prefill; absent on a PII route), and, unless `stay_switch` is `off`, `staySwitch` (`shadow`, `enforce`), `plan` (`stay`, `switch`) and `reason` (`new_pin`, `compaction`, `context_fit`, `same_tier`, `override`, `tool_loop`, `prefill_bound`, `user_turn`): the planner's verdict next to the tier taken (issue #197). No prompt text |
| `cooldown` | `peer`, `alias`, `event` (`start`, `end`), `failures` (consecutive transport or startup failures), `ms` (on `start`, how long the alias cools down): a relay backend alias after repeated failures (issue #199). An `end` is recorded at an HTTP answer (any status) or when the hub next checks the alias after it expired |
| `route_outcome` | `peer`, `decision`, `turnId`, `turn` (`completed` or `failed`), optional `task`, `pii`, `latched`, optional `next` (`severity`, `tests`: `pass`/`fail`/`none`, `repeat`) and `advisor` (`approve`/`redo`/`failed`). Exactly once per local decision at turn settlement, including failure/cancellation |
| `advisor` | `peer`, `route`, `trigger`, `verdict` (`approve`, `redo`, `failed`), `discardedChars`: an advisor check result; no transcript or feedback text |
| `progress` | `peer`, `task` (task id), `severity`, `spinning`, `exploring`, `production`: normalized tool activity dimensions for an open task; coverage differs by peer and no commands or task text are recorded |
| `stuck` | `peer`, `task` (task id), `category` (`repetition`, `false_progress`, `drift`, `desperation`, `capability_gap`), `streak`, `latched`: an escalation verdict; it recommends considering reassignment and never reassigns automatically |
| `capability` | `peer`, `state` (`verified` or `lost`), `via`: a peer's context path for facts |
| `native_turn_end` | `peer`: Claude's Stop hook, the end of its turn (Codex's is its `turn_end`); quiescence evidence for an integration |
| `hook_stats` | `peer`, `n` (facts hook calls in the turn, its Stop included), `startupMs` and `maxStartupMs` (the hook processes' start-up and connect time, summed and the largest), `hubMs` (the hub's own time for them): at Claude's Stop (issue #108) |
| `cohort` | `id`, `event` (`formed`, `joined`, `lifted`), `silent`, `tasks`, `owners`: owners of overlapping tasks formed a cohort, it changed membership, or it stopped being silent (issue #107). Recorded in every regime; only a turn-free project's cohorts can be silent |
| `split` | `task`, `where` (`routing`: routing chose the first owner of a task overlapping another owner's task not started yet, not an escalation, relay or reassignment, the record calibration reads; `cohort`: an overlap formed or changed a cohort), `verdict` (`split`, `single`, `unknown`), `single` (the peer that would finish both units alone soonest), `splitS`, `singleS`, `reason` (for `unknown`), `trace` (the inputs and steps: peer names, their profiles of versions and coordination, and numbers only): a shadow split prediction; it never changes the assignment (issue #109) |
| `state` | `peer`, `state` |
| `turn_start` | `peer`, `turn` (`<peer>#<hub run>.<n>`, unique across restarts). A turn follows the adapter: pausing a busy peer does not end it |
| `turn_end` | `peer`, `turn`, `ms`, `tokens` (when the adapter reported any during the turn), `files` and `snapshotMs` (when snapshots are on: how many files the turn changed, and the time both snapshots took); optional numeric `task`, `attribution` (`delivery`, `single_open`, `unattributed`) frozen at turn start, `pii: true` for an attributed PII task |
| `tokens` | `peer`, `n` (tokens added since the previous report), optional numeric `task`, `attribution` (`delivery`, `single_open`, `unattributed`), `pii: true` for an attributed PII task |
| `usage` | `peer`, `source`, opaque `id`, optional `measuredAt` (provider/source time), requested/served model and provider labels, and any provider-reported input/output/cache/total counters; optional numeric `task`, `attribution` (`delivery`, `single_open`, `unattributed`), `pii: true` for an attributed PII task. Missing counters stay unknown. |
| `task` | `id`, `event` (the board history event, e.g. `proposed`, `assigned`, `done`, `check failed`, `blocked`, `ready`), `by`, `state`, `owner`, `reviewer`, `class`, `pii` |
| `overlap` | `task`, `owner`, `others` (`task`, `owner`, `paths`, and `symbols` when plans name the same symbol; a name that matches a PII pattern is left out, so either list can be empty), the structured twin of the console notice |
| `pii_screen` | `task` (absent for a budget hand-off or a note not about a task), `item` (`task`, `summary`, `review note`, `handoff`, `note`), `label` (`pii`, `clear`), `source` (`regex`: a pattern matched and no call was made; `screen`; `unknown`: no verdict, handled as PII), `category` (`name`, `student_id`, `phone`, `address`, `grade`, `health`, `other`), `miss` (why there was no verdict: `too long`, `off campus`, `timeout`, `unreadable`, `failed`), `ms` (absent for `regex`): one PII screen verdict while `signals.pii_screen = "local"` (issue #198); never the text |
| `quota` | `peer`, `windows` (`id`, `used`, `resetsAt`), `hard`, `measuredAt` (when the reading was taken, if not when it arrived: Claude's numbers come through a file) |
| `conflict` | `peer`, `task` (its task in progress, when it had one), `other` (the other owner's open task), `owner`, `paths` (names that match a PII pattern left out, so it can be empty), `concurrent` (another peer worked during the turn) |

Token usage by adapter:

- Kimi (ACP `usage_update`): recorded.
- Codex (app-server `thread/tokenUsage/updated`): recorded as the growth of the thread's running total, so
  compaction estimates, usage-limit refreshes and the replay to a reattaching connection add nothing. A thread
  started under the hub counts from zero; a resumed thread's first update is its history and only sets the
  baseline. The model call of a compaction itself is real usage and counts.
- Claude native transcript usage is optional and keyed by an opaque hash of session and message identity; streamed records with the same message id count once. The status line tee still carries quota percentages only.
- The local worker records optional counters returned by OmniRoute. Requested route/model and gateway-reported served model/provider are separate fields; an alias is never treated as a served model.
- `ahub report` deduplicates usage records by peer, source and id. Coverage counts distinguish calls with provider usage from calls where usage was absent. Token counters are provider-reported values; the report never derives a price or treats missing spend as zero. Estimated price and measured provider spend remain unknown unless a future source reports them.
- Usage telemetry has no prompt, completion, task text, credential, Access header, session id or transcript path.

## Per-task usage reports

`ahub report --by task` (also `--json` and `--since`) reads only `events.jsonl`.
It reports task ids, the latest recorded class/outcome, completed logical turns,
and wall time from the first `in_progress` task event to the first `approved`
event. Wall time is unknown if either boundary is absent or the latest outcome
is not approved. Each task and class rollup includes per-peer native token
increments and provider-reported input/output/cache/total counters. Usage is
deduplicated by peer, source and id; missing counters are `null` in JSON and
`unknown` in text, with known-record counts alongside measured subsets. A
missing task history has unknown class/outcome and belongs to the unknown class
rollup. PII tasks have ids and a `pii: true` flag, never titles. No prices are derived.

At write time, the first applicable attribution rule wins:

- `delivery`: the current turn's original delivery names exactly one distinct positive task id, including work by a peer that does not own it.
- `single_open`: otherwise the peer owns exactly one `in_progress` task.
- `unattributed`: otherwise no task is assigned to the record.

`Bus.onDeliver` observes originals immediately before `peer.deliver` starts the
turn. Pending task identity is consumed at turn start and cleared on delivery
admission/failure, so later user-started native turns do not inherit it. Usage
and token events apply the rule at write time; `turn_end` keeps the start-time
attribution. Local usage uses its request-bound route policy task when present.
The existing relay has no task-bearing route usage event; this change adds no
new usage source. Schema version 1 and the control protocol are unchanged.

The unattributed share is always printed for token increments and deduplicated
usage records, against all recorded increments/usage records. A zero denominator
has unknown share. Records with no `attribution` field belong to a separate
`before attribution` bucket displayed beside the share, even if a task field is
present. Neither bucket is redistributed. `ahub export` preserves these fields
as raw JSON lines; plain `ahub report` keeps its existing behavior.

The file is local and never uploaded. It grows without rotation; delete it to start
over (the hub recreates it).

## Offline route outcome joins

For local-worker decisions, join `route_outcome.decision` to `route.decision` (one-to-one).
The route row records the chosen tier and decision-time dimensions; `next` describes only
the tool results answering that response, not an aggregate over later unrelated calls.
A final no-tool response has no `next`. Advisor checks add their closed verdict.
`latched` includes escalation that occurred later in the same turn.

Join `route.turn` or `route_outcome.turnId` to `turn_start.turn` / `turn_end.turn`.
The outcome's `turn` field is the completion status, not the turn id. To add offline
review supervision, join `route.task` to `task.id` and inspect subsequent task events
whose `state` is `approved` or `changes_requested`. Keep their timestamps so a review
from a different task revision is not treated as immediate per-call evidence.

Exclude both decisions and outcomes with `pii: true` before exporting a training set.
Labels contain ids, numbers, booleans and closed values only; they never retain tool
output, task text, advisor feedback, or raw failure fingerprints. A failed telemetry
sink does not affect model selection, budget admission or delivery. Pi outcome labels
are deferred: its existing route events retain their original shape. No control WebSocket
message changed, so the protocol number is unchanged.

Progress coverage is asymmetric: Codex contributes completed command and file-change items, local and Pi contribute
per-model-step tool observations, and Claude contributes tool inputs from turn-free pre-hooks without tool results or
a native turn id. Missing peers or intervals therefore mean unobserved, not zero activity. Escalation uses only known
native turn ids; observations without one still contribute progress dimensions but cannot establish separate attempts
or the eight-turn spinning threshold.
