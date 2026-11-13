import { expect, test } from "bun:test";
import { definitionOf } from "../src/adapters/registry.ts";
import type { AdapterDefinition } from "../src/adapters/registry-types.ts";
import { readRecoveryVersionPreflight, recoveryVersionGates, type RecoveryVersionGate } from "../src/cli/recovery-version-preflight.ts";
import type { RunCommand } from "../src/cli/recovery-package.ts";
import type { PlannedProject } from "../src/cli/upgrade.ts";

const gate: RecoveryVersionGate = { peer: "pi", compatId: "pi" };
const target = "/synthetic-target", project = "/synthetic-project";
function planned(peers: { id: string; state: string; args?: Record<string, string> }[], reconnectOnly: string[] = []): PlannedProject {
  return { project: { root: project }, source: { peers }, reconnectOnly } as PlannedProject;
}
function fixture() {
  const state = { trusted: false, current: true, native: "999.0.0\n", policy: { probe: ["pi", "--version"] } as unknown, malformed: false };
  const calls: { argv: string[]; options?: Parameters<RunCommand>[1] }[] = [];
  const run: RunCommand = async (argv, options) => {
    calls.push({ argv, options });
    // Every command is synthetic, including both target import scripts; no native executable or home is read.
    if (argv[2]?.startsWith("// recovery-version-policy")) return { code: 0, stdout: JSON.stringify(state.policy), stderr: "" };
    if (argv[2]?.startsWith("// recovery-version-assess")) return { code: 0, stdout: state.malformed ? "not JSON" : JSON.stringify({ ok: state.trusted, state: state.trusted ? "trusted" : "refused", version: "999.0.0" }), stderr: "" };
    return { code: 0, stdout: state.native, stderr: "NATIVE_ERROR_CANARY" };
  };
  return { state, calls, run, read: (gates: RecoveryVersionGate[] = [gate]) => readRecoveryVersionPreflight(target, project, gates, { run, current: () => state.current }) };
}

test("#1426 selection uses semantic restore gates, skips offline/reconnect/nonrestorable peers and keeps normal Codex ungated", () => {
  const peers = [{ id: "pi", state: "idle" }, { id: "codex", state: "idle" }, { id: "claude", state: "idle" }, { id: "local", state: "idle" }, { id: "qwen", state: "idle", args: { mode: "tui" } }, { id: "jcode", state: "idle" }];
  expect(recoveryVersionGates(planned(peers), definitionOf, { pi: ["/configured/pi", "--prefix"] })).toEqual([{ peer: "pi", compatId: "pi", command: ["/configured/pi", "--prefix"] }]);
  expect(recoveryVersionGates(planned([{ id: "pi", state: "offline" }]), definitionOf)).toEqual([]);
  expect(recoveryVersionGates(planned([{ id: "pi", state: "idle" }], ["pi"]), definitionOf)).toEqual([]);
  expect(recoveryVersionGates(planned([{ id: "qwen", state: "idle", args: { mode: "headless" } }]), definitionOf)).toEqual([{ peer: "qwen", compatId: "qwen" }]);
  const pi = definitionOf("pi")!;
  const instance = { ...pi, kind: pi.kind } as AdapterDefinition;
  expect(recoveryVersionGates(planned([{ id: "pi-extra", state: "idle" }]), id => id === "pi-extra" ? instance : undefined)).toEqual([{ peer: "pi-extra", compatId: "pi" }]);
  expect(definitionOf("codex")?.session.restoreVersionGate).toBeUndefined();
});

test("#1426 target-only refusal uses the verified target import and target's current trust, never coordinator acceptance", async () => {
  const f = fixture();
  expect(await f.read()).toEqual([{ peer: "pi", compatId: "pi", state: "refused", version: "999.0.0",
    message: "pi: target refuses installed version 999.0.0; install a verified version, or accept this exact version on this machine with: ahub agents trust pi 999.0.0" }]);
  expect(f.calls.map(call => call.argv.slice(0, 2))).toEqual([[process.execPath, "-e"], ["pi", "--version"], [process.execPath, "-e"]]);
  expect(f.calls[0]!.argv[2]).toContain('"/synthetic-target/src/adapters/compat.ts"');
  expect(f.calls[2]!.argv[2]).toContain("assessVersion(id, p.parse(");
  expect(f.calls[2]!.argv[2]).toContain("readTrust()");
  expect(f.calls.every(call => call.options?.cwd === project && call.options.timeoutMs === 10_000)).toBe(true);
  f.state.trusted = true;
  expect((await f.read())[0]).toMatchObject({ state: "accepted", version: "999.0.0" });
  expect(f.calls).toHaveLength(6); // Fresh policy, executable observation and current trust on every invocation, cached staging included.
});

test("#1426 current configured argv is preserved and target probe suffix wins", async () => {
  const f = fixture();
  await f.read([{ ...gate, command: ["/configured wrapper/pi", "--profile", "fixture"] }]);
  expect(f.calls[1]!.argv).toEqual(["/configured wrapper/pi", "--profile", "fixture", "--version"]);
  expect(f.calls.some(call => call.argv.includes("prepare") || call.argv.includes("commit") || call.argv.includes("stop"))).toBe(false);
});

test("#1426 unknown target metadata, malformed assessment and over-bound native output never become accepted or leak text", async () => {
  for (const kind of ["policy", "assessment", "output", "throw"] as const) {
    const f = fixture();
    if (kind === "policy") f.state.policy = null;
    if (kind === "assessment") f.state.malformed = true;
    if (kind === "output") f.state.native = "NATIVE_OUTPUT_CANARY".repeat(4000);
    const rows = kind === "throw" ? await readRecoveryVersionPreflight(target, project, [gate], { run: async () => { throw new Error("PRIVATE_EXCEPTION_CANARY"); }, current: () => true }) : await f.read();
    expect(rows[0]?.state).toBe("unknown");
    expect(JSON.stringify(rows)).not.toMatch(/CANARY|synthetic-target|synthetic-project/);
    expect(rows[0]).not.toHaveProperty("version");
  }
});

test("#1426 a changed target/authority suppresses the complete previously observed batch", async () => {
  const f = fixture();
  f.state.trusted = true;
  let calls = 0;
  const run: RunCommand = async (argv, options) => {
    const result = await f.run(argv, options);
    if (++calls === 4) f.state.current = false;
    return result;
  };
  const rows = await readRecoveryVersionPreflight(target, project, [gate, { peer: "pi-extra", compatId: "pi" }], { run, current: () => f.state.current });
  expect(rows.map(row => row.state)).toEqual(["unknown", "unknown"]);
  expect(rows.every(row => row.version === undefined)).toBe(true);
  expect(f.calls).toHaveLength(4);
});

test("#1426 bad preflight scope refuses before any injected command", async () => {
  const f = fixture();
  await expect(readRecoveryVersionPreflight("relative", project, [gate], { run: f.run, current: () => true })).rejects.toThrow("invalid recovery version preflight scope");
  await expect(f.read([{ ...gate, command: ["pi", "bad\nflag"] }])).rejects.toThrow("invalid recovery version preflight scope");
  expect(f.calls).toEqual([]);
});
