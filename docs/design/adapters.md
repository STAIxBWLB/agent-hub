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

## Qwen deny input fence (#888)

A successfully appended `allowed: false` has a known delivery disposition, but
no native completion ACK. The delivery remains `completed` without an answer;
the adapter stays non-ready with a host-persisted `denyPending: true` latch in
its existing state file. Persistence must succeed before the append. No BasePeer
settlement policy or other adapter's readiness behavior changes.

The denied turn's assistant/Stop, orphan Stop, result, approval response and
elapsed silence cannot release the latch. Release requires either a newly
observed same-session personal USER followed by that personal turn's normal
`end_turn` assistant and `message_stop`, with uninterrupted generation and verified
owner identity, or a verified fresh launch generation with native session/version
and a new verified owner. The event-file byte watermark uses raw newline offsets
to exclude pre-deny frames. A recovery USER must begin wholly at or after the
deny/adoption EOF boundary; finishing an older partial line never qualifies.
Malformed, invalid UTF8, oversized or unsupported
evidence invalidates unfinished proof; control/tool frames cannot preserve a
candidate final assistant for a later orphan Stop. A failed persisted clear
restores the latch and goes offline before advisory callbacks, with a storage
and permissions cause that remains until a successful clear, even if a logger
or notice throws.
For a fenced fresh launch, a host process-table baseline must positively show
no existing process naming the exact input path before any rotation, truncation
or launch preparation. An unknown table or unverified existing root leaves
those files unchanged and produces no launcher; a missing saved owner is never
evidence of absence. Ordinary trusted-owner adoption retains its prior behavior.
The fenced path also requires a positively verified empty event file before
input truncation or launch preparation. Failed event rotation or empty-file
verification leaves input unchanged and produces no launcher; old session_start
bytes cannot bind a later owner as fresh generation proof.
Detach, changed file/session/owner and adoption invalidate an unfinished personal
proof; restored buffered frames cannot supply a new personal USER. Same-generation
readability and replayed session_start never supply fresh launch proof.
Every fenced reattachment moves the watermark to restored EOF, including when
the inode is unchanged. A buffered partial USER completed after reattachment is
also excluded. Use a plain, tool-free clearing prompt and wait for its final
Stop: tool/control activity can invalidate the pending final-assistant candidate;
recovery through a tool-assisted turn is not promised.
Fenced personal and fresh-generation recovery only mark a RAM completion
candidate; neither the parser nor the owner monitor reopens input. Release waits
until the whole observed read frontier has been processed, no partial/discarded frame
remains, fresh FD EOF equals the consumed offset, the named file still matches
that FD, and owner/session/generation remain current. A later USER/tool/control
or lost frame invalidates or replaces the candidate before release. This proves
only the observed frontier: a future personal input after the final observation
would require an explicit serialized native idle ACK for an atomic guarantee,
which this protocol does not provide.
Fresh candidates bind the actual new launch generation, verified empty source,
first accepted session header and new owner. A replayed header cannot reset
activity or manufacture fresh idle proof after a later USER/tool/control frame.

`QWEN_DENY_QUIESCENCE_MS` is a 30 s operational wait. Expiry reports offline,
keeps the latch and queued messages unsubmitted, and directs the person to their
terminal or `ahub qwen --mode tui`. Passive recovery remains possible after expiry.
General adoption of an unknown running turn outside this latch retains its prior
ceiling. These source/fake controls do not qualify a new native completion signal.

Every append writes one complete UTF8 Buffer once and checks its byte count.
A short count or writer exception retains the delivery as `needs_review` and
goes offline without retrying a remainder. Errors after the writer call,
including close failure after a full byte count, retain the same uncertainty.
A non-newline input tail, checked
before append and attachment/readback, likewise fences input. Personal completion
cannot reopen this file: a verified fresh generation must start with fresh input.
The live ambiguous-write latch is RAM-only; after a crash the actual tail is the
guard. A torn prefix that happens to end with newline remains undetected. The
upgrade path if that failure is observed is a durable per-write intent record,
not a synthetic native ACK or an automatic remainder write.

## Channel attachment evidence (#1171)

The Claude plugin's inherited launcher marker is insufficient to enable push. In the inspected Claude Code 2.1.318 client path, MCP initialization advertises no usable channel opt-in; the plugin's server capability is not client evidence. The fallback checks the direct parent's bounded process row for the existing launcher's exact leading development-channel flag and supported target. Unknown, malformed, truncated or changed-parent evidence, print/background forms and repeated flags keep the plugin tools-only, with messages waiting for `hub_inbox`. The check does not walk ancestors or treat the marker as an authorization token.

The flattened process row is a conservative launch observation, not authentication or proof of registration or model consumption. Unsupported invocation layouts remain pull-only. An attached peer's status reports its mode and a closed evidence label without command text. Evidence belongs to that socket's attachment and is omitted when no current attachment exists. Older clients that omit the optional evidence field retain their prior behavior and report `unreported`; no control protocol version changes. The separate delivery-settlement contract handles an accepted notification that remains unconfirmed. The [investigation report](../verification/2026-11-04-1171-channel-client-evidence.md) distinguishes static client inspection, passive process observation and synthetic fixtures.

## Person takeover of a channel peer (#1174)

An opted-in channel process may retain a live, non-owning standby connection when
a current session holds the peer. The adapter keeps a bounded standby registry;
status exposes only its server-generated connection id, reported PID when present,
and arrival time. These values are display metadata, never native session ids,
launch/isolation evidence or caller authority. Every standby peer operation is
refused centrally until that exact socket owns the attachment.

The person's `peer_takeover` control request, used by `ahub peer takeover <peer>`
and the console, selects an explicit live standby id or the oldest eligible one.
The host checks person authority, current membership and lifecycle fences before
detaching the old ownership; the selected claim/preface reuses normal admission
and generation checks. A `requested` result means attachment is pending, not
completed. Socket detachment never stops the native process, grants no delivery
receipt and replays no work. Unconfirmed deliveries keep ordinary settlement.

The old plugin reports a fixed person-detachment cause and stops reconnecting.
A legacy plugin receives an already-terminal refusal so it cannot undo the
handover, but may report its older generic admission message until upgraded.
Older daemons retain their existing close-and-retry standby behavior. An ordinary
owner departure may release an eligible standby through normal claim admission;
a standby never evicts a live owner without the person's takeover operation.

The detailed status the console reads also names the current owner (#1310), so it is never
inferred from standby rows, process start times or attach order. `ownerAttachment` holds the
current socket's bounded `ownerPid` when it reported one, `attachedAt` (when the asynchronous
attach completed, not the earlier hello), and `nativeSessionId` only after the host bound a native
session through its verified native-facts path and only when it is a short plain token. It is
absent while a newer hello is claiming, while offline, and after a detach, roster removal or stop,
and a new attach replaces every field in one step, so a previous owner's pid, time or native
session never sits beside the new socket. It is display metadata, never authentication, delivery,
takeover or permission evidence. It carries no environment, argv, cwd, credential, prompt, title
or text, adds no event, log or memory payload, and is withheld from `status.json` and every
non-console reader. The field is additive and optional; no control protocol version changes.

Status `peerVersions` says, per peer, which agent-hub code that peer has loaded (#1385). It sits
beside `peers`, as `roleInfo` does, so the legacy peer row keeps its shape (#295). The optional
`hubClient` port belongs to an adapter whose agent-hub code runs in another process (the Claude
channel's `WsPeer`); an adapter without it runs inside the daemon and reports
`ahub: { runs: "daemon", version }`. With the port, the entry reports `runs: "client"` and the version
the attached socket's hello sent as `clientVersion`, `unreported` for a hello without one, and no
`ahub` field while nothing is attached. `ahubTools` lists the sorted distinct versions the peer's
open `tools` connections reported. The daemon keeps a reported version only when it is a plain
semver of at most 64 characters (`displayVersion`, `src/version.ts`); anything else is unreported.
The fields are display only, never compatibility, admission or protocol evidence, and are
additive: an older daemon ignores `clientVersion`, and an older console ignores both fields.

## Accepted channel delivery settlement (#1172)

Only an attached push channel opts into explicit disposition of its own accepted delivery. An `accepted` receipt acknowledges that the notification was accepted by the channel transport; it is not a native handling or task-completion signal. The host reads `bus.accepted_settle_ms` from accepted configuration on its existing maintenance sweep, defaulting to ten minutes. A row that remains unconfirmed becomes `needs_review` with no replay. `hub_inbox` returns bounded id/revision metadata for the channel's accepted and held rows, including when an accepted push prevents the pull itself. The plugin renders that metadata and avoids both an empty-inbox claim and polling advice while there is an actionable row. Important, task and review timeouts produce one durable status-kind, status-priority conductor message containing ids only when the existing `conductor.feed` policy is on; `feed: off` remains an opt-out. Pull-only sessions do not gain the explicit accepted-disposition port.

The channel's `hub_inbox` also renders the authenticated caller's bounded public held-body view (#1328 AC6), labelled read-only and uncertain. It occupies a separate MCP text content block, preserving the first block for queued/local messages, notices and existing held hints. It does not confirm, retry or resolve the earlier attempt. Malformed or unavailable additive held data produces a fixed warning while preserving normal pulled text, local failed-push messages and queue counts. A foreign peer argument grants no access; other-peer inspection remains with the person or configured conductor through queue diagnostics. Current privacy and owned task/session fences are checked by the daemon before exposure.

## Permissions, execution, and process ownership

Permission modes control whether native actions prompt; they do not widen a sandbox or path grant. The local worker's file tools use path guards, and its command tools run through the host's OS sandbox. Vendor-native tools use their vendor/runtime permission and isolation boundaries; the hub does not claim to confine every ACP or TUI tool. This distinction prevents an approval-mode setting from being mistaken for filesystem or network confinement ([#242](https://github.com/STAIxBWLB/agent-hub/issues/242), [#39](https://github.com/STAIxBWLB/agent-hub/issues/39), [#270](https://github.com/STAIxBWLB/agent-hub/issues/270)).

When the hub starts a child, the host constructs its environment, binds its launch and generation, and owns its process-group lifecycle. Stop and recovery require current evidence for the process actually started; a PID, adapter label, successful start call, or stale session record is not enough. This keeps teardown from signaling a person's unrelated process and prevents a late native callback from acquiring a replaced session's authority ([#115](https://github.com/STAIxBWLB/agent-hub/issues/115), [#625](https://github.com/STAIxBWLB/agent-hub/issues/625)).

Fresh Kimi reviews keep the complete synchronous isolation fence before spawn and
at verdict/task-MCP authority boundaries. Periodic full checks use one review-owned
worker with expected paths and fingerprints, no serialized task text or inherited
environment, and boolean replies. A serialized 100 ms absolute cadence coalesces
missed ticks without overlapping checks or adding a fixed delay after a slow check.
Worker results cannot grant or restore authority. Revocation fences the exact
child/review sequence; worker termination and join precede private-profile removal
and confirmed input cleanup, including failed native teardown. An unconfirmed join
retains ownership and the profile for an explicit stop retry ([#1284](https://github.com/STAIxBWLB/agent-hub/issues/1284)).

Permission decisions are bound to the authenticated caller and current session. A hub CLI call inside an agent session acts as that peer, not as the person; role and task checks still apply at each tool boundary. Permission modes are person-controlled, and a conductor role does not grant them. This avoids turning a received message into user consent ([#193](https://github.com/STAIxBWLB/agent-hub/issues/193), [#242](https://github.com/STAIxBWLB/agent-hub/issues/242)).

## Confined guidance probe lifecycle (#1226 T2)

The host-only `LocalPeer.runProbe` / `stopProbe` path reuses the local model/tool
loop on a fresh private peer that never joins Bus or ordinary recovery. Ordinary
`deliver` retains its existing behavior. Probe purpose suppresses ordinary
capture, history, messaging, titles, route/usage/progress observers and learning;
private correlated admissions and usage records remain separate. Stop closes
new admissions and joins the actual run and owned cleanup before claiming
quiescence. Unknown work retains its handle and hold.

The [guidance probe contract](guidance-probes.md#t2-confined-adapter-contract)
owns the complete-request binding, role input matrix, fixed model, resource
reservations, path guards and verified deny-only sandbox. Its v1 tool capability
is read/write/edit only. No arbitrary subprocess, hub, memory, package or network
tool is available. The adapter factory is not wired into the daemon; source and
fake-model checks and the model-free macOS boundary canary are separate from a
real model/worker trial, which has not been authorized.

## Model, account, and memory boundaries

Subscription-based native CLIs keep their own account authentication; those credentials are not pooled through the hub. Hub-owned inference, including internal summaries and local-worker model calls, uses the in-process model route and OmniRoute provider boundary. Prompt text may inform configured routing, but it cannot grant credential access or replace host routing policy. The optional local-worker adec consumer (#554) releases only bounded host-screened evidence, after campus/privacy and observer admission; native account, TUI, reviewer and task-assignment authority are unchanged. Shadow preserves the gateway model/effort and conversation; enforcement is refused at configuration load and no pair is applied. An explicit live model override bypasses the decision service. Current board/turn privacy and observer authority fence the optional request across waits and its proposal before telemetry; an authority change refuses the stale turn, and the refusal is not converted into a fixed-model fallback. There is no new gateway or native turn/spawn effort path. This separates native subscription identity from hub service credentials ([#553](https://github.com/STAIxBWLB/agent-hub/issues/553)).

R2 uses that same separation for `plan_execute` phase and `advisor`/`escalation`
judge model/effort suggestions. The hub retains phase transitions, judge
triggers and verdicts, escalation confirmation and actual fallback execution;
the service has no authority over native account identity, peer assignment or
provider calls. A `decisionTarget: "judge"` event is bounded metadata, not a
served-model or usage record.

The PII screen is distinct from ordinary optional inference. It may use an on-device model; a gateway screen requires positive on-campus admission and `onCampusOnly`. If no allowed path returns a closed `clear` or PII verdict before the deadline, the result is unknown and handled as private. This keeps network and model uncertainty from becoming a disclosure ([#198](https://github.com/STAIxBWLB/agent-hub/issues/198)).

Runtime memory capture and recall use the in-process `@staix/agent-mem` package, screened and invoked by host integration. claude-mem is off by default and import-only; there is no worker HTTP or model-summary path in the runtime. This avoids a parallel capture route with different privacy checks ([#752](https://github.com/STAIxBWLB/agent-hub/issues/752), [agent-mem#13](https://github.com/STAIxBWLB/agent-mem/issues/13)).

## Observed turn model (#1402)

An adapter may implement `PeerAdapter.observedModel()`: the model its native surface reported for the turn that just ended, as `{ model, evidence }`. The daemon reads it once, when it writes the peer's `turn_end`, and passes it through `turnModelFields`: the event carries `model` (the id exactly as reported, through `safeModelLabel`) and `modelEvidence` (`served`, `session` or `configured`, strongest first) or neither. A label `safeModelLabel` refuses is dropped whole, never truncated, and an alias (`opus`, `default`) is never expanded. An adapter that reports nothing, or throws, records nothing: unknown stays unknown. The per-adapter sources (Codex, Claude print, ACP peers, Pi, Antigravity) are wired by the later tasks of #1402; research builds `ownerModels` from the owner's turns only (`docs/research.md`).

## Person-owned live model selection (#1317)

A person may store a per-peer model override in `hub.db` with `ahub model set`,
clear it with `ahub model clear`, or inspect it with `ahub model list`. The CLI
uses the settings command's identity boundary, but all model subcommands are
person-only, including list. Dashboard changes use the existing person settings
session and preview/confirm flow. No hub tool, conductor role or agent shell
receives this authority. Provider, account, native home and executable changes
remain on their existing machine-local configuration paths.

The host stores desired state independently of an active turn. A model selection
is captured once at the next supported turn/review boundary and stays unchanged
through steering and local tool rounds. Captured application callbacks bind the
exact adapter owner and turn; they cannot mark a newer desired revision applied.
Two changes before a turn leave the last desired value. Status distinguishes the
effective selection, its source, a pending next-turn value and unsupported live
selection; a desired row alone is never evidence that a native model accepted it.
The precedence is override, instance model, launch model, then native default,
where the surface already supports that source. An unknown native default stays
unknown rather than becoming an invented model id.

Claude headless implementers select `--model` per spawned turn; codex-review
selects `-m` per isolated review spawn. Supported Codex app-server `turn/start`
requests carry `model` only for an override, alongside the existing permission
policy. Both hub-delivered and client-forwarded app-server `turn/start` paths
support it, but an explicit client model (for example the person's native
`/model` choice) wins and is never rewritten. The app-server retains a
`turn/start` model as its thread default. Clearing the hub override returns
selection to that current native default; it does not reconstruct an earlier
thread model. Native client acceptance does not certify a conflicting hub
override as applied. Raw or pull-only `WsPeer` TUI attachments remain unsupported.
When clear retains an acknowledged former override as the thread default,
status labels its source `native thread default (was override)`. A rejected
start retires its unused capture so a later start can sample a corrected choice;
an older rejection cannot retire a newer accepted or pending start.
`turn/steer` never acquires a model field. Local uses the existing direct
OmniRoute model path for an explicit override while retaining budget, campus,
observer and generation guards. Pi reuses its model-selection path at the next
turn and retains a separate baseline so clear can restore normal selection.
Existing no-override behavior and native permission/isolation proofs stay intact.

Live ACP selection requires two independent facts: the existing native admission
and an exact-version model-free setter receipt. Qwen and Jcode compatibility
admission includes the person's existing exact-version trust; Kimi headless uses
its existing native-identity admission, independently of Kimi reviewer isolation
compatibility. Only Kimi Code CLI 2.5.2 headless is currently enabled, through
`session/set_config_option` with `configId: model` and the
[model-free setter receipt](../verification/2026-11-08-kimi-252-model-setter-1317.md).
Qwen remains unavailable pending a separate setter admission. Its historical
A/B/B evidence did not retain the third request's purpose. The
[suggestions-off receipt](../verification/2026-11-11-qwen-setter-suggestions-off.md)
records ordinary A/B/A on exact 0.26.9 and 0.27.0 under isolated normal settings;
this adds candidate evidence, without enabling a production setter or qualifying
real accounts, default-on suggestions, TUI or Linux. Jcode headless A/B/A passed, but its shared-TUI turn fence
across failover remains unqualified; its production setter stays unavailable. A native TUI or external adapter cannot acquire a setter from an
advertisement or a registry label.

The host captures one selection before awaiting a setter, validates bounded
current-session model choices and owned process identity, then sends the prompt.
Setter acknowledgement and model/config notifications are not prompt admission:
only current prompt activity or successful completion acknowledges application.
An unanswered setter leaves native selection unknown and takes the peer offline
through its owned stop path. Trust revocation is rechecked before the prompt.
Clear restores the validated pre-override session baseline, with instance and
launch precedence retained; status does not expose a pending setter target as
that baseline. Unsupported no-override delivery retains its ordinary behavior;
a retained override instead refuses before a prompt until the person clears it
or starts a supported owner.

Fresh reviewer variants explicitly strip inherited model capability. Only an
explicit per-spawn capability, such as codex-review, receives a model getter;
a long-lived ACP policy never enables the reviewer print path. Unsupported
surfaces refuse a live set with a cause and `ahub restart <peer>` as the next
step, without storing a newly refused override or restarting anything.

Overrides survive daemon restart and are cleared by runtime reset. Retained
state must remain protected by recovery feature/integrity admission. Model ids
use the existing #844 bounded token rule, with no spaces or leading dash.
`model_change` records only peer, previous/new ids, person surface and a next-turn
boundary, never prompts or credentials. A future native turn id is not invented;
`appliesFrom: next_turn` and an existing `afterTurn` identify the boundary.

## Compatibility and external modules

Native CLI compatibility is centralized in `compat.ts`. Each gated operation asks that policy for a verified, in-contract, person-trusted, or refused result; person trust for one exact version does not skip a separate isolation or runtime proof. This lets upstream versions change without turning an untested protocol assumption into support ([#691](https://github.com/STAIxBWLB/agent-hub/issues/691)).

External adapter modules are an explicit, person-owned, machine-local opt-in. The daemon verifies and pins the captured bundle at startup, then admits only the bounded headless ACP instance contract through host-managed launch and current-owner checks. Module code runs in the daemon trust domain; pinning is integrity evidence, not a sandbox. Modules cannot supply native reviewer engines, proof ports, permission callbacks, provider selectors, or arbitrary recovery authority. This ceiling limits what imported code can claim and prevents live reload from replacing the executable catalog ([#754](https://github.com/STAIxBWLB/agent-hub/issues/754)).

`questionWaitMs` (#1053) is the time a `hub_ask` call waits for the person before it answers `pending`. It is a fixed-builtin field like `title`: `assertNativeCapabilityScope` refuses it on a configured or external definition, and the person overrides it per kind with `questions.wait_ms.<kind>`, never the caller. MCP peers carry 45 s, Pi and the local worker 300 s, provisional until the live timeout measurements of #1053 T1.

`settle` (#1054) is the code-verified signal that ends a peer's logical run, so the hub can create a completion for a run a person started. It is a fixed-builtin field like `questionWaitMs`: `assertNativeCapabilityScope` refuses it on a configured or external definition. **Owner decision 2026-11-04 (issue #1054):** completions exist only for adapters whose signal the T1 audit verified in code. Claude's TUI (`native-stop`: the transcript-verified Stop, never a lost channel or watchdog) and headless implementer, Codex (`turn-completed`), Pi (`agent-settled`, its own event: the `agent_end` plus retry/compaction fallback is not implemented), the local worker (`route-outcome`), ACP Kimi and Jcode headless (`prompt-response`) and the Qwen TUI (`message-stop`) declare one. **Absent means no completions:** agy (its declared `native-hook` signal is not verified end to end) and phase-2 person-typed Codex turns declare none, and an unattached pull-only peer starts no run. agy joins after a live receipt verifies its Stop readback and completion row; Codex person-typed turns after an origin receipt. The settle rule, outcomes and restart reconstruction live in `src/hub/completions.ts` and `src/hub/completions-store.ts`; a run settles only when the adapter signal fired AND no queued continuation, open permission or question, owned child, running check or held delivery remains.

Kimi 2.5.2's own TUI also earns completions, but only through the `ahub kimi` launcher's ephemeral `native_hook_launch` and local plugin (#1282). The plugin record binds the launch to its owner pid and process signature. A different launch may replace it only when that owner is proven gone; an active or unknown owner, including one from another project sharing the native home, is left unchanged. Replacement and cleanup share one fail-closed lock per native home, with no automatic stale-lock deletion. If begin or setup fails, the launcher reports the cause and starts the plain TUI without completion receipts. Quiet background/final-turn re-reads back off from 250 ms to 1 s, and the 2 s Stop deadline also arms them. A hook is a candidate observation, never proof. The daemon admits only the exact `kimi-tui` compat version and binds the observation to daemon, launch, native home, native session, project and current socket generation. The transcript's `turn.prompt` supplies the origin and turn id; its final `turn.ended` supplies the outcome. `prompt.completed` and `prompt.aborted`, when present, must agree with that turn; a notification may omit both id forms, so the native notification id or turn id is the fallback identity. A blocked Stop has no final row, so it cannot settle. StopFailure needs `failed`, Interrupt stays quiet with no result, and launcher loss or daemon reconstruction creates at most one `interrupted`. Every native-person result is private because the hook path cannot prove it is public. Headless ACP keeps `prompt-response`; an unverified TUI version or a launch without these readbacks keeps the old no-completion behavior. Native background task files supply the count or an explicit unknown; work or an unreadable inventory never settles. A 250 ms re-read covers missing TaskStarted/Notification hooks without turning elapsed time into evidence. No prompt, answer, error, task command or title reaches completion rows, events, logs or memory. The exact-version receipt is `docs/verification/2026-11-08-kimi-tui-completion-1282.md`.

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

## Headless Record boundaries (#1320)

Only a host-owned getter supplies the imported agent-mem instruction at an admitted headless turn boundary, after owned input and busy state exist and before the native prompt/model request. Multi-call local turns keep one fixed prompt. Native-client prompts, steer, Claude hooks and isolated reviewers keep their separate surfaces. A getter failure omits optional Record guidance and does not change ordinary routing. The production getter reads the public `recordsEnabled(activeHome, executionCwd)` accessor from the exact-pinned amem package; either machine or repository false disables the optional Record path. Its boolean revision is not a privacy-policy fingerprint: current package and hub screens are rechecked separately before effects.

Model final output uses a host-only final-answer callback distinct from explicit send tools and diagnostic messages. Only normal completion can append Record rows; partial output is stripped for sharing without certifying a settled record. Capture binds immutable owner, turn, session/generation, execution cwd, profile and policy identity. Replacement, exclusion or unsafe steering revokes the frame before any later append. This grants no task, permission, native consumption or model acceptance authority.
