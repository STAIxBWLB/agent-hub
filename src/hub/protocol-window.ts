/** Inclusive supported control-wire interval; v is its highest version. */
export interface ProtocolWindow { v: number; vMin: number }

/** Older peers without a minimum advertise only their one explicit version. */
export function protocolWindow(v: unknown, vMin?: unknown): ProtocolWindow | undefined {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) return undefined;
  const minimum = vMin === undefined ? v : vMin;
  if (typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum <= 0 || minimum > v) return undefined;
  return { v, vMin: minimum };
}

/** Choose the highest common version. Invalid intervals and disjoint ranges negotiate nothing. */
export function negotiateProtocol(local: ProtocolWindow, remote: ProtocolWindow): number | undefined {
  if (!local || typeof local !== "object" || Array.isArray(local) || !remote || typeof remote !== "object" || Array.isArray(remote)) return undefined;
  const a = protocolWindow(local.v, local.vMin), b = protocolWindow(remote.v, remote.vMin);
  if (!a || !b) return undefined;
  const highest = Math.min(a.v, b.v);
  return highest >= Math.max(a.vMin, b.vMin) ? highest : undefined;
}
