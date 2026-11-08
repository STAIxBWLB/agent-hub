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
  const hostile = Object.defineProperty({}, "peer", { get() { throw new Error("must not invoke reply getters"); } });
  expect(projectModelStatus(hostile)).toBeNull();
  expect(projectModelStatus(Object.create(row))).toBeNull();
  const text = renderRuntimeModels([row]).map(line => paint(line, false)).join("\n");
  expect(text).toContain("old"); expect(text).toContain("pending next turn"); expect(text).toContain("next turn new"); expect(text).toContain("active turn is unchanged");
  expect(renderStatus({ peers: {}, runtimeModels: [row], models: { backends: [] } }).map(line => paint(line, false)).join("\n")).toContain("pending next turn");
});

test("actual CLI defaults to sentences/table, JSON is explicit, mutations retain next-turn wording and agent calls have no model effects", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-model-cli-"))), state = join(root, ".agenthub/state"), requests: Record<string, unknown>[] = [];
  mkdirSync(state, { recursive: true }); mkdirSync(join(root, "home"));
  writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("unexpected"); }, websocket: { message(ws, raw) {
    const request = JSON.parse(String(raw));
    if (request.t === "hello") ws.send(JSON.stringify({ t: "welcome", rid: request.rid, ok: true, cwd: root, projectId: "fixture", instanceId: "fixture", protocol: PROTOCOL, features: [] }));
    else { requests.push(request); ws.send(JSON.stringify({ rid: request.rid, ok: true, models: [row], model: row, appliesFrom: "next_turn" })); }
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
    const before = requests.length;
    for (const prefix of [[], ["--live-test"]]) for (const form of [["list"], ["set", "codex", "new"], ["clear", "codex"]]) { const result = await cli([...prefix, "model", ...form], true); expect(result.code).toBe(1); }
    expect(requests.filter(request => request.t === "model")).toHaveLength(3);
    expect(requests.slice(before).some(request => request.t === "model")).toBe(false);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
