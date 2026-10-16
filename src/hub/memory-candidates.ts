import { looksSecret, type CandidateStore, type CounterKey, type MemoryStore, type View } from "@staix/agent-mem";
import type { MemoryScreen } from "./read-tools.ts";
import { PreEffectToolRefusal } from "./tool-refusal.ts";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const refuse = (): never => { throw new PreEffectToolRefusal("memory read unavailable"); };
export interface CorrectionInput { id: string; text: string; reason: string }

/** Validate model input before resolving a memory id or opening the candidate sidecar. */
export function correctionInput(args: unknown): CorrectionInput {
  if (!args || typeof args !== "object" || Array.isArray(args)) refuse();
  const input = args as Record<string, unknown>;
  const string = (value: unknown, min: number, max: number): value is string => typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && bytes(value) >= min && bytes(value) <= max;
  if (Object.keys(input).some(key => !["id", "text", "reason"].includes(key)) || !string(input.id, 6, 64) || !string(input.text, 1, 4000) || !string(input.reason, 1, 4000)) refuse();
  const result = { id: input.id, text: input.text, reason: input.reason } as CorrectionInput;
  if (bytes(JSON.stringify(result)) > 8192) refuse();
  return result;
}

function safe(value: unknown, screen: MemoryScreen): boolean {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return !looksSecret(text) && screen([{ title: null, text }]).length === 1;
  } catch { return false; }
}

function visibleId(input: string, screen: MemoryScreen): string {
  if (typeof input !== "string" || bytes(input) < 6 || bytes(input) > 64 || !safe(input, screen)) refuse();
  const id = input.replace(/^mem:/, "");
  if (id.length < 6) refuse();
  return id;
}

/** One screened projection per operation; never retained across calls or revisions. */
function visibleResolver(store: MemoryStore, project: string, screen: MemoryScreen): (id: string) => View {
  const all = screen(store.list({ project, limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true })).filter(view => safe(view, screen));
  const byId = new Map(all.map(view => [view.id, view]));
  const promoted = new Map<string, View[]>();
  for (const view of all) if (view.promotedFrom) {
    const group = promoted.get(view.promotedFrom) ?? [];
    group.push(view); promoted.set(view.promotedFrom, group);
  }
  const aliases = [...new Set([...byId.keys(), ...promoted.keys()])], exactAliases = new Set(aliases);
  return id => {
    const matched = exactAliases.has(id) ? [id] : aliases.filter(alias => alias.startsWith(id));
    let found: View | undefined;
    if (matched.length === 1) {
      found = byId.get(matched[0]!);
      if (!found) {
        const copies = promoted.get(matched[0]!) ?? [];
        if (copies.length === 1) found = copies[0];
      }
    } else if (matched.length === 0) {
      // Older promotion chains need the core's redirect, but may terminate only in this screened snapshot.
      const redirected = store.get(id, project);
      found = redirected && byId.get(redirected.id);
    }
    if (!found || found.supersededBy) return refuse();
    return found;
  };
}

/** Resolve only screened visible ids and aliases; unavailable and ambiguous inputs have the same refusal. */
export function resolveVisibleMemory(store: MemoryStore, project: string, screen: MemoryScreen, input: string): View {
  const id = visibleId(input, screen); // Input rejection precedes any storage work.
  try { return store.withDeferredPromotions(() => visibleResolver(store, project, screen)(id)); }
  catch { return refuse(); }
}

export type MemoryCounterContext = Omit<CounterKey, "entryId" | "project">;
export type MemoryCounterField = "rendered" | "delivered" | "cited";

/** Sidecar-only observations: the absent fields stay unknown; no message body is persisted. */
export class MemoryTelemetry {
  constructor(private readonly sidecar: CandidateStore, private readonly store: MemoryStore, private readonly project: string, private readonly screen: MemoryScreen) {}

  record(text: string, context: MemoryCounterContext, field: MemoryCounterField, privateTurn = false): void {
    if (privateTurn || !["rendered", "delivered", "cited"].includes(field)) return;
    try {
      if (!safe(context, this.screen)) return;
      const ids = new Set<string>();
      for (const match of text.matchAll(/\bmem:([a-f0-9]{8,64})(?![a-zA-Z0-9])/g)) {
        try { ids.add(visibleId(match[1]!, this.screen)); } catch { /* unavailable input */ }
      }
      if (!ids.size) return;
      this.store.withDeferredPromotions(() => {
        const resolve = visibleResolver(this.store, this.project, this.screen), seen = new Set<string>();
        for (const id of ids) {
          try {
            const view = resolve(id);
            if (seen.has(view.id)) continue;
            seen.add(view.id);
            this.sidecar.recordCounter({ ...context, project: this.project, entryId: view.id }, { [field]: 1 }, "public");
          } catch { /* A hidden, ambiguous or unavailable citation reveals no counters or diagnostics. */ }
        }
      });
    } catch { /* Sidecar telemetry never blocks a delivery or an answer. */ }
  }
}
