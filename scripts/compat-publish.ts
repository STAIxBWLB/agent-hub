/** Publisher policy only: no I/O, clock, environment, package loading or artifact Markdown. */
export type PublishStatus = "pass" | "fail" | "not-run";
export type PublishCause = "ok" | "proof-failed" | "timeout" | "cancelled" | "platform" | "model-required" | "tui-required"
  | "producer-not-committed" | "producer-not-importable" | "not-applicable" | "disposable-required" | "process-cleanup-unproven"
  | "source-review-required" | "install-unavailable" | "integrity" | "input" | "cleanup";
export interface PublishManifestEntry {
  receipt: string; runnerOS: readonly string[]; nativePlatform: string; autoAdmit: boolean;
  install: { method: string };
  legs: readonly { id: string; category: string; runnerOS: readonly string[]; requiredForAdmission: boolean }[];
}
export interface PublishCandidate { id: string; version: string }
export interface CompatPullRequest extends PublishCandidate { number: number; branch: string; state: "open" | "closed" | "merged" }
export interface PublishedLeg { id: string; category: string; requiredForAdmission: boolean; status: PublishStatus; cause: PublishCause }
export interface PublishedReceipt extends PublishCandidate {
  schemaVersion: 1; procedureReceipt: string; runnerOS: string; architecture: string;
  artifact: { method: string; integrity: string } | null;
  installation: { status: PublishStatus; cause: PublishCause };
  ownedStopConfirmed: boolean; processCleanup: "proven" | "unproven"; containment: "disposable-runner-lifetime";
  outcome: PublishStatus; autoAdmit: boolean; legs: PublishedLeg[];
}
export type PublishDriftCause = "missing-artifact" | "malformed-artifact" | "proof-failed" | "not-run" | "policy" | "newer-pr" | "already-published";
export type CompatPublishAction =
  | (PublishCandidate & { kind: "create-pr"; branch: string; receipt: PublishedReceipt })
  | (PublishCandidate & { kind: "update-pr"; branch: string; number: number; receipt: PublishedReceipt })
  | (PublishCandidate & { kind: "supersede-pr"; branch: string; number: number; replacementVersion: string; replacementBranch: string })
  | (PublishCandidate & { kind: "update-drift"; cause: PublishDriftCause; legs: PublishedLeg[]; processCleanup?: "proven" | "unproven"; ownedStopConfirmed?: boolean });
export interface CompatPublishInput {
  manifest: Readonly<Record<string, PublishManifestEntry>>; candidates: readonly PublishCandidate[];
  artifacts: readonly unknown[]; existingPullRequests: readonly CompatPullRequest[]; dryRun: boolean;
}
export interface CompatPublishPlan { dryRun: boolean; actions: CompatPublishAction[] }
export class CompatPublishInputError extends Error { constructor() { super("compat publish input invalid; no actions planned"); this.name = "CompatPublishInputError"; } }

const CAUSES = new Set<PublishCause>(["ok", "proof-failed", "timeout", "cancelled", "platform", "model-required", "tui-required", "producer-not-committed",
  "producer-not-importable", "not-applicable", "disposable-required", "process-cleanup-unproven", "source-review-required", "install-unavailable", "integrity", "input", "cleanup"]);
const SOURCE_LEGS = new Set(["source-impact", "source-review", "source-comparison", "upstream-impact-review", "tag-binding", "reviewed-optional-lifecycle-replay"]);
const CATEGORIES = new Set(["linux-ci", "macos-runner", "account-or-model", "tui-desktop"]);
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const LEG_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function version(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parts = VERSION.exec(value);
  return !!parts && (!parts[4] || parts[4].split(".").every(part => !/^[0-9]+$/.test(part) || part === "0" || !part.startsWith("0")));
}
function compare(a: string, b: string): number {
  const aa = VERSION.exec(a)!, bb = VERSION.exec(b)!;
  for (const i of [1, 2, 3]) { const x = BigInt(aa[i]!), y = BigInt(bb[i]!); if (x !== y) return x > y ? 1 : -1; }
  if (aa[4] === bb[4]) return 0;
  if (!aa[4]) return 1; if (!bb[4]) return -1;
  const x = aa[4].split("."), y = bb[4].split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1; if (y[i] === undefined) return 1;
    const left = x[i]!, right = y[i]!; if (left === right) continue;
    const ln = /^[0-9]+$/.test(left), rn = /^[0-9]+$/.test(right);
    if (ln && rn) return BigInt(left) > BigInt(right) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}
function record(value: unknown, allowed?: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.values(fields).some(field => !Object.hasOwn(field, "value")) || allowed && Object.keys(fields).some(key => !allowed.includes(key))) return;
  return value as Record<string, unknown>;
}
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 4096;
function legArray(value: unknown, length: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return;
  const fields: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value as object);
  if (fields.length?.value !== length || Object.keys(fields).length !== length + 1) return;
  const rows: unknown[] = [];
  for (let i = 0; i < length; i++) { const field = fields[String(i)]; if (!field || !Object.hasOwn(field, "value")) return; rows.push(field.value); }
  return rows;
}
const status = (value: unknown): value is PublishStatus => value === "pass" || value === "fail" || value === "not-run";
function proof(value: unknown): { status: PublishStatus; cause: PublishCause } | undefined {
  const row = record(value, ["status", "cause", "reason", "nextStep"]);
  if (!row || !status(row.status) || !CAUSES.has(row.cause as PublishCause) || (row.status === "pass") !== (row.cause === "ok")
    || !text(row.reason) || !text(row.nextStep)) return;
  return { status: row.status, cause: row.cause as PublishCause };
}
function integrity(value: unknown, method: string): value is string {
  if (typeof value !== "string") return false;
  if (method === "github-release-asset-checksum") return /^sha256:[a-f0-9]{64}$/.test(value);
  if (method !== "npm-exact") return false;
  return /^sha256-[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(value) || /^sha384-[A-Za-z0-9+/]{64}$/.test(value) || /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/.test(value);
}
function autoAdmit(id: string, entry: PublishManifestEntry): boolean {
  return entry.autoAdmit && id !== "codex-review" && id !== "agy"
    && !entry.legs.some(leg => leg.requiredForAdmission && (leg.category === "account-or-model" || leg.category === "tui-desktop"));
}
function blocked(leg: PublishManifestEntry["legs"][number], os: string, arch: string, entry: PublishManifestEntry): PublishCause | undefined {
  if (leg.category === "account-or-model") return "model-required";
  if (leg.category === "tui-desktop") return "tui-required";
  if (!leg.runnerOS.includes(os) || leg.category === "macos-runner" && entry.nativePlatform === "macos-arm64" && arch !== "arm64") return "platform";
  if (SOURCE_LEGS.has(leg.id)) return "source-review-required";
}
function receipt(value: unknown, candidate: PublishCandidate, entry: PublishManifestEntry): PublishedReceipt | undefined {
  const row = record(value, ["schemaVersion", "id", "version", "runnerOS", "architecture", "procedureReceipt", "generatedAt", "bounds", "ownedStopConfirmed",
    "processCleanup", "processCleanupReason", "containment", "installation", "artifact", "integrity", "autoAdmit", "eligible", "outcome", "elapsedMs", "legs", "survivorDetected"]);
  if (!row || row.schemaVersion !== 1 || row.id !== candidate.id || row.version !== candidate.version || row.procedureReceipt !== entry.receipt
    || !["linux", "macos"].includes(row.runnerOS as string) || !["arm64", "x64"].includes(row.architecture as string)
    || typeof row.ownedStopConfirmed !== "boolean" || !["proven", "unproven"].includes(row.processCleanup as string)
    || row.containment !== "disposable-runner-lifetime" || typeof row.autoAdmit !== "boolean" || typeof row.eligible !== "boolean"
    || !status(row.outcome) || !text(row.processCleanupReason) || !text(row.generatedAt)
    || !Number.isSafeInteger(row.elapsedMs) || Number(row.elapsedMs) < 0 || row.survivorDetected !== undefined && typeof row.survivorDetected !== "boolean") return;
  const bounds = record(row.bounds, ["totalMs", "legMs", "cleanupMs", "outputMs"]);
  if (!bounds || ["totalMs", "legMs", "cleanupMs", "outputMs"].some(key => !Number.isSafeInteger(bounds[key]) || Number(bounds[key]) <= 0)) return;
  const installation = proof(row.installation);
  const rows = legArray(row.legs, entry.legs.length);
  if (!installation || !rows) return;
  let artifact: PublishedReceipt["artifact"] = null;
  if (row.artifact !== null) {
    const art = record(row.artifact, ["method", "integrity"]);
    if (!art || art.method !== entry.install.method || !integrity(art.integrity, entry.install.method) || row.integrity !== art.integrity) return;
    artifact = { method: entry.install.method, integrity: art.integrity };
  } else if (row.integrity !== null || installation.status === "pass") return;
  if ((installation.status === "pass") !== (artifact !== null)) return;
  const legs: PublishedLeg[] = [], seen = new Set<string>();
  for (const value of rows) {
    const source = record(value, ["id", "category", "requiredForAdmission", "status", "cause", "reason", "nextStep"]);
    const spec = source && entry.legs.find(leg => leg.id === source.id);
    if (!source || !spec || seen.has(spec.id) || source.requiredForAdmission !== spec.requiredForAdmission
      || source.category !== undefined && source.category !== spec.category) return;
    const check = proof({ status: source.status, cause: source.cause, reason: source.reason, nextStep: source.nextStep });
    if (!check) return;
    const refusal = blocked(spec, row.runnerOS as string, row.architecture as string, entry);
    if (refusal && (check.status !== "not-run" || check.cause !== refusal)) return;
    seen.add(spec.id); legs.push({ id: spec.id, category: spec.category, requiredForAdmission: spec.requiredForAdmission, ...check });
  }
  const required = legs.filter(leg => leg.requiredForAdmission);
  const expected = !row.ownedStopConfirmed || row.survivorDetected === true || installation.status === "fail" || required.some(leg => leg.status === "fail") ? "fail"
    : installation.status !== "pass" || required.some(leg => leg.status === "not-run") ? "not-run" : "pass";
  if (row.outcome !== expected) return;
  if (expected === "pass" && (!entry.runnerOS.includes(row.runnerOS as string)
    || entry.nativePlatform === "macos-arm64" && (row.runnerOS !== "macos" || row.architecture !== "arm64"))) return;
  return { schemaVersion: 1, id: candidate.id, version: candidate.version, procedureReceipt: entry.receipt,
    runnerOS: row.runnerOS as string, architecture: row.architecture as string, artifact, installation,
    ownedStopConfirmed: row.ownedStopConfirmed, processCleanup: row.processCleanup as "proven" | "unproven", containment: "disposable-runner-lifetime",
    outcome: expected, autoAdmit: autoAdmit(candidate.id, entry), legs };
}

function unavailableRunnerCause(category: string): PublishCause {
  if (category === "account-or-model") return "model-required";
  if (category === "tui-desktop") return "tui-required";
  return "platform";
}

/** Inputs from the watcher/manifest/PR reader are trusted data, but still structurally checked before planning writes. */
export function planCompatPublish(input: CompatPublishInput): CompatPublishPlan {
  if (!input || !record(input.manifest) || typeof input.dryRun !== "boolean" || !Array.isArray(input.candidates) || input.candidates.length > 8
    || !Array.isArray(input.artifacts) || input.artifacts.length > 8 || !Array.isArray(input.existingPullRequests)) throw new CompatPublishInputError();
  const selected = new Set<string>();
  const validIdentity = (row: PublishCandidate) => row && typeof row.id === "string" && ID.test(row.id) && Object.hasOwn(input.manifest, row.id) && version(row.version);
  for (const candidate of input.candidates) {
    if (!validIdentity(candidate) || selected.has(candidate.id)) throw new CompatPublishInputError(); selected.add(candidate.id);
    const entry = input.manifest[candidate.id]!;
    if (!entry || typeof entry.autoAdmit !== "boolean" || !entry.legs.length || new Set(entry.legs.map(leg => leg.id)).size !== entry.legs.length
      || entry.legs.some(leg => !LEG_ID.test(leg.id) || !CATEGORIES.has(leg.category) || typeof leg.requiredForAdmission !== "boolean")
      || !entry.legs.some(leg => leg.requiredForAdmission)) throw new CompatPublishInputError();
  }
  const numbers = new Set<number>(), opens = new Set<string>();
  for (const pr of input.existingPullRequests) {
    if (!validIdentity(pr) || !Number.isSafeInteger(pr.number) || pr.number <= 0 || numbers.has(pr.number)
      || pr.branch !== `compat/${pr.id}-${pr.version}` || !["open", "closed", "merged"].includes(pr.state)) throw new CompatPublishInputError();
    numbers.add(pr.number);
    if (pr.state === "open") { const key = `${pr.id}/${pr.version}`; if (opens.has(key)) throw new CompatPublishInputError(); opens.add(key); }
  }
  const inventory = new Map<string, PublishedReceipt>(); let malformed = false;
  for (const value of input.artifacts) {
    const row = record(value);
    const candidate = row && input.candidates.find(item => item.id === row.id && item.version === row.version);
    if (!row || !candidate || inventory.has(candidate.id)) { malformed = true; continue; }
    const summary = receipt(value, candidate, input.manifest[candidate.id]!);
    if (!summary) { malformed = true; continue; }
    inventory.set(candidate.id, summary);
  }
  const actions: CompatPublishAction[] = [];
  const drift = (candidate: PublishCandidate, cause: PublishDriftCause, summary?: PublishedReceipt) => {
    actions.push({ kind: "update-drift", id: candidate.id, version: candidate.version, cause, legs: summary?.legs ?? [],
      ...(summary ? { processCleanup: summary.processCleanup, ownedStopConfirmed: summary.ownedStopConfirmed } : {}) });
  };
  for (const candidate of input.candidates) {
    if (malformed) { drift(candidate, "malformed-artifact"); continue; }
    if (!inventory.has(candidate.id)) {
      const entry = input.manifest[candidate.id]!;
      if (entry.runnerOS.some(os => os === "linux" || os === "macos")) drift(candidate, "missing-artifact");
      else actions.push({ kind: "update-drift", id: candidate.id, version: candidate.version, cause: "not-run",
        legs: entry.legs.map(leg => ({ id: leg.id, category: leg.category, requiredForAdmission: leg.requiredForAdmission,
          status: "not-run", cause: unavailableRunnerCause(leg.category) })) });
      continue;
    }
    const summary = inventory.get(candidate.id)!;
    if (summary.outcome === "fail" || summary.legs.some(leg => leg.status === "fail")) { drift(candidate, "proof-failed", summary); continue; }
    if (summary.outcome !== "pass") { drift(candidate, "not-run", summary); continue; }
    if (!summary.autoAdmit) { drift(candidate, "policy", summary); continue; }
    const previous = input.existingPullRequests.filter(pr => pr.id === candidate.id);
    if (previous.some(pr => pr.state === "merged" && compare(pr.version, candidate.version) >= 0)) { drift(candidate, "already-published", summary); continue; }
    if (previous.some(pr => pr.state === "open" && compare(pr.version, candidate.version) > 0)) { drift(candidate, "newer-pr", summary); continue; }
    const branch = `compat/${candidate.id}-${candidate.version}`, current = previous.find(pr => pr.state === "open" && pr.version === candidate.version);
    if (current) actions.push({ kind: "update-pr", id: candidate.id, version: candidate.version, branch, number: current.number, receipt: summary });
    else actions.push({ kind: "create-pr", id: candidate.id, version: candidate.version, branch, receipt: summary });
    for (const pr of previous.filter(pr => pr.state === "open" && compare(pr.version, candidate.version) < 0).sort((a, b) => a.number - b.number)) {
      actions.push({ kind: "supersede-pr", id: pr.id, version: pr.version, branch: pr.branch, number: pr.number,
        replacementVersion: candidate.version, replacementBranch: branch });
    }
  }
  return { dryRun: input.dryRun, actions };
}
