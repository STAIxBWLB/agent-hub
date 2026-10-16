# agent-hub

A hub on one developer's machine where coding agents work as a team: Claude Code,
Codex, Kimi Code, Pi and a hub-owned local worker (Qwen Code and Jcode optional)
share a message bus and a task board per project and one memory on the machine,
each attached through its own native interface.

Status: 0.12.29, control protocol 16. Bun + TypeScript, one loopback daemon per
project. Site: [agent-hub.staix.net](https://agent-hub.staix.net).

## What it does today

- **Peers, not a pipeline.** Every agent can message the others, and the hub
  delivers to each through its native surface (Claude channel plugin, Codex
  app-server, ACP, Pi RPC or TUI). Messages are batched into digests, priorities
  decide what interrupts a turn, and delivery is durable across restarts.
- **A shared task board.** Tasks are proposed, accepted, done and reviewed through
  hub tools. `routing.toml` assigns owners by task class, roles split planning,
  implementation and review, and owners of overlapping work are told what
  changed.
- **Shared memory.** Decisions, contracts, fails and findings go to the hub's own
  store (short- and long-term tiers, a typed graph, git sync between machines),
  next to optional claude-mem capture. Entries belong to their project unless
  saved as shared, which makes them readable from every project on the machine.
  Agents get memory as a recall preface, as briefs on a task, and through read
  tools.
- **Local and remote models.** Pi and the local worker run on DGX or local MLX
  through an authenticated relay; Switchyard routes model calls by task in front
  of a self-hosted OmniRoute gateway. Tasks flagged as PII stay on the on-prem
  worker.
- **Guard rails.** The local worker and Pi run in a sandbox, and by default their
  writes and shell commands wait for the person's approval; a permission mode
  the person picks (`ask-when-needed`, `never-ask`) skips some or all prompts.
  Budgets pause a peer before it runs out of quota, and recovery never replays
  an effect whose outcome is unknown.
- **Operations.** A terminal console and a local dashboard, one hub per
  repository or worktree with a machine-wide view, and `ahub upgrade` that carries
  running sessions across versions.

## Where it is going

- **Memory as its own package** ([#412](https://github.com/STAIxBWLB/agent-hub/issues/412)).
  The memory core now lives in [agent-mem](https://github.com/STAIxBWLB/agent-mem)
  with the `amem` CLI; agent-hub will consume it as a library. After the split,
  memory becomes curated rather than captured: compression, removal, correction
  and failure-driven management, each shipped only after its contract and a
  measurement.
- **Every peer able to do its share** ([#418](https://github.com/STAIxBWLB/agent-hub/issues/418)).
  Sandboxed peers read a task's spec and run tests in isolated containers through
  hub-owned tools instead of declining the work.
- **Measured, not assumed.** Add-ons and memory are kept or dropped by controlled
  comparisons ([#248](https://github.com/STAIxBWLB/agent-hub/issues/248),
  [#258](https://github.com/STAIxBWLB/agent-hub/issues/258)).

## Install

Requires [Bun](https://bun.sh) 1.4.2 or later on PATH.

```bash
bun add -g @staix/agent-hub && ahub setup
cd <your project> && ahub init && ahub up
```

`ahub init --dry-run --json` shows what init would write first. While hubs run,
`ahub upgrade` moves them to the latest release.

## Documentation

- [Quickstart](docs/quickstart.md): install, the first session, a working day
- [Operations guide](docs/operations.md): console, task flow, Pi and models, dashboard, projects, upgrade and recovery
- [Hub memory](docs/memory.md) and [agent-mem](https://github.com/STAIxBWLB/agent-mem)
- [Security notes](docs/security.md): what the hub defends and what it does not
- [Design spec](docs/specs/2026-09-19-agent-hub-design.md): how it is built and why
- [Smoke checklist](docs/smoke.md): what has been verified against real agents
- [Changelog](CHANGELOG.md), [Contributing](CONTRIBUTING.md)

`AGENTS.md` and [`docs/agent-notes/`](docs/agent-notes/) hold the rules coding
agents follow when they work on this repository.

## Origin

The first idea came from [agent-bridge](https://github.com/raysonmeng/agent-bridge),
which lets Claude Code and Codex talk to each other. agent-hub has since grown
into a different system with its own goals and shares no code with it.

## License

MIT
