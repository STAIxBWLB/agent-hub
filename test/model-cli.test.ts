import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { parseModelCommand, projectModelStatus } from "../src/cli/model.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { paint } from "../src/cli/console-state.ts";
import { renderRuntimeModels, renderStatus } from "../src/cli/output.ts";

const row = { peer: "codex", effectiveModel: "old", source: "override" as const, desiredModel: "new", pendingNextTurn: true };
test("model parser keeps all commands person-only, bounded and distinct from plural models", () => {
  for (const args of [["list"], ["list", "--json"], ["set", "codex", "vendor/model:v1"], ["clear", "codex"]]) {
    expect(classifyPeerCommand("model", args)).toBe("console");
    expect(liveTestRefusal("model", args)).toBe(true);
    expect(cliCommandLabel("model", args)).toBe("model " + args[0]);
    expect(() => parseModelCommand(args)).not.toThrow();
  }
  expect(classifyPeerCommand("models", ["status"])).toBe("allowed");
  for (const args of [[], ["list", "--json", "--json"], ["clear", "codex", "extra"], ["set", "codex", "-model"], ["set", "codex", "a b"], ["set", "codex", "a".repeat(129)]]) expect(() => parseModelCommand(args)).toThrow("usage:");
});
test("model display distinguishes effective from next turn, keeps closed sources and ignores extra reply prose", () => {
  const projected = projectModelStatus({ ...row, body: "secret", token: "secret", unsupported: { reasonCode: "unverified_setter", kind: "qwen", reason: "secret", nextStep: "secret" } });
  expect(projected?.unsupported?.nextStep).toContain("ahub restart codex");
  expect(projected?.unsupported?.reason).toBe("unsupported live: qwen (version unverified) has no verified model setter");
  expect(projected?.unsupported?.nextStep).not.toContain("selected model");
  expect(JSON.stringify(projected)).not.toContain("secret");
  expect(projectModelStatus({ ...row, unsupported: { reasonCode: "unmanaged_attachment" } })?.unsupported?.reason).toContain("this attachment has no verified live model setter");
  for (const unsupported of [{ reason: "secret" }, { reasonCode: "secret" }, { reasonCode: "unverified_setter", kind: "secret text" }]) expect(projectModelStatus({ ...row, unsupported })).toBeNull();
  expect(projectModelStatus({ ...row, source: "secret" })).toBeNull();
  const sticky = projectModelStatus({ ...row, desiredModel: null, pendingNextTurn: false, source: "native thread default (was override)" });
  expect(sticky?.source).toBe("native thread default (was override)");
  expect(renderRuntimeModels([sticky!]).map(line => paint(line, false)).join("\n")).toContain("native thread default (was override)");
  const hostile = Object.defineProperty({}, "peer", { get() { throw new Error("must not invoke reply getters"); } });
  expect(projectModelStatus(hostile)).toBeNull();
  expect(projectModelStatus(Object.create(row))).toBeNull();
  const text = renderRuntimeModels([row]).map(line => paint(line, false)).join("\n");
  expect(text).toContain("old"); expect(text).toContain("pending next turn"); expect(text).toContain("next turn new"); expect(text).toContain("active turn is unchanged");
  expect(renderStatus({ peers: {}, runtimeModels: [row], models: { backends: [] } }).map(line => paint(line, false)).join("\n")).toContain("pending next turn");
});

test("ACP unsupported model projection names only a validated kind and exact native version", () => {
  const cause = { reasonCode: "acp_setter_unavailable", kind: "qwen", version: "0.26.9", reason: "forged native reason", nextStep: "forged native action" };
  const projected = projectModelStatus({ ...row, unsupported: cause });
  expect(projected?.unsupported).toEqual({ reasonCode: "acp_setter_unavailable", kind: "qwen", version: "0.26.9", reason: "unsupported live: qwen 0.26.9 lacks a setter receipt or compat admission", nextStep: "restart this peer with ahub restart codex" });
  expect(JSON.stringify(projected)).not.toContain("forged native");
  const text = renderRuntimeModels([projected!]).map(line => paint(line, false)).join("\n");
  expect(text).toContain("qwen 0.26.9 lacks a setter receipt or compat admission"); expect(text).toContain("ahub restart codex");
  const unknown = projectModelStatus({ ...row, unsupported: { reasonCode: "acp_setter_unavailable", kind: "jcode" } });
  expect(unknown?.unsupported?.reason).toBe("unsupported live: jcode unknown lacks a setter receipt or compat admission");
  expect(unknown?.unsupported).not.toHaveProperty("version");
  for (const version of ["0.26.9\n", "qwen 0.26.9", "0.26.9; restart all", "01.2.3", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-rc.1", "a".repeat(129), { toString: () => "0.26.9" }]) expect(projectModelStatus({ ...row, unsupported: { ...cause, version } })).toBeNull();
  for (const kind of [undefined, "qwen\n", "qwen prose"]) expect(projectModelStatus({ ...row, unsupported: { ...cause, kind } })).toBeNull();
  const accessor = Object.defineProperty({ reasonCode: "acp_setter_unavailable", kind: "qwen" }, "version", { get() { throw new Error("native getter must not execute"); } });
  expect(projectModelStatus({ ...row, unsupported: accessor })).toBeNull();
});

test("status names catalog overflow rather than rendering an empty model success", () => {
  const output = renderStatus({ peers: { codex: { state: "idle", queued: 0 } }, runtimeModels: [row], runtimeModelsUnavailable: true, models: { backends: [] } });
  const text = output.map(line => paint(line, false)).join("\n");
  expect(text).toContain("Runtime models unavailable: could not read a bounded model catalog");
  expect(text).toContain("run ahub model list for the cause");
  expect(text).toContain("ahub model set <peer> <model>"); expect(text).toContain("ahub model clear <peer>");
  expect(text).not.toContain("EFFECTIVE MODEL"); expect(text).toContain("codex"); expect(text).toContain("idle");
  expect(output.flat().some(cell => cell.tone === "attention" && cell.text.includes("Runtime models unavailable"))).toBe(true);
});

test("actual CLI defaults to sentences/table, JSON is explicit, mutations retain next-turn wording and agent calls have no model effects", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-model-cli-"))), state = join(root, ".agenthub/state"), requests: Record<string, unknown>[] = [];
  let supportsModels = true, responseRows = [row];
  mkdirSync(state, { recursive: true }); mkdirSync(join(root, "home"));
  writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("unexpected"); }, websocket: { message(ws, raw) {
    const request = JSON.parse(String(raw));
    if (request.t === "hello") ws.send(JSON.stringify({ t: "welcome", rid: request.rid, ok: true, cwd: root, projectId: "fixture", instanceId: "fixture", protocol: PROTOCOL, features: supportsModels ? ["model_overrides"] : [] }));
    else { requests.push(request); ws.send(JSON.stringify({ rid: request.rid, ok: true, models: responseRows, model: row, appliesFrom: "next_turn" })); }
  } } });
  writeFileSync(join(state, "control-token"), "fixture-token");
  writeFileSync(join(state, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL, projectId: "fixture", instanceId: "fixture", pid: process.pid, pidSignature: processSignature(process.pid) }));
  const cli = async (args: string[], agent = false) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: root, env: { HOME: join(root, "home"), AGENTHUB_HOME: join(root, "home/hub"), AMEM_HOME: join(root, "home/amem"), PATH: process.env.PATH, ...(agent ? { AGENTHUB_PEER_ID: "codex" } : {}) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; } finally { clearTimeout(timer); }
  };
  try {
    const human = await cli(["model", "list"]); expect(human.code, human.stderr).toBe(0); expect(human.stdout).toContain("EFFECTIVE MODEL"); expect(human.stdout).not.toMatch(/^\s*\{/);
    const json = await cli(["model", "list", "--json"]); expect(json.code, json.stderr).toBe(0); expect(JSON.parse(json.stdout)).toEqual({ models: [row] });
    const mutation = await cli(["model", "set", "codex", "new"]); expect(mutation.code, mutation.stderr).toBe(0); expect(mutation.stdout).toContain("active turn is unchanged");
    supportsModels = false;
    const beforeOlder = requests.length, older = await cli(["model", "list"]);
    expect(older.code).toBe(1); expect(older.stderr).toContain("running hub lacks model_overrides support"); expect(older.stderr).toContain("upgrade and restart the hub");
    expect(requests.slice(beforeOlder).some(request => request.t === "model")).toBe(false);
    supportsModels = true;
    const before = requests.length;
    for (const prefix of [[], ["--live-test"]]) for (const form of [["list"], ["set", "codex", "new"], ["clear", "codex"]]) { const result = await cli([...prefix, "model", ...form], true); expect(result.code).toBe(1); }
    expect(requests.filter(request => request.t === "model")).toHaveLength(3);
    expect(requests.slice(before).some(request => request.t === "model")).toBe(false);
    responseRows = Array.from({ length: 129 }, (_, index) => ({ ...row, peer: `peer-${index}` }));
    const large = await cli(["model", "list", "--json"]); expect(large.code, large.stderr).toBe(0);
    expect(JSON.parse(large.stdout).models).toEqual(responseRows);
    responseRows = Array.from({ length: 257 }, (_, index) => ({ ...row, peer: `peer-${index}` }));
    const complete = await cli(["model", "list", "--json"]); expect(complete.code, complete.stderr).toBe(0);
    expect(JSON.parse(complete.stdout).models).toEqual(responseRows);
    responseRows = Array.from({ length: 513 }, (_, index) => ({ ...row, peer: `peer-${index}` }));
    const oversized = await cli(["model", "list", "--json"]); expect(oversized.code).toBe(1);
    expect(oversized.stderr).toContain("model reply is not a supported bounded row list"); expect(oversized.stderr).toContain("upgrade and restart the hub"); expect(oversized.stdout).toBe("");
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
