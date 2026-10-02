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
| `fact` | `peer`, `id` (the offer), `files` (files whose diff it carried), `plans`, `unknown` (files whose change it showed with attribution unknown), `bytes` (the injected text), `via` (`hook` for Claude, `steer` for Codex, `done` with an integration request), `ms` (the hub's time to build it), `hookMs` (the hook process's own start-up and connect time), `accepted` (whether app-server took the steer), `unanswered` (app-server did not answer it within 10 s: it may have gone in), `rttMs` (an accepted steer: from sending it to app-server's answer), `probe` (a context check), `coverage` (it named files earlier changes are not covered for): one fact offer (issue #108) |
| `fact_ack` | `peer`, `id`, `via` (`hook` and `steer`: a readback found the offer in the native session; `done`: the next `hub_task_done`), `ms` (from the offer): an acknowledged offer, the only thing that moves a peer's view |
| `capability` | `peer`, `state` (`verified` or `lost`), `via`: a peer's context path for facts |
| `native_turn_end` | `peer`: Claude's Stop hook, the end of its turn (Codex's is its `turn_end`); quiescence evidence for an integration |
| `hook_stats` | `peer`, `n` (facts hook calls in the turn, its Stop included), `startupMs` and `maxStartupMs` (the hook processes' start-up and connect time, summed and the largest), `hubMs` (the hub's own time for them): at Claude's Stop (issue #108) |
| `cohort` | `id`, `event` (`formed`, `joined`, `lifted`), `silent`, `tasks`, `owners`: owners of overlapping tasks formed a cohort, it changed membership, or it stopped being silent (issue #107). Recorded in every regime; only a turn-free project's cohorts can be silent |
| `split` | `task`, `verdict` (`split`, `single`, `unknown`), `single` (the peer that would finish both units alone soonest), `splitS`, `singleS`, `reason` (for `unknown`), `trace` (the inputs and steps: peer names and numbers only): a shadow split prediction where an overlap forms or changes a cohort, routed or named; it never changes the assignment (issue #109) |
| `state` | `peer`, `state` |
| `turn_start` | `peer`, `turn` (`<peer>#<hub run>.<n>`, unique across restarts). A turn follows the adapter: pausing a busy peer does not end it |
| `turn_end` | `peer`, `turn`, `ms`, `tokens` (when the adapter reported any during the turn), `files` and `snapshotMs` (when snapshots are on: how many files the turn changed, and the time both snapshots took) |
| `tokens` | `peer`, `n` (tokens added since the previous report) |
| `usage` | `peer`, `source`, opaque `id`, optional `measuredAt` (provider/source time), requested/served model and provider labels, and any provider-reported input/output/cache/total counters. Missing counters stay unknown. |
| `task` | `id`, `event` (the board history event, e.g. `proposed`, `assigned`, `done`, `check failed`, `blocked`, `ready`), `by`, `state`, `owner`, `reviewer`, `class`, `pii` |
| `overlap` | `task`, `owner`, `others` (`task`, `owner`, `paths`, and `symbols` when plans name the same symbol; a name that matches a PII pattern is left out, so either list can be empty), the structured twin of the console notice |
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

The file is local and never uploaded. It grows without rotation; delete it to start
over (the hub recreates it).
