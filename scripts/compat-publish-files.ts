import type { PublishedReceipt } from "./compat-publish.ts";

/** Closed error: never include source text or artifact-controlled prose. */
export class CompatPublishFilesError extends Error {
  constructor() { super("compat publish file input invalid; no files changed"); this.name = "CompatPublishFilesError"; }
}
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const RECEIPT = /^docs\/verification\/\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])-[a-z][a-z0-9.-]*\.md$/;
const OPEN = "export const COMPAT = {";
const CLOSE = "} as const satisfies Record<string, CompatPolicy>;";
function fail(): never { throw new CompatPublishFilesError(); }
function validVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = VERSION.exec(value);
  return !!match && match[0] === value && (!match[4] || match[4].split(".").every(part => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0")));
}
function validReceipt(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length <= 200 && RECEIPT.test(value) && !value.includes("..");
}
interface Row { id: string; versions: string[]; arrayStart: number; arrayEnd: number; array: string; receiptStart: number; receiptEnd: number }
function rows(source: string): Row[] {
  if (typeof source !== "string") return fail();
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset = 0, opened = false, closed = false;
  const result: Row[] = [], seen = new Set<string>();
  let current: Omit<Row, "receiptStart" | "receiptEnd"> | undefined;
  for (const line of lines) {
    const text = line.replace(/\r?\n$/, "");
    if (text === OPEN) {
      if (opened || closed || current) return fail();
      opened = true;
    } else if (text === CLOSE) {
      if (!opened || closed || current) return fail();
      closed = true;
    } else if (opened && !closed) {
      if (!current) {
        if (/^\s*$/.test(text) || /^  \/\//.test(text)) { offset += line.length; continue; }
        // Deliberately accept the committed row grammar only. JSON literals are parsed, never TS.
        const start = /^  ("[a-z][a-z0-9-]*"|[a-z][a-z0-9]*): \{ label: "(?:[^"\\]|\\.)*", verified: (\[[^\r\n]*?\]),/.exec(text);
        if (!start) return fail();
        const id = start[1]!.startsWith('"') ? JSON.parse(start[1]!) as string : start[1]!;
        if (!ID.test(id) || id.trim() !== id || seen.has(id) || (text.match(/\bverified\s*:/g) ?? []).length !== 1) return fail();
        let versions: unknown;
        try { versions = JSON.parse(start[2]!); } catch { return fail(); }
        if (!Array.isArray(versions) || !versions.every(validVersion) || new Set(versions).size !== versions.length) return fail();
        const arrayStart = offset + text.indexOf(start[2]!, text.indexOf("verified:"));
        current = { id, versions, arrayStart, arrayEnd: arrayStart + start[2]!.length, array: start[2]! };
        seen.add(id);
      } else {
        const end = /^    receipt: ("(?:[^"\\]|\\.)*") \},$/.exec(text);
        if (end) {
          let receipt: unknown;
          try { receipt = JSON.parse(end[1]!); } catch { return fail(); }
          if (!validReceipt(receipt)) return fail();
          const receiptStart = offset + text.indexOf(end[1]!);
          result.push({ ...current, receiptStart, receiptEnd: receiptStart + end[1]!.length });
          current = undefined;
        } else if (!/^    \S/.test(text) || /\b(?:verified|receipt)\s*:/.test(text) || /[`]|\/\*/.test(text)) return fail();
      }
    }
    offset += line.length;
  }
  if (!opened || !closed || current || !result.length) return fail();
  return result;
}
function selected(source: string, id: string): Row {
  if (typeof id !== "string" || !ID.test(id) || id.trim() !== id) return fail();
  return rows(source).find(row => row.id === id) ?? fail();
}

/** Return a detached literal array; never import or execute the TypeScript policy. */
export function readCompatVerified(source: string, id: string): string[] {
  return [...selected(source, id).versions];
}

/** Change only the selected verified literal and receipt string, retaining every other byte. */
export function patchCompatSource(source: string, id: string, version: string, receiptPath: string): string {
  if (!validVersion(version) || !validReceipt(receiptPath)) return fail();
  const row = selected(source, id);
  let array = row.array;
  if (!row.versions.includes(version)) {
    const end = array.search(/\s*\]$/);
    if (end < 0) return fail();
    array = `${array.slice(0, end)}${row.versions.length ? ", " : ""}${JSON.stringify(version)}${array.slice(end)}`;
  }
  return source.slice(0, row.arrayStart) + array + source.slice(row.arrayEnd, row.receiptStart)
    + JSON.stringify(receiptPath) + source.slice(row.receiptEnd);
}

const STATUSES = new Set(["pass", "fail", "not-run"]);
const CAUSES = new Set(["ok", "proof-failed", "timeout", "cancelled", "platform", "model-required", "tui-required", "producer-not-committed", "producer-not-importable", "not-applicable", "disposable-required", "process-cleanup-unproven", "source-review-required", "install-unavailable", "integrity", "input", "cleanup"]);
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || keys.some(key => !descriptors[key] || !("value" in descriptors[key]!)) || Object.keys(descriptors).some(key => !keys.includes(key))) return fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function proof(value: unknown): Record<string, unknown> {
  const row = record(value, ["status", "cause"]);
  if (!STATUSES.has(row.status as string) || !CAUSES.has(row.cause as string) || (row.status === "pass") !== (row.cause === "ok")) return fail();
  return row;
}

/** Render only the publisher's validated projection, never native output or artifact Markdown. */
export function renderPublishedReceipt(projection: PublishedReceipt): string {
  const row = record(projection, ["schemaVersion", "id", "version", "procedureReceipt", "runnerOS", "architecture", "artifact", "installation", "ownedStopConfirmed", "processCleanup", "containment", "outcome", "autoAdmit", "legs"]);
  if (row.schemaVersion !== 1 || typeof row.id !== "string" || !ID.test(row.id) || row.id.trim() !== row.id || !validVersion(row.version) || !validReceipt(row.procedureReceipt)
    || !["linux", "macos"].includes(row.runnerOS as string) || !["arm64", "x64"].includes(row.architecture as string)
    || typeof row.ownedStopConfirmed !== "boolean" || !["proven", "unproven"].includes(row.processCleanup as string)
    || row.containment !== "disposable-runner-lifetime" || !STATUSES.has(row.outcome as string) || typeof row.autoAdmit !== "boolean"
    || !Array.isArray(row.legs) || row.legs.length > 128) return fail();
  const installation = proof(row.installation);
  let artifact = "No installed artifact.";
  if (row.artifact !== null) {
    const art = record(row.artifact, ["method", "integrity"]);
    if (typeof art.integrity !== "string" || !["npm-exact", "github-release-asset-checksum"].includes(art.method as string)
      || (art.method === "npm-exact" ? !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(art.integrity) : !/^sha256:[a-f0-9]{64}$/.test(art.integrity))) return fail();
    artifact = `Artifact: ${art.method}, integrity \`${art.integrity}\`.`;
  }
  const seen = new Set<string>();
  const legs = row.legs.map(value => {
    const leg = record(value, ["id", "category", "requiredForAdmission", "status", "cause"]);
    if (typeof leg.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(leg.id) || leg.id.trim() !== leg.id || leg.id.length > 128 || seen.has(leg.id)
      || !["linux-ci", "macos-runner", "account-or-model", "tui-desktop"].includes(leg.category as string) || typeof leg.requiredForAdmission !== "boolean") return fail();
    const check = proof({ status: leg.status, cause: leg.cause }); seen.add(leg.id);
    return `| ${leg.id} | ${leg.category} | ${leg.requiredForAdmission ? "yes" : "no"} | ${check.status} | ${check.cause} |`;
  });
  return [`# Compatibility receipt: ${row.id} ${row.version}`, "", "Refs #1248.", "",
    `Procedure: [${row.procedureReceipt}](${(row.procedureReceipt as string).split("/").at(-1)}).`, "", `Runner: ${row.runnerOS} ${row.architecture}.`, "", artifact, "",
    `Installation: ${installation.status} (${installation.cause}).`, `Outcome: ${row.outcome}. Auto-admit policy: ${row.autoAdmit ? "enabled" : "disabled"}.`, "",
    `Owned stop confirmed: ${row.ownedStopConfirmed ? "yes" : "no"}. Process cleanup: ${row.processCleanup}. Containment: ${row.containment}.`, "",
    "| Leg | Category | Required | Status | Cause |", "| --- | --- | --- | --- | --- |", ...legs, "",
    "Only the listed observations are recorded. Account, model and TUI behavior require their own proof legs.", ""].join("\n");
}
