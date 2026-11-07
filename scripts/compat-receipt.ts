import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isCompatId } from "../src/adapters/compat.ts";
import { realPath } from "../src/hub/project.ts";
import { openReceiptOutput, RECEIPT_OUTPUT_MS } from "./compat-receipts/output.ts";
import { installCompatArtifact } from "./compat-receipts/install.ts";
import { runManifestProofs } from "./compat-receipts/proofs.ts";
import { RECEIPT_CLEANUP_MS, runBoundedReceiptCommand } from "./compat-receipts/runner.ts";
import { ReceiptError, type Cause, type LegResult, type ManifestEntry, type ReceiptContext, type ReceiptLimits, type ReceiptPorts, type ReceiptSummary, type InstalledArtifact } from "./compat-receipts/types.ts";

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
  "not-applicable": ["The original pre-admission negative condition does not apply to this already-admitted candidate.", "Use an unverified candidate for the negative check; do not remove verified versions or change machine trust to force it."],
  "disposable-required": ["The harness requires an explicitly disposable runner; a personal Mac is not contained by a temporary HOME.", "Use a GitHub-hosted runner or disposable Linux container and pass --disposable-runner; never run on a personal host."],
  "process-cleanup-unproven": ["Lifetime process cleanup is unproven; a helper can detach outside the original process group.", "Use runner destruction for containment and complete the process-supervision follow-up before claiming this cleanup leg."],
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
  const local = new AbortController(), combined = AbortSignal.any([signal, local.signal]), deadline = performance.now() + ms;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new ReceiptError("timeout")); combined.addEventListener("abort", rejectAbort, { once: true }); });
  const timer = setTimeout(() => local.abort(), ms);
  try {
    if (combined.aborted) throw new ReceiptError("timeout");
    const value = await Promise.race([operation(combined), aborted]);
    if (combined.aborted || performance.now() >= deadline) throw new ReceiptError("timeout");
    return value;
  }
  finally { clearTimeout(timer); if (rejectAbort) combined.removeEventListener("abort", rejectAbort); }
}
function blockedCause(leg: ManifestEntry["legs"][number], os: string, architecture: string, entry: ManifestEntry): Cause | undefined {
  if (leg.category === "account-or-model") return "model-required";
  if (leg.category === "tui-desktop") return "tui-required";
  if (!leg.runnerOS.includes(os) || leg.category === "macos-runner" && entry.nativePlatform === "macos-arm64" && architecture !== "arm64") return "platform";
  if (["source-impact", "source-review", "source-comparison", "upstream-impact-review", "tag-binding", "reviewed-optional-lifecycle-replay"].includes(leg.id)) return "source-review-required";
}
function renderReceipt(summary: ReceiptSummary): string {
  const markdown = [`# ${summary.id} ${summary.version} model-free compatibility receipt`, "", `Date: ${summary.generatedAt}.`, "",
    `Procedure: ${summary.procedureReceipt}. Runner: ${summary.runnerOS} ${summary.architecture}.`, "",
    `Artifact: ${summary.artifact ? `${summary.artifact.method}, ${summary.artifact.integrity}` : "not installed"}.`,
    `Outcome: ${summary.outcome}. Policy autoAdmit: ${summary.autoAdmit}; eligible: ${summary.eligible}.`,
    "No real account, API key or model is supplied. A not-run leg is not admission evidence.", "",
    "| Leg | Required | Status | Cause | Next step |", "| --- | --- | --- | --- | --- |",
    ...summary.legs.map(leg => `| ${leg.id} | ${leg.requiredForAdmission} | ${leg.status} | ${leg.reason} | ${leg.nextStep} |`), "",
    `Owned stop confirmed: ${summary.ownedStopConfirmed}. Process cleanup: ${summary.processCleanup}. ${summary.processCleanupReason}`,
    "Containment: disposable runner lifetime; the runner VM/container must be destroyed after the job.",
    `Execution elapsed before publication: ${summary.elapsedMs} ms.`, ""].join("\n");
  return markdown;
}

/** Host/test ports are programmatic only; the CLI never selects code or credentials from configuration. */
export async function runCompatReceipt(input: { id: string; version: string; out: string; disposableRunner?: boolean }, ports: ReceiptPorts = {}): Promise<ReceiptSummary> {
  if (!isCompatId(input.id) || input.version.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) throw new ReceiptError("input");
  const disposableHost = ports.disposable ?? (process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted" ||
    process.platform === "linux" && existsSync("/.dockerenv"));
  if (!input.disposableRunner || !disposableHost) throw new ReceiptError("disposable-required");
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("./compat-receipts/manifest.json", import.meta.url)), "utf8")) as { entries: Record<string, ManifestEntry> };
  const entry = ports.entry ?? manifest.entries[input.id]!;
  const categories = new Set(["linux-ci", "macos-runner", "account-or-model", "tui-desktop"]);
  if (!entry?.legs.length || !entry.legs.some(leg => leg.requiredForAdmission) || new Set(entry.legs.map(leg => leg.id)).size !== entry.legs.length ||
    entry.legs.some(leg => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(leg.id) || !categories.has(leg.category) || typeof leg.requiredForAdmission !== "boolean")) throw new ReceiptError("input");
  const limits = limitsFor(ports.limits), out = openReceiptOutput(input.out), started = performance.now();
  let root: string;
  try { root = realPath(mkdtempSync(join(tmpdir(), "ahub-compat-receipt-"))); }
  catch { out.close(); throw new ReceiptError("input"); }
  const home = join(root, "home"), prefix = join(root, "prefix"), cwd = join(root, "project");
  let env: NodeJS.ProcessEnv;
  try {
    for (const folder of [home, prefix, cwd]) mkdirSync(folder, { mode: 0o700 });
    env = isolatedEnvironment(root, home);
  } catch { rmSync(root, { recursive: true, force: true }); out.close(); throw new ReceiptError("input"); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.totalMs);
  const active = new Set<Promise<unknown>>();
  let ownedStopConfirmed = true, survivorDetected = false;
  const lifetime: { status: "proven" | "unproven"; reason: string } = { status: "proven", reason: "No external command was started." };
  const context: ReceiptContext = { id: input.id, version: input.version, root, home, prefix, cwd, env, signal: controller.signal, limits,
    run: async (argv, options) => {
      if (options.signal.aborted || controller.signal.aborted || performance.now() - started >= limits.totalMs) throw new ReceiptError("timeout");
      const task = (ports.run ?? runBoundedReceiptCommand)(argv, { ...options, signal: AbortSignal.any([controller.signal, options.signal]),
        timeoutMs: Math.min(options.timeoutMs, Math.max(1, limits.totalMs - (performance.now() - started))) });
      active.add(task);
      try {
        const result = await task;
        if (!result.ownedStopConfirmed) ownedStopConfirmed = false;
        if (result.processCleanup !== "proven") { lifetime.status = "unproven"; lifetime.reason = DIAGNOSTICS["process-cleanup-unproven"][0]; }
        else if (lifetime.status === "proven") lifetime.reason = "Every started command has explicit lifetime-cleanup evidence from the trusted runner.";
        if (result.survivorDetected) { survivorDetected = true; ownedStopConfirmed = false; }
        return result;
      } catch (error) { ownedStopConfirmed = false; lifetime.status = "unproven"; lifetime.reason = DIAGNOSTICS["process-cleanup-unproven"][0]; throw error; }
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
      if (cause === "cleanup") ownedStopConfirmed = false;
      installation = proof(cause === "install-unavailable" || cause === "platform" ? "not-run" : "fail", cause, "installation", true);
    }
    if (artifact) {
      const runnable = entry.legs.filter(leg => !blockedCause(leg, os, architecture, entry));
      if (runnable.length) try {
        const results = await bounded(controller.signal, limits.legMs, signal => (ports.proofs ?? runManifestProofs)({ ...context, signal, artifact: artifact!, entry: { ...entry, legs: runnable } }));
        for (const leg of runnable) {
          if (!Object.hasOwn(results, leg.id)) continue;
          const result = results[leg.id];
          if (!result || !["pass", "fail", "not-run"].includes(result.status) || !Object.hasOwn(DIAGNOSTICS, result.cause) ||
            (result.status === "pass") !== (result.cause === "ok")) throw new ReceiptError("proof-failed");
          legs[entry.legs.indexOf(leg)] = proof(result.status, result.cause, leg.id, leg.requiredForAdmission);
          if (result.cause === "cleanup") ownedStopConfirmed = false;
        }
      } catch (error) {
        const cause = error instanceof ReceiptError ? error.causeCode : "proof-failed";
        if (cause === "cleanup") ownedStopConfirmed = false;
        for (const leg of runnable) legs[entry.legs.indexOf(leg)] = proof("fail", cause, leg.id, leg.requiredForAdmission);
      }
    }
  } finally {
    controller.abort();
    await Promise.allSettled([...active]);
    clearTimeout(timer);
    if (ownedStopConfirmed && lifetime.status === "proven") try { rmSync(root, { recursive: true, force: true }); } catch { ownedStopConfirmed = false; }
  }
  if (!ownedStopConfirmed) for (const [index, leg] of legs.entries()) if (leg.status === "pass") legs[index] = proof("fail", "cleanup", leg.id, leg.requiredForAdmission);
  if (lifetime.status === "unproven") for (const [index, leg] of legs.entries()) {
    if (leg.status === "pass" && /(?:^|-)cleanup$/.test(leg.id)) legs[index] = proof("not-run", "process-cleanup-unproven", leg.id, leg.requiredForAdmission);
  }
  const required = legs.filter(leg => leg.requiredForAdmission);
  let outcome: ReceiptSummary["outcome"] = "pass";
  if (!ownedStopConfirmed || survivorDetected || installation.status === "fail" || required.some(leg => leg.status === "fail")) outcome = "fail";
  else if (installation.status !== "pass" || required.some(leg => leg.status === "not-run")) outcome = "not-run";
  const autoAdmit = entry.autoAdmit && input.id !== "codex-review" && input.id !== "agy" && !entry.legs.some(leg => leg.requiredForAdmission && ["account-or-model", "tui-desktop"].includes(leg.category));
  const [reason, nextStep] = DIAGNOSTICS[installation.cause];
  const summary: ReceiptSummary = { schemaVersion: 1, id: input.id, version: input.version, runnerOS: os, architecture,
    procedureReceipt: entry.receipt, generatedAt: new Date().toISOString(), bounds: { totalMs: limits.totalMs + RECEIPT_CLEANUP_MS + RECEIPT_OUTPUT_MS, legMs: limits.legMs + RECEIPT_CLEANUP_MS, cleanupMs: RECEIPT_CLEANUP_MS, outputMs: RECEIPT_OUTPUT_MS }, ownedStopConfirmed, processCleanup: lifetime.status, processCleanupReason: lifetime.reason, containment: "disposable-runner-lifetime",
    installation: { status: installation.status, cause: installation.cause, reason, nextStep },
    artifact: artifact ? { method: artifact.method, integrity: artifact.integrity } : null, integrity: artifact?.integrity ?? null, autoAdmit, eligible: outcome === "pass" && autoAdmit && ownedStopConfirmed && lifetime.status === "proven",
    outcome, elapsedMs: Math.round(performance.now() - started), legs };
  try { await out.write(summary, renderReceipt(summary)); } finally { out.close(); }
  if (!ownedStopConfirmed || lifetime.status === "unproven") console.error(`Process cleanup is unproven; next: destroy the disposable runner after inspecting only the retained private workspace ${root}.`);
  return summary;
}

if (import.meta.main) {
  const [id, version, flag, out, disposableFlag, ...extra] = process.argv.slice(2);
  if (!id || !version || flag !== "--out" || !out || disposableFlag !== "--disposable-runner" || extra.length) {
    console.error("Disposable runner required; next: bun scripts/compat-receipt.ts <id> <version> --out <dir> --disposable-runner on a GitHub-hosted runner or disposable Linux container."); process.exitCode = 2;
  }
  else try {
    const result = await runCompatReceipt({ id, version, out, disposableRunner: true });
    await new Promise<void>(done => { process.stdout.write(`${JSON.stringify(result)}\n`, () => done()); });
    process.exit({ pass: 0, "not-run": 3, fail: 1 }[result.outcome]);
  }
  catch (error) {
    const cause = error instanceof ReceiptError ? error.causeCode : "input";
    console.error(`${DIAGNOSTICS[cause][0]} Next: ${DIAGNOSTICS[cause][1]}`); process.exitCode = 2;
  }
}
