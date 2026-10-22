import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JcodePeer, jcodeCommand } from "../src/adapters/jcode.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

// issue #685: extra builtin Jcode peers own separate native homes, private servers, sockets and ids.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-jcode-inst-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const fake = [process.execPath, join(import.meta.dir, "fakes/jcode-instance-agent.ts")];
const until = async (condition: () => boolean) => { for (let i = 0; i < 300 && !condition(); i++) await Bun.sleep(10); expect(condition()).toBe(true); };
const home = (dir: string, name: string) => { const path = join(dir, name); mkdirSync(path); writeFileSync(join(path, "mcp.json"), "{}"); return path; };
const rows = (file: string) => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
const launch = (file: string, role: "serve" | "acp") => rows(file).find(row => row.kind === "launch" && row.role === role);

test("two Jcode peers own separate serve groups, sockets and homes; stopping one leaves the other running (#685)", async () => {
  const dir = root(), baseRecord = join(dir, "base.jsonl"), extraRecord = join(dir, "extra.jsonl");
  const base = new JcodePeer({ command: [...fake, "--record", baseRecord], cwd: dir, home: home(dir, "home-base") });
  const extra = new JcodePeer({ peer: "jcode-local", command: [...fake, "--record", extraRecord], cwd: dir, home: home(dir, "home-extra") });
  cleanups.push(() => base.stop(), () => extra.stop());
  await Promise.all([base.start(), extra.start()]);
  expect(base.id).toBe("jcode"); expect(extra.id).toBe("jcode-local");
  const baseServer = rows(baseRecord).find(row => row.kind === "serve"), extraServer = rows(extraRecord).find(row => row.kind === "serve");
  expect(baseServer.socket).not.toBe(extraServer.socket); expect(baseServer.pid).not.toBe(extraServer.pid);
  expect(baseServer.home).toBe(join(dir, "home-base")); expect(extraServer.home).toBe(join(dir, "home-extra"));
  expect(existsSync(baseServer.socket) && existsSync(extraServer.socket)).toBe(true);
  // Each peer's owned processes act for their own id, never the other's.
  expect(launch(extraRecord, "serve").peer).toBe("jcode-local"); expect(launch(extraRecord, "acp").peer).toBe("jcode-local");
  expect(launch(baseRecord, "serve").peer).toBe("jcode"); expect(launch(baseRecord, "acp").peer).toBe("jcode");
  const replies: string[] = []; extra.onMessage = message => { replies.push(message); };
  await extra.deliver([newEnvelope("user", "work for the extra instance", { to: ["jcode-local"] })]); await until(() => replies.length > 0);
  expect(rows(extraRecord).filter(row => row.kind === "rpc").every(row => row.home === join(dir, "home-extra"))).toBe(true);
  await extra.stop();
  expect(existsSync(extraServer.socket)).toBe(false); expect(() => process.kill(extraServer.pid, 0)).toThrow();
  // The base peer's server, socket and ACP client are untouched.
  expect(existsSync(baseServer.socket)).toBe(true); expect(() => process.kill(baseServer.pid, 0)).not.toThrow();
  expect(base.state).not.toBe("offline");
  await base.stop(); expect(existsSync(baseServer.socket)).toBe(false);
});

test("an instance's launch metadata and server name name the instance, so recovery never resumes it as the base Jcode (#685)", () => {
  const dir = root();
  const extra = new JcodePeer({ peer: "jcode-local", command: ["jcode"], cwd: dir, home: join(dir, "h"), launchModel: "dgx/fast" });
  cleanups.push(() => extra.stop());
  expect(extra.recoveryMetadata().launch).toMatchObject({ kind: "jcode", peer: "jcode-local", mode: "headless", model: "dgx/fast" });
  expect(jcodeCommand(["jcode"], "serve", "/s/j.sock", dir, undefined, undefined, undefined, "jcode-local")).toContain("agent-hub-jcode-local");
  expect(jcodeCommand(["jcode"], "serve", "/s/j.sock", dir)).toContain("agent-hub-jcode");
  expect(jcodeCommand(["jcode"], "serve", "/s/j.sock", dir)).not.toContain("agent-hub-jcode-local");
});

test("a provider and a relay change only the instance's own native arguments and environment, and the gateway key never reaches it (#685)", async () => {
  const dir = root(), record = join(dir, "r.jsonl");
  expect(jcodeCommand(["jcode"], "acp", "/s/j.sock", dir, "dgx/fast", undefined, "openai-compatible")).toEqual(expect.arrayContaining(["-p", "openai-compatible", "--model", "dgx/fast"]));
  expect(jcodeCommand(["jcode"], "acp", "/s/j.sock", dir)).not.toContain("-p");
  const priorKey = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "gateway-secret-never-forwarded";
  cleanups.push(() => { if (priorKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = priorKey; });
  const peer = new JcodePeer({ peer: "jcode-local", command: [...fake, "--record", record], cwd: dir, home: home(dir, "h"), provider: "openai-compatible", launchModel: "dgx/fast", relay: { url: "http://127.0.0.1:9/v1", token: "per-launch-token" } });
  cleanups.push(() => peer.stop());
  await peer.start();
  for (const role of ["serve", "acp"] as const) {
    const row = launch(record, role);
    expect(row.compatBase).toBe("http://127.0.0.1:9/v1"); expect(row.compatKey).toBe("per-launch-token");
    expect(row.argv).toEqual(expect.arrayContaining(["-p", "openai-compatible", "--model", "dgx/fast"]));
    expect(row.gatewayKey).toBeUndefined();
  }
  // Without a relay no compatibility variable is set at all.
  const plain = new JcodePeer({ command: [...fake, "--record", join(dir, "p.jsonl")], cwd: dir, home: home(dir, "h2") }); cleanups.push(() => plain.stop());
  await plain.start();
  for (const role of ["serve", "acp"] as const) { const row = launch(join(dir, "p.jsonl"), role); expect(row.compatBase).toBeUndefined(); expect(row.compatKey).toBeUndefined(); }
});

// ahub jcode --as <id> (#685): the launcher names the instance in every hub request, and starts it headless by default.
import { runJcodeEntry } from "../src/adapters/definitions/native-cli-entry-jcode.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { startModeOf } from "../src/hub/start-mode.ts";
import type { NativeCliEntryContext } from "../src/adapters/definitions/native-cli-entry-types.ts";

function launcher(instance: string | undefined, args: string[] = []) {
  const requests: Record<string, unknown>[] = [];
  let configured = 0;
  const context = {
    person: true, args, cwd: "/project", stateDir: "/state", cliDir: "/package/src/cli", unattendedEnv: false, ...(instance ? { instance } : {}),
    definition: definitionOf("jcode"), projectConfig: () => ({}),
    fail: (message: string): never => { throw new Error(message); },
    connect: async () => ({ features: ["native_tui_launch"], request: async (message: Record<string, unknown>) => {
      requests.push(message);
      return message.t === "status" ? { status: { roster: [{ peer: "jcode", on: true }, { peer: "jcode-local", on: true }] } } : { ok: true };
    }, close() {} }),
    takeFlags: (argv: string[]) => ({ one: Object.fromEntries(argv.reduce<string[][]>((pairs, value, index) => index % 2 ? pairs : [...pairs, [value, argv[index + 1]!]], [])), rest: [], many: {} }),
    execWithEnv: (): never => { throw new Error("headless must not open a terminal"); },
    helpers: { startModeOf, readControl: () => undefined, qwenSessionId: () => true, configureJcodeMcp: () => { configured++; return { changed: false, tracked: false }; } },
  } as unknown as NativeCliEntryContext;
  return { context, requests, configured: () => configured };
}

test("ahub jcode --as <id> starts that instance headless by default and names it in the roster check and the start request (#685)", async () => {
  const f = launcher("jcode-local");
  await runJcodeEntry(f.context);
  expect(f.requests.find(row => row.t === "start")).toMatchObject({ peer: "jcode-local", args: { mode: "headless" } });
  expect(f.requests.some(row => row.t === "start" && row.peer === "jcode")).toBe(false);
});

test("ahub jcode --as <id> refuses an instance that is off roster, naming the instance (#685)", async () => {
  const f = launcher("jcode-missing");
  await expect(runJcodeEntry(f.context)).rejects.toThrow(/jcode-missing/);
  expect(f.requests.some(row => row.t === "start")).toBe(false);
});

test("the base ahub jcode still names jcode (#685)", async () => {
  const f = launcher(undefined, ["--mode", "headless"]);
  await runJcodeEntry(f.context);
  expect(f.requests.find(row => row.t === "start")).toMatchObject({ peer: "jcode" });
});

// Doctor (#685): one MCP inventory per rostered instance home, named for the instance, optional like the base Jcode's checks.
import { nativeDoctorCheck, nativeDoctorOptionalProbes } from "../src/adapters/definitions/native-cli-doctor.ts";

test("doctor inventories the MCP servers of each rostered Jcode instance's own home, named for it (#685)", () => {
  const base = { jcode_cmd: ["jcode"], qwen_cmd: ["qwen"], jcode_home: "/h/base" };
  const instances = { "jcode-local": { kind: "jcode", jcode_home: "/h/local", model_relay: "dgx/fast" as const }, "jcode-off": { kind: "jcode", jcode_home: "/h/off" } };
  const probes = nativeDoctorOptionalProbes({ roster: { jcode: true, "jcode-local": true, "jcode-off": false }, instances, ...base });
  expect(probes.filter(probe => probe.kind === "jcode-mcp")).toEqual([
    { kind: "jcode-mcp", name: "jcode MCP servers", home: "/h/base" },
    { kind: "jcode-mcp", name: "jcode-local MCP servers", home: "/h/local" },
  ]);
  // Nothing about an instance's relay, token or URL is in a probe.
  expect(JSON.stringify(probes)).not.toMatch(/dgx|relay|token/);
  expect(nativeDoctorOptionalProbes({ roster: { jcode: true }, ...base }).filter(probe => probe.kind === "jcode-mcp")).toHaveLength(1);
});

test("a Jcode instance's MCP doctor row has the same severity as the base Jcode's, and its tool row is optional (#685)", () => {
  // The base row's severity is existing behavior (a Hub check): the instance row neither softens nor hardens it.
  expect(nativeDoctorCheck(false, "jcode-local MCP servers", "2 extra").level).toBe(nativeDoctorCheck(false, "jcode MCP servers", "2 extra").level);
  expect(nativeDoctorCheck(false, "jcode-local MCP servers", "2 extra").section).toBe(nativeDoctorCheck(false, "jcode MCP servers", "2 extra").section);
});
