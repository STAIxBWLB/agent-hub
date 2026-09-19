# agent-hub

Native multi-agent hub for one developer's machine: Claude Code, Codex, Kimi Code and a
hub-owned local-LLM worker collaborate as peers in one project directory, with
task-aware model routing (Switchyard) in front of a self-hosted gateway (OmniRoute).

Status: M1 (messaging core and the Claude, Codex and Kimi adapters), M2 (priority tiers,
digests, Codex steer, queue bounds, session-start recall) M3 (the hub-native `local` worker on
self-hosted models, OmniRoute client, Switchyard sidecar, claude-mem capture) and M4 (task board,
role contracts, routing policy with an enforced on-prem path for PII, review handoff and
escalation, task briefs and shared notes) and M5 (budget relay: quota sources, checkpoint then pause, handoff to `local` first, resume on
reset) are implemented; internal inference and packaging (M6) are not. Design spec and milestone
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
hub local         # hub-native worker on the self-hosted models (needs an OmniRoute key, see docs/smoke.md)
hub tail          # watch the conversation; `hub say [@peer] <text>` to join it
hub doctor        # what is installed, running and captured
```

Unmarked agent messages are batched into digests (3 messages or 15 s) so a busy conversation does
not cost one turn per message; `[IMPORTANT]` goes out at once and steers a running Codex turn,
`[FYI]` is recorded only. `hub say` is immediate. `hub pause <peer>` / `hub resume <peer>` hold and
release a peer's queue. On its first delivery each peer also gets a capped block of recent
claude-mem context from the other agents' sessions.

Work is divided on a task board: `hub task propose <class> <title>` (or an agent's
`hub_task_propose`) routes a task by `routing.toml` to an owner and a reviewer, `hub board` shows
who has what, `hub route explain` says why. A task that matches a PII pattern goes to `local` only
and its text appears nowhere but `hub task show <id>`.

When a subscription peer nears its quota (Codex rate limits, Claude's status line numbers, or
`hub budget set`), the hub asks it for a checkpoint, pauses it, hands its open tasks to `local`
first, and resumes it when the window resets. `hub budget` shows the windows and who is paused.

`local` works only inside the project: secrets are unreadable, edits and commands wait for
`hub permit`, and everything it executes is sandboxed (no writes outside the project, no
credential reads, no network). Its model calls go through Switchyard when `switchyard-server` is
installed and straight to OmniRoute's `fixed_model` when it is not.

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
