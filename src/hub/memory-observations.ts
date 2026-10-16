import type { Envelope, PeerId } from "./envelope.ts";
import { HUB } from "./envelope.ts";
import type { MemoryCounterContext, MemoryTelemetry } from "./memory-candidates.ts";

export type MemoryObservationContext = Omit<MemoryCounterContext, "deliveryId">;
/** Only positively public context is returned. Missing identity fields remain unknown. */
export type MemoryContext = (peer: PeerId, envelopes: readonly Envelope[]) => MemoryObservationContext | undefined;

/** Bind an acknowledgement to the render's context, never to a later turn or session. */
export class MemoryObservations {
  private readonly pending = new Map<string, { peer: PeerId; context: MemoryObservationContext; text: string }>();
  constructor(private readonly telemetry: MemoryTelemetry, private readonly context: MemoryContext) {}

  delivery(peer: PeerId, deliveryId: string, out: Envelope[], field: "rendered" | "delivered"): void {
    try {
      if (field === "rendered") {
        const context = this.context(peer, out);
        if (!context || out.some(env => env.private)) return;
        // Ordinary quoted citations are counted as citations, not as a fresh recall rendering.
        const text = out.filter(env => env.kind === "presence" || env.from === HUB && /Memory brief \(/.test(env.body)).map(env => env.body).join("\n");
        if (!text.includes("mem:")) return;
        this.pending.set(deliveryId, { peer, context, text });
        // ponytail: retain at most 2048 live render contexts; an evicted or pre-restart acknowledgement stays unknown.
        // Persist ids-only render context with the journal if measurements need complete crash/recovery coverage.
        while (this.pending.size > 2048) this.pending.delete(this.pending.keys().next().value!);
        this.telemetry.record(text, { ...context, deliveryId }, "rendered");
      } else {
        const prior = this.pending.get(deliveryId);
        if (!prior || prior.peer !== peer) return;
        this.pending.delete(deliveryId);
        const now = this.context(peer, out);
        if (!now || out.some(env => env.private) || now.session !== prior.context.session) return;
        this.telemetry.record(prior.text, { ...prior.context, deliveryId }, "delivered");
      }
    } catch { /* optional sidecar observations never change transport or task outcomes */ }
  }

  // ponytail: citations without a proven source delivery use message:/summary: observation ids, not journal receipts.
  // Join citations to a verified source delivery if per-delivery causal ratios become a study requirement.
  cite(peer: PeerId, text: string, deliveryId: string, envelopes: readonly Envelope[] = []): void {
    try {
      const context = this.context(peer, envelopes);
      if (!context || envelopes.some(env => env.private)) return;
      this.telemetry.record(text, { ...context, deliveryId }, "cited");
    } catch { /* unknown, never a fabricated zero */ }
  }
}
