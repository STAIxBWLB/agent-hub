import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { runCompatReceipt } from "../scripts/compat-receipt.ts";
import { runBoundedReceiptCommand } from "../scripts/compat-receipts/runner.ts";
import type { CommandResult, InstalledArtifact, ManifestEntry, ProofResults, ReceiptContext, ReceiptPorts, ReceiptSummary } from "../scripts/compat-receipts/types.ts";

const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0).reverse()) await finish();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const nativeLeg = "native-identity", modelLeg = "model-backed-hub-call", cleanupLeg = "isolated-home-cleanup", version = "9.8.7";
function live(pid: number): boolean {
  const ps = Bun.which("ps", { PATH: "/usr/bin:/bin" });
  if (!ps) throw new Error("fixture process observation unavailable");
  const result = Bun.spawnSync([ps, "-p", String(pid), "-o", "stat="], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, stdin: "ignore" });
  if (![0, 1].includes(result.exitCode)) throw new Error("fixture process table could not confirm stopped state");
  return result.stdout.toString().trim().split(/\s+/).filter(Boolean).some(state => !state.startsWith("Z"));
}
function fixtureEntry(withModel = false): ManifestEntry {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../scripts/compat-receipts/manifest.json"), "utf8")) as { entries: Record<string, ManifestEntry> };
  const pi = manifest.entries.pi!, identity = pi.legs.find(leg => leg.id === nativeLeg)!, cleanup = pi.legs.find(leg => leg.id === cleanupLeg)!;
  return { ...pi, install: { ...pi.install }, autoAdmit: true, legs: [identity, cleanup, ...(withModel ? [{ id: modelLeg, label: "Person-authorized model-backed hub call", category: "account-or-model", runnerOS: ["macos"], requiredForAdmission: true }] : [])] };
}
interface Observation { role: string; mode: string; leg: string; pid: number; cwd: string; homes: Record<string, string>; sensitiveKeys: string[]; parentCanarySeen: boolean }
function fixture(mode: "pass" | "fail" | "hang" | "detach-normal" = "pass", withModel = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-compat-receipt-")); roots.push(root);
  const out = join(root, "out"), observed = join(root, "observed.jsonl"), entry = fixtureEntry(withModel);
  const contexts: ReceiptContext[] = [], requestedLegs: string[][] = [], artifacts: InstalledArtifact[] = [], commands: CommandResult[] = [];
  const knownPids = (): number[] => existsSync(`${observed}.children.json`)
    ? Object.values(JSON.parse(readFileSync(`${observed}.children.json`, "utf8")) as { leader: number; descendant: number })
    : observations().map(row => row.pid);
  const ports: ReceiptPorts = { disposable: true, entry, platform: "darwin", architecture: "arm64", limits: { totalMs: 10_000, installMs: 2000, legMs: 3000 },
    run: async (argv, options) => {
      const result = await runBoundedReceiptCommand(argv, options);
      const controlled = ["pass", "fail", "hang"].includes(mode);
      // Trusted fake-host attestation only: these authored modes cannot detach,
      // and every process they create is enumerated and observed stopped.
      const proven = controlled && !result.survivorDetected && result.ownedStopConfirmed && knownPids().length > 0 && knownPids().every(pid => !live(pid));
      const final = proven ? { ...result, processCleanup: "proven" as const, processCleanupReason: "controlled fixture modes have no detach path; every enumerated process stopped" } : result;
      commands.push(final); return final;
    },
    install: async context => {
      if (!basename(context.root).startsWith("ahub-compat-receipt-") || !within(context.root, context.prefix)) throw new Error("unsafe fixture install context");
      contexts.push(context);
      const packageRoot = join(context.prefix, "node_modules/fixture-agent"); mkdirSync(packageRoot, { recursive: true });
      const cli = join(packageRoot, "cli.ts"), code = readFileSync(join(import.meta.dir, "fakes/compat-receipt.ts")); writeFileSync(cli, code);
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-agent", version: context.version }));
      const artifact = { method: "npm-exact", integrity: `sha512-${createHash("sha512").update(code).digest("base64")}`, packageRoot, command: [process.execPath, cli] };
      artifacts.push(artifact); return artifact;
    },
    proofs: async context => {
      requestedLegs.push(context.entry.legs.map(leg => leg.id));
      const results: ProofResults = {};
      for (const leg of context.entry.legs) {
        if (leg.id === cleanupLeg) { results[leg.id] = { status: "pass", cause: "ok" }; continue; }
        const selected = leg.category === "account-or-model" ? "model" : mode;
        const result = await context.run([...context.artifact.command, selected, observed, leg.id], { cwd: context.cwd, env: context.env, signal: context.signal,
          timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes });
        if (result.timedOut || context.signal.aborted) { results[leg.id] = { status: "fail", cause: "timeout" }; continue; }
        const parsed = JSON.parse(result.stdout) as { schemaVersion: number; legs: ProofResults };
        if (parsed.schemaVersion !== 1 || !parsed.legs[leg.id]) throw new Error("fixture proof response is invalid");
        results[leg.id] = parsed.legs[leg.id]!;
      }
      // A producer's optimistic result can never override the manifest's model boundary.
      if (withModel) results[modelLeg] = { status: "pass", cause: "ok" };
      return results;
    },
  };
  const observations = (): Observation[] => existsSync(observed) ? readFileSync(observed, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const run = () => runCompatReceipt({ id: "pi", version, out, disposableRunner: true }, ports);
  cleanup.push(async () => {
    writeFileSync(`${observed}.stop`, "fixture-owned stop request");
    const end = performance.now() + 7000;
    while (knownPids().some(live) && performance.now() < end) await Bun.sleep(20);
    if (knownPids().some(live)) throw new Error("fixture helper is still live; its workspace was retained without signalling an unknown PID");
    for (const context of contexts) if (existsSync(context.root)) rmSync(context.root, { recursive: true, force: true });
  });
  return { root, out, observed, entry, contexts, requestedLegs, artifacts, commands, ports, observations, run };
}
function output(summary: ReceiptSummary, out: string) {
  expect(readdirSync(out).sort()).toEqual(["receipt.md", "summary.json"]);
  const json = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
  expect(json).toEqual(summary);
  expect(json).not.toHaveProperty("cleanupConfirmed");
  expect(json.containment).toBe("disposable-runner-lifetime");
  const markdown = readFileSync(join(out, "receipt.md"), "utf8");
  expect(markdown).toContain(summary.id); expect(markdown).toContain(summary.version);
  expect(markdown).not.toContain("Cleanup confirmed: true");
  expect(markdown).not.toContain("PARENT_RECEIPT_CANARY"); expect(JSON.stringify(json)).not.toContain("PARENT_RECEIPT_CANARY");
  return { json, markdown };
}
function within(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return isAbsolute(candidate) && suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix);
}
const parentKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "PI_MODEL", "QWEN_HOME", "KIMI_CODE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;

test("a fake receipt pass writes both bound artifacts after private-home child proof and cleanup", async () => {
  const f = fixture(), original = Object.fromEntries(parentKeys.map(key => [key, process.env[key]]));
  const canaries = Object.fromEntries(parentKeys.map(key => [key, `PARENT_RECEIPT_CANARY_${key}`]));
  try {
    for (const key of parentKeys) process.env[key] = canaries[key];
    const summary = await f.run(), context = f.contexts[0]!;
    expect(summary).toMatchObject({ schemaVersion: 1, id: "pi", version, runnerOS: "macos", architecture: "arm64", eligible: true, outcome: "pass", ownedStopConfirmed: true, processCleanup: "proven", containment: "disposable-runner-lifetime",
      installation: { status: "pass" }, artifact: { method: "npm-exact", integrity: f.artifacts[0]!.integrity } });
    expect(summary.legs).toContainEqual(expect.objectContaining({ id: nativeLeg, status: "pass", cause: "ok", requiredForAdmission: true }));
    const observed = f.observations(); expect(observed).toHaveLength(1);
    expect(observed[0]!.cwd).toBe(context.cwd); expect(observed[0]!.homes.HOME).toBe(context.home);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR"]) {
      expect(typeof observed[0]!.homes[key]).toBe("string"); expect(within(context.root, observed[0]!.homes[key]!)).toBe(true);
    }
    expect(observed[0]!.sensitiveKeys).toEqual([]); expect(observed[0]!.parentCanarySeen).toBe(false);
    for (const candidate of Object.values(observed[0]!.homes)) expect(within(context.root, candidate)).toBe(true);
    expect(existsSync(context.root)).toBe(false);
    output(summary, f.out);
    expect(Object.fromEntries(parentKeys.map(key => [key, process.env[key]]))).toEqual(canaries);
  } finally { for (const key of parentKeys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } }
  expect(Object.fromEntries(parentKeys.map(key => [key, process.env[key]]))).toEqual(original);
});

test("an actual failing fake proof produces a non-eligible failure receipt and no PR artifact", async () => {
  const f = fixture("fail"), summary = await f.run();
  expect(summary).toMatchObject({ eligible: false, outcome: "fail", ownedStopConfirmed: true, processCleanup: "proven", containment: "disposable-runner-lifetime", installation: { status: "pass" } });
  const failed = summary.legs.find(leg => leg.id === nativeLeg)!;
  expect(failed).toMatchObject({ status: "fail", cause: "proof-failed" }); expect(failed.reason.length).toBeGreaterThan(0); expect(failed.nextStep.length).toBeGreaterThan(0);
  const written = output(summary, f.out);
  expect(JSON.stringify(written)).not.toContain("UNTRUSTED_NATIVE_FAILURE_CANARY");
  expect(f.observations().map(row => row.leg)).toEqual([nativeLeg]); expect(existsSync(f.contexts[0]!.root)).toBe(false);
});

test("required model legs remain not-run before dispatch even if a fake producer claims pass", async () => {
  const f = fixture("pass", true), summary = await f.run();
  expect(summary.eligible).toBe(false);
  expect(summary.legs.find(leg => leg.id === modelLeg)).toMatchObject({ status: "not-run", cause: "model-required", requiredForAdmission: true });
  expect(f.requestedLegs).toHaveLength(1);
  expect(f.requestedLegs[0]).toContain(nativeLeg); expect(f.requestedLegs[0]).not.toContain(modelLeg);
  expect(f.observations().map(row => row.leg)).toEqual([nativeLeg]); expect(existsSync(`${f.observed}.model-executed`)).toBe(false);
  output(summary, f.out);
});

for (const bound of ["leg", "total"] as const) test(`the ${bound} deadline settles owned fake descendants before private workspace cleanup`, async () => {
  const f = fixture("hang");
  f.ports.limits = { totalMs: bound === "total" ? 2000 : 8000, legMs: bound === "leg" ? 2000 : 6000, installMs: 1000 };
  const summary = await f.run();
  expect(summary.eligible).toBe(false); expect(summary.outcome).toBe("fail"); expect(summary.ownedStopConfirmed).toBe(true); expect(summary.processCleanup).toBe("proven");
  expect(summary.legs.find(leg => leg.id === nativeLeg)).toMatchObject({ status: "fail", cause: "timeout" });
  expect(existsSync(`${f.observed}.children.json`)).toBe(true);
  const child = JSON.parse(readFileSync(`${f.observed}.children.json`, "utf8")) as { leader: number; descendant: number };
  expect(child.leader).not.toBe(child.descendant);
  for (const pid of [child.leader, child.descendant]) expect(live(pid)).toBe(false);
  expect(existsSync(f.contexts[0]!.root)).toBe(false);
  output(summary, f.out);
}, 20_000);

test("an unsupported native platform never dispatches the fake native leg", async () => {
  const f = fixture(); f.ports.platform = "linux"; f.ports.architecture = "x64";
  const summary = await f.run();
  expect(summary.eligible).toBe(false); expect(summary.legs.find(leg => leg.id === nativeLeg)).toMatchObject({ status: "not-run", cause: "platform" });
  expect(f.observations()).toEqual([]); output(summary, f.out);
});

test("invalid identifiers and non-exact versions refuse before fake installation or output", async () => {
  for (const input of [{ id: "not-a-compat-id", version }, { id: "pi", version: "latest" }, { id: "pi", version: "^1.2.3" }]) {
    const f = fixture();
    await expect(runCompatReceipt({ ...input, out: f.out, disposableRunner: true }, f.ports)).rejects.toThrow();
    expect(f.contexts).toEqual([]); expect(existsSync(f.out)).toBe(false);
  }
});

test("a symlink output directory is refused without changing its existing target", async () => {
  const f = fixture(), target = join(f.root, "person-owned"), sentinel = join(target, "keep.txt");
  mkdirSync(target); writeFileSync(sentinel, "untouched"); symlinkSync(target, f.out);
  await expect(f.run()).rejects.toThrow();
  expect(f.contexts).toEqual([]); expect(lstatSync(f.out).isSymbolicLink()).toBe(true);
  expect(readdirSync(target)).toEqual(["keep.txt"]); expect(readFileSync(sentinel, "utf8")).toBe("untouched");
});

test("an inconsistent optimistic producer result cannot make a receipt eligible", async () => {
  const f = fixture();
  f.ports.proofs = async () => ({ [nativeLeg]: { status: "pass", cause: "timeout" } });
  const summary = await f.run();
  expect(summary.eligible).toBe(false);
  expect(summary.outcome).toBe("fail");
  expect(summary.legs.find(leg => leg.id === nativeLeg)).toMatchObject({ status: "fail", cause: "proof-failed" });
  output(summary, f.out);
});


test("the disposable-runner declaration is mandatory even for a trusted fake host", async () => {
  const f = fixture();
  const input = { id: "pi", version, out: f.out } as Parameters<typeof runCompatReceipt>[0];
  await expect(runCompatReceipt(input, f.ports)).rejects.toMatchObject({ causeCode: "disposable-required" });
  expect(f.contexts).toEqual([]); expect(f.commands).toEqual([]); expect(existsSync(f.out)).toBe(false);
});

test("a local Mac cannot use the disposable flag without trusted disposable containment", async () => {
  const f = fixture(); f.ports.disposable = false;
  await expect(f.run()).rejects.toMatchObject({ causeCode: "disposable-required" });
  expect(f.contexts).toEqual([]); expect(f.commands).toEqual([]); expect(existsSync(f.out)).toBe(false);
});

test("normal leader exit and an empty old PGID never prove a detached helper's lifetime cleanup", async () => {
  const f = fixture("detach-normal");
  f.ports.limits = { totalMs: 15_000, legMs: 8000, installMs: 2000 };
  const summary = await f.run();
  expect(summary.processCleanup).toBe("unproven");
  expect(summary.processCleanupReason.length).toBeGreaterThan(0);
  expect(summary.containment).toBe("disposable-runner-lifetime");
  expect(f.commands).toHaveLength(1);
  const command = f.commands[0]!;
  expect(command.exitCode).toBe(0); expect(command.timedOut).toBe(false);
  expect(command.processCleanup).toBe("unproven"); expect(command).not.toHaveProperty("cleanup");
  const child = JSON.parse(readFileSync(`${f.observed}.children.json`, "utf8")) as { leader: number; descendant: number };
  const helper = JSON.parse(readFileSync(`${f.observed}.detached-ready.json`, "utf8")) as { pid: number; pgid: number };
  expect(helper.pid).toBe(child.descendant); expect(helper.pgid).toBe(helper.pid); expect(helper.pgid).not.toBe(child.leader);
  expect(live(child.leader)).toBe(false); expect(live(child.descendant)).toBe(true);
  const isolation = summary.legs.find(leg => leg.id === cleanupLeg)!;
  if (command.survivorDetected) {
    expect(summary.eligible).toBe(false);
    expect(summary.outcome).toBe("fail"); expect(isolation).toMatchObject({ status: "fail", cause: "cleanup" });
  } else {
    expect(summary.eligible).toBe(true); expect(summary.outcome).toBe("pass");
    expect(isolation).toMatchObject({ status: "pass", cause: "ok" });
  }
  expect(existsSync(f.contexts[0]!.root)).toBe(true);
  output(summary, f.out);
  // The fixture helper exits itself on its stop file or bounded deadline. Teardown
  // observes that exit before deleting only this fixture's retained workspace.
  writeFileSync(`${f.observed}.stop`, "fixture-owned stop request");
}, 20_000);
