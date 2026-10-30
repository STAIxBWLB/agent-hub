/** The one X4 outbound view. A proof never carries refs, private task text or untrusted authority. */
import { looksSecret } from "@staix/agent-mem";
import { HUB, DIGEST, MAX_HOP, USER, sanitize, type Envelope } from "../hub/envelope.ts";
import { mentionsPrivatePath } from "../hub/memory-policy.ts";
import { detectSignals, type Routing } from "../hub/routing.ts";
import type { PiiVerdict } from "../hub/inference.ts";
import { encodeRoomMessage, isRoomLocalPeerId, parseRemotePeerId, type RoomChatEnvelope, type RoomInvocationPayload, type RoomInvocationKind, encodeRoomInvocationBody, decodeRoomInvocationBody } from "./application.ts";

export interface RoomBoundaryContext {
  cwd: string; target: string; current: () => boolean;
  senderExposed: (id: string) => boolean;
  senderPrivate: (id: string) => boolean | undefined;
  taskPrivate: (id: number) => boolean | undefined;
  routing: () => Routing; piiPaths: () => readonly string[];
  modelScreenOn: () => boolean;
  /** The existing host-bound screenPii port owns device/campus admission, deadlines and fixed models. */
  screen?: (text: string) => Promise<PiiVerdict>;
  /** Host ledger provenance, never a serializable request/peer capability. */
  invocation?: RoomInvocationAuthorization;
}
export type RoomBoundaryCode = "invalid_message" | "not_exposed" | "boundary_refused" | "hop";
declare const proofBrand: unique symbol;
export interface RoomOutboundProof { readonly [proofBrand]: true }
export type RoomBoundaryResult = { status: "refused"; code: RoomBoundaryCode } | { status: "ready"; proof: RoomOutboundProof; withheld: boolean };
const proofs = new WeakMap<RoomOutboundProof, { envelope: Readonly<RoomChatEnvelope>; current: () => boolean }>();
const ENVELOPE_FIELDS = new Set(["id", "trace", "hop", "from", "to", "kind", "priority", "body", "refs", "private", "ts"]);
const encoder = new TextEncoder();
const refused = (code: RoomBoundaryCode): RoomBoundaryResult => ({ status: "refused", code });

declare const invocationBrand: unique symbol;
export interface RoomInvocationAuthorization { readonly [invocationBrand]: true }
interface AuthorizedInvocation { binding: string; sender: string; kind: RoomInvocationKind; body: string; current: () => boolean }
const invocations = new WeakMap<RoomInvocationAuthorization, AuthorizedInvocation>();
/** Host-only construction: the ledger owner supplies the actual caller/callee and exact request/result. */
export function authorizeRoomInvocation(envelope: Envelope, sender: string, payload: RoomInvocationPayload, current: () => boolean): RoomInvocationAuthorization {
  if (envelope.from !== HUB || envelope.kind !== "invocation" && envelope.kind !== "invocation_result" || !isRoomLocalPeerId(sender) || sender === USER) throw new Error("room: invocation provenance unavailable");
  const body = encodeRoomInvocationBody(envelope.kind, payload);
  const token = Object.freeze({}) as RoomInvocationAuthorization;
  invocations.set(token, { binding: JSON.stringify(envelope), sender, kind: envelope.kind, body, current });
  return token;
}
function invocationOf(token: RoomInvocationAuthorization | undefined, envelope: Envelope): AuthorizedInvocation | undefined {
  if (!token || typeof token !== "object") return undefined;
  const bound = invocations.get(token);
  try { return bound && bound.kind === envelope.kind && bound.binding === JSON.stringify(envelope) && bound.current() === true ? bound : undefined; }
  catch { return undefined; }
}

interface BodyPolicy { routing: Routing; paths: string[]; model: boolean; signature: string }
function bodyPolicy(context: RoomBoundaryContext): BodyPolicy | undefined {
  try {
    const routing = context.routing(), paths = [...context.piiPaths()], model = context.modelScreenOn();
    if (typeof model !== "boolean" || paths.some(path => typeof path !== "string") || !Array.isArray(routing.signals.pii_patterns) || routing.signals.pii_patterns.some(pattern => typeof pattern !== "string")) return undefined;
    const patterns = [...routing.signals.pii_patterns];
    return { routing: { ...routing, signals: { ...routing.signals, pii_patterns: patterns } }, paths, model, signature: JSON.stringify([patterns, paths, model]) };
  } catch { return undefined; }
}
function clearBody(body: string, paths: readonly string[], context: RoomBoundaryContext, policy: BodyPolicy | undefined): boolean {
  if (!policy) return false;
  try {
    return !looksSecret(body) && !mentionsPrivatePath(body, paths.map(path => `path:${path}`), policy.paths, context.cwd)
      && !detectSignals({ title: "", detail: body, refs: {} }, policy.routing, context.cwd).includes("pii");
  } catch { return false; }
}
/** Snapshot before any await; host ports remain captured, while their decisions are read fresh. */
export async function roomBoundary(input: Envelope, ctx: RoomBoundaryContext): Promise<RoomBoundaryResult> {
  try {
    const env = structuredClone(input), context: RoomBoundaryContext = { ...ctx };
    const target = parseRemotePeerId(context.target);
    if (!target || !env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).some(key => !ENVELOPE_FIELDS.has(key))) return refused("invalid_message");
    const invocation = invocationOf(context.invocation, env), sender = invocation?.sender ?? env.from;
    if (env.from === HUB && !invocation || env.from === DIGEST || !isRoomLocalPeerId(sender)) return refused("boundary_refused");
    if (!invocation && env.kind !== "chat" && env.kind !== "status" || env.private === true) return refused("boundary_refused");
    if (env.private !== undefined && typeof env.private !== "boolean") return refused("invalid_message");
    if (!Array.isArray(env.to) || !env.to.includes(context.target)) return refused("boundary_refused");
    if (invocation && (env.to.length !== 1 || env.to[0] !== context.target)) return refused("boundary_refused");
    if (env.to.length > 64 || env.to.some(id => !isRoomLocalPeerId(id) && !parseRemotePeerId(id))) return refused("invalid_message");
    if (!Number.isSafeInteger(env.hop) || env.hop < 0 || env.hop > MAX_HOP) return refused("hop");
    if (env.refs !== undefined && (!env.refs || typeof env.refs !== "object" || Array.isArray(env.refs))) return refused("invalid_message");
    const paths = env.refs?.paths ?? [];
    if (!Array.isArray(paths) || paths.length > 64 || paths.some(path => typeof path !== "string" || encoder.encode(path).length > 4096)) return refused("invalid_message");
    const task = env.refs?.task;
    if (task !== undefined && (typeof task !== "string" || !Number.isSafeInteger(Number(task)) || Number(task) < 1 || String(Number(task)) !== task)) return refused("invalid_message");
    const taskId = task === undefined ? undefined : Number(task);
    const authorized = (): RoomBoundaryCode | undefined => {
      try {
        if (context.current() !== true) return "boundary_refused";
        if (context.invocation && invocationOf(context.invocation, env) !== invocation) return "boundary_refused";
        if (sender !== USER && context.senderExposed(sender) !== true) return "not_exposed";
        if (context.senderPrivate(sender) !== false || taskId !== undefined && context.taskPrivate(taskId) !== false) return "boundary_refused";
        return context.current() === true ? undefined : "boundary_refused";
      } catch { return "boundary_refused"; }
    };
    const initial = authorized(); if (initial) return refused(initial);
    const envelope: RoomChatEnvelope = { id: env.id, trace: env.trace, hop: env.hop, from: sender, to: target.peer, kind: env.kind as RoomChatEnvelope["kind"], priority: invocation ? "status" : env.priority === "important" ? "status" : env.priority, body: invocation?.body ?? env.body, ts: env.ts };
    encodeRoomMessage({ v: 1, type: "chat", envelope }); // Validate metadata/body budget before any model sees it.
    const policy = bodyPolicy(context);
    const body = envelope.body;
    let withheld = !clearBody(body, paths, context, policy);
    if (!withheld && policy?.model) {
      const before = authorized(); if (before) return refused(before);
      let verdict: PiiVerdict | undefined;
      try { verdict = await context.screen?.(body); } catch { /* unknown fails closed to the fixed stub */ }
      const after = authorized(); if (after) return refused(after);
      withheld = verdict?.label !== "clear";
      const fresh = bodyPolicy(context);
      if (!fresh || fresh.signature !== policy.signature) return refused("boundary_refused");
      withheld ||= !clearBody(body, paths, context, fresh);
    }
    const final = authorized(); if (final) return refused(final);
    if (invocation?.kind === "invocation" && withheld) return refused("boundary_refused");
    let outgoingBody = withheld ? `[room message ${envelope.id} withheld]` : sanitize(envelope.body);
    if (invocation?.kind === "invocation_result") {
      const result = decodeRoomInvocationBody("invocation_result", body);
      const hiddenOutcome = result.outcome === "needs_review" || result.outcome === "timeout" ? "needs_review" : result.outcome === "refused" ? "refused" : "withheld";
      outgoingBody = encodeRoomInvocationBody("invocation_result", withheld ? { ...result, outcome: hiddenOutcome, body: "" } : { ...result, body: sanitize(result.body) });
    } else if (invocation) outgoingBody = body; // Canonical structured args, sanitized only when the target renders them.
    const outgoing = Object.freeze({ ...envelope, body: outgoingBody });
    encodeRoomMessage({ v: 1, type: "chat", envelope: outgoing });
    const current = () => authorized() === undefined && (withheld || (() => {
      const latest = bodyPolicy(context);
      return latest !== undefined && latest.signature === policy?.signature && clearBody(body, paths, context, latest);
    })());
    const proof = Object.freeze({}) as RoomOutboundProof;
    proofs.set(proof, { envelope: outgoing, current });
    return { status: "ready", proof, withheld };
  } catch { return refused("invalid_message"); }
}
export function readRoomOutbound(proof: RoomOutboundProof): RoomChatEnvelope | undefined {
  if (!proof || typeof proof !== "object") return undefined;
  const state = proofs.get(proof);
  if (!state) return undefined;
  try { return state.current() === true ? { ...state.envelope } : undefined; }
  catch { return undefined; }
}
