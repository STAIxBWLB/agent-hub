# Kimi TUI completion facts (#1282)

Date: 2026-11-08. Scope: exact native version Kimi Code 2.5.2 on macOS arm64, isolated Git projects and isolated `KIMI_CODE_HOME`, real model turns and the real hub control protocol. No prompt, answer, session id, task title, command or credential is reproduced here.

## T0 native evidence

- Ordinary turns write `turn.prompt(origin.kind)` and final `turn.ended(reason)`. A blocked first Stop produced only the intermediate `agent.turn.ended`; the final `turn.ended` and `prompt.completed` appeared only after the second Stop was allowed.
- A real background process wrote `agents/main/tasks/<id>.json` with `status: "running"` and `endedAt: null`, then `status: "completed"` with a numeric end time. Its ordinary turn completed before the background process.
- StopFailure produced `turn.ended(reason: "failed")` and a matching prompt failure. Interrupt produced `turn.ended(reason: "cancelled")` and `prompt.aborted`.
- `TurnStarted.origin_kind` was `user` for person prompts and `task` for a background notification. `turn.prompt` may omit `promptId`; notification turns may also omit `prompt.completed`. The native `notificationId` or turn id is the correlation fallback.
- TaskStarted and Notification hooks were not observed in these runs. Settlement therefore re-reads the native inventory and final turn instead of requiring a hook.
- A launcher-scoped local plugin worked from `plugins/managed/agent-hub` and `plugins/installed.json`. Its record carries the launch id, not prompt data. Normal TUI exit removed the record and files; another plugin remained.
- `spawnSync` blocked the launcher's control socket heartbeat. The production launcher now uses async spawn in the foreground process group.

## Live implementation evidence

- Ordinary person turn: one private `done`, with the correlated native turn end and no text in the completion sinks.
- Real background `sleep 15`: no completion while the task file said running. One `done` appeared only after the task and notification turn had settled, without requiring TaskStarted or Notification hooks.
- `hub_inbox`: a queued message was pulled and the person prompt that called the tool produced one `done`. The hub message itself opened no additional person run.
- Earlier forced-close/restart probes produced one `interrupted` for the open run, never a duplicate on later reads.
- `ahub results --json` exposed only ids, peer, outcome, times and `private: true`. The launch-scoped plugin was removed on normal exit and other plugins stayed installed.
- Focused regression suites: 76 completion, agy, launcher and review-follow-up tests plus 36 full-gate failure-focused tests passed, with typecheck and bundle freshness. These covered the codec, completion flow, missing prompt ids, absent Stop/Notification hooks, unknown inventory, compat receipts and unverified-version behavior.
- PR review follow-up: the version probe preserves a wrapper/interpreter prefix without launch-only model options. A shared-home plugin record carries its owner pid and process signature; an active or unknown owner is never replaced, and only a proven-gone owner is stale.
- Full Linux `scripts/check.sh --changed` at `196ef79c2f17ae4422e0c9c82f3aad72633110c2`: **12634 pass, 101 skip, 0 fail**, ending `check: OK`. The earlier full run's 10 failures were all fixed and re-run in the focused suites.
- OCR delegation covered all 20 reviewable files at that head. Two preview/ownership findings were fixed with red/green plugin regressions.

## Acceptance criteria

- [x] AC1: blocked-Stop, delayed final output and stale-replay cases; Stop alone creates no completion.
- [x] AC2: one unread completion only after final-turn readback and verified background quiescence.
- [x] AC3: StopFailure becomes `failed` only after final-state readback; Interrupt is quiet; launcher loss/restart yields at most one `interrupted`.
- [x] AC4: a real `hub_inbox` pull does not create a person-originated native turn; the person's prompt settles once.
- [x] AC5: forged, stale, wrong-launch, wrong-session, wrong-cwd and replayed observations create no run, completion or receipt.
- [x] AC6: active background work and unknown inventory never produce a premature `done`.
- [x] AC7: no prompt, answer, hook error, task command or title reaches completion rows, events, logs or memory; native-person results are private stubs.
- [x] AC8: only compat `kimi-tui` 2.5.2 enables the bridge; other versions keep existing TUI behavior with completion disabled.
- [x] AC9: `scripts/check.sh --changed` passed at `196ef79c2f17ae4422e0c9c82f3aad72633110c2`, with 12634 pass, 101 skip and 0 fail. Live exact-version evidence above is complete.

## Hardcoded-value calibration

A fresh blind sample of 80 decided entries passed 69/80 (86.25%) after applying the published contract, external-input safety floor, operational default and test-seam distinctions. The new inventory constants were then classified; `bun scripts/inventory-hardcoded-values.ts --check` passed (3494 entries, 2489 classified, 1005 baseline).

## Implementation boundary

Hooks are candidates only. The daemon, current launch, native home, native session, project and current socket generation bind every observation. The transcript supplies origin and final outcome; background task files supply count or explicit unknown. Native-person results stay private. Headless ACP behavior is unchanged. An unverified TUI version or a launch without these readbacks declares no TUI settle.
