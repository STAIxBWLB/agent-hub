---
id: adapters
type: module
title: Native Adapters and Spawned Agents
status: draft
parent: agent-hub-architecture
paths:
  - src/adapters/**
  - src/pi/**
  - src/hub/peers.ts
  - src/hub/permission-mode.ts
  - src/hub/tool-refusal.ts
  - src/hub/child-process.ts
  - src/hub/lifecycle.ts
  - src/hub/start-mode.ts
  - src/hub/terminal-open.ts
  - src/memory/capture.ts
  - src/hub/native-hook-launch.ts
  - src/hub/peer-catalog.ts
  - src/cli/configured-acp-entry.ts
  - src/cli/agy-mcp.ts
  - src/cli/kimi-mcp.ts
  - src/cli/jcode-mcp.ts
  - scripts/benchmarks/teardown.ts
  - src/hub/action-enforce.ts
  - src/hub/read-only-shell.ts
  - src/hub/read-only-shell-proof.ts
  - src/hub/operational-authority.ts
  - src/hub/permission-payload.ts
  - src/hub/claude-shell-wrapper.ts
  - src/hub/task-shell-command.ts
  - src/hub/task-shell-default.ts
  - src/hub/task-shell-proof.ts
  - src/hub/task-shell-sandbox.ts
  - src/cli/claude-shell-wrapper.ts
covers: [adapters]
tags: [agent-hub, dogfood]
---

# Native Adapters and Spawned Agents

This module records how vendor protocols meet the hub. For operational rules see the [adapter](../agent-notes/adapters.md), [daemon](../agent-notes/daemon.md), [local-worker](../agent-notes/local-worker.md), and [model](../agent-notes/models.md) notes, and the [new-adapter guide](../adding-an-ai-tool.md).

## Registry and host boundary

Each peer kind is described by an `AdapterDefinition` in the registry. Per-kind launch, protocol, and permission details stay with that definition; the daemon consumes registry fields rather than spreading vendor-name branches through policy. `PeerAdapter` is the runtime interface for delivery, turn state, permission acknowledgement, lifecycle, and optional host evidence. The host owns identity, admission, audits, task role checks, and effects; an adapter reports facts but cannot certify its own authority. This keeps a new transport from changing common policy accidentally ([#451](https://github.com/STAIxBWLB/agent-hub/issues/451), [#625](https://github.com/STAIxBWLB/agent-hub/issues/625)).

Optional ports have explicit meaning: absent keeps the generic path, while present-but-unknown refuses where the port gates a safety decision. Native evidence stays with the party that can observe it: the daemon retains host launch and socket-generation records, while a protocol adapter retains in-protocol evidence such as a thread's native sandbox or approval state. This prevents a configured adapter from asserting proof it does not possess ([#625](https://github.com/STAIxBWLB/agent-hub/issues/625)).

Adapters translate different interaction surfaces without changing the peer's task identity. Claude's plugin channel connects through MCP and the hub control service; Codex is proxied through app-server; ACP peers share an ACP transport; Pi uses its extension bridge. Kimi defaults to a pull-only TUI, with headless ACP as a separate selected form under the same peer id. The TUI does not inherit headless push, session, or recovery behavior. Keeping forms distinct lets the hub preserve the native user interaction model while enforcing one role and delivery policy ([#316](https://github.com/STAIxBWLB/agent-hub/issues/316), [#625](https://github.com/STAIxBWLB/agent-hub/issues/625)).

## Channel attachment evidence (#1171)

The Claude plugin's inherited launcher marker is insufficient to enable push. In the inspected Claude Code 2.1.318 client path, MCP initialization advertises no usable channel opt-in; the plugin's server capability is not client evidence. The fallback checks the direct parent's bounded process row for the existing launcher's exact leading development-channel flag and supported target. Unknown, malformed, truncated or changed-parent evidence, print/background forms and repeated flags keep the plugin tools-only, with messages waiting for `hub_inbox`. The check does not walk ancestors or treat the marker as an authorization token.

The flattened process row is a conservative launch observation, not authentication or proof of registration or model consumption. Unsupported invocation layouts remain pull-only. An attached peer's status reports its mode and a closed evidence label without command text. Evidence belongs to that socket's attachment and is omitted when no current attachment exists. Older clients that omit the optional evidence field retain their prior behavior and report `unreported`; no control protocol version changes. The separate delivery-settlement contract handles an accepted notification that remains unconfirmed. The [investigation report](../verification/2026-11-04-1171-channel-client-evidence.md) distinguishes static client inspection, passive process observation and synthetic fixtures.

## Accepted channel delivery settlement (#1172)

Only an attached push channel opts into explicit disposition of its own accepted delivery. An `accepted` receipt acknowledges that the notification was accepted by the channel transport; it is not a native handling or task-completion signal. The host reads `bus.accepted_settle_ms` from accepted configuration on its existing maintenance sweep, defaulting to ten minutes. A row that remains unconfirmed becomes `needs_review` with no replay. `hub_inbox` returns bounded id/revision metadata for the channel's accepted and held rows, including when an accepted push prevents the pull itself. The plugin renders that metadata and avoids both an empty-inbox claim and polling advice while there is an actionable row. Important, task and review timeouts produce one durable status-kind, status-priority conductor message containing ids only when the existing `conductor.feed` policy is on; `feed: off` remains an opt-out. Pull-only sessions do not gain the explicit accepted-disposition port.

## Permissions, execution, and process ownership

Permission modes control whether native actions prompt; they do not widen a sandbox or path grant. The local worker's file tools use path guards, and its command tools run through the host's OS sandbox. Vendor-native tools use their vendor/runtime permission and isolation boundaries; the hub does not claim to confine every ACP or TUI tool. This distinction prevents an approval-mode setting from being mistaken for filesystem or network confinement ([#242](https://github.com/STAIxBWLB/agent-hub/issues/242), [#39](https://github.com/STAIxBWLB/agent-hub/issues/39), [#270](https://github.com/STAIxBWLB/agent-hub/issues/270)).

When the hub starts a child, the host constructs its environment, binds its launch and generation, and owns its process-group lifecycle. Stop and recovery require current evidence for the process actually started; a PID, adapter label, successful start call, or stale session record is not enough. This keeps teardown from signaling a person's unrelated process and prevents a late native callback from acquiring a replaced session's authority ([#115](https://github.com/STAIxBWLB/agent-hub/issues/115), [#625](https://github.com/STAIxBWLB/agent-hub/issues/625)).

Permission decisions are bound to the authenticated caller and current session. A hub CLI call inside an agent session acts as that peer, not as the person; role and task checks still apply at each tool boundary. Permission modes are person-controlled, and a conductor role does not grant them. This avoids turning a received message into user consent ([#193](https://github.com/STAIxBWLB/agent-hub/issues/193), [#242](https://github.com/STAIxBWLB/agent-hub/issues/242)).

## Model, account, and memory boundaries

Subscription-based native CLIs keep their own account authentication; those credentials are not pooled through the hub. Hub-owned inference, including internal summaries and local-worker model calls, uses the in-process model route and OmniRoute provider boundary. Prompt text may inform configured routing, but it cannot grant credential access or replace host routing policy. This separates native subscription identity from hub service credentials ([#553](https://github.com/STAIxBWLB/agent-hub/issues/553)).

The PII screen is distinct from ordinary optional inference. It may use an on-device model; a gateway screen requires positive on-campus admission and `onCampusOnly`. If no allowed path returns a closed `clear` or PII verdict before the deadline, the result is unknown and handled as private. This keeps network and model uncertainty from becoming a disclosure ([#198](https://github.com/STAIxBWLB/agent-hub/issues/198)).

Runtime memory capture and recall use the in-process `@staix/agent-mem` package, screened and invoked by host integration. claude-mem is off by default and import-only; there is no worker HTTP or model-summary path in the runtime. This avoids a parallel capture route with different privacy checks ([#752](https://github.com/STAIxBWLB/agent-hub/issues/752), [agent-mem#13](https://github.com/STAIxBWLB/agent-mem/issues/13)).

## Compatibility and external modules

Native CLI compatibility is centralized in `compat.ts`. Each gated operation asks that policy for a verified, in-contract, person-trusted, or refused result; person trust for one exact version does not skip a separate isolation or runtime proof. This lets upstream versions change without turning an untested protocol assumption into support ([#691](https://github.com/STAIxBWLB/agent-hub/issues/691)).

External adapter modules are an explicit, person-owned, machine-local opt-in. The daemon verifies and pins the captured bundle at startup, then admits only the bounded headless ACP instance contract through host-managed launch and current-owner checks. Module code runs in the daemon trust domain; pinning is integrity evidence, not a sandbox. Modules cannot supply native reviewer engines, proof ports, permission callbacks, provider selectors, or arbitrary recovery authority. This ceiling limits what imported code can claim and prevents live reload from replacing the executable catalog ([#754](https://github.com/STAIxBWLB/agent-hub/issues/754)).

`questionWaitMs` (#1053) is the time a `hub_ask` call waits for the person before it answers `pending`. It is a fixed-builtin field like `title`: `assertNativeCapabilityScope` refuses it on a configured or external definition, and the person overrides it per kind with `questions.wait_ms.<kind>`, never the caller. MCP peers carry 45 s, Pi and the local worker 300 s, provisional until the live timeout measurements of #1053 T1.

`settle` (#1054) is the code-verified signal that ends a peer's logical run, so the hub can create a completion for a run a person started. It is a fixed-builtin field like `questionWaitMs`: `assertNativeCapabilityScope` refuses it on a configured or external definition. **Owner decision 2026-11-04 (issue #1054):** completions exist only for adapters whose signal the T1 audit verified in code. Claude's TUI (`native-stop`: the transcript-verified Stop, never a lost channel or watchdog) and headless implementer, Codex (`turn-completed`), Pi (`agent-settled`, its own event: the `agent_end` plus retry/compaction fallback is not implemented), the local worker (`route-outcome`), ACP Kimi and Jcode headless (`prompt-response`) and the Qwen TUI (`message-stop`) declare one. **Absent means no completions:** Kimi in its own TUI (pull-only, no signal), agy (its declared `native-hook` signal is not verified end to end) and phase-2 person-typed Codex turns declare none, and the daemon starts no run for a peer attached pull-only. agy joins after a live receipt verifies its Stop readback and completion row; Codex person-typed turns after an origin receipt. The settle rule, outcomes and restart reconstruction live in `src/hub/completions.ts` and `src/hub/completions-store.ts`; a run settles only when the adapter signal fired AND no queued continuation, open permission or question, owned child, running check or held delivery remains.

## Session title slots

Only fixed Pi and local definitions opt into `title: "hub"` (#1055). Their
standalone `hub_set_title` schema is excluded from native-peer tool lists, and
the daemon independently checks the resolved definition and current owner.
An agent fills only an unnamed slot; a person's console rename replaces it.
Pi's native session name is canonical and its bridge rechecks the native name,
owner, session and generation before writing. Local keeps its name in the
worker's existing in-memory session. Both expose a separate `titleSession`
identity for display continuity; Local's native-session/provenance authority
does not change. Titles pass the current metadata/privacy screen at write and
display. No helper inference or task/Git/instance naming path is involved.

Refusals keep the `already_named`, `private` and `invalid` reason codes and
include a public `error` explaining the cause and next step. Errors identify
length, offline/owner, session/generation and confirmation failures without
copying the supplied title or private details. If a write might have landed,
the result says it may have been applied and directs the caller to inspect
`ahub status` before retrying.

An unnamed label is derived from the first positively acknowledged original,
never stored as a name. The #1055 restart-recomputation design is amended with
`session-title-inputs.json` under the daemon state directory: the journal does
not itself bind an original delivery to the recipient's native session.
Only fixed definitions declaring `titlePersistence: "native"` retain restart
bindings. This private, atomically replaced file maps each retained peer ID
to exactly three opaque IDs, `session`, `delivery` and `envelope`. It contains no source body,
session title or derived label. Only the first positive delivery acknowledgement
for a peer's current title-session can create or replace its entry;
`hub_set_title` and person rename never write it.

The file is limited to 128 peer entries and 64 KiB of serialized UTF-8,
including JSON formatting and the final newline. Each stored ID is nonempty,
at most 512 UTF-16 code units, and excludes control and format characters.
An unreadable, malformed, oversized, symlinked or multiply linked input is
ignored. Capacity or write failure leaves delivery successful and makes that
new restart binding unavailable.

Native-session bindings survive daemon stop/restart until replaced by the
first acknowledged delivery of a later session for that peer, or until the
state directory is removed. Entries for removed instances are dropped when
their removal applies. Local's session exists only in daemon memory and gets
a fresh ID each start, so its binding is not retained on disk; startup removes
legacy Local entries. A stale native-session entry grants no display value: restore
requires the same title-session ID and the original still retained in that
project's journal. A different session or pruned original yields no inherited
label. There is no separate retention of message text and no timer or automatic
replay. The derived label remains absent from disk status, events, logs,
capture and rooms.

Incoming-message labels are visible only to the console and the configured
conductor. Other status readers receive `unnamed`. A label has its own source
tag and explanation: its text comes from an incoming message and is never
attributed as speech written by the session's peer. Public-metadata screening
and private stubs still apply to authorized label viewers.

## Evidence boundary

Compatibility probes and fake transports verify source contracts, not an account login, live model turn, native permission prompt, or operating-system isolation. Those receipts remain separate because protocol inventory alone cannot prove runtime behavior ([#625](https://github.com/STAIxBWLB/agent-hub/issues/625), [#754](https://github.com/STAIxBWLB/agent-hub/issues/754)).

## Owned print input admission (#1056)

A trusted owned adapter can accept an envelope before it has chosen the actual model-input session. Reviewer print children choose a fresh isolated context per review; the Claude implementer selects a persisted task-session UUID and may replace it after verified missing-transcript evidence. Their host-only input guard runs with that final target identity before prompt data can reach the backend or native child. It persists quote-bearing provenance before exposure. A failed guard releases no prompt and retains the adapter's owned teardown rules.

Owned observer-context IDs identify the history the host controls. They do not populate `nativeSession` or grant budget, resume, permission or task authority; an unrelated title or socket identity is not a substitute. Local's observer identity belongs to its in-memory history. Retained external native sessions keep their confirmed native identity, including across a launch change. Persistent implementer input keeps the same observer identity when its task session is resumed.

A successful stdin handout may confirm ordinary-input replacement for the matching context and input token. This is metadata about handing over bytes, not native handling, task completion or a new transport ACK. Old callbacks cannot release a newer input hold. The bus journal keeps its original transport receipts separately from this actual native-input observation. A fresh reviewer context may discard its own observer receipt only after its process group is confirmed gone, its task MCP bridge is closed and launch cleanup succeeds. The host retains the turn exclusion through remaining diagnostics. Persistent implementer and retained native histories do not acquire that disposal rule.

When a quote-bearing review reaches a peer without a stable native session ID, the host commits a peer-scoped incomplete marker before handoff and keeps the observer exclusion in daemon memory. A failed marker write refuses the handoff. An ordinary input within the review's active turn is staged and cannot release that turn's final outputs; the host clears only the peer marker at the next turn boundary while that ordinary input remains current. An ordinary input in a later turn, or while no turn is active, clears only that peer marker after verified handoff when the peer has no earlier SID-specific hold or incomplete record. If any earlier positive hold or SID-specific incomplete marker exists and the current SID is unknown, ordinary input cannot release the hold; status asks the person to reconnect so the native session ID can be confirmed. A confirmed native session change clears only the peer marker, then the host checks the exact-session receipt. If the current daemon has RAM evidence of a quote handed out while unbound, it first stores a positive receipt under the newly confirmed SID. Other SID receipts remain intact. The daemon keeps the quote's admission-turn fence in RAM separately from the active turn id, which adapters may rebind. No launch, attachment, socket or runtime UUID is persisted as a substitute session ID. Positive held receipts for a known pull-only session remain sticky until a confirmed session change. Positive held receipts are expected state, not a health failure. Status reports incomplete or corrupt provenance with a bounded cause and next step; repair guidance preserves delivery and task state.

## Local review turns (#1056)

The local worker binds review observer exclusion to its actual input envelopes before awaiting model or tool work. An anchored `hub_review` submission latches that exclusion for the rest of the batch/turn, including sibling and later tool calls. While latched, `hub_remember` and `hub_task_propose` are refused before reaching the host task tools; the caller can retry them in a later ordinary turn. Such turns do not call capture, commit review messages into later model history, or put provider error text and partial model text in failure logs. A later ordinary local turn resumes ordinary history and capture without inheriting the review payload. This is distinct from the PII policy: a public review package retains ordinary task authority and does not acquire an on-campus-only model route. Vendor-native histories remain owned by their adapters; the hub's current-turn and named-parent observer provenance is described in [the bus contract](bus.md#review-observer-provenance-1056).
