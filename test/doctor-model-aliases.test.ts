import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";

async function doctor(
  served: string[],
  inventoryFails = false,
  retired = false,
  invalidRouting: boolean | { file?: "routing.toml" | "routing.local.toml"; content?: string } = false,
) {
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
    for (const name of ["bun", "claude", "codex", "kimi", "jcode", "qwen", "agy", "pi", "dot"]) writeFileSync(join(root, "bin", name), '#!/bin/sh\ncase "$1" in --version) echo "fixture 1.0";; plugin) echo "[]";; esac\n', { mode: 0o755 });
    if (retired) appendFileSync(join(root, ".agenthub/routing.toml"), '[targets.old]\nid="coding"\n[routes."sy/old"]\ntype="passthrough"\ntarget="old"\n');
    if (invalidRouting) {
      const target = typeof invalidRouting === "object" && invalidRouting.file ? invalidRouting.file : "routing.toml";
      const content = typeof invalidRouting === "object" && invalidRouting.content ? invalidRouting.content : "[local";
      writeFileSync(join(root, ".agenthub", target), content);
    }
    const wrapper = join(root, "doctor.ts");
    const cli = join(import.meta.dir, "../src/cli/main.ts");
    writeFileSync(wrapper, `const original = fetch; globalThis.fetch = ((input, init) => String(input).startsWith("http://127.0.0.1:${gateway.port}/") ? original(input, init) : Promise.resolve(new Response("fixture unavailable", {status:503}))); await import(${JSON.stringify(cli)});`);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, AGENTHUB_HOME: join(root, "home"), AMEM_HOME: join(root, "mem"), PATH: `${join(root, "bin")}:${process.env.PATH}`, OMNIROUTE_API_KEY: "fixture" };
    for (const marker of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "AGENTHUB_DELIVERY_ONLY", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_OMNIROUTE_URL"]) delete env[marker];
    env.AGENTHUB_OMNIROUTE_URL = `http://127.0.0.1:${gateway.port}/v1`;
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


test("#553 doctor reports retired routing tables as Config findings and still inventories models", async () => {
  const rows = await doctor(aliases, false, true);
  const retired = rows.filter(row => row.name === "retired setting");
  expect(retired).toHaveLength(2);
  for (const table of ["[targets]", "[routes]"]) expect(retired).toContainEqual(expect.objectContaining({ level: "fail", section: "Config", detail: expect.stringContaining(table) }));
  expect(rows).toContainEqual(expect.objectContaining({ name: "routing models", level: "ok", section: "Models" }));
});


test("#553 invalid routing does not abort doctor model and memory probes", async () => {
  const rows = await doctor(aliases, false, false, true);
  expect(rows).toContainEqual(expect.objectContaining({ name: "routing models", section: "Models", level: "unknown" }));
  expect(rows).toContainEqual(expect.objectContaining({ name: "memory library", level: "ok", detail: expect.stringContaining("amem 0.18.0") }));
  expect(rows.some(row => row.name === "memory worker")).toBe(false);
  expect(rows.some(row => row.name === "catalog roles" && row.level === "fail")).toBe(false);
});

test("#563 malformed routing.toml adds a failing Config row naming the file and parse error without file contents, and Models says routing could not be read", async () => {
  const rows = await doctor(aliases, false, false, { file: "routing.toml", content: "# secret-routing-line\n[local\napi_key = super_secret_token\n" });
  const failing = rows.filter(row => row.name === "routing" && row.level === "fail");
  expect(failing).toHaveLength(1);
  expect(failing[0]!.section).toBe("Config");
  expect(failing[0]!.detail).toContain("routing.toml");
  expect(failing[0]!.detail).toContain("TOML Parse error");
  expect(failing[0]!.detail).not.toContain("secret-routing-line");
  expect(failing[0]!.detail).not.toContain("super_secret_token");

  const unquoted = await doctor(aliases, false, false, { file: "routing.toml", content: "secret_token = super_secret_routing_value\n" });
  const unquotedRow = unquoted.find(row => row.name === "routing" && row.level === "fail");
  expect(unquotedRow?.detail).toContain("routing.toml");
  expect(unquotedRow?.detail).toContain("TOML Parse error: Strings must be quoted");
  expect(unquotedRow?.detail).not.toContain("super_secret_routing_value");

  const modelsRow = rows.find(row => row.name === "routing models");
  expect(modelsRow).toEqual({
    section: "Models",
    level: "unknown",
    name: "routing models",
    detail: "routing could not be read",
  });
});

test("#563 malformed routing.local.toml names routing.local.toml and parse error without blaming gateway inventory, while valid routing output is unchanged", async () => {
  const rows = await doctor(aliases, false, false, { file: "routing.local.toml", content: "# secret-overlay-line\n[classes" });
  const failing = rows.filter(row => row.name === "routing" && row.level === "fail");
  expect(failing).toHaveLength(1);
  expect(failing[0]!.section).toBe("Config");
  expect(failing[0]!.detail).toContain("routing.local.toml");
  expect(failing[0]!.detail).toContain("TOML Parse error");
  expect(failing[0]!.detail).not.toContain("secret-overlay-line");
  expect(rows.find(row => row.name === "routing models")).toEqual({
    section: "Models",
    level: "unknown",
    name: "routing models",
    detail: "routing could not be read",
  });

  const valid = await doctor(aliases);
  expect(valid.some(row => row.name === "routing")).toBe(false);
});
