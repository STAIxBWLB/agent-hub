import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLineageCommand, renderExecutionLineage, validateLineageReply, validateLineageLink } from "../src/cli/lineage.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { processSignature } from "../src/pi/process-signature.ts";

const task = { v: 1 as const, tool: "ahub" as const, projectKey: "fixture-project", kind: "task", id: "7" };
const attempt = { ...task, kind: "attempt", id: "ra-0123456789ab" };
const external = { v: 1 as const, tool: "ares" as const, projectKey: "outside-project", kind: "output", id: "opaque-output", revision: "r1", sha256: "a".repeat(64) };
const page = { state: "available" as const, nodes: [{ ref: task, state: "in_progress", strength: "host-observed" as const }, { ref: attempt, state: "failed", strength: "runner-attested" as const }],
  edges: [{ from: task, to: attempt, relation: "attempted" as const, strength: "host-observed" as const }], truncated: false };

test("lineage CLI parses source-owned selectors, opaque refs and complete task/revision link bindings", () => {
  expect(parseLineageCommand(["show", "--task", "7"])).toEqual({ op: "show", json: false, taskId: 7 });
  expect(parseLineageCommand(["show", "--attempt", attempt.id])).toEqual({ op: "show", json: false, attemptId: attempt.id });
  expect(parseLineageCommand(["show", "--root", JSON.stringify(task), "--task-scope", "7", "--task-created", "100", "--nodes", "2", "--edges", "1", "--bytes", "4096", "--cursor", "opaque_cursor", "--json"]))
    .toEqual({ op: "show", json: true, root: task, task: { id: 7, created: 100 }, nodes: 2, edges: 1, bytes: 4096, cursor: "opaque_cursor" });
  expect(parseLineageCommand(["link", "--task", "7", "--task-created", "100", "--revision", "0", "--ref", JSON.stringify(external), "--from", JSON.stringify(attempt), "--json"]))
    .toEqual({ op: "link", json: true, taskId: 7, taskCreated: 100, flowRevision: 0, reference: external, from: attempt });
  for (const args of [[], ["show"], ["show", "--task", "7", "--attempt", attempt.id], ["show", "--task", "7", "--task-created", "100"],
    ["show", "--root", JSON.stringify(task), "--task-scope", "7"], ["show", "--attempt", "ra-wrong"], ["show", "--task", "7", "--nodes", "101"],
    ["show", "--task", "7", "--bytes", "4095"], ["show", "--task", "7", "--json", "--json"], ["show", "--task", "7", "--cursor", "bad cursor"],
    ["link", "--task", "7", "--revision", "1", "--ref", JSON.stringify(external)], ["link", "--task", "7", "--task-created", "100", "--revision", "1", "--ref", JSON.stringify({ ...external, authority: true })]])
    expect(() => parseLineageCommand(args), args.join(" ")).toThrow("invalid lineage arguments");
});

test("lineage metadata display preserves separate states/strengths, opaque paging and unavailable rather than empty success", () => {
  expect(validateLineageReply(page)).toBe(page);
  const shown = renderExecutionLineage(page).join("\n");
  expect(shown).toContain("task 7"); expect(shown).toContain("failed, runner-attested"); expect(shown).toContain("attempted, host-observed"); expect(shown).toContain("Page complete.");
  expect(renderExecutionLineage(validateLineageReply({ ...page, truncated: true, cursor: "opaque_cursor" })).join("\n")).toContain("same root and bounds with --cursor opaque_cursor");
  const unavailable = renderExecutionLineage(validateLineageReply({ state: "unavailable" })).join("\n");
  expect(unavailable).toContain("Lineage unavailable;"); expect(unavailable).not.toContain("Page complete"); expect(unavailable).not.toContain("missing");
  for (const reply of [{ ...page, cursor: "cursor_on_complete" }, { ...page, truncated: true }, { ...page, title: "private payload" },
    { ...page, nodes: [{ ...page.nodes[0], body: "private payload" }] }, { ...page, edges: [{ ...page.edges[0], relation: "inferred" }] },
    { ...page, nodes: [{ ref: external, state: "produced", strength: "runner-attested" }] },
    { ...page, edges: [{ from: external, to: task, relation: "produced", strength: "declared" }] },
    { ...page, edges: [{ from: task, to: external, relation: "produced", strength: "host-observed" }] },
    { state: "unavailable", hiddenCount: 1 }, { state: "unavailable", reason: "private payload" }, { state: "available", nodes: [], edges: [] },
    { ...page, nodes: [{ state: "failed", strength: "declared" }] }]) expect(() => validateLineageReply(reply)).toThrow("unsupported shape");
  expect(() => validateLineageReply({ state: "available", nodes: [], edges: [{ from: task, to: external, relation: "declared-external", strength: "declared" }], truncated: false })).not.toThrow();
  const link = { id: "link-id", taskId: 7, reference: external, strength: "declared", already: false };
  expect(validateLineageLink(link, { taskId: 7, reference: external })).toBe(link);
  for (const bad of [{ ...link, strength: "runner-attested" }, { ...link, taskId: 8 }, { ...link, reference: task }, { reference: external }])
    expect(() => validateLineageLink(bad, { taskId: 7, reference: external })).toThrow("unconfirmed");
});

test("lineage shell forms retain task actor authority and action-only audit labels; live-test cannot link", () => {
  for (const op of ["show", "link"]) {
    expect(classifyPeerCommand("lineage", [op, "--task", "7"])).toBe("allowed");
    expect(cliCommandLabel("lineage", [op, "secret operand"])).toBe(`lineage ${op}`);
    expect(classifyPeerCommand("lineage", [op, "--as-user"])).toBe("console");
  }
  expect(classifyPeerCommand("lineage", ["repair"])).toBe("console");
  expect(liveTestRefusal("lineage", ["link"])).toBe(true); expect(liveTestRefusal("lineage", ["show"])).toBe(false);
});

async function fixture(run: (f: { requests: Record<string, any>[]; hellos: Record<string, any>[]; cli: (args: string[], agent?: boolean) => Promise<{ code: number; stdout: string; stderr: string }>; reply: (value: unknown) => void; support: (value: boolean) => void }) => Promise<void>) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-lineage-cli-"))), home = join(root, "home"), state = join(root, ".agenthub/state");
  mkdirSync(home); mkdirSync(state, { recursive: true }); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const requests: Record<string, any>[] = [], hellos: Record<string, any>[] = []; let reply: unknown = page, supports = true;
  const link = { id: "link-id", taskId: 7, reference: external, strength: "declared", already: false };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { return server.upgrade(req) ? undefined : new Response("fixture"); }, websocket: { message(ws, raw) {
    const row = JSON.parse(String(raw));
    if (row.t === "hello") { hellos.push(row); ws.send(JSON.stringify({ t: "welcome", rid: row.rid, ok: true, cwd: root, protocol: PROTOCOL, projectId: "fixture", instanceId: "fixture", features: supports ? ["execution_lineage"] : [] })); }
    else { requests.push(row); ws.send(JSON.stringify({ rid: row.rid, ok: true, ...(row.t === "lineage_show" ? { lineage: reply } : { link }) })); }
  } } });
  writeFileSync(join(state, "control-token"), "fixture-token");
  writeFileSync(join(state, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL, projectId: "fixture", instanceId: "fixture", pid: process.pid, pidSignature: processSignature(process.pid) }));
  const cli = async (args: string[], agent = false) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: root,
      env: { HOME: home, AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "amem"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), TMPDIR: root, PATH: process.env.PATH, ...(agent ? { AGENTHUB_PEER_ID: "codex" } : {}) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); await child.exited; }
  };
  try { await run({ requests, hellos, cli, reply: value => { reply = value; }, support: value => { supports = value; } }); }
  finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}

test("actual lineage CLI preserves host selectors, returns admitted JSON exactly and defaults to metadata text", async () => {
  await fixture(async f => {
    const human = await f.cli(["lineage", "show", "--task", "7"]); expect(human.code, human.stderr).toBe(0); expect(human.stdout).toContain("Execution lineage (metadata only)"); expect(human.stdout).not.toMatch(/^\s*\{/);
    expect(f.requests[0]).toMatchObject({ t: "lineage_show", taskId: 7 }); expect(f.requests[0]).not.toHaveProperty("root"); expect(f.requests[0]).not.toHaveProperty("projectKey");
    const json = await f.cli(["lineage", "show", "--attempt", attempt.id, "--json"]); expect(json.code, json.stderr).toBe(0); expect(JSON.parse(json.stdout)).toEqual(page);
    expect(f.requests[1]).toMatchObject({ t: "lineage_show", attemptId: attempt.id });
    f.reply({ state: "unavailable" }); const unavailable = await f.cli(["lineage", "show", "--task", "999"]); expect(unavailable.code).toBe(0); expect(unavailable.stdout).toContain("Lineage unavailable;"); expect(unavailable.stdout).not.toContain("Page complete.");
  });
}, 20_000);

test("actual lineage links preserve the tools hello and optional parent ref; live-test refuses before connecting", async () => {
  await fixture(async f => {
    const args = ["lineage", "link", "--task", "7", "--task-created", "100", "--revision", "3", "--ref", JSON.stringify(external), "--from", JSON.stringify(attempt)];
    const linked = await f.cli([...args, "--json"], true); expect(linked.code, linked.stderr).toBe(0);
    expect(JSON.parse(linked.stdout)).toEqual({ id: "link-id", taskId: 7, reference: external, strength: "declared", already: false });
    expect(f.requests[0]).toMatchObject({ t: "lineage_link", taskId: 7, taskCreated: 100, flowRevision: 3, reference: external, from: attempt });
    expect(f.hellos[0]).toMatchObject({ role: "tools", peer: "codex" });
    const before = f.hellos.length, refused = await f.cli(["--live-test", ...args], true); expect(refused.code).toBe(1); expect(refused.stderr).toContain("live-test cannot register execution links"); expect(f.hellos).toHaveLength(before); expect(f.requests).toHaveLength(1);
  });
}, 20_000);

test("old hubs and malformed complete-page cursors are refused without pretending a successful lineage read", async () => {
  await fixture(async f => {
    f.support(false); const old = await f.cli(["lineage", "show", "--task", "7"]); expect(old.code).toBe(1); expect(old.stderr).toContain("upgrade and restart the hub"); expect(f.requests).toEqual([]);
    f.support(true); f.reply({ ...page, cursor: "cursor_on_complete" }); const invalid = await f.cli(["lineage", "show", "--task", "7", "--json"]); expect(invalid.code).toBe(1); expect(invalid.stdout).toBe(""); expect(invalid.stderr).toContain("unsupported shape");
  });
}, 20_000);
