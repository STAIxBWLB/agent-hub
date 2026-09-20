# Quickstart

agent-hub lets the coding agents on one machine work as peers in one project directory: Claude Code, Codex, Kimi Code, and `local`, a worker the hub runs itself on a model you host. You talk to all of them from the hub console.

## Install

Needs [Bun](https://bun.sh) 1.3 or newer and macOS (Linux works without the `local` worker's `bash` and `git` tools, which need the macOS sandbox).

Node alone is not supported. Keep `bun` on PATH even if you install with npm.
The registry package uses the `staix` organization scope. Install from npm:

```bash
bun add -g @staix/agent-hub                 # installs `ahub` (also as `agent-hub`)
ahub setup                                # installs the Claude Code channel plugin from this package, then runs doctor
```

Or use the matching GitHub release:

```bash
bun add -g github:STAIxBWLB/agent-hub#v0.7.0
ahub setup
```

From a clone instead: `git clone`, `bun install`, `bun link`.

`ahub doctor` tells you what is installed, running and configured. Rows you do not need can stay red: the hub works with any subset of the peers.

For managed launchers, two-agent task/review work, approvals, graceful shutdown,
and upgrade or crash recovery, see the [operations guide](operations.md).

## First session

In your project directory, one terminal each:

```bash
ahub init          # .agenthub/config.json, .agenthub/routing.toml, marker blocks in CLAUDE.md and AGENTS.md
ahub up            # the daemon for this directory (loopback only)
ahub tail          # keep open: the conversation, state changes, permission requests
ahub kimi          # Kimi, headless
ahub codex         # Codex TUI, attached through the hub
ahub claude        # Claude Code with the hub channel
```

Then talk:

```bash
ahub say "Each of you: reply with your name."      # broadcast
ahub say @kimi "run the tests and report"          # one peer
```

## The local worker

`local` needs an OpenAI-compatible gateway. Put yours in `.agenthub/config.json`:

```json
{ "omniroute": { "urls": ["http://your-gateway:20128/v1"], "api_key_file": "/path/to/key" } }
```

or set `OMNIROUTE_API_KEY`. Name the model in `.agenthub/routing.toml` (`[local] fixed_model`). Then `ahub local`. It works only inside the project, asks before it writes or runs anything (`ahub permit <id> allow`), and everything it executes is sandboxed.

## The five commands of a working day

| Command | What for |
| --- | --- |
| `ahub say [@peer] <text>` | talk; start with `[STATUS]` to let it batch, `[FYI]` for the record only |
| `ahub task propose [--class <c>] <title>` | put work on the board; the hub picks an owner and a reviewer, and the class if you name none |
| `ahub board` | who has what; `ahub task show <id>` for one task |
| `ahub status` | peers, queues, pauses; `ahub budget` for quota windows |
| `ahub ask <question>` | what the board, shared memory and the log say, with the ids the answer rests on |
| `ahub kill` | stop the daemon and everything it started |

More: `ahub help`. How it is built and why: [`docs/specs/2026-09-19-agent-hub-design.md`](specs/2026-09-19-agent-hub-design.md). What it protects and what it does not: [`docs/security.md`](security.md).

## Browser dashboard

After `ahub up`, run `ahub ui` to open the local dashboard. It refreshes the
conversation stream, peer queues, task board, budget windows and approvals every
second. No build step, web server command or browser extension is needed.

Use the page to pause/resume a peer, send a console message, propose/assign tasks,
and allow/deny agent permission requests. Local-worker requests show no tool
contents: inspect them with `ahub tail`, then use `ahub permit <id> <option>` to
allow. They can be denied on the page. PII task details remain available only via
`ahub task show <id>` in the terminal.

`ahub ui --no-open` prints a one-time link instead of launching a browser. Open it
within 60 seconds. A session expires after one hour; run `ahub ui` again. Restarting
the daemon invalidates all links and sessions. The UI listener is started only on
request, binds loopback and stops with the daemon. Remote access is not supported.

The stream retains the latest 200 events since the dashboard listener was started;
it does not load historical logs. An unopened dashboard has no listener or event
buffer. A paused budget window cannot be overridden on the page; the CLI's
`ahub budget resume <peer>` remains the explicit override.


## Concurrent project development (0.4.0)

Initialize and start each repository/worktree separately, or use the global
`--project <path|id>` prefix. `ahub projects` lists registered roots and live
status; `ahub status --all` includes peer/task summaries. Within a subdirectory,
commands use the nearest project inside that Git working-tree boundary.

Open `ahub ui --all` from any directory to manage all registered hubs. Use Start
to launch an initialized project, Use to view a running project, and Stop to stop
the selected hub. Stop confirmation names its root. Terminal agent launch is
still `ahub --project <path> claude` or `ahub --project <path> codex`.

The manager is independent: `ahub ui --all --stop` closes its browser sessions
without stopping project hubs. One-time links and session expiry work the same
way as the project-local dashboard. For headless environments use `--no-open`.

Project data is retained after stopping and after `ahub projects remove <id>`.
To use a custom runtime directory initially, set both `AGENTHUB_PROJECT_DIR` to
the canonical project root and `AGENTHUB_STATE_DIR` to the desired directory;
subsequent explicit project selection reads the registered location.

For dashboard-started model workers, put gateway URLs and credential-file
references in that project's config. The manager never copies another project's
gateway override or unattended setting. Native memory and provider accounts keep
their existing sharing rules; the dashboard marks shared native memory aliases.
