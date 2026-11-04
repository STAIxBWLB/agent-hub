import { configuredPolicy, looksSecret, memoryPolicySnapshot, type MemoryStore } from "@staix/agent-mem";
import { createHash } from "node:crypto";
import { types } from "node:util";

/** Fields produced by agent-mem itself. Every other field is outbound text, including fields this hub has not seen yet. */
// ponytail: projection matches the exact-pinned agent-mem 0.20.1 schema; replace it with the public outbound projection requested in agent-mem#260.
const GENERATED = new Set(["id", "schema", "op", "at", "machine", "actor", "target", "promotedFrom", "supersedes", "expires", "by", "tier", "scope", "kind", "source"]);
const MAX_ROWS = 20_000;
const hostRule = (value: string | undefined): string => value === "hub privacy policy: PII pattern or private path"
  ? value : "hub privacy policy";

export function projectMemorySyncText(row: Record<string, unknown>): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row) || types.isProxy(row)) throw new Error("invalid memory sync row");
  const prototype = Object.getPrototypeOf(row);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(row).length) throw new Error("invalid memory sync row");
  const descriptors = Object.getOwnPropertyDescriptors(row);
  const text = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("invalid memory sync row");
    if (!GENERATED.has(key)) Object.defineProperty(text, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  return text;
}

export type MemorySyncHostScreen = (row: Record<string, unknown>) => { ok: boolean; rule?: string };
export type MemorySyncPolicyResult = { ok: true } | { ok: false; rule: string };

export interface MemorySyncPolicyOptions {
  home: string;
  cwd?: string;
  /** Additional host deny paths and patterns. Machine and repository policy is always loaded and retained. */
  denyPaths?: readonly string[];
  piiPatterns?: readonly string[];
  /** Hub-owned narrowing policy (routing PII and project-private paths). */
  hostScreen?: MemorySyncHostScreen;
}

/**
 * The outbound screen used by agent-mem sync, plus the hub's narrower privacy rules.
 * Machine and repository policy remains authoritative through the public configuredPolicy API.
 */
export function createMemorySyncPolicy(options: MemorySyncPolicyOptions): { screen(row: Record<string, unknown>): MemorySyncPolicyResult } {
  const standalone = configuredPolicy(options.home, options.cwd, { denyPaths: options.denyPaths, piiPatterns: options.piiPatterns });
  return {
    screen(row) {
      let text: Record<string, unknown>;
      try { text = projectMemorySyncText(row); } catch { return { ok: false, rule: "configured standalone policy: invalid input" }; }
      let accepted: boolean;
      try { accepted = standalone.screenStandalone(text); } catch { return { ok: false, rule: "configured standalone policy: invalid input" }; }
      if (!accepted) {
        const safe = memoryPolicySnapshot(text);
        const serialized = safe === undefined ? undefined : safeJson(safe);
        const rule = serialized !== undefined && looksSecret(serialized)
          ? "configured standalone policy: secret"
          : standalone.declinesPersonal(serialized ?? "")
            ? "configured standalone policy: personal data, configured pattern, or deny path"
            : "configured standalone policy: privacy rule";
        return { ok: false, rule };
      }
      if (options.hostScreen) {
        let host: unknown;
        try { host = options.hostScreen(text); } catch { return { ok: false, rule: "hub privacy policy unavailable" }; }
        const result = safeHostResult(host);
        if (!result) return { ok: false, rule: "hub privacy policy unavailable" };
        if (result.ok !== true) return { ok: false, rule: hostRule(result.rule) };
      }
      return { ok: true };
    },
  };
}

function safeJson(value: unknown): string | undefined {
  try { return JSON.stringify(value); } catch { return undefined; }
}

function safeHostResult(value: unknown): { ok: boolean; rule?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !["ok", "rule"].includes(key))) return undefined;
  for (const descriptor of Object.values(descriptors)) if (!descriptor.enumerable || !("value" in descriptor)) return undefined;
  const ok = descriptors.ok?.value;
  const rule = descriptors.rule?.value;
  if (typeof ok !== "boolean" || rule !== undefined && typeof rule !== "string") return undefined;
  return { ok, ...(typeof rule === "string" ? { rule } : {}) };
}

/** Inspect the same physical own rows sync would publish, including forgotten originals still present in the log. */
export function inspectDeclinedMemoryRows(store: MemoryStore, policy: ReturnType<typeof createMemorySyncPolicy>): {
  rows: { id: string; rule: string }[];
  declinedIdsFingerprint: string;
  complete: boolean;
  reason?: string;
} {
  const rows: { id: string; rule: string }[] = [];
  for (const target of store.openedSyncTargets()) {
    // The public prune snapshot is the canonical physical source for generation-backed sync, including shard overlays.
    // The public legacy-prefix reader has no byte-budget argument; do not use it to inspect shared-v1 homes unboundedly.
    if (target.profile.kind !== "generation") return { rows, declinedIdsFingerprint: fingerprint(rows), complete: false, reason: "legacy physical rows cannot be inspected within the sync read bound using the public store API" };
    let snapshot: ReturnType<ReturnType<MemoryStore["prunePort"]>["snapshot"]>;
    try { snapshot = target.prunePort().snapshot(); }
    catch { return { rows, declinedIdsFingerprint: fingerprint(rows), complete: false, reason: "physical memory rows could not be inspected" }; }
    let scanned = 0;
    for (const source of snapshot.rows) {
      if (source.placement !== "synced" || !(source.own || source.legacy)) continue;
      if (++scanned > MAX_ROWS) return { rows, declinedIdsFingerprint: fingerprint(rows), complete: false, reason: `more than ${MAX_ROWS} rows; inspection stopped` };
      const row = source.row as unknown as Record<string, unknown>;
      const result = policy.screen(row);
      if (!result.ok) rows.push({ id: typeof row.id === "string" ? row.id : "(no id)", rule: result.rule });
    }
  }
  return { rows, declinedIdsFingerprint: fingerprint(rows), complete: true };
}

function fingerprint(rows: readonly { id: string }[]): string {
  return createHash("sha256").update([...rows.map(row => row.id)].sort().join("\n")).digest("hex");
}
