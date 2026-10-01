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
| `state` | `peer`, `state` |
| `turn_start` | `peer`, `turn` (`<peer>#<hub run>.<n>`, unique across restarts). A turn follows the adapter: pausing a busy peer does not end it |
| `turn_end` | `peer`, `turn`, `ms`, `tokens` (when the adapter reported any during the turn) |
| `tokens` | `peer`, `n` (tokens added since the previous report) |
| `task` | `id`, `event` (the board history event, e.g. `proposed`, `assigned`, `done`, `check failed`), `by`, `state`, `owner`, `reviewer`, `class`, `pii` |
| `overlap` | `task`, `owner`, `others` (`task`, `owner`, `paths`), the structured twin of the console notice |
| `quota` | `peer`, `windows` (`id`, `used`, `resetsAt`), `hard`, `measuredAt` (when the reading was taken, if not when it arrived: Claude's numbers come through a file) |

Token usage by adapter:

- Kimi (ACP `usage_update`): recorded.
- Codex (app-server `thread/tokenUsage/updated`, a running thread total): recorded.
- Claude: not recorded. The status line tee carries quota percentages only; per-turn
  tokens would need transcript parsing.
- Pi and the local worker: not recorded.

The file is local and never uploaded. It grows without rotation; delete it to start
over (the hub recreates it).
