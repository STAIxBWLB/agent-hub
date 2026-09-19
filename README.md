# agent-hub

Native multi-agent hub for one developer's machine: Claude Code, Codex, Kimi Code and a
hub-owned local-LLM worker collaborate as peers in one project directory, with
task-aware model routing (Switchyard) in front of a self-hosted gateway (OmniRoute).

Status: M1 (messaging core and the Claude, Codex and Kimi adapters) is implemented; the local
worker, routing, task board and budget relay (M2 to M6) are not. Design spec and milestone
checklist: [`docs/specs/2026-09-19-agent-hub-design.md`](docs/specs/2026-09-19-agent-hub-design.md).

## Quickstart

```bash
bun install && bun link                      # `hub` on PATH
claude plugin marketplace add "$(pwd)" && claude plugin install agent-hub@agent-hub

cd <your project>
hub init          # .agenthub/config.json + marker blocks in CLAUDE.md and AGENTS.md
hub up            # daemon for this directory (loopback only)
hub kimi          # Kimi headless under ACP
hub codex         # Codex TUI attached through the hub proxy
hub claude        # Claude Code with the hub channel
hub tail          # watch the conversation; `hub say [@peer] <text>` to join it
hub doctor        # what is installed, running and captured
```

Permission prompts stay on by default. `--unattended` turns them off and says so.
Live verification steps and their results: [`docs/smoke.md`](docs/smoke.md).

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
