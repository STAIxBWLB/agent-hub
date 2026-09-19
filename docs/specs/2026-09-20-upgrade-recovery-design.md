# Controlled upgrade and session recovery

Status: Implementation on `feat/upgrade-recovery`, issue #21
Date: 2026-09-20

## Problem and decisions

Version 0.4.0 added project isolation but upgrading still required a separate
restart script. Queued messages and manual pauses lived only in memory, and
native terminal identity was not recorded. A successful package installation
therefore did not prove that conversations or pending work survived.

Protocol 8 adds a controlled-restart contract. Package installation, daemon
readiness, native conversation recovery and queue release are separately
verified. Existing protocols 5–7 require a manual maintenance bootstrap with
their matching CLI; the new coordinator never guesses a PID to terminate.

## Commands

- `ahub upgrade --to <exact-version> --dry-run`: inspect the running registered
  projects, release identity, native session mappings and blockers.
- `ahub upgrade --to <exact-version> [--yes]`: review the plan, revalidate it and
  schedule an independent recovery process. `--yes` accepts the displayed scope;
  it never overrides blockers.
- `ahub --project <path|id> restart [--dry-run] [--yes]`: recover one project using
  the current package, without changing the global installation or plugin.
- `ahub recovery status|resume <operation-id>`: read redacted progress or resume
  the recorded operation after checking live ownership.
- `ahub recovery abort <operation-id>`: cancel a preflight and release its lock
  only before a runtime has stopped or a terminal mutation has been attempted.

Upgrade uses all affected running registrations. Stopped projects stay stopped.
An incompatible or unavailable active registration blocks apply. No global
installation, plugin changes, runtime shutdown or terminal mutation occurs in
dry-run. No lifecycle mutation is retried solely because a subprocess exited.

## Runtime and coordinator

The daemon exposes console-only `recovery` RPCs: inspect, prepare, commit, abort
and release. Mutations are pinned to the expected instance and operation. Prepare
holds deliveries while current turns and approvals finish. A ten-minute source
preparation timeout aborts the hold without stopping the source. The replacement
remains held until explicit verified release.

Commit writes a private, atomic project snapshot of queued envelopes, IDs,
parents/hops, retries, dedupe state, prefaces, manual pauses and peer descriptors.
The existing task and budget databases remain authoritative. A mismatched or
corrupt snapshot blocks startup. Snapshot restoration precedes peer attachment;
release is idempotent and retires replayable snapshot state before delivery.
Release atomically moves that snapshot to a private per-operation archive before
lifting the hold. Archives retain evidence for an uncertain release and are never
automatically replayed. Preparation freezes the peer roster; a new unplanned peer
cannot attach until recovery ends.

The coordinator has an exclusive machine operation lock and an exclusive runner
claim. Lifecycle commands and the manager respect that lock. Package versions
are staged in a retained directory, with exact registry integrity and local
runtime digest checks. The coordinator runs from a preserved source tree so
replacing the global executable cannot kill its own recovery logic.

Projects transition sequentially. Source terminal ownership and idle state are
verified before closing only the captured terminals. New daemons restore with
delivery held, then Codex and hub-owned workers reconnect. The shared Claude
plugin is installed in a final common phase, followed by the original Claude
sessions. Verified projects release queues; the global CLI is promoted last.
There is no automatic rollback of projects that have resumed work.

An interrupted operation re-reads actual daemon identity, package digests,
terminal mappings and phase receipts. Lost commit/start replies can be reconciled.
Mutable receipts are reloaded under the exclusive runner claim, and saved terminal
bindings are checked again before release. An ordinary startup ignores a completed
operation ID inherited from a restored agent session.
An uncertain terminal creation is not repeated: the original session must be
found and verified, or the operation stays blocked for manual recovery.

## Native session boundaries

- Codex resumes the exact captured thread, with authenticated adapter readback.
- Claude resumes the captured session after the shared plugin transition.
- Kimi/local start new sessions using preserved routing selection and task context.
- Orca terminal bindings use exact project, worktree, handle and incarnation.
  Newly launched `ahub codex`/`ahub claude` wrappers record private ownership
  metadata when Orca omits session identity. Only account-home references are
  retained from their launch environment; credentials and arbitrary environment
  values are excluded.
- Other terminals or unverifiable bindings are `manual-required`. No terminal
  title, generic process-name match or shell-input guess authorizes a restart.

The initial coordinator supports protocol 8 source and target packages. A target
with another control protocol requires a compatible coordinator and is rejected
before shutdown. Fully general crash recovery and exactly-once external tool
effects are not claimed.

## Verification and release

Test two-project ordering, queue and pause preservation, active turns/approvals,
changed identities, stale terminal handles, PID reuse, interrupted steps,
uncertain subprocess outcomes, corrupt snapshots and post-release normal use.
Run `scripts/check.sh` on macOS and Ubuntu. Fake services and isolated detached
CLI tests are distinct from an attended real Orca/native-account smoke.

Protocol 5–7 bootstrap, real account smoke, production deployment and npm
publication remain explicit release activities; this implementation does not
silently restart the developer's currently running project sessions.
The bootstrap includes an incompatible dashboard manager, which must also be
stopped with its matching CLI before a protocol-8 manager is launched.
