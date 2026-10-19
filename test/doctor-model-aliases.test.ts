import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";

async function doctor(served: string[], inventoryFails = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-doctor-alias-")));
  let inventories = 0;
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    if (inventoryFails && ++inventories > 1) return new Response("unavailable", { status: 503 });
    return Response.json({ data: served.map(id => ({ id })) });
  } });
  try {
    mkdirSync(join(root, ".agenthub")); mkdirSync(join(root, "bin"));
    writeFileSync(join(root, ".agenthub/config.json"), "{}");
    writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ memory: { enabled: false }, mlx: { enabled: false }, omniroute: { urls: [`http://127.0.0.1:${gateway.port}/v1`], access_hosts: [] } }));
    writeFileSync(join(root, ".agenthub/routing.toml"), '[local]\nfixed_model="base"\n[classes.implement]\npeers=["local"]\nfixed_model="class-only"\n[classes.test]\npeers=["local"]\nfixed_model="base"\n[hub_routes."hub/default"]\ntype="stage"\n[hub_routes."hub/custom"]\ntype="escalation"\nefficient="efficient"\ncapable="capable"\njudge="judge"\n');
    for (const name of ["bun", "claude", "codex", "kimi", "jcode", "qwen", "agy", "pi", "dot", "switchyard-server"]) writeFileSync(join(root, "bin", name), '#!/bin/sh\ncase "$1" in --version) echo "fixture 1.0";; plugin) echo "[]";; esac\n', { mode: 0o755 });
    const wrapper = join(root, "doctor.ts");
    const cli = join(import.meta.dir, "../src/cli/main.ts");
    writeFileSync(wrapper, `const original = fetch; globalThis.fetch = ((input, init) => String(input).startsWith("http://127.0.0.1:${gateway.port}/") ? original(input, init) : Promise.resolve(new Response("fixture unavailable", {status:503}))); await import(${JSON.stringify(cli)});`);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, AGENTHUB_HOME: join(root, "home"), AMEM_HOME: join(root, "mem"), PATH: `${join(root, "bin")}:${process.env.PATH}`, OMNIROUTE_API_KEY: "fixture" };
    for (const marker of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "AGENTHUB_DELIVERY_ONLY", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_OMNIROUTE_URL"]) delete env[marker];
    const child = Bun.spawn([process.execPath, wrapper, "doctor", "--json"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout) as { name: string; level: string; section: string; detail: string }[];
  } finally { gateway.stop(true); rmSync(root, { recursive: true, force: true }); }
}
const aliases = ["base", "class-only", "fast", "coding", "efficient", "capable", "judge"];

test("#553 doctor inventories class-only, default tiers and explicit judges once per missing alias", async () => {
  const rows = await doctor(["base", "fast", "efficient", "capable"]);
  const missing = rows.filter(row => row.name === "routing model" && row.level === "fail");
  expect(missing.map(row => row.detail.split(" ")[0]).sort()).toEqual(["class-only", "coding", "judge"]);
  expect(missing.every(row => row.section === "Models")).toBe(true);
  expect(rows.some(row => row.name === "switchyard")).toBe(false);
});

test("#553 doctor reports aggregate success only when all routing aliases are served", async () => {
  const rows = await doctor(aliases);
  expect(rows.filter(row => row.name === "routing models")).toEqual([expect.objectContaining({ level: "ok", section: "Models" })]);
  expect(rows.some(row => row.name === "routing model" && row.level === "fail")).toBe(false);
});

test("#553 unavailable gateway inventory is unknown rather than alias success", async () => {
  const rows = await doctor(aliases, true);
  expect(rows.filter(row => row.name === "routing models")).toEqual([expect.objectContaining({ level: "unknown", section: "Models" })]);
});
