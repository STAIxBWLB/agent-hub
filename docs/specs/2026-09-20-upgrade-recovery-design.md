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
Budget expiry, pause and handoff transitions are held with message delivery;
in-flight budget work must settle before commit. Deferred quota readings are
evaluated after release or abort, preserving hard-limit semantics.

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
Recovery authority is removed from native agent and app-server child environments.
The reviewed fingerprint retains active-versus-offline peer membership, while
normalizing transient idle/busy/paused changes.

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

## Current 0.7.0 correction and recovery contract

Amended 2026-09-30: 0.7.0 shipped protocol 10 and the queue commands; protocol 10
went into production with 0.7.0 and was verified there with 0.7.1, where
`ahub queue list` read back live receipts ([smoke checklist](../smoke.md)). `ahub queue show` and `ahub queue resolve` are
covered by tests, not by a live run. The paragraphs below keep the pre-release
wording.

The earlier sections record the protocol-8 implementation history. The current
release is 0.6.4 with protocol 9; the next target is 0.7.0 with protocol 10.
This correction supersedes the earlier protocol-8 source/target statement for
the planned transition while retaining that historical evidence.

The 0.7.0 coordinator accepts a verified protocol-9 source and starts a
protocol-10 target. It must stage the exact package, preserve the source
coordinator, and promote the global CLI only after the target has passed its
readback. The transition is sequential per project and uses native managed
launchers. Claude requires manual confirmation of the captured session before
resume; the coordinator must never create a second Claude terminal when
ownership is uncertain. Kimi and local-worker sessions may start fresh with
preserved routing and task context. hwp-cli is outside this transition.

Protocol 10 adds durable delivery receipts with the states
`queued`, `dispatching`, `accepted`, `completed`, `needs_review`, `failed`,
and `discarded`. An accepted bridge handoff is not task completion. An
unsettled `dispatching` or `accepted` record after an unplanned stop becomes
`needs_review`; timeout, disconnect, cancellation, and partial effects are
uncertain and are never replayed automatically. Queue resolution records the
observed revision and operator reason. A retry closes the old record and makes
one linked attempt; stale or conflicting resolutions fail.

The target console commands are `ahub queue list [--peer <id>] [--json]`,
`ahub queue show <delivery-id>`, and `ahub queue resolve <delivery-id>
--action completed|retry|discard --reason <text>`. They are a 0.7.0 target and
remain unavailable in the released 0.6.4 CLI until implementation and live
verification complete.

The documented verification sequence is: run a dry-run, verify package and
session identity, manually confirm Claude recovery, read back version, session,
queue, task, and budget state, then release the held queues. Do not claim a
successful 0.7.0 cutover from tests, synthetic approvals, or package
installation alone. Issue [#1](https://github.com/STAIxBWLB/agent-hub/issues/1)
remains open for off-campus Access credentials and a natural near-limit budget
pause.


### Protocol 11 follow-up (0.12.1)

The target coordinator accepts authenticated protocol 9, 10 and 11 sources, then
uses protocol 11 after startup. Older supported managers are refreshed onto the
current implementation. The real 0.6.4/protocol-9 transition and the 0.12.0/protocol-10
development-hub transition are recorded in `docs/smoke.md`.

### Unmanaged Claude sessions (#206)

Amended 2026-10-09. An attached Claude session is managed when a live `ahub claude`
launcher is recorded for the running daemon instance (`terminal-recovery.json`, its
launcher identity checked with the shared `processSignature`) and the session record
(`claude-session.json`) was written by that launch. Managed sessions are closed and
resumed in a new terminal as before.

Any other attached Claude session is unmanaged: a plain `claude`, an `ahub claude`
outside Orca, or one whose launcher has ended. Its session record cannot be bound to
the attached session, so the plan drops the id (no output names it) and lists the
peer under `reconnectOnly`: no terminal is inspected, closed or relaunched, and the
source roster check compares its membership only. Before starting the target the
coordinator writes an operation-fenced waiver (`recovery-waivers.json`, mode 0600),
so the restored daemon does not require the saved session id for that peer; release
still requires it to reattach, which the coordinator waits for up to 90 seconds
(three times the plugin's longest reconnect backoff). Reconnect-only requires the
source control protocol to equal the target's; otherwise the plan names a blocker
whose next action is to end the session or relaunch it with `ahub claude` in Orca.
A live launcher whose record was written by another launch is a blocker, never a
target. Refused `upgrade --yes` and `restart --yes`, and every dry-run, print each
blocker on stderr before the final line.

The channel's hello carries no launch id, so a plain `claude` that took the peer id
from a live managed session is classified as managed. Telling them apart needs the
launch id at hello, which is a protocol change and is not claimed here. A live
upgrade with an unmanaged session attached has not been run.

### Partial operations (#215)

Amended 2026-10-09, before implementation.

Expired preparation. The source hold lapses after ten minutes. When a project is
still `prepared` (terminal effects may already be recorded) and its hold is gone,
resume re-prepares the same source instead of reporting "source is no longer
prepared". The running daemon must be the planned source instance: a replaced
daemon or a source held by another operation is refused, with nothing prepared,
closed or stopped. The coordinator prepares again under the same operation id,
waits for readiness within the preparation bound (on timeout it aborts only its
own hold) and checks the roster again. A peer whose terminal this operation
already closed must stay detached; every other peer must keep its planned
conversation. Effect receipts are never reset, so no terminal is closed twice,
and the exclusive runner claim and instance fencing are unchanged. The
re-prepared source records a closed peer as offline, so the target daemon does
not require that peer itself; the coordinator still requires every originally
attached peer back before release. A roster change while effects are recorded
names the peer and the choices below instead of asking for a new plan.

Native resume viability. A Codex thread counts as resumable only when a rollout
file naming it exists under `sessions/` of the store its restoration uses (the
launcher's captured `CODEX_HOME`, else `~/.codex`); an app-server thread id
alone proves nothing. The plan blocks a Codex peer without one, the coordinator
checks again before closing its terminal (closing nothing when it fails) and
before creating the replacement.

Launcher failure. Orca's `terminal create --command` types the command into a
login shell, which outlives it, so the terminal never exits with the launcher
and its exit is no evidence. The evidence is the hub's own: `ahub codex`,
`ahub claude` and `ahub pi --mode tui` record their launcher (pid and process
signature) in `terminal-recovery.json` for the terminal they run in, before
they start the native agent. A replacement is awaited in 5-second slices of
Orca's `tui-idle` wait (Orca 1.4.223 answers a timed-out wait with exit 1 and
`{"ok":false,"error":{"code":"timeout"}}`, which counts as not yet). Between
slices, and once the terminal reads idle (an idle terminal may be the shell the
launcher returned to), a recorded launcher that is gone means the launch failed,
recognized within one slice. A launcher whose identity cannot be read is unknown
and is waited for, never taken as gone. A handle Orca reports
`terminal_handle_stale` means the terminal is gone only when no recorded
launcher may still run and Orca no longer lists the terminal's incarnation;
otherwise the create stays uncertain. A launcher that died before recording
itself is not distinguished from a slow one, and whether Orca reports the bare
login shell as TUI-idle is not verified: if it does, the create stops at once as
not mappable to the session; if not, after the 10-minute readiness bound. Either
way it blocks as needing manual verification with the receipt `pending`, and the
next resume, finding no live launcher and no attached session, records `failed`. Resume settles a `pending` or `failed` receipt by what is live
(the table below): an attached planned (or accepted) session is the
restoration, a launcher that may run is waited for, and only nothing live makes
it `failed` or, for `failed`, launches again. No terminal is created while a
recorded launcher for the peer may run on the target or its session is attached.
A launch that failed, or a thread found not resumable before the launch, is
receipted `restored:<peer>` = `failed` and never counts as restored. A Codex
store that cannot be read (other than missing) is unknown and blocks the plan,
the close and the create rather than counting as not resumable. Claude's
zero-turn rule is unchanged; Pi resume viability is not checked.

Failed restoration. The operation blocks naming the peer, its session or thread
id and the choices. `resume` launches a failed peer again once its cause is
fixed; a thread that is still not resumable fails again with the same choices.

Status. `ahub recovery status <id>` reports the receipt (phase, step, update
time, error); whether a runner process holds the operation now (`runner.state`
`running` with its pid, or `none`); `stale` when the receipt says `running` but
no runner holds it; each project's phase and effect receipts (`closed:<peer>`,
`restored:<peer>` as `done`, `pending` or `failed`); whether the shared plugin
and the global CLI were installed; any lost continuity and disposition; and
`next`, the commands that apply now. It never contains task or message text.
`resume` does not start a second runner while one is alive.

Disposition. Two human-only choices, each with a required `--reason`, run from
an ordinary terminal (agent shells are refused by the CLI identity gate), claim
the runner (refusing while one is alive) and append to the receipt's audit:

- `ahub recovery dispose <id> --fresh-session <peer> --reason <text>` applies
  only to a Codex or Claude peer whose restoration is receipted `failed`; Pi is
  refused, because a restored hub refills a Pi start from its recorded resume.
  Like reconnect-only (#206), it needs a target that reads
  `recovery-waivers.json`: staging refuses a target without it when a
  reconnect-only session is planned, and the fresh launch is refused on one. Per affected project
  it records the lost session or thread id (`fresh`) and schedules `resume`,
  which writes an operation-fenced waiver so the restored daemon accepts a new
  session for that peer, launches the peer without a resume id in a new
  terminal, records the id the daemon then reports, and verifies everything
  else as before. The operation may then complete; its status keeps the lost
  continuity.
- `ahub recovery dispose <id> --stop-and-archive --reason <text>` abandons the
  operation. It inspects every project before acting; a runtime that is
  starting, stopping or unreachable refuses the whole disposition, and a project
  whose directory is gone is recorded as such (nothing to stop or archive). A
  source this operation holds and has not committed gets its hold aborted and
  keeps running. A target this operation started and has not released (a
  running daemon in phase `restored` under this operation id, other than the
  source, whether or not the receipt recorded its instance) is stopped by its
  live instance through the lifecycle stop, which verifies the instance and
  waits until its manifest and registry claim are gone, and is then inspected
  again. A daemon this operation does not own, or one already released, is left
  running. Each project's outcome is recorded as it happens; a disposition that
  stops partway keeps the lock, and resume and `--fresh-session` then refuse
  until `--stop-and-archive` is run again and finishes. A stopped project's committed
  snapshot of this operation moves to `restart.abandoned.<hash>.json`, which is
  never replayed, so an ordinary `up` works again. Queued envelopes are not
  delivered from that file; a hub with a delivery journal (protocol 10 and
  later) reloads the queues it persisted in `hub.db` on its next start.
  Replacement terminals the operation created stay open, attached to nothing
  until a hub runs again. Only then is the operation
  recorded `cancelled` with its disposition (per-project outcome, plugin and CLI
  state) and the lock released. It is never recorded as completed, the global
  CLI is not promoted, and terminals it closed stay closed. A project whose
  target ran is started again with the target's CLI. The archived reset proposed
  in #214 can follow: no lock or replayable snapshot is left in its way.
- `abort` stays the escape for a preflight without effects; its refusal names
  the disposition. It also cancels a prepared project whose source still runs as
  the same instance after its hold lapsed, which was never committed. A roster
  change found while no effects are recorded offers `abort` exactly when
  `abortRefusal` allows it (this operation's lock refuses a new upgrade until it
  is cancelled).

#### Receipts, evidence and next actions

Resume, abort, dispose, the `next` list of `status` and every error follow this
table. A `failed` receipt stays `failed` until the relaunch replaces it with
`pending`, so a refusal on the way (an unreadable store, a launch found live, a
target without waivers) keeps its choices. `--fresh-session` is neither offered
nor accepted when the target cannot read recovery waivers. A runner record that
cannot be read shows as `unknown` in `status`, never as no runner; `status` and every error that lists choices build them with one function
(`nextActions`), in this order: resume (which also launches a failed peer
again), abort where it can succeed, a fresh session for each failed Codex or
Claude restoration, stop-and-archive. An error gives only its own step (the
last column below) and ends with that list (`next actions: ...`), so it names
abort exactly when `abortRefusal` allows it, the same as `status`, and never
"make a new plan" alone: this operation's lock refuses a new one. `<c>` is the operation's own coordinator, printed in full as
`bun <preserved source>/src/cli/main.js`: during an upgrade the global `ahub`
may still be the older release, whose `recovery` lacks these commands.
"Effects" means any project past `prepared` or any terminal receipt in the whole
operation. Stop-and-archive (`<c> recovery dispose <id> --stop-and-archive
--reason <text>`) is allowed in every open state and is always the last `next`
entry; the rows give what else applies.

A recorded launcher is the `terminal-recovery.json` row for that peer on the
target instance. It is live when its process signature matches, gone when the
pid no longer exists (ESRCH) or now belongs to another process, and unknown when
the pid exists but its identity cannot be read. Unknown is never treated as gone. At planning, an
unknown Claude launcher blocks: whether the attached session is managed cannot
be told.
Restore reads this evidence in one place: the target's report, which counts only
when the target runs as the expected instance, then the recorded launcher. A
target that does not, a launcher that cannot be read, or a launcher record file
that cannot be read or parsed is unknown and blocks without changing a receipt;
the record file is written atomically (temp + rename), and a launch is not recorded
over a record file that cannot be read (that would erase the other launchers'
records). `ahub codex` and `ahub pi --mode tui` launched by the operation that
holds the lock record themselves before the hub's start round trip. Whether a
target reads waivers is one check, used by staging, restore, `next` and dispose. A truncated Orca
inventory never shows a terminal as gone. While a stop-and-archive is recorded,
`resume` is refused by the running release, whichever coordinator started the
operation, and the runner keeps the disposition's own error. Abort and `next` decide with one predicate
(`abortRefusal`); `status` reads the sources when abort could apply.
An attached session is the target's report of that peer online with a thread
(Codex) or session (Claude, Pi) id.

| Receipt | Live evidence | Resume | Other actions | Next action text |
| --- | --- | --- | --- | --- |
| project `pending` or `prepared`, no effects | roster changed | blocks | abort where `abortRefusal` allows it, dispose | `a new plan can be made once this operation is cancelled or ended` |
| project `prepared`, hold ours | roster as planned | roster checked again, then close and commit | abort if no effects | none (it proceeds) |
| project `prepared`, hold ours | roster changed, effects | blocks, hold kept | dispose | `end that <peer> session` (joined after the plan, or its terminal was closed) or `restore <peer>'s original session`, `then <c> recovery resume <id>` |
| project `prepared`, hold lapsed (same source instance) | roster as planned | re-prepare, check roster, close, commit | abort if no effects | none |
| project `prepared`, hold lapsed | roster changed | as the two rows above | as above | as above |
| project `prepared` | source replaced or held by another operation | blocks, nothing touched | abort if no effects (cancels and leaves that daemon or hold alone), dispose | `<c> recovery status <id>` and stop-and-archive |
| project `prepared` with `commitSent` (a per-project receipt flag written right before the commit request; `step` is rewritten on every resume and is not evidence) | any (the commit may have been sent) | continues from the commit | dispose; abort is neither offered nor accepted | `<c> recovery resume <id>` |
| project `prepared`, no `commitSent`, operation of a #215 coordinator | source stopped (crashed before any commit request) | blocks; the phase stays `prepared` (nothing was committed, so there is nothing to start from) | abort if no effects, dispose | `<c> recovery abort <id>` without effects, else stop-and-archive (the lock refuses starting that hub by hand) |
| project `prepared` | source unavailable, stopping or not inspected | as above when it reads again | dispose; abort neither offered nor accepted (its hold may still stand) | `<c> recovery status <id>` once it answers |
| project `prepared`, operation of an older coordinator (no `commitSent` written) | source not running, or not inspected | as its own runner does | dispose; abort neither offered nor accepted (it may have committed) | `<c> recovery status <id>` |
| disposition recorded, first act not finished | any | refused | abort refused, stop-and-archive only | as the disposition row below |
| `closed:<peer>` `pending` | Orca still lists the terminal | blocks | dispose | `close Orca terminal <handle> (the login shell it runs in) by hand, then <c> recovery resume <id>` |
| `closed:<peer>` done | peer attached again | blocks | dispose | `end that <peer> session, then <c> recovery resume <id>` |
| `restored:<peer>` `pending` or `failed` | session attached with the planned id (or an accepted new one: fresh choice, planned fresh start, zero-turn Claude) | recorded as restored | none | none |
| `restored:<peer>` `pending` or `failed` | another session attached | blocks | dispose | `end that <peer> session and close its terminal, then <c> recovery resume <id>` |
| `restored:<peer>` `pending` or `failed` | no session, recorded launcher live or unknown | blocks | dispose | `wait until it attaches, or end it and close terminal <handle>, then <c> recovery resume <id>` |
| `restored:<peer>` `pending` | no session, launcher gone or never recorded | receipted `failed`, blocks | fresh session (Codex, Claude), dispose | the failed-restoration choices below |
| `restored:<peer>` `failed` | no session, launcher gone or never recorded | launches again (fresh if chosen) | fresh session (Codex, Claude), dispose | the failed-restoration choices below |
| `restored:codex` absent | rollout missing | receipted `failed`, blocks, no terminal created | fresh session, dispose | the failed-restoration choices below |
| any, before close or create | Codex store unreadable | blocks, nothing closed or created | dispose | `make <store> readable, then <c> recovery resume <id>` |
| `restored:<peer>` absent | the planned session attached | recorded as restored | none | none |
| `restored:<peer>` absent | another session attached, or a recorded launcher live | blocks, no terminal created | dispose | `end that <peer> session and close its terminal` (or `wait until it attaches, or end it and close terminal <handle>`), `then <c> recovery resume <id>` |
| any receipt being settled or launched | target hub not running as the expected instance (unavailable, stopped, another instance), or a launcher that cannot be read | blocks; no receipt changes, nothing created | dispose | `once the target answers` (or wait for / end the launcher), `<c> recovery resume <id>` |
| `fresh` recorded for a peer | none live | launches it without a resume id, records the new id | dispose | none |
| disposition recorded, not finished | any | refused | stop-and-archive only | `rerun <c> recovery dispose <id> --stop-and-archive --reason <text> once its runtimes have settled` |
| `completed` or `cancelled` | any | nothing to do | none | none |

The failed-restoration choices are `<c> recovery dispose <id> --fresh-session
<peer> --reason <text>` (Codex or Claude; records the lost session and resumes;
if the original session attaches after all, the recorded loss is cleared) and
stop-and-archive. When the operation's own coordinator predates these commands
(it has no `dispose`, refuses abort and resume on a lapsed hold and prints no
`next`), `<c>` names the running release for every action: abort, status and
dispose run in that process, while resume still runs the operation's own runner
and its `next` entry says what that runner cannot do. Stop-and-archive stops a
target that speaks an older control protocol at that protocol (a `kill` fenced
by its instance), then waits for its manifest and registry claim as the
lifecycle stop does. The disposition and its audit are written before the first
act. A recovery launch of `ahub codex` records its launcher before the hub's
`start` round trip; an ordinary launch records it after, so a refused start never
replaces the record of a Codex already running.

A Codex thread with no rollout is not blocked at the plan only when the hub saw
Codex start it (`native_thread` with `fresh`, logged by the adapter when it
adopts a thread) and logged no Codex `turn_start` while it was the adopted
thread (Codex writes the rollout with the first message). The plan then lists
it under `freshStart`, says so, and it restarts as a new session with nothing to
lose. Detaching forgets nothing; a thread whose start the log does not show
(resumed, an older hub, a pruned log) is unsure and stays a plan blocker, as
does one with turns. A planned fresh start still needs the store to show the
rollout missing: an unreadable store blocks the close and the create.
