import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CLAUDE_COMPANION_LIMITS as limits, FakeClaudeCompanionCli, fixtureBoard, fixtureStatus, type ClaudeCompanionCall } from "./fakes/claude-code-companion-cli.ts";
const root = "/opaque project/$(NEVER_EXECUTE); & 'quoted'";
const binding = { root, projectId: "p_fixture" };
const request = (extra: Partial<ClaudeCompanionCall> = {}): ClaudeCompanionCall => ({ executable: "ahub", argv: ["--project", root, "status", "--json"], cwd: root, ...limits, ...extra });
const status = (extra = {}) => JSON.stringify({ cwd: root, projectId: "p_fixture", version: "0.35.0", peers: { claude: { state: "offline", queued: 2, attached: false, needsReview: 1, doing: "PRIVATE" } }, tasks: { in_review: 1 }, ...extra });
test("C0 matrix pins seven evidence verdicts, bounds and unqualified surfaces", () => {
  const contract = JSON.parse(readFileSync(new URL("../integrations/claude-code/host-contract-v1.json", import.meta.url), "utf8"));
  expect(contract.schema).toBe(1); expect(contract.task).toBe("C0"); expect(contract.capabilities).toHaveLength(7);
  expect(contract.fixture.bounds).toEqual(limits);
  for (const row of contract.capabilities) { expect(["proven", "unproven", "unsupported"]).toContain(row.verdict); expect(row.evidence.length).toBeGreaterThan(0); expect(row.consequence.length).toBeGreaterThan(0); }
  for (const surface of contract.surfaces) expect(surface.status).toBe("NOT RUN");
  expect(contract.baseline.journeys.map((j: { procedureActions: number }) => j.procedureActions)).toEqual([2, 2]);
});
test("fixed argv keeps opaque roots literal; mutations, widened bounds and shell calls refuse before reads", async () => {
  const cli = new FakeClaudeCompanionCli([{ stdout: "[]", exitCode: 0 }]); const call = request();
  expect((await cli.run(call)).stdout).toBe("[]"); (call.argv as string[]).push("mutated"); expect(cli.calls[0]!.argv).toEqual(request().argv);
  for (const bad of [{ executable: "sh" }, { argv: ["--project", root, "queue", "resolve"] }, { cwd: "/other" }, { timeoutMs: 5001 }, { maxOutputBytes: 262145 }]) await expect(cli.run(request(bad))).rejects.toMatchObject({ code: "invalid_request" });
  expect(cli.calls).toHaveLength(1);
});
test("bounded failures are distinct, UTF-8 bytes are counted and no truncated JSON is accepted", async () => {
  const cli = new FakeClaudeCompanionCli([{ stdout: "[]", exitCode: 0, durationMs: 5001 }, { stdout: "한".repeat(90000), exitCode: 0 }, { stdout: "[]", stderr: "x".repeat(262144), exitCode: 0 }, { stdout: "[]", exitCode: 7 }]);
  for (const code of ["timeout", "oversized", "oversized", "nonzero"]) await expect(cli.run(request())).rejects.toMatchObject({ code });
  await expect(cli.run(request())).rejects.toMatchObject({ code: "unscripted" });
  expect(() => fixtureStatus("{", binding)).toThrow("malformed"); expect(() => fixtureBoard("{}" )).toThrow("schema");
});
test("closed projection drops all detail, paths, doing, notes, review bodies and unknown text", () => {
  const projected = fixtureStatus(status({ detail: "PRIVATE", note: "PRIVATE", logs: ["PRIVATE"] }), binding);
  expect(projected).toEqual({ root, projectId: "p_fixture", version: "0.35.0", peers: [{ id: "claude", state: "offline", queued: 2, attached: false, needsReview: 1 }], tasks: [{ state: "in_review", count: 1 }] });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  expect(fixtureBoard(JSON.stringify([{ id: 1, title: "#1 public", state: "in_review", detail: "PRIVATE" }, { id: 2, title: "#2 [pii]", detail: "PRIVATE" }]))).toEqual([{ id: 1, publicTitle: "#1 public", state: "in_review" }, { id: 2 }]);
});
test("missing or mismatched binding and partial readings refuse instead of inventing zeroes", () => {
  for (const patch of [{ cwd: "/elsewhere" }, { projectId: "changed" }, { cwd: undefined }]) expect(() => fixtureStatus(status(patch), binding)).toThrow("binding");
  for (const patch of [{ version: undefined }, { peers: [] }, { tasks: undefined }, { peers: { x: { state: "unknown", queued: 0 } } }, { tasks: { surprise: 0 } }]) expect(() => fixtureStatus(status(patch), binding)).toThrow("schema");
  expect(fixtureStatus(status({ peers: { x: { state: "idle", queued: 0 } } }), binding).peers[0]).not.toHaveProperty("attached");
  expect(() => fixtureBoard(JSON.stringify(Array(257).fill({ id: 1, title: "x", state: "approved" })))).toThrow("schema");
});
test("disabled companion fixture leaves separately injected CLI usable; no cross-companion dependency", async () => {
  const disabled = new FakeClaudeCompanionCli([{ stdout: "[]", exitCode: 0 }]); disabled.setEnabled(false);
  await expect(disabled.run(request())).rejects.toMatchObject({ code: "disabled" }); expect(disabled.calls).toEqual([]);
  expect((await new FakeClaudeCompanionCli([{ stdout: "[]", exitCode: 0 }]).run(request())).exitCode).toBe(0);
  const source = readFileSync(new URL("./fakes/claude-code-companion-cli.ts", import.meta.url), "utf8"); expect(source).not.toMatch(/from |Bun\.spawn|child_process|\.store|setInterval/);
});
