import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { STARTUP_PHASES, StartupTimings, type StartupPhase } from "../src/hub/startup-timing.ts";
import { realPath } from "../src/hub/project.ts";

function fields(line: string): Record<string, number> {
  expect(line).toStartWith("startup timings ms: ");
  const values: Record<string, number> = {};
  for (const pair of line.slice("startup timings ms: ".length).split(" ")) {
    expect(pair).toMatch(/^[a-z_]+=\d+$/);
    const [name, value] = pair.split("=");
    values[name!] = Number(value);
  }
  expect(Object.keys(values)).toEqual([...STARTUP_PHASES, "total"]);
  expect(STARTUP_PHASES.reduce((sum, phase) => sum + values[phase]!, 0)).toBe(values.total!);
  return values;
}

test("startup timing records exclusive monotonic boundaries once with fixed numeric labels", () => {
  let now = 20.9;
  const timings = new StartupTimings(() => now);
  for (const phase of STARTUP_PHASES) { now += 3; timings.mark(phase); }
  const line = timings.finish(), values = fields(line);
  expect(STARTUP_PHASES.every(phase => values[phase] === 3)).toBe(true);
  now += 100;
  timings.mark("ready");
  expect(timings.finish()).toBe(line);
});

test("startup timing rejects arbitrary labels and clamps unavailable or regressing diagnostic clocks", () => {
  let now = 10;
  const timings = new StartupTimings(() => now);
  now = 15; timings.mark("schema");
  now = 2; timings.mark("source");
  now = Number.NaN; timings.mark("configuration");
  now = Number.POSITIVE_INFINITY; timings.mark("control");
  timings.mark("private-path secret task body\nforged=123" as StartupPhase);
  now = 19; timings.mark("post_ready");
  const line = timings.finish(), values = fields(line);
  expect(values.schema).toBe(5);
  expect(values.source).toBe(0);
  expect(values.configuration).toBe(0);
  expect(values.control).toBe(0);
  expect(values.post_ready).toBe(4);
  expect(values.total).toBe(9);
  expect(line).not.toContain("private-path");
  expect(line).not.toContain("forged");
});

test("an unavailable timing clock cannot fail startup diagnostics", () => {
  const timings = new StartupTimings(() => { throw new Error("private diagnostic error"); });
  timings.mark("schema");
  expect(fields(timings.finish()).total).toBe(0);
  expect(timings.finish()).not.toContain("private diagnostic error");
});

test("isolated daemon startup writes one timing line without project paths or private content", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-startup-private-canary-"))), stateDir = join(cwd, "state");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({ cwd, stateDir, configWatch: false, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG,
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false, sync_interval_min: 0 },
        pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
        task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
        specs: { ...DEFAULT_CONFIG.specs, enabled: false },
      } });
    const lines = readFileSync(join(stateDir, "hub.log"), "utf8").split("\n").filter(line => line.includes("startup timings ms: "));
    expect(lines).toHaveLength(1);
    const line = lines[0]!.slice(lines[0]!.indexOf("startup timings ms: "));
    fields(line);
    expect(line).not.toContain(cwd);
    expect(line).not.toContain("private-canary");
    expect(line).not.toContain(daemon.token);
  } finally {
    try { await daemon?.stop(); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  }
}, 20_000);
