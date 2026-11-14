import { buildPiLaunch } from "../src/pi/launch.ts";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { validateRawConfig, validateEffectiveConfig } from "../src/hub/config-apply.ts";
import { mergeNativeConfiguration } from "../src/adapters/definitions/native-config-defaults.ts";
import { PI_CEILING_KIND } from "../src/pi/ceiling.ts";

test("T3 Pi defaults and tracked config use 100 while local stays 30 and policy accepts both", () => {
  const tracked = JSON.parse(readFileSync(join(import.meta.dir, "../.agenthub/config.json"), "utf8"));
  expect(DEFAULT_CONFIG.pi.max_steps).toBe(100);
  expect(DEFAULT_CONFIG.local.max_steps).toBe(30);
  expect(tracked.pi.max_steps).toBe(100);
  expect(tracked.local.max_steps).toBe(30);
  const template = JSON.parse(readFileSync(join(import.meta.dir, "../templates/config.json"), "utf8"));
  expect(template.pi.max_steps).toBe(DEFAULT_CONFIG.pi.max_steps);
  expect(template.local.max_steps).toBe(30);
  expect(mergeNativeConfiguration({ pi: { max_steps: 30 } }, DEFAULT_CONFIG).pi.max_steps).toBe(30);
  expect(() => validateRawConfig({ pi: { max_steps: 100 }, local: { max_steps: 30 } })).not.toThrow();
  expect(() => validateEffectiveConfig(DEFAULT_CONFIG)).not.toThrow();
});

test("T3 launcher omission injects 100 and an explicit existing 30 stays 30", () => {
  const options = { stateDir: "/fixture/pi-state", mode: "headless" as const, backend: "dgx" as const,
    relay: { url: "http://127.0.0.1:9/v1", token: "fixture-token", models: [{ id: "dgx/coding" }] }, tools: [] };
  const launch = (maxSteps?: number) => buildPiLaunch({ ...options, ...(maxSteps === undefined ? {} : { maxSteps }) }, {}, "/fixture/extension.ts", 9, "fixture-bridge-token");
  expect(launch().env.AGENTHUB_PI_MAX_STEPS).toBe("100");
  expect(launch(30).env.AGENTHUB_PI_MAX_STEPS).toBe("30");
});

for (const configured of [true, false]) test(`T3 the real extension rejects attempt 101 before its tool effect with ${configured ? "configured" : "unset-env default"} 100 ceiling`, async () => {
  const limit = DEFAULT_CONFIG.pi.max_steps;
  const calls: string[] = [], ceilings: { kind?: string; count?: number; limit?: number }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/commands") return Response.json({ command: null });
    const body = await request.json() as { kind?: string; count?: number; limit?: number; toolCallId?: string };
    if (pathname === "/budget") return Response.json({ decisions: [] });
    if (pathname === "/tool") { calls.push(String(body.toolCallId)); return Response.json({ text: "ok", failed: false }); }
    if (body.kind === PI_CEILING_KIND) ceilings.push(body);
    return Response.json({ ok: true });
  } });
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const env: NodeJS.ProcessEnv = { ...process.env,
    AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`, AGENTHUB_PI_BRIDGE_TOKEN: "fixture-token",
    AGENTHUB_PI_TOOLS: JSON.stringify([{ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }]),
  };
  delete env.AGENTHUB_PI_MAX_STEPS;
  if (configured) env.AGENTHUB_PI_MAX_STEPS = String(limit);
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fakes/pi-ceiling-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts"), String(limit + 1)], {
      stdout: "pipe", stderr: "pipe", env,
    });
    proc = child;
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, error).toBe(0); expect(error).toBe("");
    const results = output.trim().split("\n").map(line => JSON.parse(line));
    expect(results).toHaveLength(101);
    expect(results.slice(0, 100).every(result => result.isError !== true)).toBe(true);
    expect(results[100].isError).toBe(true);
    expect(calls).toHaveLength(100); expect(calls.at(-1)).toBe("c100"); expect(calls).not.toContain("c101");
    expect(ceilings).toHaveLength(1); expect(ceilings[0]).toMatchObject({ kind: PI_CEILING_KIND, count: 101, limit: 100 });
  } finally {
    if (proc && proc.exitCode === null) { proc.kill(); await proc.exited; }
    server.stop(true);
  }
}, 20_000);
