# H4 recovery and upgrade waits: H0 ledger

Reconciliation for #489 H4 (task 445), against the H0 inventory `2026-10-24-hardcoded-values.md`. The inventory lists 141 rows for the area "recovery/upgrade waits" (117 unique after the inventory's duplicate display rows). Locations are frozen H0 locations, not current source lines. The rows are taken from the inventory as it stands and each disposition was read against the code at main 3af9255d; the generator is not committed.

Classification of the unique rows by H0: 58 operational, 23 safety floor, 26 contract, 10 test seam.

Dispositions: **6 rows converted** into five settings (111 left out, each with its reason below). 0 rows are unclassified.

The five settings (all `next use`, read from the project's config at the start of each wait by `src/cli/recovery-waits.ts`):

| Setting | Bounds | Default | Constant it replaces |
| --- | --- | --- | --- |
| `recovery.reconnect_wait_s` | 600 to 3600 s | 600 | `RECONNECT_WAIT_MS` |
| `recovery.unmanaged_reconnect_wait_s` | 90 to 900 s | 90 | `UNMANAGED_RECONNECT_WAIT_MS` |
| `recovery.control_timeout_s` | 30 to 300 s | 30 | `RECOVERY_CONTROL_TIMEOUT_MS` |
| `recovery.shutdown_wait_s` | 30 to 300 s | 30 | the 30 s wait after a commit in `runRecovery` |
| `recovery.terminal_idle_wait_s` | 30 to 600 s | 120 | the two 120 s `waitForIdle` calls |

Every minimum is today's constant except the terminal idle wait: a person-visible wait may be raised and never shortened below what ships. A shorter terminal idle wait only ends a wait in manual-required, which retains the terminal.

Handed over from H3 and not in this area's inventory rows: the recovery fence poll in `src/hub/bus.ts` (`fenceRecovery`: a 1 ms initial poll, doubling to a 50 ms cap, bounded by a 5 s deadline). H3's ledger rows `bus.ts:365:17` and `bus.ts:372:35` deferred it to this task. **Left out of H4**, with the reason: the 5 s deadline is already an injectable parameter of `fenceRecovery(timeoutMs = 5_000)` and a fence that times out leaves queues, in-flight deliveries and any hold the caller did not set exactly as they were, so a longer value only delays a refusal the caller retries; the 1 ms and 50 ms poll steps are an implementation detail of that bounded wait, not a wait a person tunes. It stays a constant (H3's row `bus.ts:361:35` records the same `5_000` as a test seam). Both daemon call sites (`recovery prepare` and `recovery restore`) pass no argument. This is a disposition, not a conversion: no setting was added for it.

| Frozen H0 location | Name | Value | H0 class | Disposition | Reason |
| --- | --- | --- | --- | --- | --- |
| src/cli/recovery-guidance.ts:89:173 | `[...new Set(recorded.filter((peer): peer is string => typeof` | `64` | contract | keep: contract | A format, protocol or arithmetic constant. |
| src/cli/recovery-package.ts:15:23 | `next.length > 2_000_000` | `2_000_000` | safety floor | defer (H4 follow-up): recovery-package.ts | Outside this task's paths: package-copy and child-process timeouts. |
| src/cli/recovery-package.ts:16:23 | `next.slice` | `-2_000_000` | safety floor | defer (H4 follow-up): recovery-package.ts | Outside this task's paths: package-copy and child-process timeouts. |
| src/cli/recovery-package.ts:21:100 | `options.timeoutMs ?? 60_000` | `60_000` | operational | defer (H4 follow-up): recovery-package.ts | Outside this task's paths: package-copy and child-process timeouts. |
| src/cli/recovery-package.ts:22:61 | `setTimeout` | `(options.timeoutMs ?? 60_000) ` | operational | defer (H4 follow-up): recovery-package.ts | Outside this task's paths: package-copy and child-process timeouts. |
| src/cli/recovery-package.ts:22:83 | `options.timeoutMs ?? 60_000` | `60_000` | operational | defer (H4 follow-up): recovery-package.ts | Outside this task's paths: package-copy and child-process timeouts. |
| src/cli/recovery-package.ts:110:128 | `timeoutMs` | `30_000` | operational | defer (H4 follow-up): recovery-package.ts | Outside this task's paths: package-copy and child-process timeouts. |
| src/cli/recovery-package.ts:121:99 | `timeoutMs` | `30_000` | operational | defer (H4 follow-up): recovery-package.ts | Outside this task's paths: package-copy and child-process timeouts. |
| src/cli/recovery-package.ts:153:115 | `timeoutMs` | `180_000` | operational | defer (H4 follow-up): recovery-package.ts | Outside this task's paths: package-copy and child-process timeouts. |
| src/cli/terminal-recovery.ts:178:7 | `MAX_WAIT_MS` | `10 * 60 * 1000` | operational | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:179:14 | `MAX_COMMAND_MS` | `30000` | operational | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:181:7 | `EXIT_SLICE_MS` | `5000` | operational | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:183:7 | `MAP_POLL_MS` | `1000` | operational | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:222:66 | `argv.slice` | `2` | contract | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:239:88 | `argv.slice` | `2` | contract | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:472:61 | `JSON.stringify(value).length > 32 * 1024` | `32 * 1024` | safety floor | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:473:101 | `value.launchId.length > 128` | `128` | safety floor | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:473:141 | `value.launcherSignature.length > 256` | `256` | safety floor | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:808:113 | `timeout` | `0` | contract | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:829:75 | `timeoutMs` | `600_000` | test seam | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:838:35 | `deadline` | `5000` | operational | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:842:23 | `Bun.sleep` | `100` | operational | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:854:127 | `timeoutMs` | `600_000` | test seam | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:928:32 | `Math.max` | `1` | operational | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/terminal-recovery.ts:941:77 | `timeoutMs` | `600_000` | test seam | defer (H4 follow-up): terminal-recovery.ts | Outside this task's paths. MAX_WAIT_MS is the ceiling every terminal wait is clamped to, so the idle wait setting cannot exceed it; the poll slices and the 5 s close confirmation stay with it. |
| src/cli/upgrade-interactive.ts:116:100 | `peer.state.padEnd` | `7` | contract | defer (H4 follow-up): upgrade-interactive.ts | Outside this task's paths: a one-minute refresh cadence of an interactive screen. |
| src/cli/upgrade-interactive.ts:116:139 | `KINDS[peerKind(p, peer)].padEnd` | `8` | contract | defer (H4 follow-up): upgrade-interactive.ts | Outside this task's paths: a one-minute refresh cadence of an interactive screen. |
| src/cli/upgrade-interactive.ts:165:83 | `clock(io) - lastWaitAt >= 60_000` | `60_000` | operational | defer (H4 follow-up): upgrade-interactive.ts | Outside this task's paths: a one-minute refresh cadence of an interactive screen. |
| src/cli/upgrade-interactive.ts:174:59 | `clock(io) - lastWaitAt >= 60_000` | `60_000` | operational | defer (H4 follow-up): upgrade-interactive.ts | Outside this task's paths: a one-minute refresh cadence of an interactive screen. |
| src/cli/upgrade-interactive.ts:259:80 | `reason.slice` | `500` | safety floor | defer (H4 follow-up): upgrade-interactive.ts | Outside this task's paths: a one-minute refresh cadence of an interactive screen. |
| src/cli/upgrade-interactive.ts:287:112 | `reason.slice` | `500` | safety floor | defer (H4 follow-up): upgrade-interactive.ts | Outside this task's paths: a one-minute refresh cadence of an interactive screen. |
| src/cli/upgrade-labels.ts:17:42 | `ms < 90_000` | `90_000` | contract | keep: presentation | A label threshold or a line index, not a wait. |
| src/cli/upgrade-labels.ts:17:99 | `ms < 5_400_000` | `5_400_000` | contract | keep: presentation | A label threshold or a line index, not a wait. |
| src/cli/upgrade-labels.ts:27:75 | `lines.push` | `0` | operational | keep: presentation | A label threshold or a line index, not a wait. |
| src/cli/upgrade-presentation.ts:35:28 | `Math.max` | `0` | contract | keep: contract | A format, protocol or arithmetic constant. |
| src/cli/upgrade-presentation.ts:36:17 | `seconds < 60` | `60` | contract | keep: contract | A format, protocol or arithmetic constant. |
| src/cli/upgrade-presentation.ts:38:17 | `minutes < 60` | `60` | contract | keep: contract | A format, protocol or arithmetic constant. |
| src/cli/upgrade-presentation.ts:39:76 | `minutes % 60` | `60` | contract | keep: contract | A format, protocol or arithmetic constant. |
| src/cli/upgrade-presentation.ts:39:89 | `String(minutes % 60).padStart` | `2` | contract | keep: contract | A format, protocol or arithmetic constant. |
| src/cli/upgrade-presentation.ts:171:40 | `points.length > 512` | `512` | safety floor | keep: safety floor | A size or count cap that protects data or the host; never loosenable here. |
| src/cli/upgrade-presentation.ts:171:65 | `points.slice` | `509` | safety floor | keep: safety floor | A size or count cap that protects data or the host; never loosenable here. |
| src/cli/upgrade-runtime.ts:26:7 | `UNMANAGED_RECONNECT_WAIT_MS` | `90000` | operational | convert: recovery.unmanaged_reconnect_wait_s (floor = 90 s) | Read from the project's own config at the start of the wait; unset is the old constant. |
| src/cli/upgrade-runtime.ts:28:7 | `RECONNECT_WAIT_MS` | `600000` | operational | convert: recovery.reconnect_wait_s (floor = 600 s) | Read from the project's own config at the start of the wait; unset is the old constant. |
| src/cli/upgrade-runtime.ts:65:72 | `timeoutMs` | `610_000` | operational | keep: orca runner timeout | One Orca command is bounded by terminal-recovery's own ten-minute ceiling (MAX_WAIT_MS) plus 10 s; raising the reconnect wait must not raise it, and lowering it below that ceiling would cut a wait the ceiling allows. |
| src/cli/upgrade-runtime.ts:79:7 | `RECOVERY_CONTROL_TIMEOUT_MS` | `30000` | operational | convert: recovery.control_timeout_s (floor = 30 s) | Read from the project's own config at the start of the wait; unset is the old constant. |
| src/cli/upgrade-runtime.ts:231:166 | `(Array.isArray(response.recovery?.blockers) ? response.recov` | `20` | safety floor | keep: safety floor | A bound on blocker text copied into a receipt. |
| src/cli/upgrade-runtime.ts:231:200 | `b.slice` | `200` | safety floor | keep: safety floor | A bound on blocker text copied into a receipt. |
| src/cli/upgrade-runtime.ts:248:69 | `timeoutMs` | `10_000` | operational | keep: installer probe | A version probe of the shared Claude plugin installer. A short fixed probe, not a wait a person tunes. |
| src/cli/upgrade-runtime.ts:393:106 | `timeoutMs` | `180_000` | operational | keep: global install timeout | `bun add -g` is a global effect with no project, so no project config can own it; and it is not a shorter-is-safe wait. |
| src/cli/upgrade-runtime.ts:412:61 | `waitForIdle` | `120_000` | operational | convert: recovery.terminal_idle_wait_s (30-600 s) | Read from the project's own config at the start of the wait; unset is the old constant. |
| src/cli/upgrade-runtime.ts:510:45 | `waitForIdle` | `120_000` | operational | convert: recovery.terminal_idle_wait_s (30-600 s) | Read from the project's own config at the start of the wait; unset is the old constant. |
| src/cli/upgrade-runtime.ts:562:32 | `Math.min` | `1000` | operational | keep: polling slice | A poll or sleep slice inside a bounded wait (the bound is the setting); not a wait. |
| src/cli/upgrade-runtime.ts:579:28 | `Math.min` | `1000` | operational | keep: polling slice | A poll or sleep slice inside a bounded wait (the bound is the setting); not a wait. |
| src/cli/upgrade-runtime.ts:583:125 | `timeoutMs` | `3000` | operational | keep: orca show timeout | One `orca terminal show` read inside the attachment poll; the poll's bound is the setting. |
| src/cli/upgrade-runtime.ts:698:49 | `waitForIdle` | `600_000` | operational | keep: idle wait before the close | waitForIdle(binding, 600_000) before a terminal is closed is bounded by the source's preparation lease, a fixed ten minutes (daemon.ts armRecoveryLease): a longer wait expires the lease, a shorter one cuts the floor of a person-visible wait. |
| src/cli/upgrade-runtime.ts:955:23 | `sleep` | `1000` | operational | keep: polling slice | A poll or sleep slice inside a bounded wait (the bound is the setting); not a wait. |
| src/cli/upgrade-runtime.ts:973:151 | `timeoutMs` | `180_000` | operational | keep: global install timeout | `bun add -g` is a global effect with no project, so no project config can own it; and it is not a shorter-is-safe wait. |
| src/cli/upgrade.ts:111:7 | `MAX_RECOVERY_DELEGATIONS` | `256` | safety floor | keep: safety floor | Delegation count cap. |
| src/cli/upgrade.ts:565:105 | `idleTimeoutMs` | `600_000` | test seam | keep: test seam | `runRecovery`'s idleTimeoutMs default is the 600 s source-quiet wait, bounded by the source's ten-minute lease; the parameter is a test seam. |
| src/cli/upgrade.ts:751:43 | `deadline` | `30_000` | operational | convert: recovery.shutdown_wait_s (floor = 30 s) | Read from the project's own config at the start of the wait; unset is the old constant. |
| src/hub/control-client.ts:11:14 | `PROTOCOL` | `16` | contract | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/control-client.ts:21:17 | `backoff` | `250` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/control-client.ts:26:37 | `includes` | `1006` | contract | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/control-client.ts:30:26 | `Math.min` | `1000` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/control-client.ts:30:42 | `Math.min` | `2` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/control-client.ts:73:97 | `status.controlPort > 65535` | `65535` | contract | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/control-client.ts:113:62 | `timeoutMs` | `3000` | test seam | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/control-client.ts:170:53 | `timeoutMs` | `30_000` | test seam | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/lifecycle.ts:23:68 | `timeoutMs` | `3000` | test seam | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/lifecycle.ts:97:32 | `SHUTDOWN_DEADLINE_MS` | `15_000` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/lifecycle.ts:114:37 | `attempt < 100` | `100` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/lifecycle.ts:173:35 | `deadline` | `12_000` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/lifecycle.ts:178:23 | `Bun.sleep` | `100` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/lifecycle.ts:210:33 | `deadline` | `10_000` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/lifecycle.ts:217:21 | `Bun.sleep` | `100` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:17:7 | `MANAGER_OWNER_DB_BUSY_TIMEOUT_MS` | `5000` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:30:7 | `CONTROL_TIMEOUT` | `3000` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:34:87 | `error.message.slice` | `300` | safety floor | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:72:76 | `status.port > 65535` | `65535` | contract | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:161:25 | `nominalMs` | `10_000` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:180:78 | `maxRequestBodySize` | `1024` | safety floor | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:207:33 | `options.orphanWatchMs ?? 10_000` | `10_000` | test seam | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:251:33 | `deadline` | `8000` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:262:54 | `Bun.sleep` | `100` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:274:73 | `Bun.sleep` | `25` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/manager.ts:291:21 | `Bun.sleep` | `25` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:6:14 | `BASE_PORT` | `4600` | contract | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:7:14 | `STRIDE` | `10` | contract | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:9:14 | `CONTROL` | `0` | contract | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:10:14 | `CODEX_APP` | `1` | contract | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:11:14 | `CODEX_PROXY` | `2` | contract | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:13:14 | `SWITCHYARD` | `3` | contract | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:27:22 | `attempt` | `0` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:30:76 | `attempt >= 500` | `500` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:31:57 | `Atomics.wait` | `4` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:31:62 | `Atomics.wait` | `0` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:31:65 | `Atomics.wait` | `0` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/ports.ts:31:68 | `Atomics.wait` | `10` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/recovery-continuity.ts:9:14 | `RECOVERY_CONTINUITY_BUSY_TIMEOUT_MS` | `3000` | operational | defer (H4 follow-up): SQLite busy timeouts | Outside this task's paths: database busy timeouts that protect receipts; a safety bound before a tunable. |
| src/hub/recovery-continuity.ts:10:7 | `MAX_BOOKMARK_BYTES` | `16 * 1024` | safety floor | defer (H4 follow-up): SQLite busy timeouts | Outside this task's paths: database busy timeouts that protect receipts; a safety bound before a tunable. |
| src/hub/recovery-error.ts:30:82 | `(stack ?? ).split(\n).filter(line => /^\s*at /.test(line)).s` | `8` | safety floor | keep: safety floor | A size or count cap that protects data or the host; never loosenable here. |
| src/hub/recovery-error.ts:30:128 | `sanitize(line.trim()).slice` | `400` | safety floor | keep: safety floor | A size or count cap that protects data or the host; never loosenable here. |
| src/hub/recovery-store.ts:8:7 | `RUNNER_DB_BUSY_TIMEOUT_MS` | `3000` | operational | defer (H4 follow-up): SQLite busy timeouts | Outside this task's paths: database busy timeouts that protect receipts; a safety bound before a tunable. |
| src/hub/recovery-store.ts:152:79 | `waitMs` | `5000` | test seam | defer (H4 follow-up): SQLite busy timeouts | Outside this task's paths: database busy timeouts that protect receipts; a safety bound before a tunable. |
| src/hub/recovery-store.ts:159:56 | `setTimeout` | `100` | operational | defer (H4 follow-up): SQLite busy timeouts | Outside this task's paths: database busy timeouts that protect receipts; a safety bound before a tunable. |
| src/hub/restart.ts:11:14 | `RESTART_SCHEMA_VERSION` | `1` | contract | keep: contract | A format, protocol or arithmetic constant. |
| src/hub/restart.ts:74:74 | `e.id.length <= 256` | `256` | contract | keep: contract | A format, protocol or arithmetic constant. |
| src/hub/restart.ts:74:152 | `e.trace.length <= 256` | `256` | contract | keep: contract | A format, protocol or arithmetic constant. |
| src/hub/snapshots.ts:36:23 | `Math.max` | `1` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/snapshots.ts:41:7 | `SNAPSHOT_TIMEOUT_MS` | `10000` | operational | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/snapshots.ts:55:21 | `++entries > 20000` | `20000` | safety floor | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/snapshots.ts:55:38 | `depth > 32` | `32` | safety floor | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/snapshots.ts:182:7 | `HEAD_LOG_TAIL_BYTES` | `4096` | safety floor | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/snapshots.ts:183:7 | `HEAD_LOG_MAX_APPEND_BYTES` | `128 * 1024` | safety floor | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/snapshots.ts:184:7 | `HEAD_LOG_MAX_MOVES` | `64` | safety floor | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/snapshots.ts:239:88 | `named.size > 4096` | `4096` | safety floor | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
| src/hub/snapshots.ts:619:31 | `limit` | `20` | test seam | defer (H4 follow-up): hub process lifecycle | Outside this task's paths: daemon shutdown, manager, port and control-client timing. |
