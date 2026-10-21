# agent-hub

A hub on one developer's machine where coding agents work as a team: Claude Code,
Codex, Kimi Code, Pi and a hub-owned local worker (Qwen Code, Jcode and Antigravity
optional) share a message bus and a task board per project and one memory on the
machine, each attached through its own native interface.

Status: 0.12.43, control protocol 16. Bun + TypeScript, one loopback daemon per
project. Site: [agent-hub.staix.net](https://agent-hub.staix.net).

## What it does today

- **Peers, not a pipeline.** Every agent can message the others, and the hub
  delivers to each through its native surface (Claude channel plugin, Codex
  app-server, ACP, Pi RPC or TUI). Messages are batched into digests, priorities
  decide what interrupts a turn, and delivery is durable across restarts.
- **A shared task board.** Tasks are proposed, accepted, done and reviewed through
  hub tools. `routing.toml` assigns owners by task class, roles split planning,
  implementation and review, and a designated planner can be changed live.
  Cause-deduplicated stalls and unread pull-only offers need attention; cancellation
  closes work without approving it or releasing its dependents. Owners of
  overlapping work in the same repository are told what changed.
- **Shared memory.** Decisions, contracts, fails and findings go to the hub's own
  store through the exact-pinned first-party `@staix/agent-mem` library (short-
  and long-term tiers, a typed graph, git sync between machines),
  next to optional claude-mem capture. Entries belong to their project unless
  saved as shared, which makes them readable from every project on the machine.
  Agents get memory as a recall preface, as briefs on a task, and through bounded
  `hub_memory_search`, `hub_memory_show` and `hub_memory_graph` tools. Agents
  can propose corrections; candidates stay outside evidence until a person acts.
- **Local and remote models.** Pi and the local worker run on DGX or local MLX
  through an authenticated relay; in-process hub routes select models by task
  through a self-hosted OmniRoute gateway. Tasks flagged as PII stay on the on-prem
  worker.
- **Guard rails.** The local worker and Pi run in a sandbox, and by default their
  writes and shell commands wait for the person's approval; a permission mode
  the person picks (`ask-when-needed`, `never-ask`) skips some or all prompts.
  Budgets pause a peer before it runs out of quota, and recovery never replays
  an effect whose outcome is unknown.
- **Operations.** A terminal console and a local dashboard, one hub per
  repository or worktree with a machine-wide view, and `ahub upgrade` that carries
  running sessions across versions. Settings reload without a restart where their
  apply class allows; guarded values wait for a person's confirmed
  `ahub settings reload` in a terminal. The console supports revision-checked task
  assignment/unassignment, delivery-queue resolution and per-peer planner WIP limits. Peers with independent
  tool turns can request one uncertain redelivery; the delivery-only local worker
  and headless ACP peers leave held deliveries for the person to resolve.

## Where it is going

- **Curated memory** ([#412](https://github.com/STAIxBWLB/agent-hub/issues/412)).
  The memory core now lives in [agent-mem](https://github.com/STAIxBWLB/agent-mem)
  (`@staix/agent-mem`, with the `amem` CLI), which agent-hub uses as its one
  exact-pinned first-party dependency. Next, memory becomes curated rather than
  captured: compression, removal, correction
  and failure-driven management, each shipped only after its contract and a
  measurement.
- **Every peer able to do its share** ([#418](https://github.com/STAIxBWLB/agent-hub/issues/418)).
  Bounded task-spec reads and opt-in isolated checks are implemented. Installed
  managed-Pi verification (AC8) remains open; source and CI results do not certify
  that live runtime.
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

After upgrading from 0.12.30 or earlier, run `ahub jcode --mode headless` once in each
project that uses Jcode to refresh its owned MCP entry before conductor or dashboard
starts of Jcode. The entry's format is unchanged in 0.12.37; a daemon start that still
reports the entry missing or stale is fixed by the same command, which since 0.12.36
writes the running hub's own plugin bundle (#502). Since 0.12.37 the hub accepts jcode
0.98.0 or later, below 1.0.0, and no longer 0.94.0 (#529).
Since 0.12.39 `ahub jcode` opens Jcode's native TUI on the hub-owned ACP session by
default (#464); `--mode headless` or `ahub settings set peers.jcode.start_mode headless`
keeps headless startup. On 0.12.39 the TUI launcher stopped after the first hub turn;
0.12.40 opens it again (#564). On 0.12.40 `ahub codex` in a recorded Orca terminal
failed with `invalid remote address`; 0.12.41 starts it again (#586). Since 0.12.42
`ahub agy` accepts the Antigravity CLI 1.4.x line (1.4.2 verified; other patches warn),
because agy updates itself and 0.12.41 refused 1.4.3 (#589). Since 0.12.43 agy's native reads are recorded as peer facts on 1.4.2 and 1.4.3 (#555); 1.4.3 stays unverified, and in its TUI the hub tools appear from the second turn (#267).
Cancellation needs a daemon advertising `task_cancel`; controlled downgrades
refuse while cancelled rows exist. Live-test delegated CLI commands need a daemon
advertising `cli_audit_delegated` and refuse with an upgrade remedy otherwise
(#410). For local/Pi implementation, opt in to an available
`checks.runner = "container"`; issue-backed owners also need authenticated
spec access. PII work and designated reviewers retain their separate exemptions.
See [release verification](docs/verification/2026-10-21-0.12.43.md) for the live legs
still open, including #418 AC8, #438 AC7, the native console settings leg (#439 AC5),
real upgrades with reattach (#463) and with a managed terminal and cancelled tasks
(#478), a live headless Claude review (#223), a Claude session over 32 MiB (#517), a
live fresh Codex review (#519), a live split of a real memory home (#536), the live
agy TUI/account leg (#485, hub task #251), Kimi's interactive-TUI coexistence and
usage checks (#533), Jcode's TUI with a personal account, a real provider and hub-tool
calls (#464), a live Jcode tool call held past the inactivity watchdog (#542), a live
steer of a busy Jcode turn (#572) and a real upgrade that exercises the terminal owner
record (#482).

Before migrating a memory home with `amem`, upgrade every hub using that home to
0.12.30 or later, check `ahub memory profile-check`, then quiesce and close all memory
consumers. Shared v1 remains the default; installing this release does not migrate
data. The curated shard migration (`amem migrate --shards`, agent-mem 0.4.0) needs
every hub using that home to run 0.12.37 or later, which opens memory through shards
(#534). An older hub (0.12.36 or earlier, agent-mem 0.3.1) does not detect the
split: it keeps reading and writing the old layout, and its writes reach the shards
only through `amem migrate --shards --resume`. Upgrade or stop every such hub before
splitting. `ahub memory profile-check` is split-aware (#536). See [memory profiles and rollout](docs/memory.md#selected-memory-profile).

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
