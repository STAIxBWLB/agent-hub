# Research records

Opt-in records of how each task went, kept across projects for management and research (#247). They are built only
from a project's `events.jsonl`, so they hold ids, states, counts, tokens and times, never a title, detail, plan, note,
path, message body or check output.

## Turning them on

In a project's `.agenthub/config.json`:

```json
{ "research": { "enabled": true } }
```

Off by default; anything but `true` is off. While it is off the hub writes nothing and creates no file. The setting is
read when the hub starts.

## Where they go

`~/.agenthub/research/<project key>.jsonl` (the directory 0700, the file 0600), where the key is the first 16 hex
characters of the SHA-256 of the project's registry id. Every project on the machine that opts in writes to the same
directory, so `ahub research --all` can compare them. `ahub reset --all` does not touch it.

## When a record is written

When a task is approved (a review approves it, or its owner reports a task without a reviewer done), the hub appends
one task record built from that project's events up to the approval. A task approved again after it reopened gets a
newer record with `revision` one higher; reports use the latest revision. A failing write is one `hub.log` line per hub
run and never changes the task flow.

`ahub research backfill` builds the same records from a project's existing `events.jsonl` (marked
`writer.source: "backfill"`) and appends those the store does not hold yet (same task, revision and approval time).

## Task record (`agent-hub.research/v1`, `kind: "task"`)

| Field | Meaning |
| --- | --- |
| `project` | the project key above |
| `task`, `revision` | the board's task id; 1 for the first approval |
| `class`, `pii` | the task's class; whether it was a PII task (its record holds counts only, like any other) |
| `outcome` | `approved` |
| `createdAt`, `startedAt`, `approvedAt` | proposal, first `in_progress`, this approval (ISO) |
| `wallMs` | from `startedAt` to `approvedAt`, null when the start is not in the events |
| `activeMs`, `turns`, `filesChanged` | sums over the turns attributed to the task (`turn_end`) |
| `owners`, `reviewer` | peer ids that owned it, the last reviewer |
| `reviewRounds`, `changesRequested`, `checkFailed`, `dones`, `reassignments` | times it went to review, was sent back, failed its check, was reported done, was declined, escalated or reassigned |
| `firstPass` | approved on its first review with no failed check and no changes requested |
| `stuck`, `overlaps`, `conflicts` | escalation verdicts, overlap warnings and file conflicts about the task |
| `tests` | route outcomes that ran tests: `pass`, `fail` counts |
| `tokens` | attributed tokens, `total` and `byPeer` (#200 attribution; unattributed tokens are in no record) |
| `usage` | provider usage per peer: `input`, `output`, `cacheRead`, `total` (null when never reported) |
| `models` | model routes and served models of the attributed requests |
| `writer` | the release and `live` or `backfill` |

## Label record (`kind: "label"`)

`ahub task label <id> ok|regressed|reverted|incomplete|wrong|abandoned` appends `{ project, task, label, at }`: a
person's later verdict (a revert next week, a regression found later, work given up). Only a person can run it (agent
shells are refused), and only while research is on. The latest label wins.

## Measures

`ahub research [--since 30d] [--all] [--json]` reports, overall and by class, owner, model and project:

- success rate: approved tasks whose latest label is none or `ok`, over approved tasks;
- first-pass rate: `firstPass` over approved tasks;
- rework: changes requested per approved task;
- check-failure rate: failed checks over reported dones;
- tokens and wall time per approved task, median and p90.

They are computed each time from the records; nothing derived is stored. `ahub research export [--format jsonl|csv]
[--since] [--all]` writes the records for outside analysis; the CSV columns are, in order: project, task, revision,
class, pii, outcome, createdAt, startedAt, approvedAt, wallMs, activeMs, owners, reviewer, reviewRounds,
changesRequested, checkFailed, dones, reassignments, firstPass, stuck, overlaps, conflicts, testsPass, testsFail, tokens,
turns, filesChanged, models, label, writerVersion, writerSource.

Agents may read the measures and export (ids and counts only); `backfill` and `task label` are a person's.
