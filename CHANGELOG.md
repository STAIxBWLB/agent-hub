# Changelog

## 0.5.0 (unreleased)

- Controlled protocol-8 restart with private queue/session snapshots, manual-pause preservation, instance fencing and verified release (#21).
- Exact-version upgrade planning, immutable package staging, detached resumable operation receipts and machine lifecycle locking.
- Orca-first native terminal recovery: original Codex/Claude conversations, new Kimi/local sessions with task context, and explicit manual blockers for unsupported sessions.
- Running projects transition sequentially; the shared Claude plugin and Claude sessions have a final common phase. Global CLI promotion follows verification.
- Protocols 5–7 require a manual bootstrap using their matching CLI. No automatic legacy shutdown, uncertain side-effect replay or rollback.

## 0.4.1

- Synchronize the daemon digest integration fixture without changing batching semantics or weakening digest/FYI assertions (#15).
- Reconcile completed live smoke and npm publication evidence; infrastructure-dependent checks remain tracked in #12.

## 0.4.0

- Independent repository and worktree hubs with canonical project selection, `--project <path|id>`, `projects`, and `status --all` (#19).
- Transactional machine-wide project/port registration, concurrent startup claims, authenticated instance checks and owned shutdown; legacy port allocations are imported without resetting them.
- `ahub ui --all` opens a separate local manager for project selection, hub start/stop and existing dashboard actions. `ahub ui --all --stop` leaves project hubs running.
- Native memory aliases stay compatible with claude-mem, including worktree parent/composite names. Shared aliases are indicated in the manager.
- A second Codex TUI cannot take over an existing hub connection. Owned child shutdown is awaited before runtime ownership is released.
- Control protocol 7: stop old hubs with their matching CLI before upgrading; refresh the channel bundle with `ahub setup`, then restart hubs and agent sessions. No automatic restarts or account configuration changes.

## 0.3.2

- The channel plugin no longer fights a second session attached as the same peer: the replaced one stays detached and its tools say so, instead of taking the peer back every second (#16).
- The plugin MCP server exits when its host goes away, and stops retrying a hub that refused it (wire version, token, peer id), reporting the hub's reason (#17).
- After upgrading, run `ahub setup` to refresh the Claude plugin and restart agent sessions; stale `server.js` processes from earlier versions have to be ended by hand once.

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
