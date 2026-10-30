/** Host-owned X6 correlation. The room transport never becomes a task/tool authority. */
import { PreEffectToolRefusal } from "./tool-refusal.ts";
import { HUB, MAX_HOP, newEnvelope, type Envelope } from "./envelope.ts";
import type { Bus } from "./bus.ts";
import { argsDigest, boundedInvocationBody, isOpenOutcome, type InvocationLedger, type InvocationOutcome, type InvocationRow } from "./invocations.ts";
import { canonical, type ShareConfig } from "./capabilities.ts";
import { authorizeRoomInvocation, type RoomInvocationAuthorization } from "../rooms/boundary.ts";
import { decodeRoomInvocationBody, encodeRoomInvocationBody, type RoomReadInvocationRequest } from "../rooms/application.ts";
import type { RoomInvocationIdentity, RoomInvocationIngress } from "../rooms/service.ts";

export interface RoomInvocationPorts {
  bus: Bus; ledger: InvocationLedger; shares: () => ShareConfig;
  identity: (peer: string, sender?: string) => RoomInvocationIdentity | undefined;
  target: (input: RoomInvocationIngress, request: RoomReadInvocationRequest) => Promise<void>;
  safeResult: (body: string, current: () => boolean) => Promise<boolean>;
  finish: (row: InvocationRow, outcome: InvocationOutcome, input?: { body?: string; reason?: string }) => void;
}
export class RoomInvocations {
  constructor(private readonly p: RoomInvocationPorts) {}
  authorization(env: Envelope, identity: RoomInvocationIdentity): RoomInvocationAuthorization | undefined {
    const local = env.kind === "invocation" ? env.id : env.refs?.invocation;
    const row = local && this.p.ledger.get(local), route = local && this.p.ledger.relay(local);
    if (!row || !route || row.class !== "read" || env.from !== HUB || env.to?.length !== 1 || env.to[0] !== route.remotePeer
      || route.room !== identity.room || route.member !== identity.member || route.epoch !== identity.epoch || !identity.current()) return undefined;
    if (env.kind === "invocation" && (route.direction !== "outbound" || !isOpenOutcome(row.outcome) || env.id !== route.request)) return undefined;
    if (env.kind === "invocation_result" && (route.direction !== "inbound" || env.id !== route.result || route.state !== "result_queued")) return undefined;
    if (env.kind !== "invocation" && env.kind !== "invocation_result") return undefined;
    if (env.trace !== row.trace || env.hop !== route.hop + (env.kind === "invocation_result" ? 1 : 0)) return undefined;
    if (env.kind === "invocation" && roomInvocationHash({ id: env.id, trace: env.trace, hop: env.hop, from: route.caller, to: route.target,
      kind: env.kind, priority: "status", body: env.body, ts: env.ts }) !== route.hash) return undefined;
    const payload = decodeRoomInvocationBody(env.kind, env.body);
    if (payload.invocation !== route.request || payload.capability !== route.capability || payload.digest !== route.digest) return undefined;
    if (env.kind === "invocation_result" && (payload as import("../rooms/application.ts").RoomReadInvocationResult).outcome !== row.outcome) return undefined;
    if (env.kind === "invocation" && argsDigest((payload as RoomReadInvocationRequest).args) !== row.argsSha256) return undefined;
    const current = () => {
      const live = this.p.ledger.relay(row.id), candidate = this.p.ledger.get(row.id);
      const pin = this.p.shares()[route.remotePeer]?.[route.capability];
      return identity.current() && !!candidate && live?.room === identity.room && live.member === identity.member && live.epoch === identity.epoch
        && (env.kind === "invocation" ? isOpenOutcome(candidate.outcome) && pin?.digest === row.digest && pin.class === "read" : live.state === "result_queued" && live.result === env.id);
    };
    return authorizeRoomInvocation(env, route.direction === "outbound" ? row.caller : row.target, payload, current);
  }
  /** Called after target execution settles, before the ordinary caller-offline early return. */
  result(row: InvocationRow, outcome: InvocationOutcome, input: { body?: string; reason?: string }): boolean {
    const route = this.p.ledger.relay(row.id);
    if (!route || route.direction !== "inbound") return false;
    const result = newEnvelope(HUB, "", { to: [route.remotePeer], kind: "invocation_result", priority: "status", refs: { invocation: row.id } });
    result.trace = row.trace; result.hop = route.hop + 1;
    result.body = encodeRoomInvocationBody("invocation_result", { invocation: route.request, capability: row.capability, digest: row.digest, class: "read",
      outcome: outcome as Exclude<InvocationOutcome, "queued" | "delivered">, body: outcome === "withheld" ? "" : boundedInvocationBody(input.body ?? input.reason ?? "no result") });
    const identity = this.p.identity(route.remotePeer, row.target);
    if (!identity || identity.room !== route.room || identity.member !== route.member || identity.epoch !== route.epoch || !identity.current()) {
      this.p.ledger.updateRelay(row.id, "needs_review"); this.p.bus.holdInvocation(row.id, "remote invocation result route changed", row.target); return true;
    }
    this.p.ledger.updateRelay(row.id, "result_queued", result.id);
    try { this.p.bus.publish(result); }
    catch { this.p.ledger.updateRelay(row.id, "needs_review"); this.p.bus.holdInvocation(row.id, "remote invocation result publication is uncertain", row.target); }
    return true;
  }
  async receive(input: RoomInvocationIngress): Promise<"admitted" | "refused"> {
    const env = input.envelope;
    if (env.kind === "invocation") {
      const request = decodeRoomInvocationBody("invocation", env.body);
      if (env.hop >= MAX_HOP || !input.current()) return "refused";
      const prior = this.p.ledger.relayByRemote(input.room, input.member, request.invocation, "inbound");
      if (prior) {
        if (prior.hash !== input.hash || prior.epoch !== input.epoch || prior.remotePeer !== input.remotePeer || prior.caller !== env.from || prior.target !== env.to || prior.capability !== request.capability || prior.digest !== request.digest) return "refused";
        if (!input.claim()) throw new Error("room: invocation claim unavailable");
        return "admitted";
      }
      try { await this.p.target(input, request); return "admitted"; }
      catch (error) {
        // Only a proven pre-effect refusal earns a signed NACK; storage/post-claim failures retain uncertainty.
        if (error instanceof PreEffectToolRefusal) return "refused";
        throw error;
      }
    }
    if (env.kind !== "invocation_result") return "refused";
    const result = decodeRoomInvocationBody("invocation_result", env.body), route = this.p.ledger.relay(result.invocation), row = this.p.ledger.get(result.invocation);
    if (!route || !row || route.direction !== "outbound" || route.room !== input.room || route.member !== input.member || route.epoch !== input.epoch
      || route.remotePeer !== input.remotePeer || env.from !== route.target || env.to !== route.caller || env.trace !== row.trace || env.hop !== route.hop + 1
      || result.capability !== row.capability || result.digest !== row.digest || !input.current()) return "refused";
    if (!isOpenOutcome(row.outcome)) { if (!input.claim()) throw new Error("room: invocation claim unavailable"); return "admitted"; }
    const pin = this.p.shares()[route.remotePeer]?.[route.capability];
    const current = () => input.current() && this.p.shares()[route.remotePeer]?.[route.capability]?.digest === row.digest
      && this.p.shares()[route.remotePeer]?.[route.capability]?.class === "read";
    let safe = pin?.digest === row.digest && pin.class === "read" && await this.p.safeResult(result.body, current);
    if (!input.current()) throw new Error("room: invocation trust changed");
    safe &&= current();
    if (!input.claim()) throw new Error("room: invocation claim unavailable");
    if (result.outcome === "needs_review") this.p.bus.holdInvocation(row.id, "target hub reports an uncertain invocation", row.target);
    this.p.ledger.updateRelay(row.id, route.state, env.id);
    this.p.finish(row, safe ? result.outcome : result.outcome === "refused" ? "refused" : "withheld", safe
      ? result.outcome === "completed" ? { body: result.body } : { reason: result.body }
      : result.outcome === "refused" ? { reason: "the target declined; the reason was withheld" } : {});
    this.p.ledger.updateRelay(row.id, "completed", env.id);
    return "admitted";
  }
  receipt(id: string, state: "completed" | "failed_safe" | "needs_review"): void {
    const request = this.p.ledger.relay(id), result = this.p.ledger.relayForResult(id);
    if (request?.direction === "outbound") {
      if (state === "completed") { this.p.ledger.markDelivered(id); this.p.ledger.updateRelay(id, "admitted"); }
      else {
        this.p.ledger.updateRelay(id, state === "failed_safe" ? "completed" : "needs_review"); const row = this.p.ledger.get(id);
        if (row) this.p.finish(row, state === "failed_safe" ? "refused" : "needs_review", { reason: state === "failed_safe" ? "the target hub refused read admission" : "remote invocation delivery is uncertain; inspect it by hand" });
      }
    }
    if (result) this.p.ledger.updateRelay(result.local, state === "completed" ? "completed" : "needs_review");
  }
  /** Startup only: never resend an outcome whose publication a crash could have interrupted. */
  reconcile(): void {
    const pending = this.p.bus.queueList(undefined, true);
    for (const route of this.p.ledger.pendingRelays()) {
      if (route.state === "needs_review") continue;
      const row = this.p.ledger.get(route.local);
      if (!row) continue;
      const result = route.result && pending.find(delivery => delivery.originals.some(env => env.id === route.result));
      if (route.direction === "inbound" && !isOpenOutcome(row.outcome) && (route.state !== "result_queued" || !result || result.state !== "queued")) {
        this.p.ledger.updateRelay(row.id, "needs_review");
        if (!route.result) this.p.bus.holdInvocation(row.id, "remote result publication was interrupted", row.target);
      } else if (route.direction === "outbound" && !isOpenOutcome(row.outcome)) this.p.ledger.updateRelay(row.id, "needs_review");
    }
  }
}
export const roomInvocationHash = (value: unknown): string => argsDigest(canonical(value));
