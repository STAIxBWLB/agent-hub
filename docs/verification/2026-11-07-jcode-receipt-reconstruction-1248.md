# Jcode receipt reconstruction: partial control, not qualified (#1248)

Date: 2026-11-07. Task #767. This is new proof code, not promotion of the missing
producer behind [the historical Mac receipt](2026-10-26-jcode-0.99.1.md).

The isolated Linux x64 control executed the verified 0.99.1 release. Isolation,
serve cleanup, ACP and MCP passed. Telemetry and the strict persisted-context
binding failed. Source comparison remains not-run. These failures are retained;
this report makes no COMPAT, trust or macOS qualification change.

## Artifact and runner binding

The public [v0.99.1 release](https://github.com/1jehuang/jcode/releases/tag/v0.99.1)
provides `jcode-linux-x86_64.tar.gz`, 56203997 bytes, with SHA-256
`0b2a612de97c6e01ae6de1c0cff555b3460cf8364d1a11d2f8649fc0c9d7a1e6`.
The installer verified its tagged asset digest and `SHA256SUMS` before extraction.
The archive has a 505-byte regular wrapper `jcode-linux-x86_64` and its regular
adjacent `.bin`; their names and bytes are preserved.

At `350a3d042fc9d9680fa84b90c82f5c77bd3941b7`, dgx02 ran Bun 1.4.2 in a
disposable Linux x64 container. Typecheck and 79 fixture tests passed. The actual
native control's installation passed with the digest above; its overall outcome
was failure, with owned stop confirmed and lifetime process cleanup unproven.
The container's lifetime supplies containment. The control sets `autoAdmit:false`
in a temporary in-memory Linux projection and never spoofs its OS or architecture.
The checked-in manifest still requires macOS arm64.

The Mac archive's acquisition was checked separately on Linux without executing
its binary: SHA-256
`3623164d518b0c9d443ab07052084244b379e8a3377037db67d2382220f4ed14`,
wrapper `jcode-macos-aarch64`. That is packaging evidence, not native Mac evidence.

## Reconstructed procedure and observed legs

The single imported module owns private HOME/JCODE_HOME, the loopback provider,
serve/ACP children and their cleanup. Every native argv uses production
`jcodeCommand`. The MCP entry carries no peer environment; the observer checks the
two synthetic owned-launch markers inherited by its native child. No real native
home, account, API key or model is supplied. The four real-home hashes from the
historical receipt were not reproduced: only the private HOME decoys are fenced.

| Leg | 0.99.1 Linux observation |
| --- | --- |
| isolation | pass: private environment and unchanged private decoy files |
| serve-cleanup | pass: ready FD/socket/sidecar metadata and stopped owned groups |
| acp-initialize-new-load-mode-ceilings | pass: protocol/identity/new/load and both unsupported-method checks |
| mcp-owned-environment | pass: actual eager child inherits the two expected markers |
| active-turn-soft-interrupt | fail: strict private persisted System-carrier binding was not established |
| telemetry | fail: `telemetry_id` appeared in the private native home |
| source-comparison | not-run: scoped source investigation is not the historical full compare review |

`session/load` still omits `sessionId`. The existing withheld recovery guarantee
and `requireLoadSessionEcho` policy are unchanged.

The fixed-stream loopback turn reached ping capability, same-session subscribe,
idle/active state, non-urgent interrupt acknowledgement, `end_turn` and two
completion bodies. Closed observations classified the first request as native
context plus original prompt, and the second as context, original, streamed head
and steer. Those observations do not substitute for the failed persisted-role
assertion. The final code also counts every completion POST attempt, rejecting a
third attempt even when its body is refused by the two-body storage cap.

## Narrow context and lock rules

Pinned source
[session.rs](https://github.com/1jehuang/jcode/blob/7206efd0c1dbf49ef38d06b63f3a96a3a7cee611/crates/jcode-base/src/session.rs#L989)
and [prompt.rs](https://github.com/1jehuang/jcode/blob/7206efd0c1dbf49ef38d06b63f3a96a3a7cee611/crates/jcode-base/src/prompt.rs#L656)
define the hidden user/System-display session-context carrier. The allowed
exception requires the new private session's matching ID and working directory,
a first stored `role:user`/`display_role:system` text carrier, the exact reminder
frame and seven field names, and identical bytes once at the same position in
both provider requests. Only that carrier may be excluded. Duplicate, forged,
changed-field, extra-field, moved or app-sentinel carriers fail. Application
original/head/steer bytes, order and all generic extra-user negatives remain
strict.

The Linux control failed that binding. The source also permits optional hardware
and Git context, which the seven-field rule does not admit. That is a possible
platform-dependent limitation, not a diagnosis proved by the closed failure
checkpoint. Snapshot/journal coverage is not inferred when the role binding is
unavailable.

Today's 0.99.1 control creates an empty `telemetry_id.lock`. The proof treats only
that exact zero-byte, regular, single-link, run-owned file in the private native
home, with `JCODE_NO_TELEMETRY=1`, as coordination rather than telemetry data.
Non-empty, symlink, hardlink and wrong-location locks fail; identity, event and
milestone artifacts still fail. The same control subsequently detected
`telemetry_id`, so the telemetry leg remains failed. File presence does not prove
that telemetry was transmitted.

We cannot tell whether the original 2026-10-26 producer saw the empty lock,
ignored it, or whether it did not appear then. The historical receipt is unchanged
and is not claimed to cover this allowance.

## Acquisition and runner corrections

The real control exposed three shared harness defects:

- GitHub release metadata rejected `Accept:application/octet-stream` with HTTP
  415. Metadata now requests JSON; archive/checksum requests retain binary content
  negotiation and every redirect, checksum and pre-effect integrity check.
- The archive wrapper is platform-qualified rather than named `jcode`. An
  optional trusted recipe executable basename selects its unique existing file;
  traversal, links and paths outside the verified prefix remain refused.
- A nested command runner counted its own proof worker's private request path as
  a survivor. Only that current PID is excluded from the path heuristic. Known
  descendants and other private-root processes remain detected, and lifetime
  cleanup remains unproven. A separately owned helper negative verifies that the
  observation never grants authority to signal it.

The metadata regression failed on dgx02 before its correction. Header-sensitive
and executable-selector fixtures retain all archive, timeout and integrity
negatives. Protocol fakes exercise the application/role/context/telemetry and
third-request refusals; they are not native-version qualification evidence.
Diagnostics contain bounded closed labels, booleans and counts only, and are
never admission data or native content. Final committed-head gate and review
evidence are recorded in the PR/task.
