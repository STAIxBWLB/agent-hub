import { isNativeModelToken } from "../adapters/model-token.ts";
import type { RuntimeModelStatus } from "../hub/model-overrides.ts";

export const MODEL_USAGE = "usage: ahub model set <peer> <model> | clear <peer> | list [--json]";
const peerToken = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);
export function parseModelCommand(args: readonly string[]): { op: "list" | "set" | "clear"; peer?: string; model?: string; json: boolean } {
  const [op, peer, model, ...extra] = args;
  if (op === "list" && (args.length === 1 || args.length === 2 && peer === "--json")) return { op, json: peer === "--json" };
  if (op === "clear" && args.length === 2 && peerToken(peer)) return { op, peer, json: false };
  if (op === "set" && !extra.length && args.length === 3 && peerToken(peer) && isNativeModelToken(model)) return { op, peer, model, json: false };
  throw new Error(MODEL_USAGE);
}

/** Closed metadata projection: an older or malformed reply never supplies display prose. */
export function projectModelStatus(value: unknown): RuntimeModelStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row: Record<string, unknown> = {};
  try {
    for (const key of ["peer", "effectiveModel", "desiredModel", "source", "pendingNextTurn", "unsupported"]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) row[key] = descriptor.value;
    }
  } catch { return null; }
  if (!peerToken(row.peer) || !(row.effectiveModel === null || isNativeModelToken(row.effectiveModel)) || !(row.desiredModel === null || isNativeModelToken(row.desiredModel)) || !(typeof row.source === "string" && ["override", "instance", "launch", "native default", "native thread default (was override)"].includes(row.source)) || typeof row.pendingNextTurn !== "boolean") return null;
  let unsupported: RuntimeModelStatus["unsupported"];
  if (row.unsupported !== undefined) {
    if (!row.unsupported || typeof row.unsupported !== "object" || Array.isArray(row.unsupported)) return null;
    let reasonCode: unknown, kind: unknown;
    try {
      const code = Object.getOwnPropertyDescriptor(row.unsupported, "reasonCode"), adapter = Object.getOwnPropertyDescriptor(row.unsupported, "kind");
      reasonCode = code && "value" in code ? code.value : undefined;
      kind = adapter && "value" in adapter ? adapter.value : undefined;
    } catch { return null; }
    if (kind !== undefined && !peerToken(kind)) return null;
    if (reasonCode === "unverified_setter") unsupported = { reasonCode, ...(kind ? { kind } : {}), reason: `unsupported live: ${kind ?? "retained peer"} (version unverified) has no verified model setter`, nextStep: `restart this peer with ahub restart ${row.peer}` };
    else if (reasonCode === "unmanaged_attachment") unsupported = { reasonCode, reason: "unsupported live: this attachment has no verified live model setter", nextStep: `change the native setting or restart this peer with ahub restart ${row.peer}` };
    else if (reasonCode === "acp_setter_unavailable") {
      if (!peerToken(kind)) return null;
      let version: unknown;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(row.unsupported, "version");
        if (descriptor && !("value" in descriptor)) return null;
        version = descriptor?.value;
      } catch { return null; }
      if (version !== undefined && !(isNativeModelToken(version) && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version))) return null;
      unsupported = { reasonCode, kind, ...(typeof version === "string" ? { version } : {}), reason: `unsupported live: ${kind} ${version ?? "unknown"} lacks a setter receipt or compat admission`, nextStep: `restart this peer with ahub restart ${row.peer}` };
    }
    else return null;
  }
  return { peer: row.peer, effectiveModel: row.effectiveModel, desiredModel: row.desiredModel, source: row.source as RuntimeModelStatus["source"], pendingNextTurn: row.pendingNextTurn,
    ...(unsupported ? { unsupported } : {}) };
}
