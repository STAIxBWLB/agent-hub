---
id: bus
type: module
title: Message Bus and Delivery
status: draft
parent: agent-hub-architecture
paths:
  - src/hub/bus.ts
  - src/hub/envelope.ts
  - src/hub/limits.ts
  - src/hub/delivery-journal.ts
  - src/hub/delivery-superseded.ts
  - src/hub/deferred-hub.ts
  - src/cli/reset.ts
  - src/hub/inference.ts
covers: [bus]
tags: [agent-hub, dogfood]
---

# Message Bus and Delivery

The bus carries bounded messages among peers in one project. Its operational contracts are in the [bus note](../agent-notes/bus.md); this spec records the design reasons behind them.

## Message contract

An envelope binds a sender, kind, priority, trace and hop count to a body and optional recipients, references, and privacy marker. An omitted recipient list means broadcast, while a reply inherits its addressee; malformed recipient input is refused rather than changed into a broadcast. This prevents a typo in a directed message from widening its audience ([#963](https://github.com/STAIxBWLB/agent-hub/issues/963)).

Replies keep the highest hop from the delivery they answer, including when the peer received a condensed digest. The hop cap therefore cannot be reset through a summary or relay ([#546](https://github.com/STAIxBWLB/agent-hub/issues/546)). Message bodies are framed as untrusted peer or hub text, not a new authority source; private envelopes remain private in logs and public views ([#193](https://github.com/STAIxBWLB/agent-hub/issues/193), [#198](https://github.com/STAIxBWLB/agent-hub/issues/198)).

The bus applies limits to a sender, sender-recipient pair, important messages, and repeated content before queueing. An important message consumes scarce attention because it can steer a busy turn; refusals cost no rate token and name the retry boundary ([#38](https://github.com/STAIxBWLB/agent-hub/issues/38)).

## Queues and delivery outcomes

The in-memory bus schedules messages; `DeliveryJournal` durably records an individual transport attempt and the original envelopes behind any rendered output. A peer receipt such as `accepted` or `completed` describes transport, not the corresponding task's acceptance, completion, or approval. That separation lets a timeout or restart remain explicitly uncertain without inventing a task outcome ([#37](https://github.com/STAIxBWLB/agent-hub/issues/37)).

For #1055, `Bus.onDelivered(peer, originals, deliveryId?)` exposes the existing
journal delivery ID to the observer at the first positive transport ACK. The
optional argument accompanies the original envelopes, including when the
rendered delivery was condensed. Queueing supplies no positive-ACK evidence,
and an observer exception cannot alter delivery settlement. This supports the
[ID-only session-title restart binding](adapters.md#session-title-slots) without
changing dispatch, retry, task acceptance or task-completion authority.

Push peers receive bounded batches. Condensation is optional, excludes important, remote, and invocation messages, and keeps `originals` separate from `out` so replies, safe failures, and recovery still refer to what the peer was actually given. On an eligible safe retry, a failed batch falls back to individual envelopes, and a previously failed envelope goes alone so a poison item cannot block its neighbors. These bounds preserve queue progress when summarization or one recipient fails ([#713](https://github.com/STAIxBWLB/agent-hub/issues/713), [#553](https://github.com/STAIxBWLB/agent-hub/issues/553)).

Pull-only peers catch up oldest-first under a byte budget, but the first envelope always goes even when it exceeds that budget so one oversized item cannot starve the queue; push peers use the digest batch limit. Pull records returned envelopes as completed at handout because the tool result is the readback, not a later native receipt. A busy Claude channel can also pull its own messages through `hub_inbox`; that avoids making a long-running turn an unbounded queue lock ([#493](https://github.com/STAIxBWLB/agent-hub/issues/493), [#713](https://github.com/STAIxBWLB/agent-hub/issues/713)).

Delivery uncertainty normally holds the original and is never an automatic replay. The narrow exception is a hub-authored presence or workflow notice proven moot by current task evidence; mixed, unknown, or requested-stop rows remain held. This removes stale notices without treating arbitrary peer messages as seen ([#434](https://github.com/STAIxBWLB/agent-hub/issues/434)). Safe pre-acceptance failures may retry within a bounded attempt policy; uncertain results remain `needs_review` until an explicit resolution. A peer may retry only its own eligible row and only once per immutable retry lineage; an invocation uses its own ledger and is not replayed as an ordinary message retry ([#37](https://github.com/STAIxBWLB/agent-hub/issues/37), [#991](https://github.com/STAIxBWLB/agent-hub/issues/991)).

A peer may settle its own local `needs_review` row as completed or discard while busy, with the observed revision and a public-safe reason; this records a delivery decision and never changes task state or redelivers the original. Another peer, a remote-room actor, or an active `dispatching`/`accepted` row remains refused. Invocation-bearing rows also remain person-settled because a transport action cannot assert the outcome of an invoked operation. `hub_inbox` may pass a `needs_review` hold to return newer queued messages and bounded id/revision metadata naming the held row, while leaving the uncertain originals held. Pause, recovery, lifecycle, storage, and active-delivery fences still apply. This lets the current recipient make progress without treating uncertain work as delivered ([#1079](https://github.com/STAIxBWLB/agent-hub/issues/1079), [#445](https://github.com/STAIxBWLB/agent-hub/issues/445), [#991](https://github.com/STAIxBWLB/agent-hub/issues/991)).

Invocation requests and results are single-envelope deliveries, not digest material. A reply is correlated to the request handed to that peer and is captured by the invocation path before ordinary publishing; uncertain outcomes stay with the invocation ledger because a missing result cannot be inferred from a transport receipt ([#445](https://github.com/STAIxBWLB/agent-hub/issues/445), [#991](https://github.com/STAIxBWLB/agent-hub/issues/991)).

## Cross-project transport

Encrypted rooms add a screened message transport between local project hubs. Room identity, deadlines, and remote provenance stay bound to each delivery; traffic is not merged into a shared board. A separately pinned read-only invocation relay cannot transfer task or approval authority. This keeps remote delivery from acquiring the receiving project's roles or memory ([#941](https://github.com/STAIxBWLB/agent-hub/issues/941), [#992](https://github.com/STAIxBWLB/agent-hub/issues/992)).
