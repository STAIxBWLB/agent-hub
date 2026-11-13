import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ADAPTERS, definitionOf, SUPPORTED_PEERS } from "../src/adapters/registry.ts";
import { applyRoleCeiling, roleEligibility } from "../src/adapters/role-eligibility.ts";
import { loadConductorPolicy } from "../src/hub/daemon.ts";
import { rolesRow } from "../src/cli/role-doctor.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { readInstanceConfigLayers } from "../src/hub/instance-config.ts";
import { freshRoles } from "../src/hub/recovery-policy.ts";
import { readInstanceConfig } from "../src/hub/instance-config.ts";
const freshRolesForTest = (dir: string) => freshRoles(readInstanceConfigLayers(dir), readInstanceConfig(dir));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function project(config: Record<string, unknown>, local?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "ahub-role-elig-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".agenthub"), { recursive: true });
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify(config));
  if (local) writeFileSync(join(dir, ".agenthub", "config.local.json"), JSON.stringify(local));
  return dir;
}

test("R1: every builtin kind states conductorEligible and reviewerEligible, and the proven set is exactly claude, codex, jcode and pi for conductor", () => {
  const kinds = ADAPTERS.map(adapter => adapter.kind);
  for (const kind of kinds) {
    const projection = definitionOf(kind)?.projection;
    expect(typeof projection?.conductorEligible, `${kind}.conductorEligible`).toBe("boolean");
    expect(typeof projection?.reviewerEligible, `${kind}.reviewerEligible`).toBe("boolean");
  }
  const conductors = SUPPORTED_PEERS.filter(peer => definitionOf(peer)?.projection?.conductorEligible === true).sort();
  expect(conductors).toEqual(["claude", "codex", "jcode", "pi"]);
  expect(SUPPORTED_PEERS.filter(peer => definitionOf(peer)?.projection?.reviewerEligible !== true)).toEqual(["agy"]);
});

test("R1: roleEligibility answers with a reason and a fix, and a headless form is refused with the start-mode fix", () => {
  expect(roleEligibility("claude", "conductor")).toEqual({ eligible: true });
  expect(roleEligibility("codex", "conductor", "tui")).toEqual({ eligible: true });
  const headless = roleEligibility("codex", "conductor", "headless");
  expect(headless.eligible).toBe(false);
  expect(headless.reason).toMatch(/starts headless/);
  expect(headless.fix).toMatch(/ahub settings set peers\.codex\.start_mode tui/);
  expect(roleEligibility("codex", "conductor")).toEqual({ eligible: true });
  for (const peer of ["local", "agy", "kimi", "qwen"]) {
    const verdict = roleEligibility(peer, "conductor", "tui");
    expect(verdict.eligible, peer).toBe(false);
    expect(verdict.reason, peer).toMatch(/cannot conduct/);
  }
  expect(roleEligibility("pi", "planner").eligible).toBe(false);
  expect(roleEligibility("claude", "planner")).toEqual({ eligible: true });
  expect(roleEligibility("agy", "reviewer").eligible).toBe(false);
  expect(roleEligibility("kimi", "reviewer")).toEqual({ eligible: true });
  expect(roleEligibility("not-a-kind", "conductor")).toEqual({ eligible: true });
});

test("R2: the ceiling keeps what the old loader kept and drops an ineligible or headless conductor with one notice that names the fix", () => {
  const plain = applyRoleCeiling("claude", ["planner", "reviewer"], undefined);
  expect(plain).toEqual({ roles: ["planner", "reviewer"], notices: [] });
  const agy = applyRoleCeiling("agy", ["implementer", "reviewer", "planner", "conductor"], undefined);
  expect(agy.roles).toEqual(["implementer"]);
  expect(agy.notices[0]).toBe("roles.agy: ignored roles outside the adapter ceiling");
  const kimi = applyRoleCeiling("kimi", ["conductor", "reviewer"], "tui");
  expect(kimi.roles).toEqual(["reviewer"]);
  expect(kimi.notices).toHaveLength(1);
  expect(kimi.notices[0]).toMatch(/^roles\.kimi: conductor ignored: kimi cannot conduct/);
  const codex = applyRoleCeiling("codex", ["conductor"], "headless");
  expect(codex.roles).toEqual([]);
  expect(codex.notices[0]).toMatch(/roles\.codex: conductor ignored: codex starts headless.*start_mode tui/);
  expect(applyRoleCeiling("codex", ["conductor"], "tui")).toEqual({ roles: ["conductor"], notices: [] });
});

test("R2: the loader ignores a headless conductor, grants it to nobody else, and a config.local.json start mode wins over the shared one", () => {
  const dir = project({ roles: { claude: ["planner", "reviewer"], codex: ["conductor"] }, peers: { codex: { start_mode: "headless" } } });
  const policy = loadConductorPolicy(dir);
  expect(policy.roles.codex).toEqual([]);
  expect(Object.entries(policy.roles).filter(([, list]) => list.includes("conductor"))).toEqual([]);
  expect(policy.notices?.join("\n")).toMatch(/roles\.codex: conductor ignored: codex starts headless/);
  // the local layer wins per peer: the shared file says headless, the person's machine says tui
  const local = project({ roles: { codex: ["conductor"] }, peers: { codex: { start_mode: "headless" } } }, { peers: { codex: { start_mode: "tui" } } });
  expect(loadConductorPolicy(local).roles.codex).toEqual(["conductor"]);
  // and the reverse: shared tui, local headless
  const reverse = project({ roles: { codex: ["conductor"] }, peers: { codex: { start_mode: "tui" } } }, { peers: { codex: { start_mode: "headless" } } });
  expect(loadConductorPolicy(reverse).roles.codex).toEqual([]);
  // the default form of a dual kind is tui, so no start_mode keeps the conductor
  expect(loadConductorPolicy(project({ roles: { codex: ["conductor"] } })).roles.codex).toEqual(["conductor"]);
  // a kind that is not eligible at all
  const none = loadConductorPolicy(project({ roles: { local: ["implementer", "conductor"] } }));
  expect(none.roles.local).toEqual(["implementer"]);
  expect(none.notices?.join("\n")).toMatch(/roles\.local: conductor ignored: local cannot conduct/);
});

test("R2: loadConfig publishes the same settled roles as the loader, so the hub never starts with an ignored conductor", () => {
  const dir = project({ roles: { codex: ["conductor"] }, peers: { codex: { start_mode: "headless" } } });
  const config = loadConfig(dir);
  expect(Object.values(config.roles).some(list => list.includes("conductor"))).toBe(false);
  expect(config.retired?.join("\n")).toMatch(/conductor ignored/);
});

test("R2: the recovery policy applies the same ceiling, so a recovery cannot re-grant a conductor the running hub ignores", () => {
  const dir = project({ roles: { codex: ["conductor"] }, peers: { codex: { start_mode: "headless" } } });
  const roles = freshRolesForTest(dir);
  expect(roles.codex).toEqual([]);
  const ok = freshRolesForTest(project({ roles: { codex: ["conductor"] } }));
  expect(ok.codex).toEqual(["conductor"]);
});

test("R2: the doctor roles row names the three holders, and warns about an ignored conductor, no planner and no reviewer", () => {
  const rostered = () => true;
  const good = rolesRow({ roles: { claude: ["planner", "reviewer"], codex: ["conductor"] }, startMode: () => "tui", rostered });
  expect(good).toEqual({ ok: true, detail: "conductor codex; planner claude; reviewer claude" });
  const none = rolesRow({ roles: { claude: ["planner", "reviewer"] }, startMode: () => undefined, rostered });
  expect(none.ok).toBe(true);
  expect(none.detail).toMatch(/conductor none \(the person conducts from ahub console\)/);
  const ignored = rolesRow({ roles: { claude: ["planner", "reviewer"], codex: [] }, declared: { codex: ["conductor"] }, startMode: peer => peer === "codex" ? "headless" : undefined, rostered });
  expect(ignored.ok).toBeUndefined();
  expect(ignored.detail).toMatch(/conductor codex is ignored: codex starts headless.*start_mode tui/);
  const noPlanner = rolesRow({ roles: { claude: ["reviewer"] }, startMode: () => undefined, rostered });
  expect(noPlanner.ok).toBeUndefined();
  expect(noPlanner.detail).toMatch(/no rostered planner is eligible/);
  const noReviewer = rolesRow({ roles: { claude: ["planner"] }, startMode: () => undefined, rostered });
  expect(noReviewer.detail).toMatch(/no rostered reviewer can run: reviews go to the person/);
  expect(noReviewer.detail).toMatch(/reviewer the person/);
  const offRoster = rolesRow({ roles: { claude: ["planner", "reviewer"] }, startMode: () => undefined, rostered: peer => peer !== "claude" });
  expect(offRoster.ok).toBeUndefined();
});

test("doctor row end to end: the row wording reads from the settled config on disk", () => {
  const dir = project({ roles: { claude: ["planner", "reviewer"], codex: ["conductor"] }, peers: { codex: { start_mode: "headless" } } });
  const settled = loadConfig(dir), layers = readInstanceConfigLayers(dir);
  const declared: Record<string, string[]> = {};
  for (const layer of layers) for (const [peer, list] of Object.entries((layer.raw.roles ?? {}) as Record<string, string[]>)) declared[peer] = list;
  const row = rolesRow({ roles: settled.roles, declared, startMode: peer => settled.peers[peer]?.start_mode, rostered: peer => peer === "claude" || peer === "codex" });
  expect(row.ok).toBeUndefined();
  expect(row.detail).toMatch(/conductor codex is ignored/);
  expect(readFileSync(join(dir, ".agenthub", "config.json"), "utf8")).toContain('"conductor"');
});

import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

test("R2: setting the conductor's start mode to headless is refused before any write, and the message says to move the role first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-role-start-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".agenthub"), { recursive: true });
  const file = join(dir, ".agenthub", "config.json");
  writeFileSync(file, JSON.stringify({ roles: { claude: ["planner", "reviewer"], codex: ["conductor"] }, memory: { enabled: false }, inference: { enabled: false, triage: false }, mlx: { enabled: false }, snapshots: { enabled: false } }));
  const before = readFileSync(file, "utf8");
  const daemon = await startDaemon({ cwd: dir, stateDir: join(dir, "state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: {
    ...DEFAULT_CONFIG, roles: { ...DEFAULT_CONFIG.roles, codex: ["conductor"] }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false },
    inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
  } });
  const person = await ControlClient.connect(join(dir, "state"), { role: "console" });
  try {
    const refused = await person.request({ t: "settings_set", key: "peers.codex.start_mode", value: "headless" });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/codex holds the conductor role, which needs an interactive session; move the role first/);
    expect(readFileSync(file, "utf8")).toBe(before);
    // tui stays allowed, and a peer that is not the conductor may go headless
    expect((await person.request({ t: "settings_set", key: "peers.codex.start_mode", value: "tui" })).error ?? "").not.toMatch(/conductor role/);
    const other = await person.request({ t: "settings_set", key: "peers.kimi.start_mode", value: "headless" });
    expect(String(other.error ?? "")).not.toMatch(/conductor role/);
  } finally { person.close(); await daemon.stop(); }
}, 60_000);

test("a project-configured ACP kind keeps the roles it is given: the ceiling reads the builtin registry only, exactly as before (#525, #735)", () => {
  const adapters = { fixture: { transport: "acp", command: "never-execute-planner-fixture", displayName: "Fixture ACP", roles: ["planner", "implementer"], identity: { name: "Fixture ACP", version: "1" } } };
  const dir = project({ adapters, roles: { fixture: ["planner", "conductor"] } });
  expect(loadConductorPolicy(dir).roles.fixture).toEqual(["planner", "conductor"]);
  expect(freshRoles(readInstanceConfigLayers(dir), readInstanceConfig(dir)).fixture).toEqual(["planner", "conductor"]);
});

test("#1063: a declared second conductor on an ineligible peer is still refused by the loader and by recovery, which agree", () => {
  const dir = project({ roles: { codex: ["conductor"], local: ["conductor"] } });
  expect(() => loadConductorPolicy(dir)).toThrow(/at most one conductor/);
  expect(() => freshRolesForTest(dir)).toThrow(/at most one conductor/);
  // Across layers as merged: the shared file names one holder, config.local.json names another peer that cannot conduct.
  const layered = project({ roles: { codex: ["conductor"] } }, { roles: { kimi: ["conductor"] } });
  expect(() => loadConductorPolicy(layered)).toThrow(/at most one conductor/);
  expect(() => freshRolesForTest(layered)).toThrow(/at most one conductor/);
  // One declared conductor on an ineligible peer is still ignored with a notice, and nobody gains it.
  const single = project({ roles: { local: ["conductor"] } });
  const policy = loadConductorPolicy(single);
  expect(policy.roles.local).not.toContain("conductor");
  expect(Object.values(policy.roles).some(list => list.includes("conductor"))).toBe(false);
  expect(policy.notices?.some(line => /conductor ignored/.test(line))).toBe(true);
});
