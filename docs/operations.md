# Operations guide

This guide describes ahub 0.7.11 and control protocol 10. Live verification
results and remaining prerequisites are recorded separately in [the smoke ledger](smoke.md).

## Install and start

Use Bun 1.3 or newer. Install the released package and install its Claude
channel plugin:

```bash
bun add -g @staix/agent-hub
ahub setup
cd <project>
ahub init
ahub up
ahub tail
```

`ahub init` writes the project configuration and managed instruction blocks.
Run it after an upgrade when those blocks need refreshing. `ahub setup`
updates the shared Claude plugin. Keep `ahub tail` open when a local worker
may request an approval.

`.agenthub/config.json` can be committed and shared. The fields that choose
what the hub runs, which files it sends as credentials, where task text goes,
or how far the local worker's sandbox reaches (`kimi_cmd`, `codex_bin`,
`pi.cmd`, `checks`, `mlx.bin`, `mlx.runtimeDir`, `mlx.modelPath`, `omniroute.urls`,
`omniroute.access_hosts`, the `omniroute` key files, `memory.worker_url`,
`local.read_allow`, `local.bash_network`) are machine-local: they apply only
from a file git confirms nobody committed. Put them in
`.agenthub/config.local.json` (`ahub init` adds it to `.gitignore`), which is
read after `config.json`; outside a git repository they keep their defaults, and
an empty value always means the default.
A committed value is ignored with a line in `hub.log`, a note from `ahub
codex` and `ahub models`, and a row in `ahub doctor`.

Managed launchers attach native peers to the project daemon:

```bash
ahub claude
ahub codex
ahub kimi
ahub pi --mode headless --backend auto
ahub local
```

Start only the peers configured for the project. A launcher records and checks
its project and session identity; do not start a second terminal by guessing
from a process name. For multiple projects, use the explicit selector before
the command, for example `ahub --project /path/to/project codex`.

## A two-agent task and review

Choose an owner explicitly, then inspect the reviewer selected by the project
routing policy before work begins:

```bash
ahub task propose implement "Update the parser" --owner codex --path src/parser.ts
ahub board
ahub task show <task-id>
```

The owner accepts with `hub_task_accept`, makes the change, and reports with
`hub_task_done` including a summary and refs. The reviewer receives a review
request and responds with `hub_review`. A console review uses:

```bash
ahub review <task-id> approved "verified against the requested behavior"
# or
ahub review <task-id> changes_requested "describe the required correction"
```

A class can carry a completion check in `.agenthub/config.json`, for example
`"checks": { "implement": "scripts/check.sh", "timeout_s": 600 }`. When the owner
marks such a task done, the tool answers at once, the hub runs the command in the
project root (one at a time; what it left in its process group is killed when it
exits, at the timeout or on shutdown), and then either
sends the task to review with the command, exit code and output tail, or keeps it
with its owner and tells it what failed. `checks` is machine-local (see Install
and start): a committed file must not choose commands the hub runs. Keys that
are not task classes are ignored with a log line. A hub stopped mid-check leaves
the task in progress (`check interrupted`); the owner marks it done again.

A task reaching `approved` is a board transition. It is not proof that an
external side effect happened unless the task's refs and a live readback show
that effect. The hub can reassign after repeated review changes according to
the routing configuration.

An agent can claim work nobody assigned it by proposing a task with itself as
owner; without a class, and with no model to name one, the claim is filed as
`implement`. When a task's paths overlap another owner's open task, the newcomer
is told to settle it and the earlier owner gets one line with its next message,
at no turn of its own. An owner offline longer than `tasks.release_after_min`
(default 30, `0` turns it off) in `.agenthub/config.json` loses its open tasks
to a peer routing can give them to; with nobody to take them they stay, and a
paused peer or a hub in a recovery operation is left alone.

Use targeted messages for coordination:

```bash
ahub say @codex "[IMPORTANT] inspect the failing fixture"
ahub say @claude "[STATUS] the test run is complete"
ahub say @kimi "[FYI] the result is recorded"
```

`@peer` addresses one known peer. With no recipient, `ahub say` broadcasts
to attached peers. `[IMPORTANT]` can bypass batching where the peer supports
it; `[STATUS]` may batch, and `[FYI]` is recorded without follow-on
delivery. A delivery or answer is not a task completion receipt.

## Telemetry: export and report

The hub writes structured events to `.agenthub/state/events.jsonl` alongside
`hub.log` (schema: `docs/events.md`). They carry ids, routing, sizes, states and
token counts, never message bodies or task titles.

```bash
ahub report --since 7d          # turns, busy time and tokens per peer, messages, overlaps, task events
ahub report --since 7d --json   # the same numbers as JSON
ahub export --since 24h         # the raw events as JSON lines, for your own analysis
```

`ahub report` counts the same overlap warnings as `scripts/overlaps.ts`, from the
structured events instead of log lines.

## Approvals and pauses

Inspect permission requests in the terminal:

```bash
ahub tail
ahub permit <request-id> allow
```

Use the exact option shown by `ahub tail`; do not approve an unresolved or
unexpected request. On macOS a waiting request also raises a desktop
notification that names the peer and, for Kimi, the tool, never what it would
run. An unanswered request is cancelled after `approvals.timeout_s` (default
120, 30 to 3600) in `.agenthub/config.json`, and the console and log say so.
Set `approvals.notify` to `false` to turn notifications off; a hub started
without a project config file raises none. While Kimi waits for an answer its
turn is kept alive, so a timeout longer than the inactivity watchdog does not
cancel it.
`ahub pause <peer>` holds delivery and `ahub resume
<peer>` releases a manual pause. Budget pauses are distinct:

```bash
ahub budget
ahub budget resume <peer>
```

A budget pause remains authoritative until the budget command explicitly
overrides it or the window resets. Check `ahub status` and `ahub board` after
a pause or handoff.

## Durable delivery and queue resolution

Protocol 10 records each recipient delivery in the private project journal.
The states are `queued`, `dispatching`, `accepted`, `completed`,
`needs_review`, `failed`, and `discarded`. Adapter acceptance means that
the native bridge received the delivery; it does not prove that the agent
executed it. Only native completion or a correlated reply can settle a receipt.

The console interface is:

```text
ahub queue list [--peer <id>] [--json]
ahub queue show <delivery-id>
ahub queue resolve <delivery-id> --action completed|retry|discard --reason "<text>"
```

These queue commands ship with protocol 10 (0.7.0 and later), where a known
offline recipient may also be queued explicitly; broadcast and automatic
assignment still require an attached peer. A hub still on protocol 9 (0.6.x)
has only `ahub status`, `ahub tail` and the task board.

Resolution requires the current observed revision. A retry closes the old
record and creates one linked attempt. Stale or conflicting resolutions fail.
If dispatching or accepted work has an uncertain outcome after a crash,
the system marks it `needs_review`. Establish evidence before choosing
`completed`, `retry`, or `discard`. Timeouts,
disconnects, cancellation, and partial effects are uncertain; do not replay
them automatically.

## Graceful shutdown

Before stopping, let active turns and approvals settle when possible:

```bash
ahub status
ahub tail
ahub kill
```

The daemon waits for shutdown work that must survive termination. Afterward,
run `ahub status` or `ahub up` and read the project state before restarting
peers. A stopped daemon does not delete task records or the durable journal.
Do not kill a native terminal by PID or start a replacement while ownership is
uncertain.

Shutdown is bounded: once it begins, a daemon that cannot finish within
15 seconds exits anyway, and a peer that refuses to stop is logged rather than
allowed to block state cleanup. A native Pi TUI owner that does not exit
gracefully is terminated by its verified process identity (never a bare PID),
so a restarted hub never launches beside a survivor. A hub whose project root
or state directory was deleted stops itself within about 10 seconds; the
dashboard manager does the same when its home directory vanishes.

## Orphaned daemons

Daemons from before those guards, or daemons whose project directory was
deleted while they were stopped mid-shutdown, are found with:

```bash
ahub doctor --orphans
```

It lists registrations whose project root is gone, with any live process
candidates (the registry claim, the state manifest, the legacy pid file).
To stop them:

```bash
ahub doctor --orphans --kill
```

`--kill` sends SIGTERM, then SIGKILL, but only while the process argv names
that project's hub daemon exactly (the argument after `--project` must equal
the registered root); a bare, reused, or merely prefix-matching PID is never
killed.
Rows without a live process are stale registrations; forget them with
`ahub projects remove <id>`.

## Upgrade and crash recovery

Upgrade running projects with the target release's own coordinator. It accepts
a running source on control protocol 9 (0.6.x) or 10 (0.7.0 and later) and only
a target on its own protocol, so the target's coordinator fits every supported
source and carries every recovery fix released up to it. Protocol 8 and older
(0.5.x and earlier) are refused as `manual-bootstrap-required`. Run from the
project directory, without replacing the global CLI first:

```bash
bunx --package @staix/agent-hub@0.7.11 ahub upgrade --to 0.7.11 --dry-run
bunx --package @staix/agent-hub@0.7.11 ahub upgrade --to 0.7.11 --yes
```

| Running now | Coordinator to use |
| --- | --- |
| 0.6.x (protocol 9) | the target's, through `bunx` as above |
| 0.7.0 up to the release before the target (protocol 10) | the target's, through `bunx` as above |
| any supported source, with the installed CLI already at the target | `ahub upgrade` below, which is the same coordinator |
| 0.5.x or earlier (protocol 8 and older) | not supported: bootstrap by hand with the matching CLI |

Do not use an older installed CLI as the coordinator. A 0.6.x CLI cannot target
protocol 10: its plan does not check the target's protocol, so the dry-run shows
no blocker, and `--yes` stops at staging ("target protocol requires a newer
coordinator") with an operation left to clear by `ahub recovery abort <id>`. An
older 0.7.x CLI may lack recovery fixes released after it. The
[smoke ledger](smoke.md) records dry-runs from real 0.6.4 and 0.7.5 hubs (issue
#75); an applied upgrade was last proven with the 0.7.0 coordinator.

The coordinator verifies and retains the exact target package, preserves its
own source, and promotes the global CLI only after restored projects pass
readback.

Once the installed CLI is 0.7.11, review the current project or all registered
projects first:

```bash
ahub restart --dry-run
ahub upgrade --to 0.7.11 --dry-run
```

Apply only after reviewing the plan:

```bash
ahub restart --yes
ahub upgrade --to 0.7.11 --yes
ahub recovery status <operation-id>
ahub recovery resume <operation-id>
ahub recovery abort <operation-id>
```

The 0.7.0 transition stages the verified package and runs a retained
coordinator from the source tree. It accepts a verified protocol-9 source and
moves to a protocol-10 target. The source journal, queued envelopes, tasks,
manual pauses, budget state, and native session identity are read back before
release. The global CLI is promoted last.

A lost commit or start reply is reconciled against the actual daemon identity,
package digest, terminal binding, and phase receipt. An uncertain terminal
creation is never repeated blindly. If Claude shows its development-channel confirmation screen, confirm it in
the captured terminal, then run `ahub recovery resume <operation-id>`; resume must not open a duplicate terminal.
Kimi and local sessions may start fresh with preserved routing and task context.
A Claude session that never persisted a transcript (zero turns) also starts fresh:
there is nothing to resume, so the upgrade accepts the new session id; a session
with a transcript must come back with its original id.
Previously stopped projects stay stopped; only the reviewed running projects
are upgraded.

Do not run an upgrade with an incompatible active protocol, an unverified
terminal binding, or an unresolved operation lock. Dry-run performs no package,
plugin, daemon, or terminal mutation.

## Evidence and limits

The 0.6.4 release has real measurements in [the smoke checklist](smoke.md):
Pi returned an exact file marker through MLX in 5.800 seconds in the production
probe; the installed-package checks measured Pi MLX at 2.234 seconds, Pi DGX
at 1.324 seconds, and a 208 ms MLX-to-DGX handover with the same session
identity. A real Kimi 2.0.1 and Pi run showed queue counts and priority counts
matching between the CLI and status file. These are individual observations,
not a latency or reliability benchmark.

The 0.6.4 production readback retained two envelopes for a disconnected Codex
peer with identical IDs before and after recovery; general status lists attached
peers and therefore did not show that backlog. No messages were deleted. The
0.7.1 attended cutover and production readback verified queue visibility and
completion receipts; see the final section of the smoke checklist.

Issue [#1](https://github.com/STAIxBWLB/agent-hub/issues/1) remains open for
off-campus Access credentials and a natural near-limit budget pause. Tests,
synthetic approvals, and an authenticated internal network do not close those
prerequisites. Adapter acceptance is not task completion, and package
installation or a passing test suite is not proof of a successful production
cutover.


## Ollama MLX migration (issue #51)

The routing names `mlx/fast` and `--backend mlx` are retained. The normal
runtime provider is now Ollama; the standalone Python server is legacy.
Use an Apple Silicon Ollama build with MLX support and keep it bound to
loopback. Configure its finite keep-alive and one-model/one-generation
limits before use. The model is prepared only by explicit `models setup`;
an incoming generation does not download models or start a service.

Project `.agenthub/config.json` example:

```json
{
  "mlx": {
    "provider": "ollama",
    "host": "127.0.0.1",
    "port": 11434,
    "model": "agenthub-fast-mlx:4b-8k",
    "sourceModel": "qwen3.5:4b-mlx",
    "contextWindow": 8192,
    "maxInputTokens": 6000,
    "maxTokens": 2048,
    "maxConcurrency": 1
  }
}
```

1. Record the current project/hub state. Do not restart stopped hubs or
   replay queued tasks as part of model migration.
2. If the old Python server is still running, use the old matching CLI's
   `models stop` before changing configuration, or explicitly select
   `provider: "legacy"` temporarily. Its PID, start time and command must
   match the ownership record. Never kill by process name. Preserve model
   files and the old configuration for rollback.
3. Apply the Ollama configuration above, removing legacy `modelPath`,
   `runtimeDir` and Python binary settings. Existing custom legacy paths
   without an explicit provider fail with a migration error. Old 16K input
   overrides must also be reduced; the new total context is 8K.
4. Run `ahub models setup`, `ahub models start`, and `ahub models status`.
   Setup creates a dedicated derived model; an existing model is inspected
   rather than silently overwritten. A wrong context recipe must be fixed
   deliberately under a new model name or after an explicit model change.
5. Verify a streamed completion and tool call through the authenticated
   relay. Check Ollama logs for the MLX runner, `/api/ps` for context and
   finite expiry, then confirm idle eviction. Catalog availability does
   not mean the model is resident. Unit tests are not this live proof.

Ollama is shared and external. `models stop` refuses in Ollama mode rather
than interrupting another client. Hub shutdown releases local handles and
requests, not the server. Normal idle eviction is Ollama's responsibility;
no AgentHub timer unloads a potentially shared active model.

The relay's input budget is an estimate, not exact model tokenization. Keep
headroom for templates/tool metadata and choose a larger dedicated recipe
only after measuring memory. This path does not change local-worker PII
routing or the DGX backend. Rollback requires explicitly restoring the old
config with `provider: "legacy"`; Ollama errors never launch Python.
