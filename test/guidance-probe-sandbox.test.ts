import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProbeDataPolicyV1, ProbeSlot } from "../src/hub/guidance-probes.ts";
import { materializeProbeWorkspace, PROBE_WORKSPACE_LIMITS, type ProbeWorkspace } from "../src/local/probe-workspace.ts";
import { ProbeConfinementError, requireProbeConfinement, verifyProbeConfinement, type ProbeConfinement } from "../src/local/probe-sandbox.ts";
import { planProbeTool, requireProbeToolWrite, runTool, type ProbeToolResourcePlan, type ToolContext } from "../src/local/tools.ts";

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0).reverse()) rmSync(directory, { recursive: true, force: true }); });
const roles: readonly ProbeSlot["role"][] = ["worker", "proposal", "compose", "select", "reflect"];
async function create(role: ProbeSlot["role"] = "worker", registerCleanup = true, current: () => void = () => {}): Promise<ProbeWorkspace> {
  const bytes = Buffer.from(`${role}: admitted input`), id = `${role}-source`, sha256 = createHash("sha256").update(bytes).digest("hex");
  const policy: ProbeDataPolicyV1 = { v: 1, admittedData: [{ id, sha256, bytes: bytes.length }],
    allowedWrites: [{ root: "output", relative: "answer.txt" }, { root: "scratch", relative: "work" }],
    roles: { worker: { dataIds: [id], guidanceOnlyExperience: true }, proposal: { dataIds: [id], improverContext: false }, compose: { dataIds: [id], improverContext: false },
      select: { dataIds: [id], anonymizedDeliverables: true }, reflect: { dataIds: [id], closedRoundOnly: true } } };
  const workspace = await materializeProbeWorkspace({ role, policy, files: [{ dataId: id, relative: "input/task.txt", sha256, bytes }],
    maxBytes: PROBE_WORKSPACE_LIMITS.workspaceBytes, verifySource: () => role === "select" ? "anonymized_deliverable" : role === "reflect" ? "closed_round_evidence" : "task_source",
    reserveStorage: () => {}, current });
  if (registerCleanup) cleanups.push(dirname(workspace.root)); return workspace;
}
function tools(workspace: ProbeWorkspace) {
  let plan: ProbeToolResourcePlan, permits = 0, sends = 0;
  const context: ToolContext = { cwd: workspace.root, deny: [], sandboxProfile: "unavailable: file-tools-only fixture",
    permit: async () => { permits++; return true; }, send: () => { sends++; throw new Error("probe send escaped its capability"); },
    probe: { root: workspace.root, writableRoots: workspace.allowedWrites, current: () => {},
      reserveWrite: async (bytes, path) => requireProbeToolWrite(plan, bytes, path, context) } };
  return { context, permits: () => permits, sends: () => sends, prepare(name: string, args: string) { plan = planProbeTool(name, args, context); return plan; } };
}

test("probe dispatch refuses all invented non-file calls before parsing, permission or hub dispatch", async () => {
  const workspace = await create(), host = tools(workspace);
  for (const name of ["bash", "git", "hub_send", "hub_task_done", "hub_remember", "hub_set_title", "doc_read", "web_fetch", "read_file"]) {
    expect(await runTool(name, "{not-json", host.context)).toBe("error: tool is unavailable in the confined probe");
  }
  expect(host.permits()).toBe(0); expect(host.sends()).toBe(0);
});

test("probe read/write/edit preserve normal approval and use only already-paid exact or conservative write bounds", async () => {
  const workspace = await create(), host = tools(workspace);
  expect(await runTool("read", JSON.stringify({ path: "/workspace/input/task.txt" }), host.context)).toContain("worker: admitted input");
  const write = JSON.stringify({ path: "/workspace/output/answer.txt", content: "가나다 old" });
  const writePlan = host.prepare("write", write);
  expect(writePlan.outputBytes).toBe(Buffer.byteLength("가나다 old", "utf8")); expect(writePlan.scratchBytes).toBe(0);
  expect(await runTool("write", write, host.context)).toBe("wrote /workspace/output/answer.txt");
  const edit = JSON.stringify({ path: "/workspace/output/answer.txt", old: "old", new: "new-result" });
  const editPlan = host.prepare("edit", edit);
  expect(editPlan.outputBytes).toBe(Buffer.byteLength("가나다 oldnew-result", "utf8"));
  expect(await runTool("edit", edit, host.context)).toBe("edited /workspace/output/answer.txt");
  expect(readFileSync(join(workspace.output, "answer.txt"), "utf8")).toBe("가나다 new-result");
  expect(host.permits()).toBe(2);
  expect(() => requireProbeToolWrite(editPlan, 1, join(workspace.output, "answer.txt"), host.context)).toThrow();
});

test("probe immutable inputs, physical absolute paths and undeclared output roots cannot request approval", async () => {
  const workspace = await create(), host = tools(workspace);
  for (const path of ["/workspace/input/task.txt", "/workspace/output/unknown.txt", "/workspace/new-parent/file.txt", join(workspace.output, "answer.txt")]) {
    const args = JSON.stringify({ path, content: "changed" });
    expect(host.prepare("write", args).maximumBytes).toBe(0);
    expect(await runTool("write", args, host.context)).toBe("error: confined probe tool operation refused");
  }
  expect(host.permits()).toBe(0);
  expect(readFileSync(join(workspace.root, "input/task.txt"), "utf8")).toBe("worker: admitted input");
});

test("probe target changes after planning or during approval refuse writes without refund or a nested charge", async () => {
  const workspace = await create(), host = tools(workspace), target = join(workspace.output, "answer.txt");
  writeFileSync(target, "old value");
  const args = JSON.stringify({ path: "/workspace/output/answer.txt", old: "old", new: "new" });
  const reservation = host.prepare("edit", args);
  writeFileSync(target, "old host replacement");
  expect(await runTool("edit", args, host.context)).toBe("error: confined probe tool operation refused");
  expect(readFileSync(target, "utf8")).toBe("old host replacement");
  expect(reservation.outputBytes).toBe(Buffer.byteLength("old valuenew", "utf8"));
  expect(host.permits()).toBe(1);
});

test("probe file guards refuse outside symlink and hardlink aliases even inside a declared write path", async () => {
  const workspace = await create(), host = tools(workspace), outside = join(dirname(workspace.root), "outside-source");
  writeFileSync(outside, "outside fixture");
  const target = join(workspace.output, "answer.txt");
  symlinkSync(outside, target);
  expect(await runTool("read", JSON.stringify({ path: "/workspace/output/answer.txt" }), host.context)).toBe("error: confined probe tool operation refused");
  rmSync(target); linkSync(outside, target);
  const args = JSON.stringify({ path: "/workspace/output/answer.txt", content: "changed" });
  expect(host.prepare("write", args).maximumBytes).toBe(0);
  expect(await runTool("write", args, host.context)).toBe("error: confined probe tool operation refused");
  expect(readFileSync(outside, "utf8")).toBe("outside fixture");
});

test("a declared profile or copied proof never substitutes for the live OS proof brand", async () => {
  const workspace = await create();
  const fake = { workspace, profile: "(version 1)\n(deny default)", env: {}, stop: async () => {} } as ProbeConfinement;
  expect(() => requireProbeConfinement(fake, workspace)).toThrow(ProbeConfinementError);
});

test.skipIf(process.platform === "darwin")("unsupported confinement refuses without a fixture-native success", async () => {
  const workspace = await create();
  await expect(verifyProbeConfinement(workspace)).rejects.toThrow(ProbeConfinementError);
  expect(existsSync(join(workspace.home, "credential-canary"))).toBe(false);
});

for (const role of roles) test.skipIf(process.platform !== "darwin")(`real probe sandbox ${role}: positive controls then evaluator/future/Git/home/other-arm/control/parent/sibling/network denial`, async () => {
  let active = true;
  const workspace = await create(role, false, () => { if (!active) throw new Error("fixture authority withdrawn"); });
  let safe = false;
  try {
    const proof = await verifyProbeConfinement(workspace);
    requireProbeConfinement(proof, workspace);
    expect(Object.keys(proof.env).sort()).toEqual(["HOME", "LANG", "PATH", "TERM"]);
    expect(proof.env.HOME).toBe(workspace.home);
    expect(proof.profile).toContain("(deny network*)");
    expect(existsSync(join(workspace.output, "answer.txt"))).toBe(false);
    expect(readFileSync(join(workspace.root, "input/task.txt"), "utf8")).toBe(`${role}: admitted input`);
    if (role === "worker") {
      active = false;
      expect(() => requireProbeConfinement(proof, workspace)).toThrow("fixture authority withdrawn");
    }
    await proof.stop(); safe = true;
    expect(() => requireProbeConfinement(proof, workspace)).toThrow(ProbeConfinementError);
  } catch (error) {
    if (error instanceof ProbeConfinementError) { await error.stop(); safe = true; }
    throw error;
  } finally {
    if (safe) cleanups.push(dirname(workspace.root));
    // An unconfirmed owned group retains its private workspace instead of deleting resources under it.
  }
}, 20000);

test.skipIf(process.platform !== "darwin")("known-quiescent proof cleanup refuses a replaced workspace root and preserves the bystander namespace", async () => {
  const workspace = await create("worker", false);
  let safe = false;
  try {
    const proof = await verifyProbeConfinement(workspace);
    safe = true; // Verification already proved its fixed child groups quiescent before this fixture replacement.
    renameSync(workspace.root, `${workspace.root}-original`);
    mkdirSync(workspace.root, { mode: 0o700 }); writeFileSync(join(workspace.root, "bystander.txt"), "bystander remains");
    await expect(proof.stop()).rejects.toThrow();
    expect(readFileSync(join(workspace.root, "bystander.txt"), "utf8")).toBe("bystander remains");
  } catch (error) {
    if (!safe && error instanceof ProbeConfinementError) { await error.stop(); safe = true; }
    throw error;
  } finally { if (safe) cleanups.push(dirname(workspace.root)); }
}, 20000);
