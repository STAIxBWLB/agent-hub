---
id: agent-hub-architecture
type: architecture
title: Agent Hub Architecture
status: draft
parent: agent-hub
paths:
  - src/hub/daemon.ts
  - src/hub/peers.ts
  - src/hub/envelope.ts
  - src/hub/tasks.ts
  - src/hub/board.ts
  - src/hub/routing.ts
  - src/hub/bus.ts
  - src/hub/delivery-journal.ts
  - src/hub/hub-tools.ts
  - src/hub/recovery-store.ts
  - src/hub/recovery-continuity.ts
  - src/adapters/registry.ts
  - src/adapters/registry-types.ts
  - src/omniroute/client.ts
  - src/models/route/runtime.ts
  - src/memory/client.ts
  - src/local/sandbox.ts
covers: [architecture]
tags: [agent-hub, dogfood]
---

# Agent Hub Architecture

The [design ledger](../specs/2026-09-19-agent-hub-design.md) records history; current operational rules live in the [AGENTS.md area notes](../../AGENTS.md#area-notes), including the [task](../agent-notes/tasks.md), [bus](../agent-notes/bus.md), [adapter](../agent-notes/adapters.md), [daemon](../agent-notes/daemon.md), [model](../agent-notes/models.md), and [local-worker](../agent-notes/local-worker.md) notes.

## Runtime and peer boundary

`src/hub/daemon.ts` is the project runtime's composition root. It owns the local control service, peer registry, `Bus`, `Tasks`, configuration, policy admission, and recovery coordination. A project has one local daemon and task board; its peers communicate through that daemon. The boundary keeps transport code from becoming a second source of role or recovery authority ([#625](https://github.com/STAIxBWLB/agent-hub/issues/625), [#900](https://github.com/STAIxBWLB/agent-hub/issues/900)).

`PeerAdapter` in [peers.ts](../../src/hub/peers.ts) is the shared native-runtime interface. Fixed adapters translate host lifecycle, messages, permissions, and delivery receipts into it; daemon-owned policy decides what those facts permit. Claude's plugin channel uses MCP over stdio and the authenticated control connection, Codex uses the app-server proxy, and Kimi supports a pull-only TUI by default or explicitly selected headless ACP mode. Keeping protocol translation outside task policy prevents vendor-specific branches there ([#625](https://github.com/STAIxBWLB/agent-hub/issues/625), [#316](https://github.com/STAIxBWLB/agent-hub/issues/316)).

External adapter modules are opt-in, pinned at startup, and limited to the accepted headless ACP contract; a module does not gain a generic native lifecycle or sandbox authority. That limit exists because imported code executes in the daemon's trust domain, so source pinning and an explicit capability ceiling are necessary ([#754](https://github.com/STAIxBWLB/agent-hub/issues/754)).

The control WebSocket binds to loopback, requires a per-run token and rejects browser-origin requests. That token is not an OS security boundary against a same-user process that can read it. The agent-session identity path classifies CLI calls as the acting peer rather than the person, so received text cannot grant the person's authority. This keeps caller identity honest without claiming a hostile-process boundary ([#193](https://github.com/STAIxBWLB/agent-hub/issues/193)).

Authority is role-scoped: the person retains decisions requiring judgment or consent; one configured conductor may perform audited operations within its project; ordinary peers receive role- and task-bound operations. Release consent remains person-originated: the person may record it, or the conductor may record it only on the person's explicit instruction in that session. That provenance is cooperative, not daemon-verifiable; model text, tasks, reviews, files, and peer relays do not count. This prevents task content from silently becoming authorization ([#812](https://github.com/STAIxBWLB/agent-hub/issues/812), [#481](https://github.com/STAIxBWLB/agent-hub/issues/481), [#787](https://github.com/STAIxBWLB/agent-hub/issues/787), [#1063](https://github.com/STAIxBWLB/agent-hub/issues/1063)).

Native tools keep their vendor permission and execution boundaries. The local worker applies path and permission checks to its tools, and runs command execution through a host-supported sandbox; the hub does not sandbox vendor-native tools or claim all ACP commands are isolated. This avoids confusing a hub permission mode with execution confinement ([#39](https://github.com/STAIxBWLB/agent-hub/issues/39), [#270](https://github.com/STAIxBWLB/agent-hub/issues/270)).

## Console presentation surfaces

The floating pet belongs to acon Mini (#1012). The compatibility command
`ahub pet --window [--close]` prints the `acon ui` pointer and succeeds for
person, agent and live-test identities, without starting a host or window.
The retired `ahub pet --palette <value>` validates its argument and prints the
same pointer without writing configuration. Legacy `pet.palette` remains
validated compatibility input with no rendering effect.
Legacy `pet.window` input is ignored with one notice and cannot change authority
or re-enable an inherited disabled terminal pet by itself. Terminal pet frames
remain local TUI presentation. The acon plugin's existing **Console message**
view owns the composer through its established `send` action (#935).

## Board, assignment, and delivery

`Tasks` is the task state machine and policy boundary; `Board` is its SQLite persistence. Proposals, assignments, acceptance, completion, and review flow through `Tasks`, which checks roles, state, privacy, and revisions before writes. Pure candidate selection keeps route explanations aligned with actual assignment. This prevents adapters or CLIs bypassing invariants with direct board writes ([#424](https://github.com/STAIxBWLB/agent-hub/issues/424), [#481](https://github.com/STAIxBWLB/agent-hub/issues/481)).

The message bus is separate from task state. `Bus` frames and routes envelopes; `DeliveryJournal` records transport attempts, acknowledgements, and uncertain outcomes. A delivery receipt does not mean its task was accepted, completed, or approved. Uncertain sends remain inspectable rather than silently replayed, and an explicit inbox pull records returned messages. This prevents transport retry from becoming a task transition ([#37](https://github.com/STAIxBWLB/agent-hub/issues/37), [#493](https://github.com/STAIxBWLB/agent-hub/issues/493)).

Encrypted rooms are an optional message transport between project hubs. They do not federate task boards, roles, approvals, or memory; each receiving project makes its own local admission decision. This prevents a remote room membership from becoming local authority ([#446](https://github.com/STAIxBWLB/agent-hub/issues/446)).

Claim evidence (#931 T1) uses the same Tasks/Board boundary and #901's canonical
claim identity and ordered-list revision. Evidence links are append-only
provenance proposals; they create no separate claim/verdict store and do not
establish entailment or synthesis readiness. The research-only record tool
returns an ids-only receipt and excludes its arguments/results from capture.
Its T1 authorization, revision and recovery boundaries are defined in
[the task-board contract](task-board.md#claim-evidence-records-931-t1).

## Models and memory

Peer selection, hub-owned model routing, and provider access are distinct layers. Task routing chooses a peer; the in-process route selects a model for hub-owned inference; OmniRoute owns provider keys, provider fallback, and usage. Native CLIs retain their own account and provider configuration; subscription OAuth credentials are not pooled through the gateway. The former Switchyard sidecar is retired; routing now runs in process. This keeps provider credentials and fallback policy in one gateway while avoiding a second routing service ([#553](https://github.com/STAIxBWLB/agent-hub/issues/553)).

The hub's portable memory storage, sync, indexing, and project helpers come from the pinned first-party `@staix/agent-mem` package. `src/memory/` and `Tasks` provide hub-specific capture, recall, privacy screening, task briefs, and shared notes. Runtime memory is in-process: there is no claude-mem worker HTTP client or model summarizer. claude-mem is an off-by-default, import-only source. This removes a second capture path while keeping caller authority and task privacy in the hub ([#752](https://github.com/STAIxBWLB/agent-hub/issues/752), [agent-mem#13](https://github.com/STAIxBWLB/agent-mem/issues/13)).

## Privacy and recovery

Session titles for the two hub-owned title slots (#1055) are conditional writes
to the current adapter session, under the same open-PII-task/private-turn and
public-metadata screens as DOING. Person rename remains console-only. Live
unnamed labels are computed from acknowledged source messages and shown only
to the console and configured conductor; other readers see `unnamed`.
Their source note identifies incoming text, not speech by the recipient.
Only opaque
session/delivery/envelope bindings persist in `session-title-inputs.json`, never
copied labels. Its fields, bounds and lifetime are defined by the
[session-title storage contract](adapters.md#session-title-slots). Native title,
task title, Git branch and instance identity remain independent.

Privacy decisions are made at hub boundaries, not delegated to model routing. A private task or turn is represented by a private envelope and a restricted public view; task text is screened before it enters memory, shared notices, or model calls. The PII screen can run on-device; its gateway path requires positive campus admission, so an unknown network result is not treated as safe. This makes each downstream observer consume the same host decision rather than infer privacy from a label or vendor ([#198](https://github.com/STAIxBWLB/agent-hub/issues/198), [#752](https://github.com/STAIxBWLB/agent-hub/issues/752)).

Recovery is a coordinated daemon operation over separately persisted board, delivery, and native-session evidence. A restart or upgrade can continue only with compatible feature evidence from the verified target and host-held proofs that still match the project and actor. Adapters report native evidence; they do not certify their own recovery authority. This avoids treating a stale status file or an unverified receipt as proof that a native process is safe to resume ([#37](https://github.com/STAIxBWLB/agent-hub/issues/37), [#625](https://github.com/STAIxBWLB/agent-hub/issues/625), [#900](https://github.com/STAIxBWLB/agent-hub/issues/900)).

The architecture does not claim that a fixture proves a real provider account, native session, campus network, or operating-system sandbox. Those are distinct runtime evidence and remain separate from source-level and automated checks ([#625](https://github.com/STAIxBWLB/agent-hub/issues/625), [#754](https://github.com/STAIxBWLB/agent-hub/issues/754)).

## Person review packages (#1056)

The task-board module owns anchored findings and person-authored comment lifecycles. Transport carries one explicit review package only after `Tasks` admits the selected draft set; drafting and editing do not start peer turns. acon supplies the shared review kit and a server-verified person identity, while the standalone dashboard reads counts and bounded placements only. Neither surface writes the Board directly.

The host-only review package reference is an observer exclusion, not PII authority. Its intended recipient may read a public package, but memory capture, operational views, delivery logging and incoming-message labels exclude its body. Local-worker capture binds that exclusion to the input turn, so a delayed response cannot become capturable when another turn starts. Recovery advertises the conditional `review_comments` feature when retained comment/package records require it. See [the task-board contract](task-board.md#anchored-review-packages-1056) for bounds, immutable snapshot placement and lifecycle authority.
