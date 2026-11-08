import { types } from "node:util";
import { createPlacementAttestation, PlacementWriterContextError, type SyncOptions } from "@staix/agent-mem";

/** The closed vocabulary of `PlacementWriterContextError.category` and `.causeClass` (agent-mem 0.23.0). Anything else projects as unknown. */
const CATEGORIES = ["running CLI", "host package", "setup receipt", "declared writer", "active locator", "home floor", "writer renewal", "unknown"] as const;
const CAUSE_CLASSES = ["missing", "changed", "unavailable"] as const;
export type WriterRefusalCategory = typeof CATEGORIES[number];
export type WriterRefusalCause = typeof CAUSE_CLASSES[number];
/** Public-safe projection of a writer-context refusal: two closed words, never the package's message, a path or a version. */
export interface WriterRefusal { category: WriterRefusalCategory; causeClass: WriterRefusalCause }

/** Reads a refusal without trusting its prototype chain or getters, and without keeping its message. */
export function writerRefusalOf(error: unknown): WriterRefusal | undefined {
  if (!error || typeof error !== "object" || types.isProxy(error)) return undefined;
  // The SDK throws this concrete class. Exact prototype identity avoids walking an arbitrary prototype chain.
  if (Object.getPrototypeOf(error) !== PlacementWriterContextError.prototype) return undefined;
  const category = Object.getOwnPropertyDescriptor(error, "category")?.value, causeClass = Object.getOwnPropertyDescriptor(error, "causeClass")?.value;
  return {
    category: (CATEGORIES as readonly unknown[]).includes(category) ? category as WriterRefusalCategory : "unknown",
    causeClass: (CAUSE_CLASSES as readonly unknown[]).includes(causeClass) ? causeClass as WriterRefusalCause : "unavailable",
  };
}

/** Legacy quiet classification reads only an ordinary error's own string, never a getter or proxy. */
export function memorySyncErrorText(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object" || types.isProxy(error) || !types.isNativeError(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

/**
 * The attestation the hub hands one `syncMemory` pass (#1173). It is agent-mem's own `createPlacementAttestation`, bound to this
 * installation and this memory home; the hub supplies no writer facts of its own and never caches a result past the pass.
 * The transport turns any thrown refusal into a generic "unavailable" result, so the wrapper keeps the first typed refusal for the
 * caller to project; the error is rethrown unchanged so the transport still fails closed.
 */
export function hostPlacementAttestation(home: string, create: typeof createPlacementAttestation = createPlacementAttestation): {
  attest: NonNullable<SyncOptions["placementAttestation"]>;
  refusal: () => WriterRefusal | undefined;
} {
  let inner: ReturnType<typeof createPlacementAttestation> | undefined;
  let refused: WriterRefusal | undefined;
  const attest: NonNullable<SyncOptions["placementAttestation"]> = () => {
    try {
      inner ??= create(home);
      return inner();
    } catch (error) {
      refused ??= writerRefusalOf(error);
      throw error;
    }
  };
  return { attest, refusal: () => refused };
}
