import { HUB, MAX_HOP, type Envelope } from "./envelope.ts";

/** ponytail: cap recovery at 2048 unpublished hub originals; replace with a paged durable outbox if measured recovery workloads exceed it. */
export const MAX_DEFERRED_HUB = 2048;

/** Refuses admission without dropping already accepted deferred work. */
export class RecoveryDeferredHubError extends Error {
  readonly code = "recovery_deferred_hub";
  constructor(message = "recovery deferred hub notice limit reached; release or abort recovery before publishing more notices") {
    super(message);
    this.name = "RecoveryDeferredHubError";
  }
}

/** Journal-less restore uses the same bounded core envelope shape as durable deferred work. */
export function validateDeferredEnvelope(value: unknown, name: string): Envelope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RecoveryDeferredHubError(`${name} must be an envelope`);
  const env = value as Record<string, unknown>;
  const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
  if (!text(env.id, 256) || !text(env.trace, 256) || env.from !== HUB ||
      typeof env.body !== "string" || env.body.length > 1_000_000 ||
      !Number.isSafeInteger(env.hop) || (env.hop as number) < 0 || (env.hop as number) > MAX_HOP ||
      !Number.isSafeInteger(env.ts) || (env.ts as number) < 0 ||
      !["chat", "task", "review", "status", "budget", "presence"].includes(env.kind as string) ||
      !["important", "status", "fyi"].includes(env.priority as string) ||
      (env.to !== undefined && (!Array.isArray(env.to) || env.to.length > 256 || !env.to.every(peer => text(peer, 256)))) ||
      (env.private !== undefined && typeof env.private !== "boolean"))
    throw new RecoveryDeferredHubError(`${name} is invalid`);
  if (env.refs !== undefined) {
    if (!env.refs || typeof env.refs !== "object" || Array.isArray(env.refs)) throw new RecoveryDeferredHubError(`${name}.refs is invalid`);
    const refs = env.refs as Record<string, unknown>;
    for (const key of ["repo", "branch", "commit", "task"])
      if (refs[key] !== undefined && !text(refs[key], 4096)) throw new RecoveryDeferredHubError(`${name}.refs.${key} is invalid`);
    if (refs.paths !== undefined && (!Array.isArray(refs.paths) || refs.paths.length > 256 || !refs.paths.every(path => text(path, 4096))))
      throw new RecoveryDeferredHubError(`${name}.refs.paths is invalid`);
  }
  return value as Envelope;
}

/** Callers keep their existing envelope validation; this leaf checks deferred-only invariants. */
export function validateDeferredHub(
  value: unknown,
  envelope: (value: unknown, name: string) => Envelope = validateDeferredEnvelope,
  occupied: ReadonlySet<string> = new Set(),
  name = "bus.deferredHub",
): Envelope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DEFERRED_HUB)
    throw new RecoveryDeferredHubError(`${name} must be an array of at most ${MAX_DEFERRED_HUB} hub envelopes`);
  const ids = new Set<string>();
  return value.map((item, index) => {
    validateDeferredEnvelope(item, `${name}[${index}]`);
    const env = envelope(item, `${name}[${index}]`);
    if (env.from !== HUB) throw new RecoveryDeferredHubError(`${name}[${index}] is not hub-originated`);
    if (ids.has(env.id) || occupied.has(env.id)) throw new RecoveryDeferredHubError(`${name}[${index}] repeats an accepted envelope id`);
    ids.add(env.id);
    return env;
  });
}
