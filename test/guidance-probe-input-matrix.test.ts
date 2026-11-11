import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import type { ProbeDataPolicyV1, ProbeSlot } from "../src/hub/guidance-probes.ts";
import { materializeProbeWorkspace, PROBE_WORKSPACE_LIMITS, probeRelativePath, probeWorkspaceCurrent, probeWorkspacePhysical, reserveProbeWorkspaceBytes, type ProbeMaterializedFile, type ProbeSourceClass, type ProbeWorkspaceInput } from "../src/local/probe-workspace.ts";
import { runTool, type ToolContext } from "../src/local/tools.ts";
import { formatProbeToolRefusal, ProbeToolRefusal } from "../src/local/probe-errors.ts";

const cleanup: string[] = [];
afterEach(() => { for (const root of cleanup.splice(0).reverse()) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const roles: readonly ProbeSlot["role"][] = ["worker", "proposal", "compose", "select", "reflect"];
const classes: Record<ProbeSlot["role"], ProbeSourceClass> = { worker: "task_source", proposal: "closed_artifact", compose: "improver_context", select: "anonymized_deliverable", reflect: "closed_round_evidence" };
const file = (dataId: string, relative = `${dataId}.txt`, body = `${dataId}: owned role fixture`): ProbeMaterializedFile => {
  const bytes = Buffer.from(body); return { dataId, relative, sha256: hash(bytes), bytes };
};
function policy(files: readonly ProbeMaterializedFile[], dataIds: readonly string[] = files.map(row => row.dataId)): ProbeDataPolicyV1 {
  return { v: 1, allowedWrites: [{ root: "output", relative: "answer.txt" }, { root: "scratch", relative: "work" }],
    admittedData: files.map(row => ({ id: row.dataId, sha256: row.sha256, bytes: row.bytes.byteLength })),
    roles: { worker: { dataIds, guidanceOnlyExperience: true }, proposal: { dataIds, improverContext: true }, compose: { dataIds, improverContext: true },
      select: { dataIds, anonymizedDeliverables: true }, reflect: { dataIds, closedRoundOnly: true } } };
}
function input(role: ProbeSlot["role"], files = [file(role)]): ProbeWorkspaceInput {
  return { role, files, policy: policy(files), maxBytes: PROBE_WORKSPACE_LIMITS.workspaceBytes, verifySource: () => classes[role], reserveStorage: () => {}, current: () => {} };
}
async function workspace(options: ProbeWorkspaceInput) {
  const value = await materializeProbeWorkspace(options); cleanup.push(dirname(value.root)); return value;
}

for (const role of roles) test(`probe ${role}: exact role ids alone are materialized as fresh immutable bytes`, async () => {
  const own = file(role), other = file("other-arm"), options = input(role, [own]);
  options.policy = policy([own, other], [own.dataId]);
  let charged = 0;
  options.reserveStorage = bytes => { charged += bytes; expect(bytes).toBe(own.bytes.byteLength); };
  const created = await workspace(options);
  expect(readFileSync(join(created.root, own.relative))).toEqual(Buffer.from(own.bytes));
  expect(readdirSync(created.root).sort()).toEqual([".probe-temp", own.relative, "output", "scratch"].sort());
  expect(created.allowedWrites).toEqual([join(created.output, "answer.txt"), join(created.scratch, "work")]);
  expect(charged).toBe(own.bytes.byteLength);
  expect(() => probeWorkspaceCurrent(created)).not.toThrow();
  expect(() => probeWorkspaceCurrent({ ...created })).toThrow();
});

for (const role of roles) test(`probe ${role}: runtime file tools deny dependency, internal-temp and unsafe relative names before approval`, async () => {
  const created = await workspace(input(role));
  const forbidden = ["output/answer.txt/node_modules/package.js", ".probe-temp/private.txt", `output/answer.txt/${"deep/".repeat(50)}too-long.txt`];
  for (const relative of forbidden) {
    const target = join(created.root, relative); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "host-only forbidden fixture");
  }
  let approvals = 0, writes = 0;
  const context: ToolContext = { cwd: created.root, deny: [], sandboxProfile: "file-only fixture, no native proof",
    permit: async () => { approvals++; return true; }, send: () => { throw new Error("no probe send capability"); },
    probe: { root: created.root, writableRoots: created.allowedWrites, current: () => probeWorkspaceCurrent(created), reserveWrite: async () => { writes++; } } };
  for (const relative of forbidden) {
    expect(await runTool("read", JSON.stringify({ path: `/workspace/${relative}` }), context)).toBe(formatProbeToolRefusal(new ProbeToolRefusal("invalid_path")));
    expect(await runTool("write", JSON.stringify({ path: `/workspace/${relative}`, content: "must not write" }), context)).toBe(formatProbeToolRefusal(new ProbeToolRefusal("invalid_path")));
    expect(readFileSync(join(created.root, relative), "utf8")).toBe("host-only forbidden fixture");
  }
  expect(await runTool("read", JSON.stringify({ path: `/workspace/${role}.txt/../${role}.txt` }), context)).toBe(formatProbeToolRefusal(new ProbeToolRefusal("invalid_path")));
  expect(approvals).toBe(0); expect(writes).toBe(0);
});

test("probe input resolution refuses extra ids, missing ids, altered bytes and uncertain source classifications before reservation", async () => {
  const allowed = file("allowed"), hidden = file("hidden");
  let reservations = 0;
  const cases = [
    { ...input("worker", [allowed, hidden]), policy: policy([allowed, hidden], [allowed.dataId]) },
    { ...input("worker", [allowed]), policy: policy([allowed, hidden]) },
    { ...input("worker", [{ ...allowed, bytes: Buffer.from("changed") }]) },
    { ...input("worker", [allowed]), verifySource: () => undefined as never },
    { ...input("worker", [allowed]), verifySource: () => "anonymized_deliverable" as const },
  ];
  for (const options of cases) await expect(materializeProbeWorkspace({ ...options, reserveStorage: () => { reservations++; } })).rejects.toThrow();
  expect(reservations).toBe(0);
});

for (const role of roles) test(`probe ${role}: role source-class restrictions cannot be widened by declared membership`, async () => {
  const forbidden: Record<ProbeSlot["role"], ProbeSourceClass> = { worker: "improver_context", proposal: "anonymized_deliverable", compose: "closed_round_evidence", select: "tree", reflect: "task_source" };
  let reserved = false;
  await expect(materializeProbeWorkspace({ ...input(role), verifySource: () => forbidden[role], reserveStorage: () => { reserved = true; } })).rejects.toThrow();
  expect(reserved).toBe(false);
});

test("proposal and compose improver context requires their frozen policy flag", async () => {
  for (const role of ["proposal", "compose"] as const) {
    const options = input(role); options.policy.roles[role].improverContext = false;
    await expect(materializeProbeWorkspace({ ...options, verifySource: () => "improver_context" })).rejects.toThrow();
  }
});

test("source callback and storage await cannot mutate the checked file or policy into a different input", async () => {
  const original = file("copy"), options = input("worker", [original]);
  options.verifySource = async () => { original.bytes.fill(0); options.policy.allowedWrites = [{ root: "output", relative: "changed" }]; return "task_source" as const; };
  const created = await workspace(options);
  expect(readFileSync(join(created.root, "copy.txt"), "utf8")).toBe("copy: owned role fixture");
  expect(created.allowedWrites).toContain(join(created.output, "answer.txt"));
  expect(created.allowedWrites).not.toContain(join(created.output, "changed"));
  await expect(materializeProbeWorkspace({ ...input("worker"), verifySource: value => { value.bytes.fill(0); return "task_source"; } })).rejects.toThrow();
});

test("probe paths reject Git/hub/dependency names, traversal, secret paths and aliases on every host", async () => {
  for (const name of ["../task.txt", "/task.txt", "a//b", "a/../b", "a\\b", ".GIT/objects/id", ".agenthub/state/key", "node_modules/lib/index.js", ".env", ".probe-temp/source"]) {
    expect(probeRelativePath(name)).toBe(false);
    await expect(materializeProbeWorkspace(input("worker", [file("bad", name)]))).rejects.toThrow();
  }
  for (const names of [["source.ts", "SOURCE.ts"], ["input", "input/child.ts"]]) {
    await expect(materializeProbeWorkspace(input("worker", names.map((name, index) => file(`case${index}`, name))))).rejects.toThrow();
  }
});

test("materialization respects the fixed and remaining resource ceilings and propagates a refused reservation", async () => {
  const bytes = new Uint8Array(PROBE_WORKSPACE_LIMITS.fileBytes + 1), oversized = { dataId: "large", relative: "large.txt", bytes, sha256: hash(bytes) };
  await expect(materializeProbeWorkspace(input("worker", [oversized]))).rejects.toMatchObject({ code: "file_ceiling" });
  await expect(materializeProbeWorkspace({ ...input("worker"), maxBytes: PROBE_WORKSPACE_LIMITS.workspaceBytes + 1 })).rejects.toMatchObject({ code: "workspace_ceiling" });
  await expect(materializeProbeWorkspace({ ...input("worker"), maxBytes: 1 })).rejects.toMatchObject({ code: "workspace_ceiling" });
  await expect(materializeProbeWorkspace({ ...input("worker"), reserveStorage: () => { throw new Error("resource reservation refused"); } })).rejects.toThrow("resource reservation refused");
});

test("workspace input identity is fenced after materialization", async () => {
  const created = await workspace(input("worker"));
  chmodSync(join(created.root, "worker.txt"), 0o600);
  writeFileSync(join(created.root, "worker.txt"), "changed", { mode: 0o600 });
  expect(() => probeWorkspaceCurrent(created)).toThrow();
});

test("narrow physical ownership remains readable after execution authority is withdrawn", async () => {
  let active = true;
  const created = await workspace({ ...input("worker"), current: () => { if (!active) throw new Error("authority withdrawn"); } });
  active = false;
  expect(() => probeWorkspaceCurrent(created)).toThrow("authority withdrawn");
  expect(() => probeWorkspacePhysical(created)).not.toThrow();
});

test("physical ownership refuses replaced parent, root, HOME and temp directories without touching the replacement", async () => {
  for (const key of ["parent", "root", "home", "temp"] as const) {
    const created = await workspace(input("worker"));
    const directory = key === "parent" ? dirname(created.root) : key === "root" ? created.root : key === "home" ? created.home : join(created.root, ".probe-temp");
    const retained = `${directory}-original`; renameSync(directory, retained);
    mkdirSync(directory, { mode: 0o700 }); writeFileSync(join(directory, "bystander.txt"), "replacement owned elsewhere");
    if (key === "parent") cleanup.push(retained);
    expect(() => probeWorkspacePhysical(created)).toThrow();
    expect(readFileSync(join(directory, "bystander.txt"), "utf8")).toBe("replacement owned elsewhere");
  }
});

test("runtime reservations retain the aggregate workspace ceiling without making another owner-ledger call", async () => {
  const options = input("worker"), initial = options.files[0]!.bytes.byteLength;
  let ownerCalls = 0; options.reserveStorage = () => { ownerCalls++; };
  options.maxBytes = initial + 12;
  const created = await workspace(options);
  reserveProbeWorkspaceBytes(created, 7);
  reserveProbeWorkspaceBytes(created, 5);
  expect(() => reserveProbeWorkspaceBytes(created, 1)).toThrow(ProbeToolRefusal);
  expect(ownerCalls).toBe(1);
});

test("tree-class inputs require the exact declared Git tree and regular blob bytes", async () => {
  const repo = mkdtempSync(join(tmpdir(), "ahub-probe-tree-")); cleanup.push(repo);
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", repo, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("owned Git fixture failed"); return result.stdout.trim();
  };
  git("init", "-q", "--object-format=sha1");
  const source = file("source", "source.txt", "declared source bytes"); writeFileSync(join(repo, source.relative), source.bytes);
  symlinkSync(source.relative, join(repo, "alias.txt"));
  git("add", "--", source.relative, "alias.txt");
  const tree = { objectFormat: "sha1" as const, oid: git("write-tree") };
  const options = { ...input("worker", [source]), verifySource: () => "tree" as const, sourceTree: { repo, tree, files: [{ dataId: source.dataId, path: source.relative }] } };
  const created = await workspace(options);
  expect(readFileSync(join(created.root, source.relative))).toEqual(Buffer.from(source.bytes));
  expect(readdirSync(created.root)).not.toContain(".git");
  await expect(materializeProbeWorkspace({ ...options, sourceTree: undefined })).rejects.toThrow();
  await expect(materializeProbeWorkspace({ ...options, sourceTree: { ...options.sourceTree, tree: { ...tree, oid: "0".repeat(40) } } })).rejects.toThrow();
  const link = file("link", "link.txt", source.relative);
  await expect(materializeProbeWorkspace({ ...input("worker", [link]), verifySource: () => "tree", sourceTree: { repo, tree, files: [{ dataId: link.dataId, path: "alias.txt" }] } })).rejects.toThrow();
  git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},linked`);
  const linkedTree = { ...tree, oid: git("write-tree") };
  await expect(materializeProbeWorkspace({ ...input("worker", [source]), verifySource: () => "tree", sourceTree: { repo, tree: linkedTree, files: [{ dataId: source.dataId, path: "linked" }] } })).rejects.toThrow();
});

for (const objectFormat of ["sha1", "sha256"] as const) test(`tree ${objectFormat}: binary blob identity is exact without decoding raw object bytes`, async () => {
  const repo = mkdtempSync(join(tmpdir(), "ahub-probe-binary-tree-")); cleanup.push(repo);
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", repo, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("owned binary Git fixture failed"); return result.stdout.trim();
  };
  git("init", "-q", `--object-format=${objectFormat}`);
  const bytes = new Uint8Array([0, 255, 254, 128, 65, 10]), source = { dataId: "binary", relative: "source.bin", sha256: hash(bytes), bytes };
  writeFileSync(join(repo, source.relative), bytes); git("add", "--", source.relative);
  const tree = { objectFormat, oid: git("write-tree") }, sourceTree = { repo, tree, files: [{ dataId: source.dataId, path: source.relative }] };
  const created = await workspace({ ...input("worker", [source]), sourceTree, verifySource: () => "tree" });
  expect(readFileSync(join(created.root, source.relative))).toEqual(Buffer.from(bytes));
  const alteredBytes = new Uint8Array([0, 255, 254, 128, 66, 10]), altered = { ...source, bytes: alteredBytes, sha256: hash(alteredBytes) };
  await expect(materializeProbeWorkspace({ ...input("worker", [altered]), sourceTree, verifySource: () => "tree" })).rejects.toThrow();
});
