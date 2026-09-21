import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopMlx } from "../src/models/mlx.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function cli(project: string, home: string, args: string[]) {
  const result = spawnSync(process.execPath, [join(import.meta.dir, "..", "src/cli/main.ts"), "--project", project, ...args], {
    cwd: project, env: { ...process.env, AGENTHUB_HOME: home }, encoding: "utf8", timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `ahub failed: ${args.join(" ")}`);
  return result.stdout.trim();
}

test("models CLI uses the project MLX runtime configuration for start/status/stop", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-models-project-")));
  const home = mkdtempSync(join(tmpdir(), "agenthub-models-home-"));
  const runtimeDir = join(project, "custom-runtime");
  const modelPath = join(project, "custom-model");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const port = probe.port!; probe.stop(true);
  cleanup.push(async () => { await stopMlx({ runtimeDir, modelPath, port }); rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const binDir = join(runtimeDir, "bin");
  mkdirSync(join(project, ".agenthub"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(modelPath, { recursive: true });
  writeFileSync(join(project, ".agenthub", "config.json"), JSON.stringify({ mlx: { provider: "legacy", runtimeDir: "custom-runtime", modelPath: "custom-model", port, maxInputTokens: 12000, maxTokens: 1024 } }));
  const fake = join(binDir, "mlx_lm.server");
  writeFileSync(fake, `#!/usr/bin/env bun
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
Bun.serve({ hostname: "127.0.0.1", port, fetch(req) { return new URL(req.url).pathname === "/models" ? Response.json({ data: [] }) : new Response("ok"); } });
await new Promise(() => {});
`);
  chmodSync(fake, 0o755);

  const started = JSON.parse(cli(project, home, ["models", "start"]));
  expect(started.state).toBe("ready");
  expect(started.url).toBe(`http://127.0.0.1:${port}/v1`);
  expect(started.model).toBe(modelPath);
  expect(started.pid).toBeGreaterThan(0);

  const status = JSON.parse(cli(project, home, ["models", "status"]));
  expect(status).toMatchObject({ state: "ready", url: `http://127.0.0.1:${port}/v1`, model: modelPath, pid: started.pid });
  cli(project, home, ["models", "stop"]);
  for (let i = 0; i < 50; i++) {
    try { process.kill(started.pid, 0); } catch { return; }
    await Bun.sleep(20);
  }
  throw new Error("configured MLX process did not stop");
});

test("Ollama CLI uses an external model and refuses shared-service shutdown", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-ollama-cli-")));
  const home = mkdtempSync(join(tmpdir(), "agenthub-ollama-home-"));
  const model = "agenthub-fast-mlx:4b-8k";
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    calls.push(path);
    if (path === "/api/tags") return Response.json({ models: [{ name: model }] });
    if (path === "/api/ps") return Response.json({ models: [] });
    if (path === "/api/show") return Response.json({ parameters: "num_ctx 8192\nnum_predict 2048\n" });
    return new Response("unexpected", { status: 500 });
  } });
  cleanup.push(async () => { server.stop(true); rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(project, ".agenthub"));
  writeFileSync(join(project, ".agenthub/config.json"), JSON.stringify({ mlx: { provider: "ollama", port: server.port, model } }));
  const run = async (action: string) => {
    const process_ = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", project, "models", action], {
      cwd: project, env: { ...process.env, AGENTHUB_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(process_.stdout).text(), new Response(process_.stderr).text(), process_.exited]);
    return { stdout, stderr, code };
  };
  for (const action of ["status", "start"]) {
    const result = await run(action);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ provider: "ollama", model, modelAvailable: true, modelResident: false });
    expect(JSON.parse(result.stdout).pid).toBeUndefined();
  }
  const stopped = await run("stop");
  expect(stopped.code).not.toBe(0);
  expect(stopped.stderr).toContain("externally managed");
  expect(calls.every(path => ["/api/tags", "/api/ps", "/api/show"].includes(path))).toBe(true);
});
