import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCompatReceipt } from "../../compat-receipt.ts";
import { ReceiptError, type ManifestEntry, type ReceiptSummary } from "../types.ts";

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
    install: { ...original.install, asset: "jcode-linux-x86_64.tar.gz" },
    legs: original.legs.map(leg => leg.category === "macos-runner"
      ? { ...leg, category: "linux-ci", runnerOS: ["linux"] }
      : leg),
  };
  return runCompatReceipt({ id: "jcode", version: "0.99.1", out, disposableRunner: true }, { entry });
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
