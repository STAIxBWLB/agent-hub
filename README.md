# agent-hub

A hub on your own machine where coding agents work together as one team. Claude
Code, Codex, Kimi Code, Pi and a hub-owned local worker (plus Qwen Code, Jcode and
Antigravity if you want them) share a message bus, a task board and a memory, each
connected through its own native interface.

Status: 0.21.0, control protocol 16. Bun + TypeScript, one loopback daemon per
project. Site: [agent-hub.staix.net](https://agent-hub.staix.net).

## Quick start

You need [Bun](https://bun.sh) 1.4.2 or later on PATH.

```bash
bun add -g @staix/agent-hub && ahub setup
cd <your project> && ahub init && ahub up   # daemon plus the operator console
```

Then start the agents you use, one terminal each, and talk to them:

```bash
ahub claude                                  # Claude Code with the hub channel
ahub codex                                   # Codex TUI, attached through the hub
ahub say "Each of you: reply with your name."
ahub ui                                      # the web dashboard
```

`ahub init --dry-run --json` shows what init would write. The
[Quickstart](docs/quickstart.md) walks through a first session and a working day.

## What you get

- **Peers, not a pipeline.** Any agent can message the others. Messages are batched
  into digests, priorities decide what interrupts a turn, and delivery survives
  restarts.
- **A shared task board.** Work is proposed, accepted, done and reviewed through hub
  tools. Roles split planning, implementation and review (up to eight planners,
  each task bound to one), `routing.toml` picks
  owners by task class, and owners of overlapping work are told what changed. A
  peer that accepted or finished a task never reviews it, a review request lists
  the task's acceptance criteria by id, and a done report can name deliverable
  files that the hub hashes itself, so an approval binds the bytes reviewed, and
  `ahub deliverables` lists them. Extra
  Claude Code instances can implement in their own worktree, in a terminal or
  headless with one session per task. `ahub sdlc metrics` reads lead times,
  rework and stalls from board history, and
  optional control bands turn a breach into a backlog card.
- **Shared memory.** Decisions, contracts, fails and findings are kept through the
  first-party [`@staix/agent-mem`](https://github.com/STAIxBWLB/agent-mem) library,
  in process with no claude-mem worker (short- and long-term tiers, a typed graph,
  git sync between machines). Agents get
  it as a recall preface, as briefs on a task, and through bounded search tools.
- **Local and on-prem models.** Pi and the local worker can run on DGX or local MLX
  through an authenticated relay. Tasks marked as PII stay on the on-prem worker.
- **Guard rails.** The local worker and Pi run in a sandbox, and their writes and
  shell commands wait for your approval unless you choose a looser permission mode.
  Publish, external-write, destroy and install calls ask a person in every mode for
  Claude Code, the local worker, Pi, hub-owned ACP peers such as Kimi and the
  approval requests Codex sends, wherever the hub sees the call before it runs;
  `ahub status` names each peer where it cannot. Budgets pause an
  agent before it runs out of quota, and recovery never replays an
  effect whose outcome is unknown.
- **Operations.** A terminal console and a local dashboard, one hub per repository or
  worktree with a machine-wide view, live settings reload, structural config
  (instances, review, lifecycle) edited with a validated diff and a backup from the
  console or a dashboard settings session, token usage and quota
  history (`ahub usage` and the dashboard's Usage view), and `ahub upgrade`, which
  carries running sessions across versions.

## Upgrading

Run `ahub upgrade` while your hubs are running. Read the notes for your version in
the [Quickstart](docs/quickstart.md) ("Upgrading to ...") and the
[Changelog](CHANGELOG.md) first: some releases need a one-time step, such as
refreshing an agent's MCP entry.

Agent CLIs update themselves. `ahub agents` shows which installed versions the hub
accepts, `ahub agents trust <id> <version>` accepts an untested one on this
machine, and the hub tells the planner when an installed version is not verified.

Before you migrate a memory home with `amem`, read
[memory profiles and rollout](docs/memory.md#selected-memory-profile). Every hub that
uses the home must run a version that understands the new layout.

## Where it is going

- **Curated memory** ([#412](https://github.com/STAIxBWLB/agent-hub/issues/412)):
  compression, removal, correction and failure-driven management, each shipped only
  after its contract and a measurement.
- **Every agent able to do its share** ([#418](https://github.com/STAIxBWLB/agent-hub/issues/418)).
- **Measured, not assumed.** Add-ons and memory are kept or dropped by controlled
  comparisons ([#248](https://github.com/STAIxBWLB/agent-hub/issues/248),
  [#258](https://github.com/STAIxBWLB/agent-hub/issues/258)).

Live checks that still need a real account or a person are listed in the
[release verification report](docs/verification/2026-10-29-0.21.0.md) and the
[smoke checklist](docs/smoke.md).

## Documentation

| Read | For |
| --- | --- |
| [Quickstart](docs/quickstart.md) | install, the first session, a working day, upgrade notes |
| [Operations guide](docs/operations.md) | console, task flow, Pi and models, dashboard, projects, upgrade and recovery |
| [Hub memory](docs/memory.md) | how memory is stored, shared and recalled |
| [Security notes](docs/security.md) | what the hub defends and what it does not |
| [Design spec](docs/specs/2026-09-19-agent-hub-design.md) | how it is built and why |
| [Smoke checklist](docs/smoke.md) | what has been verified against real agents |
| [Changelog](CHANGELOG.md), [Contributing](CONTRIBUTING.md) | releases and how to contribute |

Coding agents that work on this repository follow [`AGENTS.md`](AGENTS.md) and
[`docs/agent-notes/`](docs/agent-notes/).

## Origin

The first idea came from [agent-bridge](https://github.com/raysonmeng/agent-bridge),
which lets Claude Code and Codex talk to each other. agent-hub has since grown into a
different system with its own goals and shares no code with it.

## License

MIT
