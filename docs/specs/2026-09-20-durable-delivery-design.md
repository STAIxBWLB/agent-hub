# Durable delivery and supervised operations

Status: Implemented on `feat/durable-delivery-operations`; release application pending
Date: 2026-09-20
Target: 0.7.0, protocol 10

## Intent and acceptance

Make ahub suitable for supervised daily development: expose disconnected recipients' pending work, survive daemon termination without silently losing accepted queued messages, and make uncertain execution an explicit operator decision. Publish an English operations guide and verify the release before applying it to the current installation.

The user chose conservative recovery and deployment through production application. Never automatically replay uncertain or partially executed work. Exactly-once external effects, automatic rollback, and unattended native approval handling remain outside this release. Infrastructure prerequisites in issue #12 remain pending unless independently available; never manufacture quota exhaustion or disconnect the user's network.

## Delivery model

- Journal delivery state in the private project SQLite database with WAL, synchronous FULL, instance fencing, and private file permissions.
- Commit fan-out recipients before acknowledging submission or dispatching any recipient. Preserve original envelopes and condensed-delivery mappings, IDs, priority/order, trace/hops, attempts, withdrawal state, prefaces and manual pauses.
- States: queued, dispatching, accepted, completed, needs_review, failed, discarded. Persist handoff before invoking native delivery/steering. Adapter acceptance is not execution completion.
- Recover queued messages automatically. Unsettled dispatching/accepted records become needs_review after an unplanned stop. Hold subsequent deliveries for that recipient until review is resolved.
- Automatic retry requires positive evidence that delivery was not accepted or execution caused no effects. Timeouts, disconnects, cancellation and partial effects are uncertain.
- Claude bridge acknowledgement only confirms bridge receipt. Socket writes, bridge submission and idle state never prove execution completion. Native completion or an explicit correlated reply may settle a receipt.
- Persist failure/overflow outcomes; retain unresolved records indefinitely and bound resolved history with the existing deduplication window. A persistence fault stops dispatch and rejects successful-submission claims.

## Interfaces

- Peer delivery and steering receive an optional delivery ID. Adapters emit correlated accepted/completed/failed_safe/needs_review receipts separately from their state or answer.
- Queue-only recipients appear offline in status with pending, important, needs-review counts and oldest queued timestamp. Broadcast and automatic assignment remain attached-peer operations; explicit known offline recipients can queue work.
- Console commands: `ahub queue list [--peer <id>] [--json]`, `queue show <delivery-id>`, `queue resolve <delivery-id> --action completed|retry|discard --reason <text>`.
- Resolution uses an observed revision, records the operator assertion and reason, and is idempotent. Retry closes the old record and creates exactly one linked attempt. Stale or conflicting resolutions fail.
- New public status/recovery surfaces expose metadata; detailed console inspection follows existing private-envelope/PII redaction. No private body enters shared memory or public logs.

## Recovery compatibility

Protocol 10 carries the receipt contract. The new coordinator supports authenticated protocol 9 sources and protocol 10 targets, plus protocol 10 restarts. Unsupported combinations are rejected before shutdown; legacy protocols use their matching documented bootstrap.

A legacy controlled-restart snapshot is imported exactly once into an uninitialized journal. An initialized journal remains authoritative; repeated starts and released snapshots cannot resurrect work. New snapshots carry the journal revision/state needed to validate preservation. Unsupported downgrade is refused before mutation.

Stage the verified 0.7.0 artifact and run its retained coordinator for the initial 0.6.4-to-0.7.0 transition. Promote the global CLI only after verification. Preserve existing queued Codex envelopes, tasks, pauses and native session identity. Do not start hwp-cli or rewrite the divergent ai-workspace history.

Recovery diagnostics distinguish missing session identity, terminal ownership uncertainty, confirmation pending and delivery reconciliation. Report the affected peer, verified terminal reference and next action; never fabricate receipts, bypass approval dialogs, or blindly create another terminal.

## Documentation

Update README and quickstart, add an English operations guide covering installation, managed launchers, a two-agent task/review workflow, targeted messages and priorities, approvals, queue resolution, graceful shutdown, upgrades, crash recovery and partial effects. Record real measurements separately from synthetic tests. Remove stale version pins and outdated compatibility statements.

## Verification

- Subprocess fault injection at durable enqueue, condensation, handoff, steering, acknowledgement and completion boundaries; only disposable processes may be killed.
- Ordering, fan-out independence, overflow, retry exhaustion, withdrawal, dedupe, manual pauses, storage failure, corruption, stale-instance callbacks and migration interruption.
- Idempotent resolution and snapshot import; no uncertain effect automatically repeated. Verify every adapter's receipt semantics, including silent completion and bridge failure.
- CLI/dashboard parity for queue-only peers and redaction/access-control checks.
- Full repository gate and Ubuntu/macOS CI, fresh-install documented workflow, real MLX/DGX/Kimi tests and attended Claude recovery.
- Actual 0.6.4 package transition to protocol 10, then production application with version, session, queue, task and budget readback and a read-only Pi probe.

## Work items

- [x] Durable journal and bus recovery.
- [x] Adapter delivery receipts and safe failure classification.
- [x] Queue operator controls and status/dashboard visibility.
- [x] Cross-version recovery compatibility and actionable diagnostics.
- [x] English guides and recorded live evidence.
- [ ] Fault tests, independent review, CI, release and verified application.

## Integration decision

The journal, adapter receipt contract and wire change are delivered in one coherent implementation PR, reviewed by subsystem. Shipping intermediate incompatible interfaces would leave a falsely durable runtime. The queue remains a durable snapshot until handoff; receipt rows retain handoff and resolution history. An operator retry atomically links a queued attempt and updates the bus snapshot.

An identical operator action/reason may be repeated with its original observed revision or the freshly read terminal revision. Both return the existing result without another audit transition or retry enqueue. Conflicting actions/reasons and unrelated stale revisions are refused.
