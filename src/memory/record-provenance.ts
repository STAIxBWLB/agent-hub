import { types } from "node:util";
import { parseRecordLines } from "@staix/agent-mem";

export interface GeneratedNoteProof { id: string; anchors: readonly string[] }
export const GENERATED_NOTE_LIMITS = Object.freeze({ notes: 1024, anchors: 64, anchorBytes: 512, queryAnchors: 1024, matches: 32 });
const noteId = (value: unknown): string | undefined => typeof value === "string" && /^(?:mem:)?[a-f0-9]{32}$/.test(value)
  ? value.startsWith("mem:") ? value : `mem:${value}` : undefined;
function anchors(value: unknown, max: number, query = false): string[] | undefined {
  if (types.isProxy(value) || !Array.isArray(value) || !value.length || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return;
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, index);
    if (!field || !("value" in field) || typeof field.value !== "string" || field.value.length > GENERATED_NOTE_LIMITS.anchorBytes
      || Buffer.byteLength(field.value) > GENERATED_NOTE_LIMITS.anchorBytes) return;
    if (result.includes(field.value)) { if (!query) return; else continue; }
    result.push(field.value);
  }
  // Grammar is package-owned. Exact equality rejects normalization, splitting and incomplete metadata.
  const parsed = parseRecordLines(`amem: finding | ${result.join(",")} | provenance`);
  const canonical = parsed.records[0]?.anchors;
  if (parsed.incomplete || Object.values(parsed.drops).some(count => count) || parsed.records.length !== 1
    || !canonical || canonical.length !== result.length || canonical.some((value, index) => value !== result[index])) return;
  return result;
}
/** Convert stored owner nodes only; never derive anchors from a note's title or prose. */
export function generatedRecordAnchors(nodes: readonly string[]): string[] | undefined {
  if (types.isProxy(nodes) || !Array.isArray(nodes) || nodes.length > GENERATED_NOTE_LIMITS.anchors) return;
  const result = new Set<string>();
  for (let index = 0; index < nodes.length; index++) {
    const field = Object.getOwnPropertyDescriptor(nodes, index), node: unknown = field && "value" in field ? field.value : undefined;
    if (typeof node !== "string" || node.length > GENERATED_NOTE_LIMITS.anchorBytes || Buffer.byteLength(node) > GENERATED_NOTE_LIMITS.anchorBytes) return;
    if (node.startsWith("path:")) {
      const file = node.slice(5); if (/[#,|]/.test(file)) return;
      result.add(file);
    }
    else if (node.startsWith("symbol:")) {
      const at = node.lastIndexOf("@");
      if (at <= 7 || at === node.length - 1 || node.indexOf("@") !== at || /[#,|]/.test(node.slice(at + 1))) return;
      result.add(`${node.slice(at + 1)}#${node.slice(7, at)}`);
    } else if (!node.startsWith("task:") && !node.startsWith("issue:")) return;
  }
  return anchors([...result], GENERATED_NOTE_LIMITS.anchors);
}

/** Host-only, ephemeral proof. It is not a note store, resolver, or claim accepted from an agent. */
export class GeneratedNoteRegistry {
  // ponytail: restart/eviction falls back to the old bytes until portable generated-note provenance has a public API.
  private readonly notes = new Map<string, GeneratedNoteProof>();
  record(proof: GeneratedNoteProof): void {
    if (!proof || typeof proof !== "object" || types.isProxy(proof)) return;
    const idField = Object.getOwnPropertyDescriptor(proof, "id"), pathsField = Object.getOwnPropertyDescriptor(proof, "anchors");
    const id = noteId(idField && "value" in idField ? idField.value : undefined);
    if (!id) return;
    const paths = anchors(pathsField && "value" in pathsField ? pathsField.value : undefined, GENERATED_NOTE_LIMITS.anchors);
    this.notes.delete(id); // Incomplete replacement metadata cannot retain a stale proof.
    if (!paths) return;
    this.notes.set(id, { id, anchors: paths });
    if (this.notes.size > GENERATED_NOTE_LIMITS.notes) this.notes.delete(this.notes.keys().next().value!);
  }
  get(value: string): GeneratedNoteProof | undefined {
    const id = noteId(value), proof = id ? this.notes.get(id) : undefined;
    if (!id || !proof) return;
    this.notes.delete(id); this.notes.set(id, proof);
    return { id, anchors: [...proof.anchors] };
  }
  /** Shortlist by exact anchor intersection only; the consumer must separately prove full replacement coverage. */
  matching(value: readonly string[], limit: number = GENERATED_NOTE_LIMITS.matches): GeneratedNoteProof[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > GENERATED_NOTE_LIMITS.matches) return [];
    const paths = anchors(value, GENERATED_NOTE_LIMITS.queryAnchors, true);
    if (!paths) return [];
    const wanted = new Set(paths), matches: GeneratedNoteProof[] = [];
    for (const proof of [...this.notes.values()].reverse()) {
      if (!proof.anchors.some(anchor => wanted.has(anchor))) continue;
      matches.push({ id: proof.id, anchors: [...proof.anchors] });
      if (matches.length === limit) break;
    }
    // Touch oldest first so a shortlist read preserves the relative MRU ordering.
    for (const proof of [...matches].reverse()) this.get(proof.id);
    return matches;
  }
  clear(): void { this.notes.clear(); }
}
