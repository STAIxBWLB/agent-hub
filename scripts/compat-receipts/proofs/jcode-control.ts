import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCompatReceipt } from "../../compat-receipt.ts";
import { runManifestProofs } from "../proofs.ts";
import { ReceiptError, type ManifestEntry, type ProofContext, type ProofResults, type ReceiptSummary } from "../types.ts";

/** Diagnostics are closed observations, never admission evidence or native output. */
async function controlProofs(context: ProofContext): Promise<ProofResults> {
  const result = await runManifestProofs(context);
  let fd: number | undefined;
  try {
    fd = openSync(join(context.root, "jcode-proof-observations.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size > Math.min(context.limits.outputBytes, 16 * 1024)) throw new Error("diagnostic refused");
    const text = readFileSync(fd, "utf8"), after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("diagnostic changed");
    const lines = text.trim().split("\n");
    if (lines.length > 64) throw new Error("diagnostic bound");
    const steps = new Set(["steer-pong", "steer-subscribe", "steer-idle", "steer-stream-arrived", "steer-active", "steer-ack", "steer-end-turn", "steer-request-count", "steer-first-conversation", "steer-second-conversation", "telemetry-walk"]);
    const causes = new Set(["ok", "pending", "assertion", "telemetry-id", "milestone", "opt-out-marker", "other-telemetry-name", "symlink", "entry-budget", "io"]);
    const roots = new Set(["none", "home", "jcode-home"]);
    const records = lines.map(line => JSON.parse(line));
    for (const value of records) {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "cause,count,passed,rootClass,step"
        || !steps.has(value.step) || !causes.has(value.cause) || !roots.has(value.rootClass) || typeof value.passed !== "boolean"
        || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > context.limits.archiveEntries + 1) throw new Error("diagnostic shape");
    }
    process.stderr.write(JSON.stringify({ jcodeControlObservations: records }) + "\n");
  } catch {
    process.stderr.write("Jcode control diagnostics unavailable; next: inspect the closed checkpoint producer before another control.\n");
  } finally { if (fd !== undefined) closeSync(fd); }
  return result;
}

/** Portable reconstruction control only; the admission manifest still requires macOS arm64. */
export async function runJcodeControl(out: string): Promise<ReceiptSummary> {
  if (process.platform !== "linux" || process.arch !== "x64" || !existsSync("/.dockerenv")) throw new ReceiptError("disposable-required");
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8")) as { entries: { jcode: ManifestEntry } };
  const original = manifest.entries.jcode;
  const entry: ManifestEntry = {
    ...original,
    runnerOS: ["linux"],
    nativePlatform: "linux-x64-control-only",
    autoAdmit: false,
    install: { ...original.install, asset: "jcode-linux-x86_64.tar.gz", executable: "jcode-linux-x86_64" },
    legs: original.legs.map(leg => leg.category === "macos-runner"
      ? { ...leg, category: "linux-ci", runnerOS: ["linux"] }
      : leg),
  };
  return runCompatReceipt({ id: "jcode", version: "0.99.1", out, disposableRunner: true }, { entry, proofs: controlProofs });
}

if (import.meta.main) {
  try {
    const [flag, out, ...extra] = process.argv.slice(2);
    if (flag !== "--out" || !out || extra.length) throw new ReceiptError("input");
    const result = await runJcodeControl(out);
    process.stdout.write(JSON.stringify(result) + "\n");
    // A source-review not-run is expected; it is never silently promoted to pass.
    const nativeLegsPassed = result.legs.every(leg => leg.id === "source-comparison" ? leg.status === "not-run" : leg.status === "pass");
    if (result.outcome === "fail" || result.installation.status !== "pass" || !nativeLegsPassed) process.exitCode = 1;
  } catch (error) {
    const cause = error instanceof ReceiptError ? error.causeCode : "proof-failed";
    process.stderr.write(`Jcode portable control refused (${cause}); next: use the isolated Linux x86_64 container procedure and inspect its bounded result.\n`);
    process.exitCode = 2;
  }
}
