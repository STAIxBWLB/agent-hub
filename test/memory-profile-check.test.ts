import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateMemoryProfileCheck, readProfileCheckProjects, checkMemoryProfiles, probeMemoryProfile, formatMemoryProfileCheck, type ExpectedMemoryProfile, type ProfileEvidence } from "../src/hub/memory-profile-check.ts";
import { Registry } from "../src/hub/registry.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { realPath } from "../src/hub/project.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const value = realPath(mkdtempSync(join(tmpdir(), "ahub-profile-check-"))); dirs.push(value); return value; };
const expected: ExpectedMemoryProfile = { home: "/synthetic/memory", profile: "generation", generation: "a".repeat(32), selectorRevision: "b".repeat(64) };
function evidence(over: Partial<ProfileEvidence> = {}): ProfileEvidence {
  const project = { id: "p_fixture", root: "/synthetic/project", stateDir: "/synthetic/state", basePort: 4600, pid: 1234, instanceId: "instance-1", pidSignature: "signed-owner" };
  return { project, liveness: "live", descriptor: { url: "ws://127.0.0.1:4601", token: "not-output", projectId: project.id, instanceId: project.instanceId, cwd: project.root, pid: project.pid, pidSignature: project.pidSignature }, canonicalHome: expected.home,
    status: { pid: project.pid, projectId: project.id, instanceId: project.instanceId, cwd: project.root, version: "0.12.29", memoryProfile: { ...expected, state: "ready", agentMemVersion: "0.3.0", skippedRows: 4 } }, ...over };
}

test("readiness requires the authenticated running binding, matching home generation selector and capable library", () => {
  const report = evaluateMemoryProfileCheck(expected, [evidence()]);
  expect(report.ready).toBe(true);
  expect(report.daemons[0]).toMatchObject({ pid: 1234, hubVersion: "0.12.29", agentMemVersion: "0.3.0", scope: "same-home", ready: true });
  expect(JSON.stringify(report)).not.toContain("not-output");
  for (const patch of [{ generation: "c".repeat(32) }, { selectorRevision: "c".repeat(64) }, { profile: "shared-v1", generation: undefined }, { state: "stale" }, { state: "disabled" }, { agentMemVersion: "0.2.0" }, { agentMemVersion: "unknown" }]) {
    const value = evidence();
    const status = value.status as { memoryProfile: Record<string, unknown> };
    status.memoryProfile = { ...status.memoryProfile, ...patch };
    expect(evaluateMemoryProfileCheck(expected, [value]).ready).toBe(false);
  }
});

test("old missing unknown and mismatched process receipts never imply migration readiness", () => {
  for (const value of [evidence({ status: undefined }), evidence({ liveness: "unknown" }), evidence({ descriptor: undefined }), evidence({ canonicalHome: undefined })]) expect(evaluateMemoryProfileCheck(expected, [value]).ready).toBe(false);
  for (const field of ["pid", "instanceId", "projectId", "cwd"] as const) {
    const value = evidence(); (value.status as Record<string, unknown>)[field] = "wrong";
    expect(evaluateMemoryProfileCheck(expected, [value]).ready).toBe(false);
  }
  const unsigned = evidence(); unsigned.project.pidSignature = undefined;
  expect(evaluateMemoryProfileCheck(expected, [unsigned]).ready).toBe(false);
  const unknownVersion = evidence(); (unknownVersion.status as Record<string, unknown>).version = "unknown";
  expect(evaluateMemoryProfileCheck(expected, [unknownVersion]).ready).toBe(false);
  const old = evidence(); delete (old.status as Record<string, unknown>).memoryProfile;
  expect(evaluateMemoryProfileCheck(expected, [old]).ready).toBe(false);
});

test("positively different home is excluded but unknown home blocks a valid same-home receipt", () => {
  const other = evidence({ canonicalHome: "/synthetic/other-memory" });
  expect(evaluateMemoryProfileCheck(expected, [evidence(), other]).ready).toBe(true);
  expect(evaluateMemoryProfileCheck(expected, [evidence(), evidence({ canonicalHome: undefined })]).ready).toBe(false);
  expect(evaluateMemoryProfileCheck(expected, [evidence({ liveness: "gone" })]).ready).toBe(true);
  expect(evaluateMemoryProfileCheck(expected, []).ready).toBe(true);
  expect(evaluateMemoryProfileCheck(expected, []).reason).toContain("quiesced");
});

test("registry inspection never creates a missing registry or upgrades an unsigned legacy schema", async () => {
  const missing = temp(), before = readdirSync(missing);
  expect(readProfileCheckProjects(missing)).toEqual([]);
  expect(readdirSync(missing)).toEqual(before);
  expect(existsSync(join(missing, "registry.db"))).toBe(false);
  const legacy = temp(), file = join(legacy, "registry.db"), db = new Database(file);
  db.run("CREATE TABLE projects (id TEXT,root TEXT,state_dir TEXT,base_port INTEGER,instance_id TEXT,pid INTEGER)");
  db.query("INSERT INTO projects VALUES (?,?,?,?,?,?)").run("p_old", "/synthetic/old", "/synthetic/old/state", 4600, "old-instance", 123);
  db.close(); const bytes = readFileSync(file);
  expect(readProfileCheckProjects(legacy)[0]).toMatchObject({ id: "p_old", pid: 123, instanceId: "old-instance" });
  expect(readFileSync(file)).toEqual(bytes);
  const report = await checkMemoryProfiles(expected, { registryHome: legacy, probe: async project => ({ project, liveness: "unknown" }) });
  expect(report.ready).toBe(false); expect(readFileSync(file)).toEqual(bytes);
});

test("registry ownership signatures remain instance-bound in read-only profile checks", () => {
  const dir = temp(), projectRoot = temp(), registry = new Registry(join(dir, "registry.db"));
  const project = registry.register(projectRoot);
  expect(registry.claim(project.id, "instance-1", 123, "fixture-signature")).toBe(true); registry.close();
  const before = readFileSync(join(dir, "registry.db"));
  expect(readProfileCheckProjects(dir)[0]?.pidSignature).toBe("fixture-signature");
  expect(readFileSync(join(dir, "registry.db"))).toEqual(before);
});


test("running readiness uses an authenticated direct status reply and refuses stale credentials or mismatched pid", async () => {
  const root = temp(), state = join(root, "state"); mkdirSync(state);
  const signature = processSignature(process.pid); expect(signature).toBeDefined();
  const project = { id: "p_live", root, stateDir: state, basePort: 4600, pid: process.pid, instanceId: "live-instance", pidSignature: signature! };
  let statusPid = process.pid;
  let memoryProfile: unknown = { ...expected, state: "ready", agentMemVersion: "0.3.0", skippedRows: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("not websocket", { status: 400 }); },
    websocket: { message(socket, data) {
      const message = JSON.parse(String(data));
      if (message.t === "hello") {
        if (message.token !== "fixture-token") { socket.close(4401, "refused"); return; }
        socket.send(JSON.stringify({ t: "welcome", rid: message.rid, projectId: project.id, instanceId: project.instanceId, cwd: root }));
      } else if (message.t === "status") socket.send(JSON.stringify({ t: "status", rid: message.rid, status: { pid: statusPid, projectId: project.id, instanceId: project.instanceId, cwd: root, version: "0.12.29", memoryProfile } }));
    } },
  });
  writeFileSync(join(state, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, pid: project.pid, pidSignature: signature, projectId: project.id, instanceId: project.instanceId, cwd: root }));
  writeFileSync(join(state, "control-token"), "fixture-token");
  try {
    expect(evaluateMemoryProfileCheck(expected, [await probeMemoryProfile(project)]).ready).toBe(true);
    memoryProfile = { home: expected.home, state: "disabled", agentMemVersion: "0.3.0" };
    const quiesced = evaluateMemoryProfileCheck(expected, [await probeMemoryProfile(project)]);
    expect(quiesced.ready).toBe(true); expect(quiesced.daemons[0]?.quiesced).toBe(true);
    statusPid++;
    expect(evaluateMemoryProfileCheck(expected, [await probeMemoryProfile(project)]).ready).toBe(false);
    writeFileSync(join(state, "control-token"), "stale-token");
    const failed = evaluateMemoryProfileCheck(expected, [await probeMemoryProfile(project)]);
    expect(failed.ready).toBe(false); expect(JSON.stringify(failed)).not.toContain("stale-token");
  } finally { server.stop(true); }
});


test("profile-check labels its exact registry inventory and never reports machine-wide absence", async () => {
  const registryHome = temp();
  const result = await checkMemoryProfiles(expected, { registryHome });
  expect(result).toMatchObject({ ready: true, registryHome });
  expect(result.reason).toContain("this registry");
  expect(result.reason).toContain("this inventory only");
  const text = formatMemoryProfileCheck(result);
  expect(text).toContain(`registry inventory: ${registryHome}`);
  expect(text).toContain("other custom registries separately before migration");
  expect(readdirSync(registryHome)).toEqual([]);
});


test("dangling registry files and dangling home ancestors block readiness rather than looking empty", async () => {
  const registryHome = temp(); symlinkSync(join(registryHome, "missing-registry-target"), join(registryHome, "registry.db"));
  expect(() => readProfileCheckProjects(registryHome)).toThrow();
  expect(await checkMemoryProfiles(expected, { registryHome })).toMatchObject({ ready: false, reason: "project registry could not be read without mutation" });
  const parent = temp(), alias = join(parent, "dangling-home"); symlinkSync(join(parent, "missing-home-target"), alias, "dir");
  const danglingHome = join(alias, "child");
  expect(() => readProfileCheckProjects(danglingHome)).toThrow();
  expect((await checkMemoryProfiles(expected, { registryHome: danglingHome })).ready).toBe(false);
  expect(existsSync(join(parent, "missing-home-target"))).toBe(false);
  const notDirectory = join(parent, "regular-file"); writeFileSync(notDirectory, "not a directory");
  expect((await checkMemoryProfiles(expected, { registryHome: join(notDirectory, "child") })).ready).toBe(false);
});

test("unreadable registry and ancestor permissions block readiness while existing directory aliases remain supported", async () => {
  const registryHome = temp(), file = join(registryHome, "registry.db"), db = new Database(file);
  db.run("CREATE TABLE projects (id TEXT,root TEXT,state_dir TEXT,base_port INTEGER,instance_id TEXT,pid INTEGER)"); db.close();
  const bytes = readFileSync(file);
  chmodSync(file, 0o000);
  try { expect((await checkMemoryProfiles(expected, { registryHome })).ready).toBe(false); }
  finally { chmodSync(file, 0o600); }
  chmodSync(registryHome, 0o000);
  try { expect((await checkMemoryProfiles(expected, { registryHome })).ready).toBe(false); }
  finally { chmodSync(registryHome, 0o700); }
  const parent = temp(), alias = join(parent, "existing-home-alias"); symlinkSync(registryHome, alias, "dir");
  expect(readProfileCheckProjects(alias)).toEqual([]);
  expect((await checkMemoryProfiles(expected, { registryHome: alias })).ready).toBe(true);
  expect(readFileSync(file)).toEqual(bytes);
});


for (const state of ["disabled", "unavailable"] as const) test(`authenticated same-home daemon without a memory handle is quiesced: ${state}`, () => {
  const value = evidence();
  (value.status as Record<string, unknown>).memoryProfile = { home: expected.home, state, agentMemVersion: "0.3.0", error: "neutral unavailable reason" };
  const result = evaluateMemoryProfileCheck(expected, [value]);
  expect(result.ready).toBe(true);
  expect(result.daemons[0]).toMatchObject({ ready: true, quiesced: true, scope: "same-home", memoryProfile: { state } });
  expect(result.daemons[0]?.memoryProfile?.profile).toBeUndefined();
  expect(formatMemoryProfileCheck(result)).toContain(`unbound: memory handle ${state}; quiesced`);
  expect(JSON.stringify(result)).not.toContain("neutral unavailable reason");
});

test("unbound receipts still require capable version and authenticated known home, and bound unavailable remains blocked", () => {
  const valid = { home: expected.home, state: "unavailable", agentMemVersion: "0.3.0" };
  for (const receipt of [{ ...valid, agentMemVersion: "0.2.0" }, { ...valid, agentMemVersion: "unknown" }, { ...valid, home: undefined }, { ...valid, state: "ready" }, { ...valid, generation: expected.generation }, { ...valid, selectorRevision: expected.selectorRevision }, { ...valid, skippedRows: 0 }]) {
    const value = evidence(); (value.status as Record<string, unknown>).memoryProfile = receipt;
    expect(evaluateMemoryProfileCheck(expected, [value]).ready).toBe(false);
  }
  const unknownHome = evidence({ canonicalHome: undefined }); (unknownHome.status as Record<string, unknown>).memoryProfile = valid;
  expect(evaluateMemoryProfileCheck(expected, [unknownHome]).ready).toBe(false);
  const unsigned = evidence(); unsigned.project.pidSignature = undefined; (unsigned.status as Record<string, unknown>).memoryProfile = valid;
  expect(evaluateMemoryProfileCheck(expected, [unsigned]).ready).toBe(false);
  const bound = evidence(); ((bound.status as Record<string, unknown>).memoryProfile as Record<string, unknown>).state = "unavailable";
  const blocked = evaluateMemoryProfileCheck(expected, [bound]);
  expect(blocked.ready).toBe(false); expect(blocked.daemons[0]?.quiesced).toBeUndefined();
});
