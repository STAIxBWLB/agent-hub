# Concurrent projects and a unified local dashboard

Status: Approved for implementation on `feat/multi-project-management`
Date: 2026-09-19

## Problem

Verified against 0.3.2: inherited `AGENTHUB_STATE_DIR` routes commands in a second
project to the first hub. The unlocked JSON port registry also loses updates:
32 parallel allocations produced two unique ports and one surviving registration.
The baseline gate passes 162 tests, but does not cover these scenarios.

## Existing assets

Each daemon already owns its bus, task database, adapters, control token and local
dashboard. Bun provides SQLite without another runtime dependency. Reuse existing
console authorization, dashboard validation and PII redaction.

## Design

### Project context

- Resolve real paths and the nearest initialized ahub directory without crossing
  the nearest Git working-tree root. Otherwise use that root or the non-Git cwd.
- Each worktree/submodule is independent. A global CLI prefix,
  `ahub --project <path|id> <command>`, selects another registered project or path.
- Only accept an inherited state directory when its recorded project matches.
  Pass the validated root and state directory to children and MCP servers.
  For initial custom-state setup, an explicit matching `AGENTHUB_PROJECT_DIR` pair
  is accepted only when no contradictory marker exists. Startup records a persistent
  project marker. Native MCP sessions stay pinned to their launcher-supplied state
  directory, while their control handshake verifies the manifest identity.
- Native memory identity remains separate: preserve native claude-mem aliases,
  including parent and parent/worktree names. Show shared-alias warnings; do not
  change global hooks or historical records.

### Registry and lifecycle

- Use `~/.agenthub/registry.db` (override root with `AGENTHUB_HOME` for tests).
  Register on init/up. Store opaque ID, canonical root, state directory, ports and
  runtime ownership. Import legacy ports.json transactionally and conservatively.
- Serialize allocation and per-project startup claims. Retain base 4600/stride 10;
  retry available ranges on startup port conflicts. Never terminate foreign listeners.
- Publish readiness only after binding. Authenticated status carries project ID,
  instance ID, version and protocol; bounded clients verify the requested identity.
- Only the owning instance removes runtime files or releases a claim. Stop waits
  for owned children; uncertain ownership and incomplete shutdown are explicit errors.
- Expose `projects`, `status --all`, and `projects remove <id>` (stopped metadata
  only). Moved roots are new registrations; never merge by basename.

### Unified dashboard

- `ui --all [--no-open]` starts a separate lazy manager, usable outside projects.
  `ui --all --stop` stops only the manager. Existing project-local ui remains.
- List roots, status, peers, queues and task counts. Selecting a project exposes
  existing stream, board, messages, approvals and budgets.
- Start/stop registered hubs; stop confirmation names the project. Native TUI
  launch remains CLI-only. Manager starts are attended and use project config and
  credential files, not another project's gateway/state/unattended environment.
- Manager uses console-only authenticated snapshot/action RPCs. Browser input
  selects registry IDs, never arbitrary filesystem paths, PIDs, ports or tokens.
  Mutations carry expected daemon instance. No automatic mutation retries.
- Scope cursors/drafts by project, discard stale responses across switches and
  restarts, and maintain bounded redacted event buffers in each daemon.
- Preserve exact Host/Origin checks, loopback-only listeners, one-time tickets,
  expiring HttpOnly sessions, CSP and terminal-only private approvals.
- Bump the control protocol and rebuild the plugin. Incompatible hubs get explicit
  upgrade/restart guidance, never automatic restart.
- One active Codex TUI per hub; reject a second attachment. Quota windows may be
  account-wide and must not be added together across projects.

## Testing and acceptance criteria

- Root discovery: nested directory/project, symlink, submodule, worktree, same
  basename, invalid target, and inherited context from another project.
- 32 simultaneous allocations retain all entries with unique ports. Concurrent
  starts of one project produce one daemon. Migration, occupied ports and startup
  recovery preserve existing data and live processes.
- Two hubs with fake native/model services isolate boards, messages, approvals,
  quota files, sidecars and shutdown. Test stale tokens, PID reuse, old protocols,
  partial startup, instance changes and owned cleanup.
- Browser: start with no hub, start two projects, switch/action/stop one and keep
  using the other. Cover late responses, identical task IDs, expired approvals,
  session expiry and PII redaction.
- Run scripts/check.sh and record real two-project smoke evidence separately.

## Delivery

Implementation issue and feature branch, spec/docs updates, independently reviewed
and verified PR. Preserve pre-existing instruction-file changes.

## Out of scope

Cross-machine task routing (broker, #446), fully isolated native memory, new runtime dependencies,
visual redesign, automatic merging and npm publication.

## Cross-project task handoff (#604, agent-hub#1030)

Same-machine cross-project routing is no longer out of scope: work that belongs to another project that runs agent-hub is registered on that project's board.

- **Target.** `project` names a project in the machine registry (its canonical root or its id). An unregistered target, the caller's own project and a target whose daemon is not running are refused, the last with the person's action (`ahub up` in that project). Nothing is queued.
- **Who and what.** The person (`ahub task handoff --project <root|id> [<class>] <title...> [--path <p>]... [--issue <n>] [--task <n>] [--detail <text>]`), or a configured planner or the conductor (`hub_task_handoff`). A feature or behavior change first needs a spec issue in the target repository, passed as `issue`; a mechanical chore goes straight to a task. The request is closed (unknown fields refused), bounded (8 KiB whole) and repository-relative for paths.
- **Transport.** The origin's daemon reads the target's control descriptor (same machine user) and sends `task_handoff` as a console-role control message with origin `{ projectId, peer, taskId? }`. The target's `Tasks` creates an ownerless proposal made by the hub, with the origin recorded in `task_handoff_origin`; its own routing and planner take it from there. The origin peer has no identity or authority in the target: it is a record, never a roster peer.
- **Follow-back.** On accepted, in review, approved, declined and cancelled the target sends `task_handoff_event`; the origin records it in `task_handoff_outbound` and delivers one `kind: task` envelope to the requesting peer (`agent-hub task 123 approved: PR #N at <sha>`: an event name, a PR number and a full head, never target text). An origin that was down asks the target for the current state of its open handoffs when it starts (`task_handoff_states`). `ahub board --handoffs` and `hub_task_handoffs` list them.
- **Privacy.** Refused during a private (PII) turn and for a `[pii]` task named with `task`; the target refuses text that matches a PII pattern or that its screen cannot clear. No memory, evidence or turn content crosses beyond the handoff fields.
- **Compatibility.** The additive daemon feature `task_handoff` (no protocol bump: a new message type is answered as unknown by an older hub, and an optional field is ignored). An older target is refused with a named "upgrade the target hub" error, and a recovery target without the label is refused while either handoff table holds a row.
