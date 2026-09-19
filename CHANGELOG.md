# Changelog

## Unreleased

- The channel plugin no longer fights a second session attached as the same peer: the replaced one stays detached and its tools say so, instead of taking the peer back every second (#16).
- The plugin MCP server exits when its host goes away, and stops retrying a hub that refused it (wire version, token, peer id), reporting the hub's reason (#17).

## 0.3.1

- Hub task, review and budget events are distinguished from reference-only presence/recall in agent instructions and rendered message kinds, including mixed Claude digests.
- Reply-parent selection retains hub workflow events and their hop count.
- After upgrading, run `ahub init` to refresh managed project instructions and `ahub setup` to refresh the Claude plugin, then restart agent sessions.

## 0.3.0

- `ahub ui`: a local dashboard for live messages, peer queues, tasks, budgets and approvals, with console messages, task proposal/assignment and peer pause/resume.
- Browser access uses a short-lived single-use link and an HttpOnly, SameSite=Strict session on a separate, lazily started loopback listener. Strict Host/Origin checks, a closed action list and a hash-based content security policy preserve the control link boundary.
- PII task paths/branches are now redacted from public task lists and private-envelope streams as well as task text. Local-worker permission details and allow decisions stay in the terminal; the dashboard can deny them.
- Control protocol 6: update the plugin with `ahub setup` and restart the daemon and connected agents together when upgrading from 0.2.0.

## 0.2.0

- npm distribution: `@staix/agent-hub`, public publishing with provenance from the tag workflow, tarball content checks, and an actionable Bun requirement when the CLI is invoked with Node or an unsupported Bun version.

- `ahub ask`: answers from the task board, shared memory and the hub log, evidence first; the answer has to cite the ids it rests on.

## 0.1.0

First public release.

- Messaging core: N-peer bus with untrusted framing, hop cap, dedupe, one queue per peer; adapters for Claude Code (channel plugin), Codex (app-server proxy) and Kimi Code (ACP).
- Coordination: `[IMPORTANT]` / `[STATUS]` / `[FYI]` tiers, digests, `turn/steer` for a busy Codex, queue bounds, pause and resume, session-start recall from claude-mem.
- `local`: a hub-native worker on a self-hosted model through an OpenAI-compatible gateway, with scoped tools, approvals and a macOS sandbox; optional Switchyard sidecar with fallback; claude-mem capture.
- Task board with role contracts, routing policy (`routing.toml`), an enforced on-prem path for PII, review handoff and escalation, task briefs and shared notes.
- Budget relay: quota sources, checkpoint then pause, handoff to `local` first, resume on reset.
- Packaging: `ahub` CLI (alias `agent-hub`) installable from GitHub, `ahub setup`, one version across CLI, plugin and MCP server, CI on Ubuntu and macOS, tagged releases.
- Internal inference (optional, fail-open): condensed status digests and task class triage.
