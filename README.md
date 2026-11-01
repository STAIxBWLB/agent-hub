# agent-hub

A hub on your own machine where coding agents work together as one team. Claude
Code, Codex, Kimi Code, Pi and a hub-owned local worker (plus Qwen Code, Jcode and
Antigravity if you want them) share a message bus, a task board and a memory, each
connected through its own native interface.

Status: 0.26.0, control protocol 17 (accepts 16). Bun + TypeScript, one loopback daemon per
project. Site: [agent-hub.staix.net](https://agent-hub.staix.net).

## Quick start

You need [Bun](https://bun.sh) 1.4.2 or later on PATH.

```bash
bun add -g @staix/agent-hub && ahub setup
cd <your project> && ahub init && ahub up   # daemon, claude and codex, then the operator console
```

`ahub up` opens the default agents (claude and codex; choose them at `ahub setup`,
skip them with `--no-agents`) through `terminal.open` or Orca. Where it cannot, it
names the command; run the agents you use by hand, one terminal each, and talk to them:

```bash
ahub claude                                  # Claude Code with the hub channel
ahub codex                                   # Codex TUI, attached through the hub
ahub say "Each of you: reply with your name."
ahub ui                                      # the web dashboard
```

`ahub setup` also registers agent-hub as a plugin of the family console
([agent-console](https://github.com/STAIxBWLB/agent-console), `acon ui`): the same dashboard
appears as a panel for every registered project, and pending approvals and reviews assigned
to you reach the console inbox. The plugin is `@staix/agent-hub/ui-plugin`; it uses the
dashboard manager's own listing and forwarding, so it adds no protocol and no action.
The plugin also feeds the console's Space view (Flat, Room and 3D): agents become actors
at their desks, the task board's columns become zones, and task links and recent messages
become links. The scene carries labels and states only, never message bodies or details.

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
  optional control bands turn a breach into a backlog card. Work that belongs to
  another project running agent-hub on this machine goes onto that project's board
  with `ahub task handoff` (agents: `hub_task_handoff`), and its state changes come
  back as task messages.
- **Research campaigns.** `ahub study` keeps a multi-unit study contract as a draft
  (a planner drafts it with `hub_study_draft`); only the person approves it, which
  creates one task per unit, and `ahub study show` reads coverage per unit and
  source. A unit is covered by its owner's `hub_study_handoff` with evidence, not by
  a done task.
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
  `ahub status` names each peer where it cannot. The opt-in floor
  (`action_policy.floor`, which `ahub autonomy on` sets) lets a push of a non-default
  branch to `origin` and `gh pr create|comment|review|merge` in the project's own
  repository run without asking; force, default-branch and tag pushes and releases
  still ask. Every message records its sender's origin, and a session that is not
  the project's own peer appears as `<peer>~<origin>` with none of that peer's
  roles: sessions are distinguishable, which is provenance, not authentication.
  Budgets pause an
  agent before it runs out of quota, and recovery never replays an
  effect whose outcome is unknown.
- **Operations.** A terminal console and a local dashboard, one hub per repository or
  worktree with a machine-wide view, live settings reload, machine-local schedules
  that propose tasks by interval or by a `cron` expression in a time zone
  (`ahub schedule list`), a one-confirmation autonomy
  preset (`ahub autonomy on|off|status`), structural config
  (instances, review, lifecycle) edited with a validated diff and a backup from the
  console or a dashboard settings session, token usage and quota
  history (`ahub usage` and the dashboard's Usage view), and `ahub upgrade`, which
  carries running sessions across versions.

## Upgrading

Run `ahub upgrade` in a project while its hub is running (`--project` selects
another); other projects keep their version. Update the global CLI
(`bun add -g @staix/agent-hub@<version>`) and run `ahub setup` for the plugin
yourself. Read the notes for your version in
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
[release verification report](docs/verification/2026-11-01-0.26.0.md) and the
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
