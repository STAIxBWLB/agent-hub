import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planCompatPublish, type CompatPublishPlan, type PublishedReceipt, type PublishCandidate, type PublishManifestEntry } from "./compat-publish.ts";
import { patchCompatSource, readCompatVerified, renderPublishedReceipt } from "./compat-publish-files.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_CAP = 4 * 1024 * 1024, ASSET_CAP = 64 * 1024 * 1024, MAX_FILES = 64, MAX_DEPTH = 3, TOTAL_MS = 20 * 60_000;
const SOURCE = "src/adapters/compat.ts";
const ASSETS = ["plugins/agent-hub/server.js", "plugins/agent-hub/.claude-plugin/plugin.json", "plugins/agent-hub/ROLE-NOTICE.md"];
export interface PrepareCompatInput { root?: string; watchFile: string; summariesDir: string; out: string; sourceBaseSha: string; date: string; dryRun?: boolean }
export interface CompatBuildContext { root: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal }
export interface PrepareCompatPorts { build?(context: CompatBuildContext): Promise<void>; head?(): string }
export interface PreparedBundleDescriptor {
  schemaVersion: 1; id: string; version: string; sourceBaseSha: string; originalSourceSha256: string; receiptPath: string;
  files: Record<string, { sha256: string; size: number }>;
}
export interface PreparedCompatArtifact {
  schemaVersion: 1; sourceBaseSha: string; dryRun: boolean;
  watch: { code: 0 | 3; report: string; candidates: PublishCandidate[] };
  artifacts: unknown[]; rejectedBatch: boolean;
  plan: CompatPublishPlan;
  projections: CompatPublishPlan["actions"];
  bundles: { id: string; version: string; directory: string; descriptorSha256: string; descriptorSize: number }[];
}
export class CompatPrepareError extends Error {
  readonly cause: "input" | "build" | "timeout" | "restore" | "output";
  constructor(cause: "input" | "build" | "timeout" | "restore" | "output") { super(`compat preparation ${cause}; no GitHub operation performed`); this.cause = cause; this.name = "CompatPrepareError"; }
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function ownedDirectory(directory: string): void {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid() || (info.mode & 0o022) !== 0) throw new CompatPrepareError("input");
}
function read(file: string, cap: number): { bytes: Buffer; mode: number } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > cap || process.getuid && info.uid !== process.getuid()) throw new CompatPrepareError("input");
    const bytes = Buffer.alloc(info.size + 1); let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, size); if (!n) break; size += n; }
    if (size !== info.size || fstatSync(fd).size !== info.size) throw new CompatPrepareError("input");
    return { bytes: bytes.subarray(0, size), mode: info.mode & 0o777 };
  } finally { closeSync(fd); }
}
function restore(file: string, value: { bytes: Buffer; mode: number }): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || process.getuid && info.uid !== process.getuid()) throw new CompatPrepareError("restore");
    // Write through the opened leaf; neither a symlink nor a hardlink may redirect restoration.
    ftruncateSync(fd, 0); writeFileSync(fd, value.bytes); fchmodSync(fd, value.mode);
  } finally { closeSync(fd); }
}
function json(file: string): unknown { try { return JSON.parse(read(file, JSON_CAP).bytes.toString("utf8")); } catch { throw new CompatPrepareError("input"); } }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function watch(value: unknown, manifest: Record<string, PublishManifestEntry>): PreparedCompatArtifact["watch"] {
  if (!object(value) || value.schemaVersion !== 1 || value.code !== 0 && value.code !== 3 || typeof value.report !== "string" || value.report.length > JSON_CAP || !Array.isArray(value.ahead)) throw new CompatPrepareError("input");
  const report = value.report.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
  const header = value.code === 0 ? "Every watched agent CLI's latest published version is verified." : "Published agent CLI versions ahead of their verified set (`src/adapters/compat.ts`).";
  if (report.split("\n")[0] !== header || report.includes("```")) throw new CompatPrepareError("input");
  for (const line of report.split("\n")) {
    if (!line || line === header || line === "Informational:" || line === "Informational (no public source, not drift):"
      || /^Checked \d{4}-\d{2}-\d{2} by \.github\/workflows\/agent-compat\.yml\.$/.test(line)
      || line.startsWith("Next step for each: a model-free receipt in `docs/verification/`, then add the version to `verified`")) continue;
    const id = /^- \*\*([a-z][a-z0-9-]*)\*\*(?: \((?:npm @[a-z0-9._-]+\/[a-z0-9._-]+|GitHub releases [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\)|: no public source; local drift only)/.exec(line)?.[1];
    if (!id || !Object.hasOwn(manifest, id) || value.code === 0 && /^- \*\*[a-z][a-z0-9-]*\*\* \(/.test(line)) throw new CompatPrepareError("input");
  }
  const candidates = value.ahead as PublishCandidate[];
  // Planner validates canonical identities, duplicate IDs and the eight-ID ceiling.
  planCompatPublish({ manifest, candidates, artifacts: [], existingPullRequests: [], dryRun: false });
  if (value.code === 0 && candidates.length) throw new CompatPrepareError("input");
  return { code: value.code, report, candidates: candidates.map(row => ({ id: row.id, version: row.version })) };
}
function summaries(directory: string): unknown[] {
  ownedDirectory(directory); const found: unknown[] = []; let count = 0;
  const visit = (current: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new CompatPrepareError("input");
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (++count > MAX_FILES || entry.isSymbolicLink()) throw new CompatPrepareError("input");
      const file = join(current, entry.name);
      if (entry.isDirectory()) { ownedDirectory(file); visit(file, depth + 1); }
      else if (!entry.isFile()) throw new CompatPrepareError("input");
      else if (entry.name === "summary.json") found.push(json(file));
    }
  };
  visit(directory, 0); return found;
}
/** Preserve actual scalar measurements, but never carry producer prose into the trusted artifact. */
function canonicalEnvelopes(raw: unknown[], plan: CompatPublishPlan, candidates: PublishCandidate[], manifest: Record<string, PublishManifestEntry>): { artifacts: unknown[]; rejectedBatch: boolean } {
  const rejected = () => ({ artifacts: [], rejectedBatch: true });
  if (raw.length > candidates.length || plan.actions.some(action => action.kind === "update-drift" && action.cause === "malformed-artifact")) return rejected();
  const artifacts: unknown[] = [];
  for (const value of raw) {
    if (!object(value)) return rejected();
    const candidate = candidates.find(row => row.id === value.id && row.version === value.version);
    if (!candidate || typeof value.generatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.generatedAt)
      || !Number.isFinite(Date.parse(value.generatedAt)) || new Date(value.generatedAt).toISOString() !== value.generatedAt
      || !object(value.bounds) || !Number.isSafeInteger(value.elapsedMs) || Number(value.elapsedMs) < 0) return rejected();
    const bounds: Record<string, number> = {};
    for (const key of ["totalMs", "legMs", "cleanupMs", "outputMs"]) {
      const measurement = value.bounds[key];
      if (typeof measurement !== "number" || !Number.isSafeInteger(measurement) || measurement <= 0) return rejected();
      bounds[key] = measurement;
    }
    const action = plan.actions.find(row => row.id === candidate.id && row.version === candidate.version);
    if (!action || action.kind === "supersede-pr" || !object(value.installation)) return rejected();
    const spec = manifest[candidate.id]!, projected = action.kind === "update-drift" ? undefined : action.receipt;
    const legs = projected?.legs ?? (action.kind === "update-drift" ? action.legs : []);
    if (!legs.length) return rejected();
    const policy = projected?.autoAdmit ?? (spec.autoAdmit && candidate.id !== "codex-review" && candidate.id !== "agy"
      && !spec.legs.some(leg => leg.requiredForAdmission && ["account-or-model", "tui-desktop"].includes(leg.category)));
    artifacts.push({ schemaVersion: 1, id: candidate.id, version: candidate.version, generatedAt: value.generatedAt, bounds, elapsedMs: value.elapsedMs,
      procedureReceipt: spec.receipt, runnerOS: projected?.runnerOS ?? value.runnerOS, architecture: projected?.architecture ?? value.architecture,
      ownedStopConfirmed: projected?.ownedStopConfirmed ?? (action.kind === "update-drift" ? action.ownedStopConfirmed : undefined),
      processCleanup: projected?.processCleanup ?? (action.kind === "update-drift" ? action.processCleanup : undefined), processCleanupReason: "",
      containment: "disposable-runner-lifetime", autoAdmit: policy, eligible: false, outcome: projected?.outcome ?? value.outcome,
      artifact: value.artifact === null ? null : object(value.artifact) ? { method: spec.install.method, integrity: value.artifact.integrity } : undefined,
      integrity: value.integrity, installation: { status: value.installation.status, cause: value.installation.cause, reason: "", nextStep: "" },
      legs: legs.map(leg => ({ id: leg.id, category: leg.category, requiredForAdmission: leg.requiredForAdmission, status: leg.status, cause: leg.cause, reason: "", nextStep: "" })),
      ...(typeof value.survivorDetected === "boolean" ? { survivorDetected: value.survivorDetected } : {}) });
  }
  return { artifacts, rejectedBatch: false };
}
function sourceHead(root: string): string {
  const env = { PATH: process.env.PATH, HOME: root, LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
  const args = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root];
  try {
    const head = execFileSync("git", [...args, "rev-parse", "HEAD"], { env, encoding: "utf8", timeout: 5000, maxBuffer: 4096 }).trim();
    execFileSync("git", [...args, "diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"], { env, timeout: 5000, stdio: "ignore" });
    return head;
  } catch { throw new CompatPrepareError("input"); }
}
async function build(context: CompatBuildContext): Promise<void> {
  try {
    const pinned = read(join(context.root, ".bun-version"), JSON_CAP).bytes.toString("utf8").trim();
    const actual = execFileSync("bun", ["--version"], { env: context.env, encoding: "utf8", timeout: Math.min(context.timeoutMs, 5000), maxBuffer: 4096 }).trim();
    if (actual !== pinned) throw new CompatPrepareError("build");
    await new Promise<void>((accept, reject) => {
      const child = spawn("bun", ["run", "build"], { cwd: context.root, env: context.env, detached: true, stdio: "ignore" });
      let stopped = false;
      const stop = () => {
        stopped = true;
        if (child.pid && child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, "SIGKILL"); } catch { /* The close event still decides completion. */ }
      };
      const timer = setTimeout(stop, context.timeoutMs); context.signal.addEventListener("abort", stop, { once: true });
      child.once("spawn", () => { if (context.signal.aborted) stop(); });
      child.once("error", () => { clearTimeout(timer); context.signal.removeEventListener("abort", stop); reject(new CompatPrepareError("build")); });
      child.once("close", code => { clearTimeout(timer); context.signal.removeEventListener("abort", stop); if (stopped) reject(new CompatPrepareError("timeout")); else if (code !== 0) reject(new CompatPrepareError("build")); else accept(); });
    });
  } catch (error) { throw error instanceof CompatPrepareError ? error : new CompatPrepareError("build"); }
}
function write(file: string, bytes: Uint8Array | string): void { writeFileSync(file, bytes, { flag: "wx", mode: 0o600 }); }

/** Trusted read-only job only; native summaries never provide executable source or generated bundle bytes. */
async function prepare(input: PrepareCompatInput, ports: PrepareCompatPorts): Promise<PreparedCompatArtifact> {
  const root = resolve(input.root ?? ROOT), out = resolve(input.out);
  if (!ports.head && root !== ROOT || !/^[a-f0-9]{40}$/.test(input.sourceBaseSha) || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
    || new Date(`${input.date}T00:00:00.000Z`).toISOString().slice(0, 10) !== input.date || input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new CompatPrepareError("input");
  ownedDirectory(root);
  if ((ports.head ?? (() => sourceHead(root)))() !== input.sourceBaseSha || lstatSync(out, { throwIfNoEntry: false })) throw new CompatPrepareError("input");
  const manifestData = json(join(root, "scripts/compat-receipts/manifest.json"));
  if (!object(manifestData) || !object(manifestData.entries)) throw new CompatPrepareError("input");
  const manifest = manifestData.entries as Record<string, PublishManifestEntry>, observed = watch(json(resolve(input.watchFile)), manifest);
  const raw = summaries(resolve(input.summariesDir)), planInput = { manifest, candidates: observed.candidates, existingPullRequests: [], dryRun: !!input.dryRun };
  const originalPlan = planCompatPublish({ ...planInput, artifacts: raw }), canonical = canonicalEnvelopes(raw, originalPlan, observed.candidates, manifest);
  const plan = planCompatPublish({ ...planInput, artifacts: canonical.rejectedBatch ? [{}] : canonical.artifacts });
  if (!canonical.rejectedBatch && JSON.stringify(plan) !== JSON.stringify(originalPlan)) throw new CompatPrepareError("input");
  const originals = new Map([SOURCE, ...ASSETS].map(file => [file, read(join(root, file), ASSET_CAP)]));
  const source = originals.get(SOURCE)!.bytes.toString("utf8"), result: PreparedCompatArtifact = { schemaVersion: 1, sourceBaseSha: input.sourceBaseSha,
    dryRun: !!input.dryRun, watch: observed, ...canonical, plan, projections: plan.actions, bundles: [] };
  const parent = dirname(out); ownedDirectory(parent); mkdirSync(out, { mode: 0o700 });
  const home = mkdtempSync(join(tmpdir(), "ahub-compat-prepare-")), controller = new AbortController(), deadline = performance.now() + TOTAL_MS;
  const timer = setTimeout(() => controller.abort(), TOTAL_MS);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
    LANG: "C", LC_ALL: "C", TZ: "UTC", TERM: "dumb", AHUB_BUILD_PINNED_BUN: "1" };
  try {
    for (const action of plan.actions) {
      if (action.kind !== "create-pr" && action.kind !== "update-pr") continue;
      if (readCompatVerified(source, action.id).includes(action.version)) throw new CompatPrepareError("input");
      const receiptPath = `docs/verification/${input.date}-compat-${action.id}-${action.version}.md`;
      const patched = patchCompatSource(source, action.id, action.version, receiptPath);
      const directory = `${action.id}-${action.version}`, target = join(out, directory); mkdirSync(target, { mode: 0o700 });
      try {
        restore(join(root, SOURCE), { ...originals.get(SOURCE)!, bytes: Buffer.from(patched) });
        const timeoutMs = Math.floor(deadline - performance.now());
        if (timeoutMs <= 0 || controller.signal.aborted) throw new CompatPrepareError("timeout");
        await (ports.build ?? build)({ root, env, timeoutMs, signal: controller.signal });
        if (controller.signal.aborted || performance.now() >= deadline) throw new CompatPrepareError("timeout");
        if (read(join(root, SOURCE), ASSET_CAP).bytes.toString("utf8") !== patched) throw new CompatPrepareError("build");
        const receipt: PublishedReceipt = action.receipt;
        const contents = { "compat.ts": Buffer.from(patched), "receipt.md": Buffer.from(renderPublishedReceipt(receipt)),
          "server.js": read(join(root, ASSETS[0]!), ASSET_CAP).bytes, "plugin.json": read(join(root, ASSETS[1]!), ASSET_CAP).bytes };
        const files: PreparedBundleDescriptor["files"] = {};
        for (const [name, bytes] of Object.entries(contents)) { files[name] = { sha256: hash(bytes), size: bytes.length }; write(join(target, name), bytes); }
        const descriptor: PreparedBundleDescriptor = { schemaVersion: 1, id: action.id, version: action.version, sourceBaseSha: input.sourceBaseSha, originalSourceSha256: hash(source), receiptPath, files };
        const encoded = `${JSON.stringify(descriptor, null, 2)}\n`; write(join(target, "descriptor.json"), encoded);
        result.bundles.push({ id: action.id, version: action.version, directory, descriptorSha256: hash(encoded), descriptorSize: Buffer.byteLength(encoded) });
      } finally {
        let failed = false;
        for (const [file, original] of originals) try { restore(join(root, file), original); } catch { failed = true; }
        if (failed) throw new CompatPrepareError("restore");
      }
    }
    write(join(out, "index.json"), `${JSON.stringify(result, null, 2)}\n`); return result;
  } catch (error) { throw error instanceof CompatPrepareError ? error : new CompatPrepareError("build"); }
  finally { clearTimeout(timer); controller.abort(); rmSync(home, { recursive: true, force: true }); }
}

export async function prepareCompatArtifacts(input: PrepareCompatInput, ports: PrepareCompatPorts = {}): Promise<PreparedCompatArtifact> {
  try { return await prepare(input, ports); }
  catch (error) { throw error instanceof CompatPrepareError ? error : new CompatPrepareError("input"); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2), fields: Record<string, string> = {}; let dryRun = false;
    while (args.length) { const key = args.shift()!; if (key === "--dry-run" && !dryRun) { dryRun = true; continue; }
      if (!["--watch", "--summaries", "--out", "--source-base", "--date"].includes(key) || fields[key] || !args.length) throw new CompatPrepareError("input"); fields[key] = args.shift()!; }
    if (["--watch", "--summaries", "--out", "--source-base", "--date"].some(key => !fields[key])) throw new CompatPrepareError("input");
    const result = await prepareCompatArtifacts({ watchFile: fields["--watch"]!, summariesDir: fields["--summaries"]!, out: fields["--out"]!, sourceBaseSha: fields["--source-base"]!, date: fields["--date"]!, dryRun });
    console.log(JSON.stringify({ schemaVersion: 1, bundles: result.bundles.length }));
  } catch (error) { console.error(error instanceof CompatPrepareError ? error.message : "compat preparation input invalid; no GitHub operation performed"); process.exitCode = 1; }
}
