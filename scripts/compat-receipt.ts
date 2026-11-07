import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { COMPAT, isCompatId } from "../src/adapters/compat.ts";
import { realPath } from "../src/hub/project.ts";
import { installCompatArtifact } from "./compat-receipts/install.ts";
import { runManifestProofs } from "./compat-receipts/proofs.ts";
import { runBoundedReceiptCommand } from "./compat-receipts/runner.ts";
import { ReceiptError, type Cause, type LegResult, type ManifestEntry, type ProofResults, type ReceiptContext, type ReceiptLimits, type ReceiptPorts, type ReceiptSummary, type InstalledArtifact } from "./compat-receipts/types.ts";

const DEFAULT_LIMITS: ReceiptLimits = { totalMs: 15 * 60_000, installMs: 3 * 60_000, legMs: 2 * 60_000,
  outputBytes: 1024 * 1024, artifactBytes: 512 * 1024 * 1024, expandedBytes: 1024 * 1024 * 1024, archiveEntries: 20_000 };
const DIAGNOSTICS: Record<Cause, readonly [string, string]> = {
  ok: ["The bound proof completed successfully.", "Retain the artifact binding and review every required leg before admission."],
  "proof-failed": ["The bounded producer did not prove its contract.", "Inspect the isolated producer and correct the failure before another candidate receipt."],
  timeout: ["The install or proof exhausted its wall-time budget.", "Inspect the isolated producer and available runner resources before an explicit retry."],
  cancelled: ["The isolated work was cancelled before proof completed.", "Inspect cleanup before starting another run."],
  platform: ["The current runner does not satisfy the receipt's native platform requirement.", "Repeat on the manifest's required OS and architecture; Linux fixtures do not replace native Mac proof."],
  "model-required": ["This leg requires a person-authorized account or model run and was not executed.", "Obtain the separate person authorization and use its model-backed procedure outside this harness."],
  "tui-required": ["This leg requires an interactive TUI or desktop and was not executed.", "Use the receipt's separately authorized interactive procedure."],
  "producer-not-committed": ["producer not committed; see follow-up task", "Complete and review the per-id producer follow-up before treating this leg as proved."],
  "producer-not-importable": ["The historical producer is not import-safe or candidate-parameterized.", "Extract and review its callable proof in the producer follow-up; do not copy its assertions into this harness."],
  "source-review-required": ["The receipt requires scoped source or lifecycle review that this harness cannot certify.", "Complete the recorded human review; a fetched diff or successful install is not that review."],
  "install-unavailable": ["The exact artifact could not be installed with the recorded public method.", "Inspect the public artifact and installer on the required platform; no global installer or trust change is performed."],
  integrity: ["The exact artifact identity or integrity binding did not match.", "Check the publisher's exact-version metadata and checksum before any execution."],
  input: ["The requested input or isolated producer contract is invalid.", "Use a known COMPAT id, exact version and safe output directory, or complete the producer extraction."],
  cleanup: ["Owned process or temporary-workspace cleanup could not be confirmed.", "Inspect the retained isolated run and stop only its verified owned processes before retrying."],
};
function proof(status: LegResult["status"], cause: Cause, id: string, required: boolean): LegResult {
  const [reason, nextStep] = DIAGNOSTICS[cause];
  return { id, requiredForAdmission: required, status, cause, reason, nextStep };
}
function outputDirectory(value: string): string {
  if (!value || /\p{Cc}/u.test(value)) throw new ReceiptError("input");
  const directory = resolve(value), previous = lstatSync(directory, { throwIfNoEntry: false });
  if (previous?.isSymbolicLink() || previous && !previous.isDirectory()) throw new ReceiptError("input");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!process.getuid || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) throw new ReceiptError("input");
  for (const name of ["summary.json", "receipt.md"]) if (lstatSync(join(directory, name), { throwIfNoEntry: false })) throw new ReceiptError("input");
  return directory;
}
function limitsFor(overrides: ReceiptPorts["limits"]): ReceiptLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[name as keyof ReceiptLimits]) throw new ReceiptError("input");
  }
  return limits;
}
function isolatedEnvironment(root: string, home: string): NodeJS.ProcessEnv {
  const tools = join(root, "tools"); mkdirSync(tools, { mode: 0o700 });
  for (const name of ["bun", "node", "npm", "python3"]) {
    const target = name === "bun" ? process.execPath : Bun.which(name, { PATH: process.env.PATH });
    if (target && isAbsolute(target)) symlinkSync(target, join(tools, name));
  }
  const env: NodeJS.ProcessEnv = { PATH: `${tools}:/usr/bin:/bin`, LANG: "C", LC_ALL: "C", TZ: "UTC", TERM: "dumb", HOME: home };
  const folders: Record<string, string> = { XDG_CONFIG_HOME: "xdg-config", XDG_CACHE_HOME: "xdg-cache", XDG_DATA_HOME: "xdg-data", XDG_STATE_HOME: "xdg-state",
    TMPDIR: "tmp", AGENTHUB_HOME: "hub-home", AMEM_HOME: "memory-home", CODEX_HOME: "codex-home", KIMI_CODE_HOME: "kimi-home", QWEN_HOME: "qwen-home", QWEN_RUNTIME_DIR: "qwen-runtime", CLAUDE_CONFIG_DIR: "claude-home" };
  for (const [key, name] of Object.entries(folders)) { const folder = join(root, name); mkdirSync(folder, { mode: 0o700 }); env[key] = folder; }
  return env;
}
async function bounded<T>(signal: AbortSignal, ms: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const local = new AbortController(), combined = AbortSignal.any([signal, local.signal]);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new ReceiptError("timeout")); combined.addEventListener("abort", rejectAbort, { once: true }); });
  const timer = setTimeout(() => local.abort(), ms);
  try { if (combined.aborted) throw new ReceiptError("timeout"); return await Promise.race([operation(combined), aborted]); }
  finally { clearTimeout(timer); if (rejectAbort) combined.removeEventListener("abort", rejectAbort); }
}
function blockedCause(leg: ManifestEntry["legs"][number], os: string, architecture: string, entry: ManifestEntry): Cause | undefined {
  if (leg.category === "account-or-model") return "model-required";
  if (leg.category === "tui-desktop") return "tui-required";
  if (!leg.runnerOS.includes(os) || leg.category === "macos-runner" && entry.nativePlatform === "macos-arm64" && architecture !== "arm64") return "platform";
  if (["source-impact", "source-review", "source-comparison", "upstream-impact-review", "tag-binding", "reviewed-optional-lifecycle-replay"].includes(leg.id)) return "source-review-required";
}
function writeOutput(out: string, summary: ReceiptSummary): void {
  const markdown = [`# ${summary.id} ${summary.version} model-free compatibility receipt`, "", `Date: ${summary.generatedAt}.`, "",
    `Procedure: ${summary.procedureReceipt}. Runner: ${summary.runnerOS} ${summary.architecture}.`, "",
    `Artifact: ${summary.artifact ? `${summary.artifact.method}, ${summary.artifact.integrity}` : "not installed"}.`,
    `Outcome: ${summary.outcome}. Policy autoAdmit: ${summary.autoAdmit}; eligible: ${summary.eligible}.`,
    "No real account, API key or model is supplied. A not-run leg is not admission evidence.", "",
    "| Leg | Required | Status | Cause | Next step |", "| --- | --- | --- | --- | --- |",
    ...summary.legs.map(leg => `| ${leg.id} | ${leg.requiredForAdmission} | ${leg.status} | ${leg.reason} | ${leg.nextStep} |`), "",
    `Cleanup confirmed: ${summary.cleanupConfirmed}. Elapsed: ${summary.elapsedMs} ms.`, ""].join("\n");
  for (const [name, contents] of [["summary.json", `${JSON.stringify(summary, null, 2)}\n`], ["receipt.md", markdown]]) {
    const fd = openSync(join(out, name!), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, contents!); } finally { closeSync(fd); }
  }
}

/** Host/test ports are programmatic only; the CLI never selects code or credentials from configuration. */
export async function runCompatReceipt(input: { id: string; version: string; out: string }, ports: ReceiptPorts = {}): Promise<ReceiptSummary> {
  if (!isCompatId(input.id) || input.version.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(input.version)) throw new ReceiptError("input");
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("./compat-receipts/manifest.json", import.meta.url)), "utf8")) as { entries: Record<string, ManifestEntry> };
  const entry = ports.entry ?? manifest.entries[input.id]!;
  const categories = new Set(["linux-ci", "macos-runner", "account-or-model", "tui-desktop"]);
  if (!entry?.legs.length || !entry.legs.some(leg => leg.requiredForAdmission) || new Set(entry.legs.map(leg => leg.id)).size !== entry.legs.length ||
    entry.legs.some(leg => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(leg.id) || !categories.has(leg.category) || typeof leg.requiredForAdmission !== "boolean")) throw new ReceiptError("input");
  const limits = limitsFor(ports.limits), out = outputDirectory(input.out), started = performance.now();
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-compat-receipt-"))), home = join(root, "home"), prefix = join(root, "prefix"), cwd = join(root, "project");
  let env: NodeJS.ProcessEnv;
  try {
    for (const folder of [home, prefix, cwd]) mkdirSync(folder, { mode: 0o700 });
    env = isolatedEnvironment(root, home);
  } catch { rmSync(root, { recursive: true, force: true }); throw new ReceiptError("input"); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.totalMs);
  const active = new Set<Promise<unknown>>();
  let cleanup = true;
  const context: ReceiptContext = { id: input.id, version: input.version, root, home, prefix, cwd, env, signal: controller.signal, limits,
    run: async (argv, options) => {
      if (options.signal.aborted || controller.signal.aborted) throw new ReceiptError("timeout");
      const task = (ports.run ?? runBoundedReceiptCommand)(argv, { ...options, signal: AbortSignal.any([controller.signal, options.signal]),
        timeoutMs: Math.min(options.timeoutMs, Math.max(1, limits.totalMs - (performance.now() - started))) });
      active.add(task);
      try { const result = await task; if (!result.cleanup) cleanup = false; return result; }
      finally { active.delete(task); }
    } };
  const platform = ports.platform ?? process.platform, os = platform === "darwin" ? "macos" : platform, architecture = ports.architecture ?? process.arch;
  const legs = entry.legs.map(leg => proof("not-run", blockedCause(leg, os, architecture, entry) ?? (input.id === "pi" ? "producer-not-importable" : "producer-not-committed"), leg.id, leg.requiredForAdmission));
  let artifact: InstalledArtifact | undefined, installation = proof("not-run", "install-unavailable", "installation", true);
  try {
    try {
      artifact = await bounded(controller.signal, limits.installMs, signal => (ports.install ?? installCompatArtifact)({ ...context, signal }, entry, ports.fetch ?? fetch));
      installation = proof("pass", "ok", "installation", true);
    } catch (error) {
      const cause = error instanceof ReceiptError ? error.causeCode : "install-unavailable";
      if (cause === "cleanup") cleanup = false;
      installation = proof(cause === "install-unavailable" || cause === "platform" ? "not-run" : "fail", cause, "installation", true);
    }
    if (artifact) {
      const runnable = entry.legs.filter(leg => !blockedCause(leg, os, architecture, entry));
      if (runnable.length) try {
        const results = await bounded(controller.signal, limits.legMs, signal => (ports.proofs ?? runManifestProofs)({ ...context, signal, artifact: artifact!, entry: { ...entry, legs: runnable } }));
        for (const leg of runnable) {
          const result = results[leg.id];
          if (result && ["pass", "fail", "not-run"].includes(result.status) && Object.hasOwn(DIAGNOSTICS, result.cause)) {
            legs[entry.legs.indexOf(leg)] = proof(result.status, result.cause, leg.id, leg.requiredForAdmission);
            if (result.cause === "cleanup") cleanup = false;
          }
        }
      } catch (error) {
        const cause = error instanceof ReceiptError ? error.causeCode : "proof-failed";
        if (cause === "cleanup") cleanup = false;
        for (const leg of runnable) legs[entry.legs.indexOf(leg)] = proof("fail", cause, leg.id, leg.requiredForAdmission);
      }
    }
  } finally {
    controller.abort();
    await Promise.allSettled([...active]);
    clearTimeout(timer);
    if (cleanup) try { rmSync(root, { recursive: true, force: true }); } catch { cleanup = false; }
  }
  if (!cleanup) for (const [index, leg] of legs.entries()) if (leg.status === "pass") legs[index] = proof("fail", "cleanup", leg.id, leg.requiredForAdmission);
  const required = legs.filter(leg => leg.requiredForAdmission);
  const outcome = !cleanup || installation.status === "fail" || required.some(leg => leg.status === "fail") ? "fail"
    : installation.status !== "pass" || required.some(leg => leg.status === "not-run") ? "not-run" : "pass";
  const autoAdmit = entry.autoAdmit && input.id !== "codex-review" && input.id !== "agy";
  const [reason, nextStep] = DIAGNOSTICS[installation.cause];
  const summary: ReceiptSummary = { schemaVersion: 1, id: input.id, version: input.version, runnerOS: os, architecture,
    procedureReceipt: entry.receipt, generatedAt: new Date().toISOString(), bounds: { totalMs: limits.totalMs, legMs: limits.legMs }, cleanupConfirmed: cleanup,
    installation: { status: installation.status, cause: installation.cause, reason, nextStep },
    artifact: artifact ? { method: artifact.method, integrity: artifact.integrity } : null, integrity: artifact?.integrity ?? null, autoAdmit, eligible: outcome === "pass" && autoAdmit && cleanup,
    outcome, elapsedMs: Math.round(performance.now() - started), legs };
  writeOutput(out, summary);
  return summary;
}

if (import.meta.main) {
  const [id, version, flag, out, ...extra] = process.argv.slice(2);
  if (!id || !version || flag !== "--out" || !out || extra.length) { console.error("Invalid receipt arguments; next: bun scripts/compat-receipt.ts <id> <version> --out <dir>"); process.exitCode = 2; }
  else try { const result = await runCompatReceipt({ id, version, out }); console.log(JSON.stringify(result)); process.exitCode = result.outcome === "pass" ? 0 : result.outcome === "not-run" ? 3 : 1; }
  catch { console.error("Receipt harness refused the input or output; next: use an exact version and a new owned output directory."); process.exitCode = 2; }
}
