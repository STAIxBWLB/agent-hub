# agent-hub

Native multi-agent hub for one developer's machine: Claude Code, Codex, Kimi Code, Pi and a
hub-owned local-LLM worker collaborate as peers in independent project directories, with
task-aware model routing (Switchyard) in front of a self-hosted gateway (OmniRoute).

Status: 0.6.0. All six milestones of the design spec are implemented; the [smoke checklist](docs/smoke.md)
says what has and has not been verified against real agents.

Version 0.5.0 adds [controlled upgrade and session recovery](docs/specs/2026-09-20-upgrade-recovery-design.md).
After bootstrapping a protocol-8 hub, use `ahub restart --dry-run` to inspect one
project or `ahub upgrade --to <exact-version> --dry-run` to inspect an upgrade of
the running projects. Remove `--dry-run` to review and schedule the operation;
`ahub recovery status <operation-id>` reports progress. Existing protocol-5–7
hubs require their matching CLI and an attended maintenance bootstrap.

## Start here

Requires [Bun](https://bun.sh) >=1.3.0 on PATH; Node alone cannot run the CLI.
The npm package is `@staix/agent-hub`, under the `staix` organization.

Install from npm:

```bash
bun add -g @staix/agent-hub && ahub setup
cd <your project> && ahub init && ahub up && ahub tail
```

Or install the same version from GitHub:

```bash
bun add -g github:STAIxBWLB/agent-hub#v0.6.0 && ahub setup
```

The installed commands remain `ahub` and `agent-hub`.

When upgrading an existing project, run `ahub init` to refresh its managed agent
instructions and `ahub setup` to refresh the Claude plugin. Restart the daemon
and agent sessions so both load the update.

- [Quickstart](docs/quickstart.md): install, first session, the local worker, the commands of a working day
- [Security notes](docs/security.md): what the hub defends and what it does not
- [Design spec](docs/specs/2026-09-19-agent-hub-design.md): how it is built and why, with every amendment made along the way
- [Smoke checklist](docs/smoke.md): the live checks, and what has and has not been verified against real agents
- [Changelog](CHANGELOG.md), [Contributing](CONTRIBUTING.md)

## Why not agent-bridge

[raysonmeng/agent-bridge](https://github.com/raysonmeng/agent-bridge) proves the
Claude <-> Codex pairing. Its core is two-party by construction (single Claude seat,
`source: claude | codex`), and its v3 rooms carry signals only. agent-hub starts from
an N-peer message bus and attaches each agent through its native control surface.

## Peers and their native surfaces

| Peer | Inbound | Outbound | Busy handling |
| --- | --- | --- | --- |
| Claude Code | channel plugin push (`notifications/claude/channel`) | MCP tools | queued by Claude Code, grouped on next turn |
| Codex | app-server `turn/start` (idle) / `turn/steer` (busy) | proxy intercepts `item/agentMessage` | steer or queue |
| Kimi Code | ACP `session/prompt` | ACP `session/update` stream | queue (`turn.agent_busy`) |
| Pi | RPC or managed native TUI extension | hub-approved tools | queued until `agent_settled` |
| Local worker | hub-native agent loop | hub-native | hub-owned |

## Pi with DGX and MLX

Pi is optional. Install Pi separately and set `pi.enabled` to `true` in
`.agenthub/config.json`. Set `pi.auto_start` to `true` to start its background
peer with the hub. The project uses its existing OmniRoute connection for DGX;
`pi.dgx_coding` and `pi.dgx_fast` select the gateway's configured model IDs.

```bash
ahub models setup       # dedicated Python 3.12 environment and pinned Qwen3 8B MLX weights
ahub models start       # loopback-only Apple Silicon runtime
ahub models status
ahub pi --mode headless --backend auto
ahub say @pi "Read the project and summarize the next small implementation task"
ahub pi --mode tui     # switch the idle session to its native terminal
```

The default routing template assigns implementation, bulk edits and tests to
DGX, and summaries/triage to MLX. Pi and the existing local worker take priority
before cloud peers; planning and final review stay with Claude/Codex. Existing
projects keep their routing file, so add `pi` to the relevant `peers` lists and
set `pi_backend = "dgx"` or `"mlx"` for each class. PII tasks remain local-worker
only. `--backend dgx` or `--backend mlx` explicitly pins a Pi session's backend.

Pi connects to an authenticated relay with model aliases `dgx/coding`,
`dgx/fast`, and `mlx/fast`; upstream gateway credentials stay in the hub.
Its managed tools use the existing path guards, shell sandbox and terminal
approval flow. Keep `ahub tail` open to approve write/edit/shell operations.
Tool-call receipts survive daemon restart; an interrupted operation with an
unknown outcome must be reconciled before repeating it.

MLX uses a pinned Qwen3 8B 4-bit model, a 16K input budget and one generation
at a time. `ahub models stop` stops only the runtime whose process identity
matches its ownership record. Project hubs share the runtime; stopping a hub
does not stop MLX. The relay can fall back from MLX to DGX before streaming
starts. Inspect `ahub status` for requested routes and reported backend models.

A project has one managed Pi session owner. Mode changes require the agent to
settle and preserve the session file. Protocol 9 adds Pi recovery metadata;
protocol-8 hubs can use controlled upgrade, while protocols 5-7 still require
their matching CLI and an attended bootstrap.

## Runtime

Bun + TypeScript. Single daemon per project directory, loopback only.

## Local dashboard

With a running daemon, `ahub ui` opens a local dashboard for messages, peer states
and queues, the task board, budget windows and pending approvals. Use
`ahub ui --no-open` to print a single-use link when the browser cannot be opened.
Open the link within 60 seconds; the browser session lasts one hour.

The dashboard can send console messages, propose and assign tasks, pause or resume
peers, and answer approvals. Budget pauses still require the terminal override.
Private envelopes and PII tasks stay redacted. Local-worker tool details and
allow decisions stay in `ahub tail` / `ahub permit`; the page can deny them.
No dashboard port is opened until requested. See [the session security model](docs/security.md#local-dashboard-sessions-issue-6).


## Multiple projects and worktrees

Version 0.4.0 adds one independent hub per repository or Git worktree.
Subdirectory commands resolve to that project; symlink aliases resolve to the same
hub. Explicit selection works from any directory:

```bash
ahub --project /path/to/project-a init
ahub --project /path/to/project-b init
ahub --project /path/to/project-a up
ahub --project /path/to/project-b up
ahub projects
ahub status --all
ahub --project /path/to/project-a codex
ahub ui --all
```

The unified dashboard lists registered roots and opens their boards, streams,
messages, approvals and budgets. It can start hubs and stop a selected hub after
confirmation. Launch Claude/Codex TUIs from a terminal. The manager stays available
when a project stops; `ahub ui --all --stop` stops only the manager. Existing
`ahub ui` still opens the current project's dashboard.

`ahub projects --json` returns machine-readable live status. Use a listed ID or a
path with `--project`; the selector must precede the command. `ahub projects remove
<id>` forgets a stopped registration without deleting project data. A moved root
gets a new registration. Missing roots remain visible until removed.

Runtime state stays in each project's `.agenthub/state/`. The machine registry is
`~/.agenthub/registry.db`; existing `ports.json` allocations are imported once.
`AGENTHUB_HOME` selects an isolated machine registry (also used by tests). An
inherited state directory from a different project cannot redirect a new CLI
invocation. Explicit custom state requires a matching project marker or the
initialization pair `AGENTHUB_PROJECT_DIR` / `AGENTHUB_STATE_DIR`.

Manager-started hubs use attended mode and project configuration, including
credential-file references. They do not inherit the launching project's gateway
URL/key overrides. Native memory remains shared according to claude-mem aliases;
worktrees recall their parent and composite identity. A shared-alias notice does
not mean that task boards or agent sessions are shared. Provider quota readings
may describe the same account and should not be added across projects.

Before upgrading to protocol 7, stop existing hubs with their matching CLI, then
update the package/plugin and restart the desired projects and agent sessions.
Incompatible or unverified processes are shown explicitly and are never killed by
PID-name matching. See the [multi-project specification](docs/specs/2026-09-19-multi-project-design.md).
