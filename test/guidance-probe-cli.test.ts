import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { USER } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { guidanceProbeStatusLines } from "../src/ui/guidance-view.ts";
import type { ProbeReceiptExport } from "../src/hub/guidance-probes.ts";
import { probeTasksFixture, runProbeExperiment } from "./helpers/guidance-probe-tasks.ts";

// #1226 T4: `ahub guidance probe receipts` as a REAL CLI process against a scripted loopback hub that serves a REAL export from the real Tasks + Store.
// No model, worker, native session or account is used.
const marker = "PRIVATE-PROBE-CLI-MARKER";
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
async function realExport(): Promise<ProbeReceiptExport> {
  const f = await probeTasksFixture(clean), run = await runProbeExperiment(f);
  return f.tasks.guidanceProbeReceipts(USER, run.id);
}

async function cliFixture(run: (f: { cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>; requests: Record<string, any>[]; support(features: string[]): void; reply(value: Record<string, unknown>): void }) => Promise<void>) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-probe-cli-"))), home = join(root, "home"), state = join(root, ".agenthub/state");
  mkdirSync(home); mkdirSync(state, { recursive: true }); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const requests: Record<string, any>[] = []; let features = ["guidance_probes", "guidance_probe_receipts"], reply: Record<string, unknown> = { ok: false, error: "no export scripted" };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { return server.upgrade(req) ? undefined : new Response("fixture"); }, websocket: { message(ws, raw) {
    const row = JSON.parse(String(raw));
    if (row.t === "hello") { ws.send(JSON.stringify({ t: "welcome", rid: row.rid, ok: true, cwd: root, protocol: PROTOCOL, projectId: "fixture", instanceId: "fixture", features })); return; }
    requests.push(row); ws.send(JSON.stringify({ rid: row.rid, ...reply }));
  } } });
  writeFileSync(join(state, "control-token"), "fixture-token");
  writeFileSync(join(state, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL, projectId: "fixture", instanceId: "fixture", pid: process.pid, features }));
  const cli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: root,
      env: { HOME: home, AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "amem"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), TMPDIR: root, PATH: process.env.PATH ?? "" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); await child.exited; }
  };
  try { await run({ cli, requests, support: value => { features = value; writeFileSync(join(state, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL, projectId: "fixture", instanceId: "fixture", pid: process.pid, features })); }, reply: value => { reply = value; } }); }
  finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}

test("the real CLI prints the shared text by default and the verified export as JSON only with --json", async () => {
  const exported = await realExport(), id = exported.status.id;
  await cliFixture(async f => {
    f.reply({ ok: true, receipts: exported });
    const human = await f.cli(["guidance", "probe", "receipts", "--id", id]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout.trim().startsWith("{")).toBe(false);
    expect(human.stdout).toContain("Fixture evidence only"); expect(human.stdout).toContain("2 succeeded");
    for (const line of guidanceProbeStatusLines(exported)) expect(human.stdout).toContain(line);
    const json = await f.cli(["guidance", "probe", "receipts", "--id", id, "--json"]);
    expect(json.code, json.stderr).toBe(0); expect(JSON.parse(json.stdout)).toEqual(exported);
    expect(f.requests.every(row => row.t === "guidance_probe_receipts" && row.id === id && Object.keys(row).sort().join() === "id,rid,t")).toBe(true);
  });
}, 60_000);

test("an older hub, a malformed id and an unexpected option are refused before any request is sent", async () => {
  const exported = await realExport(), id = exported.status.id;
  await cliFixture(async f => {
    f.reply({ ok: true, receipts: exported });
    f.support(["guidance_probes"]);
    const old = await f.cli(["guidance", "probe", "receipts", "--id", id]);
    expect(old.code).toBe(1); expect(old.stderr).toContain("guidance_probe_receipts"); expect(old.stderr).toContain("upgrade"); expect(old.stdout).toBe("");
    f.support(["guidance_probes", "guidance_probe_receipts"]);
    for (const args of [["guidance", "probe", "receipts"], ["guidance", "probe", "receipts", "--id", "short"], ["guidance", "probe", "receipts", "--id", id, "--revision", "1"]]) {
      const refused = await f.cli(args); expect(refused.code, args.join(" ")).toBe(1); expect(refused.stdout).toBe("");
    }
    expect(f.requests).toEqual([]);
  });
}, 60_000);

test("a tampered or foreign export, and a refusal carrying hostile text, print nothing of it and exit non-zero", async () => {
  const exported = await realExport(), id = exported.status.id;
  const tampered = JSON.parse(JSON.stringify(exported)); tampered.slots[0].receipt.state = "failed";
  await cliFixture(async f => {
    for (const receipts of [tampered, { ...exported, privateBody: marker }, null]) {
      f.reply({ ok: true, receipts });
      const result = await f.cli(["guidance", "probe", "receipts", "--id", id, "--json"]);
      expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("digest check"); expect(result.stderr).not.toContain(marker);
    }
    f.reply({ ok: false, error: `fixed refusal${marker}\nforged line` });
    const refused = await f.cli(["guidance", "probe", "receipts", "--id", id]);
    // The refusal text goes through the same bounded one-line path as every probe refusal: a newline cannot forge a line of its own, and the failure exits 1 with
    // nothing on stdout. (That path's terminalText keeps printable Unicode such as a bidi override by design; it is the existing helper's policy, not this change's.)
    expect(refused.code).toBe(1); expect(refused.stdout).toBe("");
    expect(refused.stderr.split("\n").filter(line => line.startsWith("forged line"))).toEqual([]);
    expect(refused.stderr.trim().split("\n")).toHaveLength(1);
  });
}, 60_000);

// The text this change owns is built by `guidanceProbeStatusLines`, which strips control AND format characters (its own test is in guidance-probe-status.test.ts);
// here the real process prints exactly those lines, so a format character in an untrusted label cannot reach the terminal through the receipts command.
test("an untrusted label with a bidi override reaches the terminal without it", async () => {
  const exported = await realExport(), id = exported.status.id;
  const hostile = { ...exported, status: { ...exported.status, experimentId: "label\u202eevil\u2066" } };
  await cliFixture(async f => {
    f.reply({ ok: true, receipts: hostile });
    const human = await f.cli(["guidance", "probe", "receipts", "--id", id]);
    expect(human.code, human.stderr).toBe(0); expect(human.stdout).not.toMatch(/[\u202e\u2066]/); expect(human.stdout).toContain("labelevil");
  });
}, 60_000);
