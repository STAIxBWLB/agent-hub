# Bus, digests and replies

Scope: delivery, digests and condensation, hub envelopes, reply addressing, priority and limits. Read before editing `src/hub/bus.ts`, `src/hub/envelope.ts` or `src/hub/limits.ts`, or how an adapter addresses a reply or sets its priority.

- A failed digest is retried one envelope at a time, so a poison envelope cannot take its neighbours down with it.
- An `important` envelope being steered is not in the queue while the steer is in flight; queue it first and an idle transition delivers it twice.
- `replyParent()` decides what a reply answers (highest hop, never the `hub` preface). Use it for deliveries and steers alike, or the hop cap can be reset.
- What a peer is handed (`out`) and what it stands for (`originals`) differ once a delivery is condensed: the bus keeps both, registers `out` so `reply_to` resolves, puts the originals back on any failure (a thrown `deliver` or a later `onFailed`), and counts no attempt when the peer merely got busy while the delivery was prepared. A delivery with an `important` envelope is never condensed.
- A condensed digest is sent by `digest`, not `hub`: `replyParent()` skips `hub` items, and a reply to a digest must keep the highest hop of what it replaced. On a failed delivery the bus puts back the originals, never the digest.
- The hub itself sends envelopes (`from: hub`, kinds `task` and `review`). Code that special-cases hub envelopes keys on `kind`, not on the sender: only `kind: presence` is the recall preface.
- Limits admit what is sent: the envelope `newEnvelope` builds (a reply inherits its parent's sender, `digest` resolves to the originals, `capPriority` applies), never the raw `to` and priority. Admit first and build later, and implicit replies all count as broadcasts.
- A reply is addressed, never broadcast. An adapter that answers a delivery passes `to: replyAudience(envs)`; anything else with an `inReplyTo` inherits that envelope's sender. Leaving `to` empty fans the message out to every peer.
- `digest` is not a peer: addressing a reply at the envelopes the peer was handed sends it nowhere once a delivery was condensed. The bus resolves `digest` back through `lastDelivery.originals`; anything else that reads a reply's `to` has to do the same.
- A hub-native peer (Pi, the local worker) does not get to call its own message `important`: `capPriority` caps it unless the delivery it answers held an `important` envelope addressed to it. Check the delivery, not `replyParent`, which ties on hop and takes the later item. Do not bypass it by setting `priority` in the adapter.
