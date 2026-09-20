# Changelog

## 0.7.0

- Persist queued deliveries and expose uncertain handoffs for explicit operator reconciliation (#46).
- Show disconnected recipients, important pending counts and work needing review in CLI and dashboard; add console queue inspection and resolution (#46).
- Separate adapter acceptance from execution completion, use protocol 10 receipts, and support controlled protocol 9 to 10 upgrades (#46).
- Add an English daily operations and recovery guide with measured evidence and explicit operational limits (#46).

## 0.6.4

- Refuse accidental CLI flags in `say` and `remember`, while preserving message text around the `--` separator (#40, #44).
- Show important queued message counts and keep persisted status current after enqueue, delivery and withdrawal (#41, #44).
- Avoid a transient offline event during Pi handover, while reporting failed replacement accurately (#42, #44).
- Share no-acknowledgement and message-priority marker instructions across peers (#43, #44).

## 0.6.3

- The dashboard follows the system light/dark scheme with two tuned palettes, adds relative timestamps, kind filters for the message stream, a state filter for the task list and colored usage bars for budgets (#38).

## 0.6.2

- Address a peer's reply at whoever asked instead of broadcasting it, so one directed question no longer costs every attached peer a turn (#29).
- Cap the priority a hub-native peer claims for itself: `[IMPORTANT]` on an unsolicited report no longer interrupts the other peers (#29).
- A session whose peer id was taken over stands by and reclaims it once the hub reports the peer offline, instead of staying detached until the whole session is restarted (#30).
- Show the command a Kimi tool call will run in its approval prompt, taken from the `tool_call` update when the permission request omits it; a prompt whose payload cannot be resolved says so and offers no session-wide grant (#31).
- `ahub status` prints a namespaced backend alias once (`dgx/coding`, not `dgx/dgx/coding`) and names the backend Pi asked for on its last turn (#32).

## 0.6.1

- Preserve Pi session identity when handing an empty native session between headless and TUI modes (#27).
- Keep recovery metadata and native terminal restoration bound to the verified project session.

## 0.6.0

- Pi peer with managed local model routing, RPC and native terminal integration (#25).
- Authenticated inference relay for DGX coding/fast aliases and loopback MLX Qwen3 8B inference on Apple Silicon.
- Pi-first task routing with per-class backend selection; PII tasks remain restricted to the existing local worker.
- Hub-approved file and shell tools with persistent session/tool-call receipts to prevent duplicate effects.
- Protocol 9 and Pi session metadata for controlled recovery from protocol 8.

## 0.5.0

- Controlled protocol-8 restart with private queue/session snapshots, manual-pause preservation, instance fencing and verified release (#21).
- Exact-version upgrade planning, immutable package staging, detached resumable operation receipts and machine lifecycle locking.
- Orca-first native terminal recovery: original Codex/Claude conversations, new Kimi/local sessions with task context, and explicit manual blockers for unsupported sessions.
- Running projects transition sequentially; the shared Claude plugin and Claude sessions have a final common phase. Global CLI promotion follows verification.
- Protocols 5–7 require a manual bootstrap using their matching CLI. No automatic legacy shutdown, uncertain side-effect replay or rollback.

## 0.4.1 (included in 0.5.0)

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
