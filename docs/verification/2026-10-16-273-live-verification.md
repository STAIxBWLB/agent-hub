# Issue #273 operator execution plan

## Scope and dated observations

- Date: 2026-10-16, Asia/Seoul.
- Initial observation source: main `426bab99`, release 0.12.28, protocol 16. The following CLI refusals describe that installed version, before #408.
- Issue #273 was read live, including its 2026-10-14 additions at initial preparation; the matrix below was refreshed for the five 2026-10-16 additions before release. Every checkbox remained unchecked.
- `ahub --version` returned `0.12.28`.
- `ahub status --json` returned daemon version `0.12.28`, protocol `16`, `stopping: false`, Claude idle, Codex busy, Kimi offline and Pi idle. These are status observations, not model-delivery or restoration receipts.
- `ahub ui` exited 1 with `ahub: codex cannot run ahub ui; the person runs it in ahub console or a terminal`.
- LCU app selection for `com.apple.Terminal` returned `Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.` No Terminal inspection or input occurred.
- The operator selected procedure and blocker preparation before live execution. No identity markers were removed, no console connection was impersonated, and no lifecycle, reset, roster, quota or provider experiment was run.

## Supported execution route and remaining boundaries

From 0.12.29, an explicitly authorized agent runs operational CLI steps with
`ahub --live-test <command> [args...]`, including `init`, `up`, `console`,
`settings`, `reset`, `upgrade`, `recovery` and roster operations. Follow
[Agent-operated live verification](../operations.md#agent-operated-live-verification).
Record the initiating peer and the mandatory delegation audit (`agent_cli`
event or retained CLI audit), alongside the command and operational receipts.
The original 0.12.28 refusal above is historical evidence, not a current CLI
blocker. Identity markers remain intact; the supported option supplies authority.

Allowed-class commands retain the agent's peer identity, including messaging
and review verdicts. The flag refuses person-attributed writes, including
`--as-user`, task labels, task assign/escalate and planning/memory writes.
Delegated dashboard sessions permit operational controls but refuse sending,
proposals and person-attributed planning/history actions; changing a request body
cannot remove that restriction. Exercises requiring those actions or a person's
sign-off need the ordinary authorized actor path and cannot be completed merely
by adding the flag.

LCU's Terminal denial is a separate external computer-use restriction and remains
in force. CLI delegation does not grant Terminal app access or prove native
visual, account or accessibility observations. Record any inaccessible native
surface as unverified while continuing reachable authorized CLI checks.

## Execution order

Use a disposable Git project under the workspace scratchpad, outside this
checkout, and initialize its own Git boundary before `ahub init`. An authorized
agent runs `ahub --live-test init`, reviews the resulting configuration and starts
it with `ahub --live-test up`. Record its absolute path, project id and delegation
audit. Keep destructive recovery/reset experiments separate from the project
used for browser and model checks. Recovery can hold a machine-wide lock, so
inspect `ahub --live-test recovery status` before starting an operation and wait
for unrelated operations to finish. Upgrade isolation has the additional
machine-wide and shared-configuration requirements below.

Use installed, authenticated native tools. Record each version before its first
turn. Do not change credentials, buy access or exhaust quota to produce a result.
Do not run another session's stop or reset. Keep identity fencing in effect and
use the documented delegation route rather than removing identity markers.

1. Run reachable operational checks through `ahub --live-test`; retain their delegation audits and readbacks. Inspect terminal/dashboard rendering only through an available permitted native surface.
2. Run native messaging and role/planner exercises on the disposable project using the ordinary peer or person path as required by attribution; the delegation flag does not authorize person-content writes.
3. Run roster and recovery experiments with disposable conversations only, using the delegated operational CLI route and recording native continuity separately.
4. Run the real repository SDLC cycle only with an explicitly selected issue and release window, retaining required person verdicts.
5. Record each result in `docs/smoke.md`, retaining any unverified remainder and external blocker.

## Required observations by issue entry

All rows below are pending. A procedure reference is not evidence of execution.
Section names refer to [the smoke checklist](../smoke.md).

| Entry | Procedure or setup | Evidence required before checking the issue box |
| --- | --- | --- |
| #201 AC2/AC7, #213 AC7 | Console layout and readability | Light/dark terminal, stream and panels; terminal name, dimensions, readable text and observed clipping |
| #205 AC3 | Claude without channel evidence | Managed Claude push and settlement beside plain Claude tools-only; correlated message and settlement ids |
| #206 AC4 | Upgrade procedure below | Two distinct releases, unmanaged Claude marked reconnect-only, same native conversation after reconnect |
| #214 AC6 | ahub reset on a scratch project | Both reset scopes, queue/board checks, archive permissions and restored board, same project id |
| #215 AC6 | Expired-lease procedure below | Real expired lease and missing transcript, daemon/CLI/lock/project/archive outcomes, completion or audited disposition |
| #225 AC9 | Target-crash procedure below | Target killed after peers-restored, supported resume, original conversation and restart count readback |
| #269 AC10 | Settings from the dashboard and the terminal, parts 1-2 | Light/dark, phone width and keyboard path; actual Orca and terminal.open launches with native Pi attached |
| #285 phase 1 | Record table, #285 live item 1 | Real Kimi turn, status context source/value, usage_update timing relative to correlated prompt result |
| #284 phase 1 | One-shot command output | status/board/budget/doctor, light/dark, 80 and wider columns, console rendering and full suggested ids |
| #298 | Unified dashboard slow start | Real browser unconfirmed text, 30-second hold and keyboard focus after Start; a deterministic slow native start is a prerequisite |
| #296 | Ending Codex turn | Correlated native turn/steer response, elapsed time and exact refusal; a successful steer alone does not prove refusal matching |
| #315 Codex | Live roster return | Removal exit, printed resume command, restored same thread and peer reattachment |
| #315 Pi | Live roster return | Retained terminal/process, admission refused off roster, same TUI reattaches; prepare blocked until retained TUI ends |
| #316 trust and ingestion | Kimi TUI pull mode | Actual trust screen, project MCP tools and model-visible managed instructions/tool descriptions |
| #316 messaging/discovery | Kimi TUI pull mode | Correlated hub_inbox/hub_send exchange with another peer; trusted project and overlay discovery |
| #316 headless return | Kimi TUI pull mode | TUI to headless to TUI, session/config restoration readback; argv fixtures are insufficient |
| #256 identity/modes | Qwen Code 0.25.0 production peer | Real ACP supported identity and advertised modes; stop on CLI/ACP mismatch |
| #256 native provider | Qwen Code 0.25.0 production peer | Actual model identity, delivery, exact tool call/result and mode confirmation |
| #256 stop/recovery | Qwen Code 0.25.0 production peer | Owned stop and controlled/crash recovery retain the recorded conversation |
| #256 quota | Observe an organic refusal only | Version and exact sanitized native refusal; unknown remains failed delivery |
| #259 AC11 | Research-profile exercise | Two native agents, three sources, configured routing/classes, plans, role/tool ingestion, deterministic citations and person sign-off |
| #259 converters | Intended formats and configured converters | Actual conversion, review and undo previews; timing, caps and named-only fallback |
| #259 guidance | Same native profile sessions | Native profile/custom-stage guidance retention; preserve separate #295 and research measurements |
| #257 AC6 | SDLC gates | Real repository issue through merge/release under advise; issue/PR/head ids, gate blockers and release report |
| #295 AC16 | Native role/task cycle | Role text ingestion, retention after actual compaction, assignment/reassignment notice and review duty |
| #280 AC11 | Console attention, Global attention status, Approved character, Dashboard character | Per-phase light/dark, tmux, colour off, blocks/ascii and actual dashboard look |
| #263 AC11 | Planning and release controls | Native planner creates two releases; planned/actual dates read back |
| #263 board/intake | Project board | Desktop/phone browser against real hub, permission/state readback and actual GitHub issue intake |
| #306 | Observe an organic Kimi weekly/monthly refusal only | CLI version and exact sanitized prefix; do not deliberately consume quota |
| #403 | Offline Pi preserved-history recovery | Actual selected native session restored with identity/queue retained; a live owner refused |
| #398 | Pull-only important-message advisory | Real Kimi TUI and plain Claude see the tool-result advisory; hub_inbox drains it |
| #391 pet lifecycle | Standalone pet window | Actual stop changes it to Offline and host exits; native screenshots of states |
| #391 dashboard CSP | Split dashboard views | Browser-console capture of CSP behavior, separate from the earlier owner browser look |
| #394 VoiceOver | Office desk More control | Native VoiceOver traversal; DOM/click/Enter/Space regressions remain separate |

## Upgrade with unmanaged Claude (#206)

1. An authorized operator starts the disposable project on a known older release, records its version/project id and attaches an unmanaged Claude session using the documented plain-Claude tools-only setup. Record its native session id and a harmless conversation marker.
2. Use an isolated test environment for the hub home/registry and shared Claude plugin setup. Upgrade is machine-wide, even when invoked from the scratch cwd: it plans all registered running projects and changes the shared package/plugin; `--project` does not scope it. Run the target coordinator with `ahub --live-test upgrade --to 0.12.29 --dry-run` and retain the complete plan. Verify every planned root is a disposable fixture, record the shared CLI/plugin fate, and confirm the intended unmanaged Claude is reconnect-only. Stop without applying if any non-disposable project or shared setup is in scope. A separate AGENTHUB_HOME alone does not isolate the shared plugin; use a dedicated native configuration/test environment too.
3. The authorized agent applies that same target with `ahub --live-test upgrade --to 0.12.29 --yes` after reviewing the plan (a person may use the ordinary interactive path). Retain the delegation audit. Record operation id, source and target versions, terminal fate and plugin reconnect outcome. Do not substitute a restart at the same version.
4. Read back `ahub status`, the original native session id and marker, and one correlated hub message receipt. Record whether a second terminal appeared or a conversation was replaced.
5. Capture final operation and lock status. A refusal or failed reconnect is a failed leg, with its exact wording; it is not a pass based on the dry-run plan.

## Expired preparation lease with missing Codex transcript (#215)

This needs an isolated failure-injection setup before it is executable. There is
no public `ahub recovery prepare` CLI. Do not invent one or edit production
recovery JSON to claim a native reproduction. `test/upgrade.test.ts`,
`expiredLease`, is a scripted-driver fixture and is only a setup reference.

1. Give disposable Codex its own native session store and complete a harmless turn so its transcript exists. Record project id, daemon instance, native thread id and transcript path. Keep the original transcript outside the fixture's missing-path condition; never remove a production transcript.
2. In a controlled scratch-only harness, stop the coordinator after real source preparation and before commit, preserving its operation receipt. Record the daemon's preparation, terminal close receipts and runner identity. The harness and its pause point must be reviewed before use.
3. Make only the disposable transcript unavailable and allow the real preparation lease to expire. Confirm expiry from the daemon log/readback rather than changing a clock or receipt timestamp.
4. The authorized agent runs `ahub --live-test recovery status <operation-id>` and the supported next action it offers. Capture the exact missing-session refusal. Restore the disposable transcript and resume, or use the offered audited disposition with a reason. Do not force a fresh conversation and label it restoration.
5. Record daemon and CLI outcomes, operation/lock state, project id before/after, archive paths and modes, and the final continuity or lostContinuity disposition. Preserve failed intermediate receipts.

## Target crash after peers-restored (#225)

1. In a separate disposable project, establish native conversations with harmless markers and start a controlled recovery. Save its operation id and source conversation ids.
2. Observe the real `peers-restored` phase before release. A controlled pause at that boundary is required: if the operation already completed, this run cannot demonstrate this failure point. Do not fabricate the phase by editing a receipt.
3. Verify the target pid belongs to this disposable project's daemon and record its instance id. The authorized operator ends only that target daemon through a permitted process-control surface. Record native launcher/process state after the exit.
4. Run `ahub --live-test recovery status <operation-id>`, then its offered `ahub --live-test recovery resume <operation-id>`. Retain the delegation audits. If a surviving launcher blocks it, end the identified disposable launcher as instructed and retry the supported action.
5. Verify the new target instance, recorded restart count, same native conversations and markers, no duplicate terminal, final operation status and lock release. A missing snapshot or failed native resume remains a failure, with the precise refusal and the supported disposition recorded.

## Recording and closure

For each execution record: date/time, source commit, hub/native versions, project
id, exact command or interaction, expected observation, actual observation,
correlated ids, sanitized evidence path and pass/fail/unverified verdict. Record
partial success at the substep level. Keep raw tokens, cookies, private task text
and account details out of committed evidence.

On a confirmed defect, preserve its failure wording and open a linked defect
issue within the user's authorized scope. Check a #273 item only after its dated
record covers the entire item, or a failed run is recorded with a linked defect.
Environment/tool restrictions remain unverified prerequisites. They do not meet
the issue's failed-product-run alternative. #273 cannot close from this plan.

The initial preparation ran no full check or native model turn. Its original
commit c637a088 subsequently passed Ubuntu/macOS full gates and seeded guards
in CI run 38791043404. The release candidate must earn its own exact-head checks;
none of those automated results completes a live leg.
