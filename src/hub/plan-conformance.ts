import { createHash } from "node:crypto";
import { types } from "node:util";

export interface PlanConformance {
  state: "covered" | "departure" | "unknown";
  head?: string;
  outside: string[];
  untouched: string[];
}
/** Repository-relative literal names only. A star is a filename character, never a glob operator. */
function pathIdentity(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw || raw.length > 1000 || /[\p{Cc}\p{Cf}]/u.test(raw)
    || raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:/.test(raw)) return undefined;
  const path = raw.replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || ".";
  if (path === "." || path.split("/").some(part => part === "." || part === "..")) return undefined;
  return path;
}
const covers = (planned: string, changed: string) => changed === planned || changed.startsWith(`${planned}/`);

/** A complete file inventory is independent of any plan or coverage claim. */
export function completePlanInventory(evidence: { head: string; paths: readonly string[]; pathsComplete?: boolean } | undefined): string[] | undefined {
  if (!evidence || typeof evidence.head !== "string" || !/^[a-f0-9]{40}$/.test(evidence.head) || evidence.pathsComplete !== true || !Array.isArray(evidence.paths) || evidence.paths.length > 1000) return undefined;
  const paths: string[] = [], seen = new Set<string>();
  for (const raw of evidence.paths) {
    const path = pathIdentity(raw); if (path === undefined || seen.has(path)) return undefined;
    seen.add(path); paths.push(path);
  }
  return paths;
}

/** Compare current complete PR file metadata with the current plan; never inspect patches or the filesystem. */
export function planConformance(planPaths: readonly string[] | undefined, evidence: { head: string; paths: readonly string[]; pathsComplete?: boolean } | undefined): PlanConformance {
  const head = typeof evidence?.head === "string" && /^[a-f0-9]{40}$/.test(evidence.head) ? evidence.head : undefined;
  const unknown: PlanConformance = { state: "unknown", ...(head ? { head } : {}), outside: [], untouched: [] };
  const changed = completePlanInventory(evidence);
  if (!head || changed === undefined
    || !Array.isArray(planPaths) || !planPaths.length || planPaths.length > 1000) return unknown;
  const planned: string[] = [], seenPlan = new Set<string>();
  for (const raw of planPaths) {
    const path = pathIdentity(raw); if (path === undefined) return unknown;
    if (!seenPlan.has(path)) { seenPlan.add(path); planned.push(path); }
  }
  const outside = changed.filter(path => !planned.some(plan => covers(plan, path)));
  const untouched = planned.filter(plan => !changed.some(path => covers(plan, path)));
  return { state: outside.length ? "departure" : "covered", head, outside, untouched };
}

/** Hash plain plan data without invoking accessors/toJSON; object key order is immaterial, list order is not. */
export function planFingerprint(plan: unknown): string {
  const seen = new Set<object>();
  const fail = (): never => { throw new Error("invalid plan fingerprint data"); };
  const encode = (value: unknown, depth: number): string => {
    if (depth > 64) return fail();
    if (value === undefined) return "undefined";
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : fail();
    if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) return fail();
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Reflect.ownKeys(descriptors).length !== value.length + 1) return fail();
        return "[" + Array.from({ length: value.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          return descriptor && Object.hasOwn(descriptor, "value") ? encode(descriptor.value, depth + 1) : fail();
        }).join(",") + "]";
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
      const keys = Reflect.ownKeys(value); if (keys.some(key => typeof key !== "string")) return fail();
      return "{" + (keys as string[]).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return fail();
        return JSON.stringify(key) + ":" + encode(descriptor.value, depth + 1);
      }).join(",") + "}";
    } finally { seen.delete(value); }
  };
  return createHash("sha256").update(encode(plan, 0)).digest("hex");
}

/** Approval blockers only; untouched planned files are advisory. */
export function planConformanceBlockers(plan: (PlanConformance & { accepted?: boolean }) | undefined): string[] {
  return !plan ? [] : plan.state === "unknown" ? ["plan conformance unknown"] : plan.state === "departure" && !plan.accepted ? ["plan conformance: changed files outside the plan"] : [];
}
