# agent-hub

Native multi-agent hub for one developer's machine: Claude Code, Codex, Kimi Code and a
hub-owned local-LLM worker collaborate as peers in one project directory, with
task-aware model routing (Switchyard) in front of a self-hosted gateway (OmniRoute).

Status: design. No code yet. The design spec is the issue body of the tracking issue
and is mirrored in [`docs/specs/2026-09-19-agent-hub-design.md`](docs/specs/2026-09-19-agent-hub-design.md).

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
