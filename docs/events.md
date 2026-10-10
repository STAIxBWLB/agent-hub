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
| `native_turn_end` | `peer`, `id` (an opaque hash that names the completed turn): the end of a Claude turn, recorded once the hub finds the turn its Stop hook reported completed in the native transcript (Codex's is its `turn_end`); quiescence evidence for an integration |
| `supervision_turn` | `peer`, `turn` (the hub turn a supervision notice was delivered into, or `supervision-<uuid>` when none was open), `tokens` (when the adapter reported any for it), `ms` (from that turn's start, or from the delivery when none was open, to its native end): a completed native turn that received supervision, which `ahub report` counts; a failed delivery or turn, a peer that went offline or a changed native session records none |
| `conduct` | `peer` (the conductor, or `user` when the console releases a conductor hold), `action`, `task` (when the action names or creates one), `target` (the peer an assignment, start, hold or release names): one action of the conductor that ran, the structured twin of the console's `conductor` notice. `action` is a tool name without its `hub_` prefix: a conductor tool (`status`, `task_show`, `task_assign`, `task_escalate`, `peer_start`, `peer_hold`, `peer_release`), or one of the conductor peer's own task tools, which are not conductor tools (`task_propose`, `task_accept`, `task_decline`, `task_done`, `review`, `checkpoint`, `remember`). The role-free reads and redirects (a task's owner or reviewer with `hub_task_show`, its proposer with `hub_task_assign`) record none, and neither does `hub_task_list` |
| `agent_cli` | `peer` (`unknown` when the agent markers were invalid), `command` (the command and, where it has one, its subcommand, from a closed list; `unknown` otherwise; never an argument), `refused` (the CLI refused it before connecting: a human-only command, or an invalid identity; a later refusal by the hub is not recorded here): an `ahub` command run from an agent session. The hub reads these from the `cli-audit/` outbox, so `at` is when it read the record |
| `hook_stats` | `peer`, `n` (facts hook calls in the turn, its Stop included), `startupMs` and `maxStartupMs` (the hook processes' start-up and connect time, summed and the largest), `hubMs` (the hub's own time for them): at Claude's Stop (issue #108) |
| `cohort` | `id`, `event` (`formed`, `joined`, `lifted`), `silent`, `tasks`, `owners`: owners of overlapping tasks formed a cohort, it changed membership, or it stopped being silent (issue #107). Recorded in every regime; only a turn-free project's cohorts can be silent |
| `split` | `task`, `where` (`routing`: routing chose the first owner of a task overlapping another owner's task not started yet, not an escalation, relay or reassignment, the record calibration reads; `cohort`: an overlap formed or changed a cohort), `verdict` (`split`, `single`, `unknown`), `single` (the peer that would finish both units alone soonest), `splitS`, `singleS`, `reason` (for `unknown`), `trace` (the inputs and steps: peer names, their profiles of versions and coordination, and numbers only): a shadow split prediction; it never changes the assignment (issue #109) |
| `state` | `peer`, `state` |
| `native_thread` | `peer` (`codex`), `thread` (its native thread id), `fresh` (`true` when the TUI started the thread, `false` when it resumed one): each thread the Codex adapter adopts, before any turn on it. The upgrade planner reads it: a thread with no rollout that the hub saw start, with no `turn_start` since, is planned as a fresh start (issue #215) |
| `turn_start` | `peer`, `turn` (`<peer>#<hub run>.<n>`, unique across restarts). A turn follows the adapter: pausing a busy peer does not end it |
| `turn_end` | `peer`, `turn`, `ms`, `tokens` (when the adapter reported any during the turn), `files` and `snapshotMs` (when snapshots are on: how many files the turn changed, and the time both snapshots took); optional numeric `task`, `attribution` (`delivery`, `single_open`, `unattributed`) frozen at turn start, `pii: true` for an attributed PII task |
| `tokens` | `peer`, `n` (tokens added since the previous report), optional numeric `task`, `attribution` (`delivery`, `single_open`, `unattributed`), `pii: true` for an attributed PII task |
| `usage` | `peer`, `source` (`omniroute`, `claude_transcript`), opaque `id`, optional `measuredAt` (provider/source time), the `requestedModel`, `servedModel` and `provider` labels, and any provider-reported counters (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`); optional numeric `task`, `attribution` (`delivery`, `single_open`, `unattributed`), `pii: true` for an attributed PII task. Missing counters stay unknown. |
| `task` | `id`, `event` (the board history event, e.g. `proposed`, `assigned`, `done`, `check failed`, `blocked`, `ready`), `by`, `state`, `owner`, `reviewer`, `class`, `pii`, and `reason` when the board recorded a move reason (`manual`, `budget`, `offline`, `idle`, `rejections`, `declined`, `inference_failed`, `delivery_failed`) |
| `overlap` | `task`, `owner`, `others` (`task`, `owner`, `paths`, and `symbols` when plans name the same symbol; a name that matches a PII pattern is left out, so either list can be empty), the structured twin of the console notice |
| `permission_mode` | `peer`, `from`, `to` (`ask`, `ask-when-needed`, `never-ask`): a person set a peer's permission mode (`from` equals `to` when it was already in force) or confirmed a never-ask default (issue #242) |
| `settings` | `key` (a registry key such as `permission.kimi` or `routing.classes.implement.peers`), `from`, `to` (the value before and after: the one in force for a setting that applies at once, the stored one for a setting read at a start; a closed word, a boolean, a list of peer ids, a route id, or null for none), `source` (`dashboard`, `terminal`), and `undo: true` for an undo: a person changed a setting from the dashboard or `ahub settings` (issue #269). A mode change also writes its `permission_mode` event |
| `permission` | `id`, `peer`, `event` (`requested`, then one of `answered`, `expired`, `cancelled`) and, on the closing event, `latencyMs`, `surface` (`console`, `dashboard`, `terminal`: where a person answered; absent when the hub closed the request) and `option` (the kind of the option chosen: `allow_once`, `allow_always`, `reject_once`, `reject_always`): one approval request relayed to the console and how it ended. `expired` is `approvals.timeout_s` without an answer. `cancelled` with a `surface` is a person's deny in the console or by `ahub permit <id> deny` (a deny on the dashboard is `answered` with a reject option); without one, the hub withdrew the request (its call or turn ended, the peer was stopped, or the hub is stopping). Never the title or the tool |
| `pii_screen` | `task` (absent for a budget hand-off or a note not about a task), `item` (`task`, `summary`, `review note`, `handoff`, `note`), `label` (`pii`, `clear`), `source` (`regex`: a pattern matched and no call was made; `screen`; `unknown`: no verdict, handled as PII), `category` (`name`, `student_id`, `phone`, `address`, `grade`, `health`, `other`), `miss` (why there was no verdict: `too long`, `off campus`, `timeout`, `unreadable`, `failed`), `ms` (absent for `regex`): one PII screen verdict while `signals.pii_screen = "local"` (issue #198); never the text |
| `context_pressure` | `peer`, `source` (`claude_statusline`, `codex_token_usage`, `acp_usage_update`), `measuredAt` (epoch ms of the reading), `used` (the fraction of the context window in use, 0 to 1), `window` (its size in tokens, or null): a fresh reading of a peer's native context reached `context.gate`. Recorded once per crossing, until a reading below the gate or a new native session rearms it, and not while the peer is paused or offline or the hub is in recovery or stopping |
| `quota` | `peer`, `windows` (`id`, `used`, `resetsAt`), `hard`, `measuredAt` (when the reading was taken, if not when it arrived: Claude's numbers come through a file) |
| `conflict` | `peer`, `task` (its task in progress, when it had one), `other` (the other owner's open task), `owner`, `paths` (names that match a PII pattern left out, so it can be empty), `concurrent` (another peer worked during the turn), `turns` (the two turn ids, when two overlapping turns' snapshots both hold the change) |

Token usage by adapter:

- Kimi (ACP `usage_update`, and the usage a `session/prompt` result carries): recorded when it holds a checked
  total or an input/output pair. The `{used, size}` shape Kimi sends is context occupancy: it is shown as the peer's
  native context reading (source `acp_usage_update`, #285 phase 1) and no `tokens` event is written from it; Kimi's
  consumption is not recorded yet (phase 2). The adapter accepts the update whenever it names the current session —
  Kimi 2.1.1's source text emits it after the prompt resolves, when the peer is already idle; that order is not yet
  observed live through the hub (docs/smoke.md).
- Codex (app-server `thread/tokenUsage/updated`): recorded as the growth of the thread's running total, so
  compaction estimates, usage-limit refreshes and the replay to a reattaching connection add nothing. A thread
  started under the hub counts from zero; a resumed thread's first update is its history and only sets the
  baseline. The model call of a compaction itself is real usage and counts.
- Pi: the assistant usage its extension forwards at each `message_end`, tool-loop messages included, is recorded as
  increments, each usage id once; a message without a usable count adds nothing.
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
