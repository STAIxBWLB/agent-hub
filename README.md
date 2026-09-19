# agent-hub

Native multi-agent hub for one developer's machine: Claude Code, Codex, Kimi Code and a
hub-owned local-LLM worker collaborate as peers in one project directory, with
task-aware model routing (Switchyard) in front of a self-hosted gateway (OmniRoute).

Status: 0.1.0. All six milestones of the design spec are implemented; the [smoke checklist](docs/smoke.md)
says what has and has not been verified against real agents.

## Start here

Requires [Bun](https://bun.sh) >=1.3.0 on PATH; Node alone cannot run the CLI.
The npm package is `@staix/agent-hub`, under the `staix` organization.

After the first npm release:

```bash
bun add -g @staix/agent-hub && ahub setup
cd <your project> && ahub init && ahub up && ahub tail
```

Until that release, or to install a specific GitHub release:

```bash
bun add -g github:STAIxBWLB/agent-hub#v0.1.0 && ahub setup
```

The installed commands remain `ahub` and `agent-hub`.

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
| Local worker | hub-native agent loop | hub-native | hub-owned |

## Runtime

Bun + TypeScript. Single daemon per project directory, loopback only.
