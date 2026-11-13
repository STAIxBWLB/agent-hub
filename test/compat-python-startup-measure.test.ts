import { afterEach, expect, test } from "bun:test";
import { existsSync, fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { measureCommand, measurePythonStartup, startupArchive, type MeasurementPorts, type MeasurementSpawnOptions } from "../scripts/compat-receipts/python-startup-measure.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = "a".repeat(40), canary = "UNTRUSTED_NATIVE_OUTPUT_CANARY";
function port() {
  const calls: { args: string[]; options: MeasurementSpawnOptions }[] = [];
  const run: NonNullable<MeasurementPorts["run"]> = (command, args, options) => {
    expect(command).toBe("/fake/python3"); calls.push({ args, options });
    expect(options.timeout).toBe(15_000); expect(options.killSignal).toBe("SIGKILL"); expect(options.maxBuffer).toBe(4096);
    expect(options.env.HOME?.startsWith(options.cwd)).toBe(true);
    expect(Object.keys(options.env).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"]);
    if (args.includes("-c")) return { status: 0, stdout: '{"version":[3,12,7],"implementation":"CPython"}', stderr: canary };
    if (args.includes("check")) {
      expect(args[0]).toBe("-I"); expect(typeof options.stdio[3]).toBe("number");
      expect(fstatSync(options.stdio[3] as number).isDirectory()).toBe(true);
      return { status: existsSync(join(options.cwd, "output/summary.json")) ? 2 : 0, stdout: canary, stderr: canary };
    }
    expect(args[0]?.endsWith("extract-archive.py")).toBe(true); expect(args).not.toContain("-I");
    const tar = gunzipSync(readFileSync(args[1]!)), name = tar.subarray(0, 100).toString().split(String.fromCharCode(0))[0];
    if (name === "../escape.txt") return { status: 2, stdout: canary, stderr: canary };
    expect(name).toBe("payload.txt"); writeFileSync(join(args[2]!, "payload.txt"), "public startup fixture\n");
    return { status: 0, stdout: canary, stderr: canary };
  };
  return { calls, run };
}

for (const mode of ["output-check", "extract"] as const) test(`measurement starts with the actual ${mode} helper, then warms, refuses and finally reads interpreter metadata`, () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-startup-fake-")); roots.push(root);
  const fake = port(); let clock = 0;
  const result = measurePythonStartup({ mode, replicate: 2, sourceSha: sha, output: join(root, "measurement.json") }, { command: "/fake/python3", run: fake.run, now: () => clock++ });
  expect(fake.calls).toHaveLength(8); expect(fake.calls[0]!.args).not.toContain("-c");
  expect(fake.calls.slice(0, 7).every(call => !call.args.includes("-c"))).toBe(true); expect(fake.calls[7]!.args).toContain("-c");
  expect(result.flags).toEqual(mode === "output-check" ? ["-I"] : []);
  expect(result.cold).toMatchObject({ outcome: "success", censored: false, elapsedMs: 1 });
  expect(result.warm).toHaveLength(5); expect(result.warm.every(row => row.outcome === "success")).toBe(true);
  expect(result.refusal.outcome).toBe("refused"); expect(result.interpreter).toEqual({ status: "success", version: "3.12.7", implementation: "CPython" });
  expect(result.sourceSha).toBe(sha); expect(result.helperSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(readFileSync(join(root, "measurement.json"), "utf8"))).toEqual(result);
  expect(JSON.stringify(result)).not.toContain(canary); expect(JSON.stringify(result)).not.toContain(fake.calls[0]!.options.cwd);
  expect(existsSync(fake.calls[0]!.options.cwd)).toBe(false);
  const fd = fake.calls[0]!.options.stdio[3];
  if (typeof fd === "number") expect(() => fstatSync(fd)).toThrow();
});

for (const [code, outcome, censored] of [["ETIMEDOUT", "timeout", true], ["ENOBUFS", "output-cap", false], ["ENOENT", "spawn-error", false]] as const) test(`${code} stays a closed measurement outcome, never a passing or invented uncensored sample`, () => {
  let clock = 0;
  const measured = measureCommand({ command: "/fake/python3", args: [], cwd: "/owned/fake", env: {}, expectedExit: 0 }, {
    run: () => ({ status: null, signal: "SIGKILL", error: { code }, stdout: canary, stderr: canary }), now: () => clock++ });
  expect(measured.observation).toEqual({ elapsedMs: 1, timeoutMs: 15_000, outcome, censored, exitCode: null, signal: "SIGKILL" });
  expect(JSON.stringify(measured.observation)).not.toContain(canary);
});

test("a censored first helper attempt remains distinct from successful warm samples and no metadata runs early", () => {
  const fake = port(); let count = 0;
  const result = measurePythonStartup({ mode: "output-check", sourceSha: sha, replicate: 1 }, { command: "/fake/python3",
    run: (command, args, options) => ++count === 1 ? { status: null, error: { code: "ETIMEDOUT" } } : fake.run(command, args, options) });
  expect(result.cold.outcome).toBe("timeout"); expect(result.cold.censored).toBe(true);
  expect(result.warm.every(row => row.outcome === "success")).toBe(true); expect(result.interpreter.status).toBe("success");
});

test("signal, nonzero exit and malformed metadata never become successful observations or raw diagnostics", () => {
  for (const value of [{ status: 0, signal: "SIGTERM" }, { status: 2 }, { status: 0, error: { code: "PRIVATE_ERROR" } }]) {
    expect(measureCommand({ command: "/fake/python3", args: [], cwd: "/owned/fake", env: {}, expectedExit: 0 }, { run: () => value }).observation.outcome).not.toBe("success");
  }
  const fake = port(), result = measurePythonStartup({ mode: "output-check", sourceSha: sha, replicate: 3 }, { command: "/fake/python3",
    run: (command, args, options) => args.includes("-c") ? { status: 0, stdout: canary } : fake.run(command, args, options) });
  expect(result.interpreter.status).toBe("invalid-metadata"); expect(JSON.stringify(result)).not.toContain(canary);
});

test("Node-generated fixture is a public regular ustar entry with a valid checksum and a separate traversal refusal variant", () => {
  const tar = gunzipSync(startupArchive()), header = Buffer.from(tar.subarray(0, 512));
  const checksum = parseInt(header.subarray(148, 154).toString(), 8); header.fill(32, 148, 156);
  expect(header.reduce((sum, byte) => sum + byte, 0)).toBe(checksum);
  expect(tar.subarray(257, 262).toString()).toBe("ustar"); expect(tar[156]).toBe("0".charCodeAt(0));
  expect(gunzipSync(startupArchive("../escape.txt")).subarray(0, 14).toString()).toBe("../escape.txt" + String.fromCharCode(0));
});


test("invalid measurement identity refuses before a command and exception text is never an observation", () => {
  let calls = 0;
  expect(() => measurePythonStartup({ mode: "extract", sourceSha: "not-a-sha", replicate: 1 }, { command: "/fake/python3", run: () => { calls++; return { status: 0 }; } })).toThrow("measurement input invalid");
  expect(calls).toBe(0);
  const result = measureCommand({ command: "/fake/python3", args: [], cwd: "/owned/fake", env: {}, expectedExit: 0 }, { run: () => { throw Error(canary); } });
  expect(result.observation.outcome).toBe("spawn-error"); expect(JSON.stringify(result.observation)).not.toContain(canary);
});
