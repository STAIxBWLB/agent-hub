# Changelog

Issue and pull request numbers in the entries for 0.7.7 and earlier refer to the previous repository, archived on 2026-09-30 when this repository's history was rewritten; the one exception is the open smoke-check issue, formerly #12, which moved here as #1. Numbers in newer entries refer to this repository.

## Unreleased

- Task operations settle model-written arguments before anything reaches the board: an `owner` or `peer` that is not a peer id, or a task id that is not a whole number, is refused with a clear message instead of leaving an ownerless task behind after a database error; `null` and an empty owner mean no owner (#70).
- Review outcomes are credited to the work they judged in more cases: task paths are stored in one spelling (`./src/a.ts` and `src/a.ts` are one file for blame, and `.` blames nobody), and handing a task to the owner it already has keeps an earlier catch; ownership events now record the owner in the task history (#67).
- After a crash, `pi.auto_start` brings Pi back on its recorded headless session, with or without `recovery.auto_resume_after_crash`, and on a fresh session if that resume fails; before, a fresh Pi started and the recorded session could not be resumed while it ran (#66).

## 0.10.0

- Review checklists and review outcomes: review requests ask the reviewer to map signatures and call sites to the plan, read the check result and list unmet items (`hub_review {unmet}`); the hub records approved, caught, contradicted and escalated reviews per implementer, reviewer and class, shown by `ahub task show` and `ahub route explain`, and `review.adaptive` (off by default) orders reviewers by that record, after idle before busy and ahead of quota. A record counts tasks, a catch belongs to the owner whose work was caught, and only a failure on the same file or symbol contradicts an approval (#35).
- Recovery after an unplanned stop: the hub keeps each attached peer's session identity while it runs; a hub started after a crash reports what happened to each peer in `ahub status`, resumes Kimi (ACP `session/load`), a headless Pi and the local worker (on its recorded route) when `recovery.auto_resume_after_crash` is on, and gives each peer a notice of its deliveries left in `needs_review` with its next delivery. A stop someone asked for, even one past the shutdown deadline, is not taken for a crash (#37).
- The local worker's sandbox starts from deny default: commands may run and read the system, toolchain and project directories (and the selected Xcode or Command Line Tools dir) and write the project and temp, nothing else; `/Applications`, `/nix`, `/Volumes` and `/Users/Shared` now need `local.read_allow`; `local.sandbox: "allow-default"` (machine-local) keeps the profile of 0.9 and earlier for one release; with network on, the public CA bundles stay readable for TLS. Per-peer `capabilities` (`propose`, `assign`, `remember`, `important`) are enforced by the daemon, a malformed entry grants nothing and every refusal is logged, under deny-default the worker's commands can no longer reach the LaunchServices, CoreServices or SecurityServer brokers, and a test pins that a peer can never answer a permission request (#39).

## 0.9.0

- Early conflict detection: in a git work tree, a turn that changes a file another owner's open task changed earlier warns both owners (and the console, and `events.jsonl`), once per file and task, marked concurrent when another peer worked meanwhile. `ahub check-path` and the PreToolUse hook template `templates/claude-hooks.json` give Claude the same warning before an edit, without blocking it (#32).
- Task dependencies: `hub_task_propose` takes `after: [ids]`; a task waits, offered to nobody and not claimable, until those are approved, then goes through assignment (a task the hub stopped before offering is offered once it runs again). `hub_task_list {ready: true}` and `ahub board --ready` show the ready queue, and existing boards gain the column on open (#34).
- Quota-aware routing: candidates with quota readings are ordered by headroom per hour to their reset, so the window that resets first is drained first; a paused peer whose window resets within `budget.wait_max_min` (30 with a project config) keeps its work unless a task is `urgent`; and a peer whose recent failures in a class outweigh its approvals there is demoted for that class, with a one-day half-life. `ahub route explain` shows both, and `ahub task propose ... --urgent` marks a task urgent (#36).
- Per-sender limits on what agents send: token buckets per sender, per recipient and for `[IMPORTANT]`, plus dropping the same text to the same recipients, answering the same message, within a window. A refused `hub_send` answers with the reason and the seconds to wait; a turn answer over the important budget goes out as status, and one over a rate limit is dropped, the agent hearing why with its next delivery. `[FYI]` and the console user are never limited (#38).
- An upgrade or controlled restart from a 0.9.0 or later source waits for completion checks and console task operations still in flight; one that finished after the commit used to leave the operation blocked at verification, unable to resume or abort. A 0.8.x or older source cannot report them: wait for its checks by hand before upgrading (see the operations guide) (#50).
- Upgrading a running 0.7.x or 0.8.x hub with tasks on its board verifies the board although 0.9.0 adds the `deps` column, like 0.8.1 did for `plan` (#50).
- Turn snapshots no longer miss an edit that keeps a file's size and lands in the second git last wrote the index: the snapshot's copy of the index now keeps the original's time, which git's racy-entry check compares against in whole seconds. A missed edit could leave a file out of `ahub undo`, let undo restore over another agent's later change, or skip an early conflict warning (#60).

## 0.8.1

- Upgrading a running 0.7.x hub that has a task on its board no longer stops at verification ("queue, manual pause, task board or budget preservation was not verified"): the 0.8.0 target digested its tasks with the new `plan` field, which the 0.7.x source never had. The target now also accepts the digest in the source's shape while every plan is empty; any real change to the board still fails the check. Use the 0.8.1 coordinator, not 0.8.0's, for such an upgrade (#57).
- `ahub kill` returns only once the hub has released its registry claim, so an `ahub projects remove` right after it no longer refuses, and an `ahub up` right after it no longer reads the project as starting and starts nothing (#58).

## 0.8.0

- Plans and completed-change notices: `hub_task_propose` and `hub_task_accept` take a `plan` (paths, symbols, signatures, insertion points), overlaps also count plan paths and shared symbols, the owners of overlapping tasks get the plan as a ride-along line, and when a task is done they get a notice of the changed files, signatures and summary. PII tasks are left out on both sides, and a plan matching a PII pattern makes a new task a PII task or is refused on an ordinary one. Overlap mentions, ride-alongs, completed-change notices and overlap events leave out any name that matches a PII pattern, and model-written titles, refs and plan items are folded onto one line. During a PII turn the local worker can no longer finish, review or accept-with-plan an ordinary task, which would carry its words to other peers and claude-mem (#31).
- Per-turn snapshots and undo: in a git work tree, with `snapshots.enabled`, which is on in any project with an `.agenthub/config.json`, existing ones included (off without a config file; `"snapshots": { "enabled": false }` opts out), the hub snapshots the files at each turn boundary, `ahub turns` lists the files each turn changed (shell-made changes included), and `ahub undo <turn> --yes` restores them; it restores nothing when a file changed again since, or when another peer's turn at the same time touched it or left its changes unknown. `--context` also asks Codex to drop the turn from its thread's saved history; whether a running Codex session forgets it too is still to be checked live (#33).
- Structured telemetry: the hub writes `events.jsonl` (envelopes without bodies, peer states, turns with per-turn tokens for Kimi and Codex, board changes, overlaps, quota readings), and `ahub export` and `ahub report` read it (#40).

## 0.7.11

- A project whose path contains a backslash works with the local worker and Pi again: Bun 1.3.14's `realpathSync` throws for such paths, so the sandbox profile, the file tools' path guard and the Pi resume check now resolve paths through `realPath`, which then asks the system `realpath`; it returns each name as stored on disk, so another spelling of `.git/config` or `.env` is still refused (#26).

## 0.7.10

- A `local.deny` entry, or a project path, containing `"` no longer breaks the local worker's sandbox profile (its bash and git tools stopped with a parse error); the deny rules are written as plain SBPL strings, which can hold a quote (#23).

## 0.7.9

- A committed `.agenthub/config.json` can no longer choose what the hub runs, which files it sends as credentials, where task text goes, or how far the local worker's sandbox reaches: those machine-local fields (launch commands, checks, the legacy MLX binary and model directory, gateway URLs and key files, the memory endpoint, sandbox widening) apply only from a file git confirms nobody committed, such as the new `.agenthub/config.local.json`, and are otherwise ignored with a log line and a doctor row. A tracked file is recognised by identity, which also closes a way past the 0.7.8 completion-check gate: a committed file under a spelling macOS opens as `config.json` but git does not match (such as `ſ` for `s`) counted as uncommitted (#17).

## 0.7.8

- README, the operations guide and the upgrade-recovery spec no longer describe protocol 10 and the queue commands as unreleased (#9).
- Codex answers a digest to every sender in it, and a sender steered into its turn, like the other adapters; an answer to a condensed digest no longer goes to the reserved `digest` sender and reaches no peer, also when a steer joined the turn (the bus now maps `digest` for any adapter). A TUI that detaches mid-turn and comes back no longer answers the old turn's senders (#3).
- A waiting approval raises a macOS notification naming the peer and, for Kimi, the tool (never the payload); the approval timeout is configurable as `approvals.timeout_s`, and an unanswered request leaves a console and log line (#5).
- Claims: a self-claim without a class is filed as `implement` when no model can name one; the earlier owner of an overlapping task hears of it with its next message; an owner offline past `tasks.release_after_min` (default 30) loses its open tasks to a peer that can take them (#6).
- A class can carry a completion check (`checks.<class>` in a `.agenthub/config.json` git confirms nobody committed; outside a repository none runs): marking such a task done runs it, sends the task to review with the result on success, and keeps it with its owner with the failure otherwise. A hub stop interrupts a check without a verdict (#7).
- `scripts/overlaps.ts` counts the claim overlap warnings in hub logs per week and names the task pairs, for the two-week measurement that decides whether per-task worktrees are built. The procedure and the numbers go in `docs/smoke.md` (#8).
- Releases publish to npm through trusted publishing (OIDC) instead of a stored token, and the workflows use the Node 24 releases of `actions/checkout` and `actions/setup-node` (#4).

## 0.7.7

- `ahub setup` without a terminal and without `--yes` prints the step it would take and exits non-zero instead of waiting forever at its prompt, as `restart` and `upgrade` already did. A piped answer (`yes | ahub setup`) is no longer read: use `--yes` (#73).
- The smoke ledger no longer names the internal gateway's address, and the package check fails when any published file contains a private IPv4 address, naming only the file and line (#74).
- Kimi's requests for the hub's own tools (`hub_send`, the task tools) are approved once without a console prompt, as Codex's already were, so a Kimi nobody watches can claim work and record notes. Kimi 2.1.1 approval prompts for other tools show the command again: the payload falls back to the streamed argument JSON when the request carries none. A payload too long to show whole is marked as cut and no longer offers a session-wide grant, for every ACP agent (#72).
- The operations guide's upgrade section names each supported source range (0.6.x, 0.7.x before the target) and the unsupported one (0.5.x and earlier): run the target release's coordinator through `bunx`. Dry-runs from running 0.6.4 and 0.7.5 hubs are recorded (#75).

## 0.7.6

- Shared notes reach the agents working now: `hub_remember` has a `fail` kind for approaches that do not work, and every saved note rides on the other peers' next delivery (newest 10, one line each) instead of waiting for their next session. A note that matches a PII pattern is refused. A preface returned by a failed delivery no longer overwrites one created meanwhile (#68).
- Claims: `hub_task_propose` naming the caller as owner starts the task in progress without an offer back to the caller, and overlapping `refs.paths` with another owner's open task are named in the propose result, the offer and the console. Implementers are told to claim unassigned work and to report the check they ran in `hub_task_done` (#68).

## 0.7.5

- A zero-turn Claude session no longer wedges an upgrade after restore either: the commit snapshot records whether the session ever persisted a transcript, coordinator verification re-derives persistence from the terminal binding exactly like the restore gate did, and daemon readiness tolerates a fresh session while the original transcript is absent (snapshots from older sources are re-derived from disk). A session with a transcript keeps the strict identity check in all three places. The status line tee now records the transcript path Claude reports (#64).

## 0.7.4

- A Claude session that never persisted a transcript (zero turns) no longer wedges an upgrade at restore: when the original transcript is absent, the coordinator accepts the fresh session the operator attached, because nothing was preserved and nothing is lost. Sessions with a transcript keep the strict identity check; Codex stays strict in all cases (#21).

## 0.7.3

- A peer that detaches mid-upgrade no longer wedges the recovery: readiness ignores a now-offline peer's stale identity (a reattach with a different thread still blocks), an already-exited terminal is closed as a no-op instead of being waited on, and resume can drive the operation to release once the peer returns (#21).
- The check.sh leak guard matches tmp test roots only, so a real hub in a directory starting with `ahub-` no longer trips it (#56).

## 0.7.2

- Local inference defaults to a bounded Ollama MLX runtime: `ahub models setup/start/stop` manages it, the configured context is advertised to Pi, and the legacy standalone MLX runtime needs an explicit legacy provider (#51, #52).
- `ahub init` writes the managed block to `AGENTS.md` only and never creates `CLAUDE.md`: any `CLAUDE.md` stops Claude Code from loading `AGENTS.md`. A block an older `init` left in `CLAUDE.md` is removed, and a `CLAUDE.md` that held nothing else is deleted; a symlinked or hard-linked `CLAUDE.md` is left alone. The one template now tells every agent how it receives and answers hub messages (#54).
- Stop orphaned hub daemons from leaking and spinning: a rejected peer stop no longer blocks shutdown, a 15 s hard deadline ends a hung stop, the recovery fence waits with backoff and a timeout instead of spinning, and a daemon or manager whose project root or state dir vanished stops itself. A surviving Pi TUI owner is torn down by verified process identity before the hub reports stopped (#56).
- `ahub doctor --orphans [--kill]` lists registrations whose project root is gone and kills only processes whose argv names that project's hub daemon exactly (#56).
- A recovery commit no longer blocks when its stop-poll lands in the moment a stopping hub already refuses connections but has not removed its manifest yet: the inspection reports "unavailable" and the poll retries instead of failing the operation (#21).
- The test suite records and sweeps every hub and manager pid it starts, and `scripts/check.sh` fails the gate on any leaked `ahub-*` test daemon (#56).

## 0.7.1

- Restore native sessions while unrelated agents remain in the same worktree; the coordinator continues to fence uncertain terminal creations (#48).
- Allow a bounded inventory refresh after closing the captured terminal before reporting uncertain shutdown (#48).

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
- Reconcile completed live smoke and npm publication evidence; infrastructure-dependent checks remain tracked in #1 (formerly #12).

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
