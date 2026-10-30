import { createHash } from "node:crypto";
import { sanitize } from "./envelope.ts";

/**
 * #445 C1: what an agent can offer another, and what a person has agreed to share. Pure: no I/O, no clock, no process. The hub never calls any of these capabilities itself (C2 sends a request to the
 * owner's own session); this module only decides what is LISTED.
 *
 * Authority: nothing is shared unless the person wrote it, in `invocation.share` of `.agenthub/config.local.json`, keyed by the exact peer id and the capability id and pinned by the capability's digest.
 * Everything that comes from an agent (names, descriptions, schemas, the publisher's side-effect declaration) is untrusted text and only ever narrows what is shown.
 */

export const SIDE_EFFECTS = ["read", "write", "external", "destructive"] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];
export const CAPABILITY_KINDS = ["command", "skill", "mcp_tool"] as const;
export const CAPABILITY_SOURCES = ["acp", "codex-skills", "published"] as const;
export const CAPABILITY_INVOKES = ["native", "prompt"] as const;

export const NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const DESCRIPTION_MAX = 300;
/** A listing is bounded: no source can make the hub hold or show an unbounded manifest. */
export const MAX_CAPABILITIES = 128;
const MAX_SCHEMA_PROPERTIES = 16;
const MAX_SCHEMA_ENUM = 32;
const MAX_ENUM_VALUE = 64;
const MAX_PUBLISH_BYTES = 64 * 1024;

export interface FlatSchema {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "boolean"; enum?: string[]; description?: string }>;
  required?: string[];
  additionalProperties: false;
}
export interface Capability {
  id: string;
  kind: (typeof CAPABILITY_KINDS)[number];
  name: string;
  description: string;
  inputSchema?: FlatSchema;
  /** The publisher's declared class; absent when its source names none (every native listing). */
  sideEffect?: SideEffect;
  source: (typeof CAPABILITY_SOURCES)[number];
  invoke: (typeof CAPABILITY_INVOKES)[number];
  digest: string;
}
export interface CapabilityManifest { capabilities: Capability[]; observedAt: number }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const CONTROL_CHARS = "[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]";
/** Two regexes on purpose: the global one replaces, the plain one tests (a global regex keeps lastIndex between test calls and would miss the second of two strings). */
const CONTROL = new RegExp(CONTROL_CHARS, "g"), HAS_CONTROL = new RegExp(CONTROL_CHARS);

/** Canonical JSON: sorted keys at every depth, so equal values digest equally whatever order a source wrote them in. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * The digest pins what a person agreed to: the identity of the capability, what it takes, the declared class, where it came from and how it is run. The description is NOT in it: it is capped untrusted text
 * a source may reword freely, so rewording must not unlist an entry, while a changed schema, class, source or invoke form must.
 */
export function capabilityDigest(c: Pick<Capability, "kind" | "name" | "inputSchema" | "sideEffect" | "source" | "invoke">): string {
  return `sha256:${createHash("sha256").update(canonical({ kind: c.kind, name: c.name, inputSchema: c.inputSchema ?? null, sideEffect: c.sideEffect ?? null, source: c.source, invoke: c.invoke })).digest("hex")}`;
}

/** Agent text shown to another model: control and bidirectional characters out, header forgery quoted, whitespace collapsed, cut by code point. */
export function cleanDescription(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  return Array.from(sanitize(text.replace(CONTROL, " ")).replace(/\s+/g, " ").trim()).slice(0, DESCRIPTION_MAX).join("");
}

/** A flat object of strings, numbers, booleans and string enums, nothing nested, nothing extra. Anything else is not a schema this hub will carry. */
export function flatSchema(raw: unknown): FlatSchema | undefined {
  if (!object(raw) || raw.type !== "object" || raw.additionalProperties !== false || !object(raw.properties)) return undefined;
  const names = Object.keys(raw.properties);
  if (names.length === 0 || names.length > MAX_SCHEMA_PROPERTIES) return undefined;
  const properties: FlatSchema["properties"] = {};
  for (const name of names) {
    const prop = raw.properties[name];
    if (!NAME_RE.test(name) || !object(prop) || !["string", "number", "boolean"].includes(prop.type as string)) return undefined;
    const extra = Object.keys(prop).filter(key => !["type", "enum", "description"].includes(key));
    if (extra.length) return undefined;
    const out: FlatSchema["properties"][string] = { type: prop.type as "string" | "number" | "boolean" };
    if (prop.enum !== undefined) {
      if (prop.type !== "string" || !Array.isArray(prop.enum) || prop.enum.length === 0 || prop.enum.length > MAX_SCHEMA_ENUM
        || !prop.enum.every(value => typeof value === "string" && value.length >= 1 && value.length <= MAX_ENUM_VALUE && !HAS_CONTROL.test(value))) return undefined;
      out.enum = [...prop.enum] as string[];
    }
    if (prop.description !== undefined) out.description = cleanDescription(prop.description);
    properties[name] = out;
  }
  let required: string[] | undefined;
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || !raw.required.every(name => typeof name === "string" && Object.hasOwn(properties, name))) return undefined;
    required = [...new Set(raw.required as string[])];
  }
  return { type: "object", properties, ...(required?.length ? { required } : {}), additionalProperties: false };
}

/** A class a side wrote: absent stays absent (it contributes nothing, O6), but a value that is not one of the four reads as the most dangerous one. */
export function declaredClass(raw: unknown): SideEffect | undefined {
  if (raw === undefined) return undefined;
  return typeof raw === "string" && (SIDE_EFFECTS as readonly string[]).includes(raw) ? raw as SideEffect : "destructive";
}
const RANK: Record<SideEffect, number> = { read: 0, write: 1, external: 2, destructive: 3 };
/** The higher of the publisher's declaration and the person's class (owner decision O1): neither side can make a capability look safer than the other said. */
export function effectiveClass(declared: SideEffect | undefined, person: unknown): SideEffect {
  const chosen = declaredClass(person);
  if (declared === undefined) return chosen ?? "destructive"; // O6: only when neither side names a class
  if (chosen === undefined) return declared;
  return RANK[chosen] >= RANK[declared] ? chosen : declared;
}

export interface Candidate { kind: unknown; name: unknown; description?: unknown; inputSchema?: unknown; sideEffect?: unknown; source: Capability["source"]; invoke: Capability["invoke"] }
/** One capability from one source, made safe, or undefined when it is not a capability this hub will carry. The id is derived, never taken from the source. */
export function buildCapability(candidate: Candidate): Capability | undefined {
  if (!(CAPABILITY_KINDS as readonly unknown[]).includes(candidate.kind) || typeof candidate.name !== "string" || !NAME_RE.test(candidate.name)) return undefined;
  let inputSchema: FlatSchema | undefined;
  if (candidate.inputSchema !== undefined) { inputSchema = flatSchema(candidate.inputSchema); if (!inputSchema) return undefined; }
  const kind = candidate.kind as Capability["kind"], sideEffect = declaredClass(candidate.sideEffect);
  const base = { kind, name: candidate.name, ...(inputSchema ? { inputSchema } : {}), ...(sideEffect ? { sideEffect } : {}), source: candidate.source, invoke: candidate.invoke };
  return { id: `${kind}:${candidate.name}`, ...base, description: cleanDescription(candidate.description), digest: capabilityDigest(base) };
}

/** A manifest from a source's raw list: invalid entries are dropped one by one, duplicates by id keep the first, and the whole is bounded. */
export function buildManifest(raw: readonly Candidate[], observedAt: number): CapabilityManifest {
  const seen = new Set<string>(), capabilities: Capability[] = [];
  for (const candidate of raw) {
    const built = buildCapability(candidate);
    if (!built || seen.has(built.id)) continue;
    seen.add(built.id); capabilities.push(built);
    if (capabilities.length >= MAX_CAPABILITIES) break;
  }
  return { capabilities, observedAt };
}

export class PublishRefusal extends Error {}
/**
 * `hub_capabilities_publish`: the source for a session whose capabilities the hub cannot read natively. Every field is checked, an unknown field is a refusal, nothing is stored on a refusal, and the invoke
 * form is forced to `prompt`: a publisher cannot claim a native path the hub never verified.
 */
export function validatePublished(raw: unknown, observedAt: number): CapabilityManifest {
  if (!object(raw) || Object.keys(raw).some(key => key !== "capabilities") || !Array.isArray(raw.capabilities)) throw new PublishRefusal("capabilities must be an array");
  if (raw.capabilities.length === 0) throw new PublishRefusal("capabilities must not be empty (publish a list, or nothing)");
  if (raw.capabilities.length > MAX_CAPABILITIES) throw new PublishRefusal(`at most ${MAX_CAPABILITIES} capabilities`);
  if (JSON.stringify(raw.capabilities).length > MAX_PUBLISH_BYTES) throw new PublishRefusal("the list is too large");
  const seen = new Set<string>(), candidates: Candidate[] = [];
  raw.capabilities.forEach((entry, index) => {
    const at = `capabilities[${index}]`;
    if (!object(entry)) throw new PublishRefusal(`${at} must be an object`);
    const extra = Object.keys(entry).filter(key => !["kind", "name", "description", "inputSchema", "sideEffect"].includes(key));
    if (extra.length) throw new PublishRefusal(`${at}: unknown field ${JSON.stringify(extra[0])}`);
    if (!(CAPABILITY_KINDS as readonly unknown[]).includes(entry.kind)) throw new PublishRefusal(`${at}.kind must be one of ${CAPABILITY_KINDS.join(", ")}`);
    if (typeof entry.name !== "string" || !NAME_RE.test(entry.name)) throw new PublishRefusal(`${at}.name must match ${NAME_RE}`);
    if (typeof entry.description !== "string") throw new PublishRefusal(`${at}.description must be text`);
    if (entry.sideEffect === undefined || !(SIDE_EFFECTS as readonly unknown[]).includes(entry.sideEffect)) throw new PublishRefusal(`${at}.sideEffect must be one of ${SIDE_EFFECTS.join(", ")}`);
    if (entry.inputSchema !== undefined && !flatSchema(entry.inputSchema)) throw new PublishRefusal(`${at}.inputSchema must be a flat object of string, number, boolean or string enum properties with additionalProperties false`);
    const id = `${entry.kind}:${entry.name}`;
    if (seen.has(id)) throw new PublishRefusal(`${at}: ${id} is listed twice`);
    seen.add(id);
    candidates.push({ kind: entry.kind, name: entry.name, description: entry.description, inputSchema: entry.inputSchema, sideEffect: entry.sideEffect, source: "published", invoke: "prompt" });
  });
  return buildManifest(candidates, observedAt);
}

export interface ShareEntry { digest: string; class?: SideEffect }
export type ShareConfig = Record<string, Record<string, ShareEntry>>;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** `invocation.share` as written by a person: malformed entries are dropped and say nothing is shared for them; it is never an error that stops the hub. */
export function readShare(raw: unknown): ShareConfig {
  const out: ShareConfig = {};
  if (!object(raw)) return out;
  for (const [peer, entries] of Object.entries(raw)) {
    if (!object(entries) || !/^[a-z][a-z0-9-]{0,31}$/.test(peer)) continue;
    const kept: Record<string, ShareEntry> = {};
    for (const [id, entry] of Object.entries(entries)) {
      if (!/^(command|skill|mcp_tool):[A-Za-z0-9_.:-]{1,64}$/.test(id) || !object(entry) || typeof entry.digest !== "string" || !DIGEST_RE.test(entry.digest)) continue;
      const cls = entry.class === undefined ? undefined : (SIDE_EFFECTS as readonly unknown[]).includes(entry.class) ? entry.class as SideEffect : null;
      if (cls === null) continue;
      kept[id] = { digest: entry.digest, ...(cls ? { class: cls } : {}) };
    }
    if (Object.keys(kept).length) out[peer] = kept;
  }
  return out;
}

export interface Listed { id: string; kind: Capability["kind"]; name: string; description: string; inputSchema?: FlatSchema; class: SideEffect; invoke: Capability["invoke"]; source: Capability["source"]; digest: string }
/**
 * What `peer` offers: the capabilities of its manifest that the person listed BY THIS PEER ID and whose digest still matches. A digest change drops the entry until the person pins the new one, and a peer id
 * never reads another peer's entries (an instance `codex-2` does not inherit `codex`). With no share, or no manifest, the answer is nothing.
 */
export function listedCapabilities(peer: string, manifest: CapabilityManifest | undefined, share: ShareConfig): Listed[] {
  const entries = Object.hasOwn(share, peer) ? share[peer] : undefined;
  if (!manifest || !entries) return [];
  const out: Listed[] = [];
  for (const cap of manifest.capabilities) {
    const entry = Object.hasOwn(entries, cap.id) ? entries[cap.id] : undefined;
    if (!entry || entry.digest !== cap.digest) continue;
    out.push({ id: cap.id, kind: cap.kind, name: cap.name, description: cap.description, ...(cap.inputSchema ? { inputSchema: cap.inputSchema } : {}), class: effectiveClass(cap.sideEffect, entry.class), invoke: cap.invoke, source: cap.source, digest: cap.digest });
  }
  return out;
}

export type ShareState = "listed" | "unshared" | "digest-changed";
/** For the person's `ahub capabilities`: every manifest entry, whether the person shares it, and the class that would apply. */
export function shareView(peer: string, manifest: CapabilityManifest | undefined, share: ShareConfig): Array<{ id: string; kind: Capability["kind"]; name: string; description: string; source: Capability["source"]; invoke: Capability["invoke"]; digest: string; state: ShareState; class: SideEffect }> {
  const entries = Object.hasOwn(share, peer) ? share[peer] : undefined;
  return (manifest?.capabilities ?? []).map(cap => {
    const entry = entries && Object.hasOwn(entries, cap.id) ? entries[cap.id] : undefined;
    const state: ShareState = !entry ? "unshared" : entry.digest === cap.digest ? "listed" : "digest-changed";
    return { id: cap.id, kind: cap.kind, name: cap.name, description: cap.description, source: cap.source, invoke: cap.invoke, digest: cap.digest, state, class: effectiveClass(cap.sideEffect, entry?.class) };
  });
}
