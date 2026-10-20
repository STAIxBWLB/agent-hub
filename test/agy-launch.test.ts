import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyTuiSpawnOptions, agyVersionGate, runAgyEntry } from "../src/adapters/agy/entry.ts";
import type { NativeCliEntryContext } from "../src/adapters/definitions/native-cli-entry-types.ts";
import { nativeLaunchEnv } from "../src/cli/launch.ts";

function context(root: string, args: string[], features = ["native_hook_launch"]) {
  const requests: Record<string, unknown>[] = [];
  const hub = { features, close() {}, async request(msg: Record<string, unknown>) {
    requests.push(msg);
    if (msg.t === "status") return { status: { roster: [{ peer: "agy", on: true }], pluginBundle: "/installed/plugins/agent-hub/server.js" } };
    return { ok: true, launchId: "launch-a", instanceId: "instance-a" };
  } };
  const ctx = { args, cwd: root, stateDir: join(root, "state"), cliDir: "/installed/src/cli", unattendedEnv: false,
    connect: async () => hub, fail(message: string): never { throw new Error(message); },
    helpers: { nativeLaunchEnv, childEnv: () => ({ ...process.env }) } } as unknown as NativeCliEntryContext;
  return { ctx, requests };
}

test("agy TUI launch stays in the foreground process group", () => {
  const options = agyTuiSpawnOptions("/project", { AGENTHUB_PEER_ID: "agy" });
  expect(options).toEqual({ cwd: "/project", env: { AGENTHUB_PEER_ID: "agy" }, stdio: "inherit" });
  expect(options).not.toHaveProperty("detached");
});

test("agy preview has no file or connection effects and refuses unverified modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-preview-"));
  try {
    const { ctx, requests } = context(root, ["--dry-run"]);
    await runAgyEntry(ctx); expect(requests).toEqual([]); expect(existsSync(join(root, ".agents"))).toBe(false);
    for (const args of [["--conversation", "id"], ["--print", "prompt"], ["--unattended"], ["--mode=auto"]]) await expect(runAgyEntry(context(root, args).ctx)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("person launcher fences old daemons, scrubs channel identity, and cleans its own plugin after exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-launch-")), bin = join(root, "bin"), trace = join(root, "trace");
  mkdirSync(bin); const fake = join(bin, "agy");
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.4.2\\n"; exit 0; fi\nprintf "%s\\n" "$AGENTHUB_PEER_ID" "${AGENTHUB_CHANNEL-unset}" > "$AGY_TEST_TRACE"\n'); chmodSync(fake, 0o700);
  const saved = { PATH: process.env.PATH, AGY_TEST_TRACE: process.env.AGY_TEST_TRACE, AGENTHUB_CHANNEL: process.env.AGENTHUB_CHANNEL };
  process.env.PATH = `${bin}:${saved.PATH}`; process.env.AGY_TEST_TRACE = trace; process.env.AGENTHUB_CHANNEL = "1";
  try {
    await expect(runAgyEntry(context(root, [], []).ctx)).rejects.toThrow("running hub lacks");
    expect(existsSync(join(root, ".agents"))).toBe(false);
    const { ctx, requests } = context(root, []); await runAgyEntry(ctx);
    expect(readFileSync(trace, "utf8")).toBe("agy\nunset\n");
    expect(requests.filter(msg => msg.t === "native_hook_launch").map(msg => msg.op)).toEqual(["begin", "end"]);
    for (const name of ["plugin.json", "mcp_config.json", "hooks.json"]) expect(existsSync(join(root, ".agents/plugins/agent-hub", name))).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("agy version gate accepts the 1.4.x line, warns off the verified 1.4.2 and refuses the rest (#589)", () => {
  expect(agyVersionGate("1.4.2\n")).toEqual({ ok: true });
  const patch = agyVersionGate("1.4.3\n");
  expect(patch.ok).toBe(true); expect(patch.message).toContain("agy 1.4.3");
  for (const out of ["1.5.0", "2.0.0", "1.4", "1.4.3-beta", "agy 1.4.2", ""]) expect(agyVersionGate(out).ok).toBe(false);
});

test("an off-line agy version is refused before any hub request or plugin write (#589)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-version-")), bin = join(root, "bin");
  mkdirSync(bin); const fake = join(bin, "agy");
  writeFileSync(fake, '#!/bin/sh\nprintf "1.5.0\\n"\n'); chmodSync(fake, 0o700);
  const savedPath = process.env.PATH; process.env.PATH = `${bin}:${savedPath}`;
  try {
    const { ctx, requests } = context(root, []);
    await expect(runAgyEntry(ctx)).rejects.toThrow("1.4.x line");
    expect(requests).toEqual([]); expect(existsSync(join(root, ".agents"))).toBe(false);
  } finally { process.env.PATH = savedPath; rmSync(root, { recursive: true, force: true }); }
});
