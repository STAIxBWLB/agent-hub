import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personEnv } from "../src/hub/child-process.ts";
import { buildPiLaunch } from "../src/pi/launch.ts";

const piOptions = { stateDir: "/native/state", mode: "headless" as const, backend: "auto" as const,
  relay: { url: "http://127.0.0.1:1", token: "fixture", models: [] }, tools: [] };

test("#133 invalid instance declaration prints one bounded CLI refusal without a startup stack", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-instance-refusal-"));
  try {
    mkdirSync(join(root, ".agenthub"));
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instances: { "codex-invalid": { kind: "missing-native" } } }));
    const env = personEnv();
    delete env.AGENTHUB_PROJECT_DIR; delete env.AGENTHUB_STATE_DIR;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "codex", "--as", "codex-invalid", "--dry-run"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0); expect(stdout).toBe("");
    expect(stderr).toStartWith("ahub: "); expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr.length).toBeLessThanOrEqual(1024);
    expect(stderr).not.toContain("at validateInstances");
    expect(existsSync(join(root, ".agenthub", "state"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#133 base Pi keeps legacy absence of canonical hub state environment", () => {
  const launch = buildPiLaunch(piOptions, {}, "extension.ts", 1234, "bridge-token");
  expect(Object.hasOwn(launch.env, "AGENTHUB_STATE_DIR")).toBe(false);
  expect(launch.env.AGENTHUB_PEER_ID).toBe("pi");
  const inherited = buildPiLaunch(piOptions, { AGENTHUB_STATE_DIR: "/inherited/state" }, "extension.ts", 1234, "bridge-token");
  expect(inherited.env.AGENTHUB_STATE_DIR).toBe("/inherited/state");
});

test("#133 explicit extra Pi binding overrides inherited state while native storage stays separate", () => {
  const launch = buildPiLaunch({ ...piOptions, instance: "pi-worker", hubStateDir: "/canonical/state" }, { AGENTHUB_STATE_DIR: "/old/state" }, "extension.ts", 1234, "bridge-token");
  expect(launch.env.AGENTHUB_STATE_DIR).toBe("/canonical/state");
  expect(launch.env.PI_CODING_AGENT_DIR).toBe("/native/state/pi");
  expect(launch.env.AGENTHUB_PEER_ID).toBe("pi-worker");
});
