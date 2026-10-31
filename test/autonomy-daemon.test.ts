import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { createHash } from "node:crypto";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import type { InstancesConfig } from "../src/hub/instances.ts";
import { Registry } from "../src/hub/registry.ts";
import { prepareAutonomyProject, runAllProjectAutonomy } from "../src/cli/autonomy-projects.ts";
import { autonomyConsentStateDir, createAutonomyConsent } from "../src/hub/autonomy-consent.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(instances?: InstancesConfig, local: Record<string, unknown> = {}, machine?: { text: string; mode?: number }) {
  const root = mkdtempSync(join(tmpdir(), "ahub-autonomy-daemon-")), cwd = join(root, "repo"), home = join(root, "hub");
  mkdirSync(cwd);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const vars = { HOME: join(root, "person"), AGENTHUB_HOME: home, CLAUDE_CONFIG_DIR: join(root, "claude"), AMEM_HOME: join(root, "memory") };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]])); Object.assign(process.env, vars);
  cleanups.push(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  if (machine) { mkdirSync(home); writeFileSync(join(home, "defaults.json"), machine.text, { mode: machine.mode ?? 0o600 }); chmodSync(join(home, "defaults.json"), machine.mode ?? 0o600); }
  mkdirSync(join(cwd, ".agenthub"));
  expect(hubGitSync(["init", "-q"], { cwd, encoding: "utf8", timeout: 1000 }).status).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, research: { enabled: false }, pi: { auto_start: false } }));
  const stateDir = join(cwd, "state"), file = join(cwd, ".agenthub/config.local.json");
  if (instances || Object.keys(local).length) writeFileSync(file, JSON.stringify({ ...local, ...(instances ? { instances } : {}) }));
  const registry = new Registry(join(home, "registry.db")), project = registry.register(cwd, stateDir); cleanups.push(() => registry.close());
  const options = { cwd: project.root, stateDir: project.stateDir, projectId: project.id, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false };
  let daemon = await startDaemon({ ...options, config: loadConfig(cwd) });
  cleanups.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => person.close());
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" }); cleanups.push(() => tools.close());
  const on = async (client = person, environment = "headless") => {
    const preview = await client.request({ t: "autonomy", action: "preview", environment });
    return client.request({ t: "autonomy", action: "on", environment, confirmed: true, confirmation: preview.confirmation });
  };
  return { person, tools, cwd: project.root, file, stateDir: project.stateDir, home, registry, project, on, stop: () => daemon.stop(), read: () => JSON.parse(readFileSync(file, "utf8")), restart: async () => {
    await daemon.stop();
    daemon = await startDaemon({ ...options, config: loadConfig(cwd) });
    const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
    return client;
  } };
}

for (const all of [false, true]) test(`offline off${all ? " --all-projects" : ""} revokes issued consent before identical defaults can be replayed`, async () => {
  const p = await fixture();
  expect((await p.on()).ok).toBe(true);
  expect((await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status.consentedPeers).toContain("codex");
  const before = readFileSync(p.file, "utf8");
  await p.stop();
  if (all) await runAllProjectAutonomy(["off", "--all-projects"], { home: p.home, environment: "headless", projects: [p.project], prepare: project => prepareAutonomyProject(project, "headless", false, p.registry), ask: async () => { throw new Error("off never asks"); }, print() {} });
  else { const prepared = await prepareAutonomyProject(p.project, "headless", false, p.registry); try { await prepared.apply(); } finally { prepared.close(); } }
  expect(p.read().permission_modes?.codex).toBeUndefined();
  writeFileSync(p.file, before);
  rmSync(join(p.home, "defaults.json"), { force: true });
  const client = await p.restart();
  const status = (await client.request({ t: "autonomy", action: "status", environment: "headless" })).status;
  expect(status.consentedPeers).toEqual([]);
  const peer = status.peers.find((row: any) => row.id === "codex");
  expect(peer.effectiveMode).toBe("ask");
  expect(peer.missing.some((line: string) => line.includes("no matching retained consent"))).toBe(true);
});

test("offline off refuses an A-to-B consent directory alias without clearing another project's state", async () => {
  const p = await fixture(); expect((await p.on()).ok).toBe(true); await p.stop();
  const own = autonomyConsentStateDir(p.home, p.project.id), moved = `${own}-retained`, foreign = autonomyConsentStateDir(p.home, "project-b");
  createAutonomyConsent(foreign, "project-b").confirm({ codex: { "permission_modes.codex": "never-ask" } });
  const key = join(foreign, "autonomy/autonomy-consent.key"), receipt = join(foreign, "autonomy/autonomy-consent.json");
  const beforeKey = readFileSync(key), beforeReceipt = readFileSync(receipt);
  renameSync(own, moved); symlinkSync(foreign, own);
  const output: string[] = [];
  await expect(runAllProjectAutonomy(["off", "--all-projects"], { home: p.home, environment: "headless", projects: [p.project], prepare: project => prepareAutonomyProject(project, "headless", false, p.registry), ask: async () => null, print: line => { output.push(line); } })).rejects.toThrow("1 project(s) were not applied");
  expect(output.some(line => line.includes(p.project.root) && line.includes("consent"))).toBe(true);
  expect(output.some(line => line.includes("Project autonomy off:"))).toBe(false);
  expect(readFileSync(key)).toEqual(beforeKey); expect(readFileSync(receipt)).toEqual(beforeReceipt);
  expect(existsSync(join(moved, "autonomy/autonomy-consent.key"))).toBe(true);
  expect(p.read().permission_modes.codex).toBe("never-ask");
});

test("an offline consent-clear failure names the project and cannot report off success", async () => {
  const p = await fixture(); expect((await p.on()).ok).toBe(true); await p.stop();
  const privateDirectory = join(p.home, "autonomy", createHash("sha256").update(p.project.id).digest("hex"), "autonomy");
  chmodSync(privateDirectory, 0o755);
  const output: string[] = [];
  await expect(runAllProjectAutonomy(["off", "--all-projects"], { home: p.home, environment: "headless", projects: [p.project], prepare: project => prepareAutonomyProject(project, "headless", false, p.registry), ask: async () => null, print: line => { output.push(line); } })).rejects.toThrow("1 project(s) were not applied");
  expect(output.some(line => line.includes(p.project.root) && line.includes("consent"))).toBe(true);
  expect(output.some(line => line.includes("Project autonomy off:"))).toBe(false);
  expect(p.read().permission_modes.codex).toBe("never-ask");
  expect(p.registry.get(p.project.id)?.instanceId).toBeNull();
});

for (const [name, machine, approved] of [
  ["matching trusted opt-in", { text: '{"schema":1,"autonomy":true}' }, true],
  ["unsafe writable opt-in", { text: '{"schema":1,"autonomy":true}', mode: 0o666 }, false],
  ["forged permission fields", { text: '{"schema":1,"autonomy":true,"permission_modes":{"codex":"never-ask"}}' }, false],
  ["missing machine opt-in", undefined, false],
] as const) test(`startup issues retained consent only for ${name}`, async () => {
  const p = await fixture(undefined, { permission_modes: { codex: "never-ask" } }, machine);
  const status = (await p.person.request({ t: "autonomy", action: "status", environment: "terminal" })).status;
  expect(status.consentedPeers.includes("codex")).toBe(approved);
  expect(status.peers.find((peer: any) => peer.id === "codex").effectiveMode).toBe(approved ? "never-ask" : "ask");
  expect(existsSync(join(p.home, "autonomy"))).toBe(approved);
});

test("machine opt-in cannot approve a default sourced from tracked/shared configuration", async () => {
  const p = await fixture(undefined, {}, { text: '{"schema":1,"autonomy":true}' });
  const shared = join(p.cwd, ".agenthub/config.json"), config = JSON.parse(readFileSync(shared, "utf8"));
  config.permission_modes = { codex: "never-ask" }; writeFileSync(shared, JSON.stringify(config));
  const client = await p.restart();
  expect((await client.request({ t: "autonomy", action: "status", environment: "terminal" })).status.consentedPeers).toEqual([]);
  expect(existsSync(join(p.home, "autonomy"))).toBe(false);
});

test("daemon refuses agents and unconfirmed on; person apply/off and whole-preset undo retain settings semantics", async () => {
  const p = await fixture();
  for (const action of ["on", "off", "status", "preview"]) {
    const refused = await p.tools.request({ t: "autonomy", action, environment: "headless", confirmed: true });
    expect(refused.ok).toBe(false); expect(refused.error).toContain("person-only");
  }
  expect((await p.person.request({ t: "autonomy", action: "on", environment: "headless" })).ok).toBe(false);
  const applied = await p.on();
  expect(applied.ok, JSON.stringify(applied)).toBe(true);
  expect(p.read().tasks.auto_pull).toBe(true);
  expect(p.read().permission_modes.codex).toBe("never-ask");
  const retained = await p.person.request({ t: "autonomy", action: "status", environment: "headless" });
  expect(retained.status.consentedPeers).toContain("codex");
  const settings = await p.person.request({ t: "settings_get" });
  expect(settings.undo).toBe("autonomy.preset");
  expect((settings.rows as any[]).find(row => row.key === "tasks.auto_pull").value).toBe(true);
  expect((await p.person.request({ t: "autonomy", action: "off", environment: "terminal" })).ok).toBe(true);
  expect(p.read()._autonomy).toBeUndefined();
  expect(p.read().tasks?.auto_pull).toBeUndefined();
  expect((await p.person.request({ t: "settings_undo" })).ok).toBe(false);
  expect((await p.person.request({ t: "settings_undo", confirm: "autonomy" })).ok).toBe(true);
  expect(p.read().tasks.auto_pull).toBe(true);
  expect((await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status.consentedPeers).toEqual([]);
  expect((await p.on()).ok).toBe(true);
  expect((await p.person.request({ t: "settings_undo", confirm: "autonomy" })).ok).toBe(true);
  expect((await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status.consentedPeers).toEqual([]);
  expect((await p.person.request({ t: "autonomy", action: "off", environment: "terminal" })).ok).toBe(true);
  expect(p.read()._autonomy).toBeUndefined();
});

test("autonomy plans and applies a declared unmanaged reviewer without a permission default", async () => {
  const p = await fixture({ "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } });
  const preview = await p.person.request({ t: "autonomy", action: "preview", environment: "terminal" });
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  expect(preview.lines.some((line: string) => line.startsWith("permission_modes.codex-review:"))).toBe(false);
  expect(preview.lines).toContain("peers.codex-review.start_mode: headless (next peer start)");
  const applied = await p.person.request({ t: "autonomy", action: "on", environment: "terminal", confirmed: true, confirmation: preview.confirmation });
  expect(applied.ok, JSON.stringify(applied)).toBe(true);
  expect(p.read().permission_modes["codex-review"]).toBeUndefined();
  expect(p.read().permission_modes.codex).toBe("never-ask");
  expect(p.read().peers["codex-review"].start_mode).toBe("headless");
  const status = (await p.person.request({ t: "autonomy", action: "status", environment: "terminal" })).status;
  const reviewer = status.peers.find((peer: any) => peer.id === "codex-review");
  expect(reviewer).toMatchObject({ effectiveMode: "unmanaged", nextMode: null });
  expect(reviewer.missing).toContain("Native permissions are not managed by the hub in this form; configure them in the native client.");
});

test("status names current effective evidence and unknown guards without granting a native bypass", async () => {
  const p = await fixture();
  const result = await p.person.request({ t: "autonomy", action: "status", environment: "orca" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.status.environment).toBe("orca");
  expect(result.status.peers.length).toBeGreaterThanOrEqual(8);
  for (const peer of result.status.peers) {
    expect(peer.effectiveMode).toBeString();
    expect(peer.floor).toHaveLength(8);
    expect(peer.floor.every((row: any) => row.status !== "structural-guard")).toBe(true);
  }
});

test("only the confirmed console path retains consent across restart, and one edited peer loses its own consent", async () => {
  const p = await fixture();
  expect((await p.on()).ok).toBe(true);
  const restarted = await p.restart();
  let status = (await restarted.request({ t: "autonomy", action: "status", environment: "headless" })).status;
  expect(status.consentedPeers).toContain("codex");
  expect(status.peers.find((peer: any) => peer.id === "codex").effectiveMode).toBe("never-ask");
  const edited = p.read(); edited.permission_modes.codex = "ask-when-needed"; writeFileSync(p.file, JSON.stringify(edited));
  expect((await restarted.request({ t: "settings_reload" })).ok).toBe(true);
  status = (await restarted.request({ t: "autonomy", action: "status", environment: "headless" })).status;
  expect(status.consentedPeers).not.toContain("codex");
  expect(status.consentedPeers).toContain("pi");
});

test("a forged project ownership marker does not confirm never-ask", async () => {
  const p = await fixture();
  writeFileSync(p.file, JSON.stringify({ permission_modes: { codex: "never-ask" }, _autonomy: { version: 1, owned: [{ key: "permission_modes.codex", previous: null, written: "never-ask" }] } }));
  const restarted = await p.restart();
  const status = (await restarted.request({ t: "autonomy", action: "status", environment: "headless" })).status;
  expect(status.consentedPeers).toEqual([]);
  expect(status.peers.find((peer: any) => peer.id === "codex").effectiveMode).toBe("ask");
});

test("a changed file invalidates the concrete preview before any preset or consent write", async () => {
  const p = await fixture();
  const preview = await p.person.request({ t: "autonomy", action: "preview", environment: "headless" });
  writeFileSync(p.file, JSON.stringify({ approvals: { notify: false } }));
  const refused = await p.person.request({ t: "autonomy", action: "on", environment: "headless", confirmed: true, confirmation: preview.confirmation });
  expect(refused.ok).toBe(false);
  expect(refused.error).toContain("preview is stale");
  expect(p.read()).toEqual({ approvals: { notify: false } });
  expect((await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status.consentedPeers).toEqual([]);
});

test("forged restoration metadata cannot block off or invent a prior mode", async () => {
  const p = await fixture();
  expect((await p.on()).ok).toBe(true);
  const forged = p.read();
  forged._autonomy.owned.find((row: any) => row.key === "permission_modes.codex").previous = "ask-when-needed";
  writeFileSync(p.file, JSON.stringify(forged));
  const result = await p.person.request({ t: "autonomy", action: "off", environment: "headless" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(p.read().permission_modes?.codex).toBeUndefined();
  expect(p.read()._autonomy).toBeUndefined();
  expect((await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status.consentedPeers).toEqual([]);
});

test("a forged project-state undo row is not a host-issued preset transaction", async () => {
  const p = await fixture();
  expect((await p.on()).ok).toBe(true);
  const current = readFileSync(p.file, "utf8");
  writeFileSync(join(p.stateDir, "settings-undo.json"), JSON.stringify({ file: "config.local.json", key: "autonomy.preset", previous: '{"action_policy":{"enabled":false}}', written: createHash("sha256").update(current).digest("hex"), at: Date.now(), keys: ["action_policy.enabled"] }));
  const result = await p.person.request({ t: "settings_undo", confirm: "autonomy" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.text).toContain("fell back to removing");
  expect(p.read().permission_modes?.codex).toBeUndefined();
  expect(p.read().action_policy).toBeUndefined();
  expect((await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status.consentedPeers).toEqual([]);
});

test("mode consent remains valid when the person's separate action policy or start default changes", async () => {
  const p = await fixture();
  expect((await p.on()).ok).toBe(true);
  expect(p.read().action_policy).toEqual({ floor: true });
  expect((await p.person.request({ t: "settings_set", key: "action_policy.enabled", value: false })).ok).toBe(true);
  expect((await p.person.request({ t: "settings_set", key: "peers.codex.start_mode", value: "tui" })).ok).toBe(true);
  const status = (await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status;
  expect(status.consentedPeers).toContain("codex");
  expect(status.peers.find((peer: any) => peer.id === "codex").floor.every((row: any) => row.status === "not-enforced")).toBe(true);
});

test("reapplying another environment preserves an already confirmed unchanged mode outside the new target form", async () => {
  const p = await fixture();
  expect((await p.on()).ok).toBe(true);
  expect((await p.on(p.person, "terminal")).ok).toBe(true);
  const status = (await p.person.request({ t: "autonomy", action: "status", environment: "terminal" })).status;
  expect(status.consentedPeers).toContain("kimi");
  expect(status.peers.find((peer: any) => peer.id === "kimi").effectiveMode).toBe("unmanaged");
  expect(p.read().permission_modes.kimi).toBe("never-ask");
});

test("controlled recovery refuses a target that cannot parse active preset metadata before taking a hold", async () => {
  const p = await fixture();
  const { status } = await p.person.request({ t: "status" });
  const targetFeatures = DAEMON_FEATURES.filter(feature => feature !== "project_autonomy");
  expect((await p.person.request({ t: "recovery", op: "inspect", expectedInstanceId: status.instanceId, targetFeatures })).ok).toBe(true);
  expect((await p.on()).ok).toBe(true);
  for (const op of ["inspect", "prepare"]) {
    const result = await p.person.request({ t: "recovery", op, expectedInstanceId: status.instanceId, targetFeatures });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("target lacks project_autonomy");
  }
  expect((await p.person.request({ t: "recovery", op: "inspect", expectedInstanceId: status.instanceId })).recovery.phase).toBeUndefined();
  expect((await p.person.request({ t: "autonomy", action: "off", environment: "headless" })).ok).toBe(true);
  expect((await p.person.request({ t: "recovery", op: "inspect", expectedInstanceId: status.instanceId, targetFeatures })).ok).toBe(true);
});

for (const metadata of [undefined, { version: 1, owned: [] }, { version: 0, owned: "forged" }]) test(`off removes the fixed preset keys with missing or stale metadata ${JSON.stringify(metadata)}`, async () => {
  const p = await fixture();
  expect((await p.on()).ok).toBe(true);
  const changed = p.read();
  if (metadata === undefined) delete changed._autonomy;
  else changed._autonomy = metadata;
  changed.approvals = { notify: false };
  writeFileSync(p.file, JSON.stringify(changed));
  const result = await p.person.request({ t: "autonomy", action: "off", environment: "terminal" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(p.read().permission_modes?.codex).toBeUndefined();
  expect(p.read().tasks?.auto_pull).toBeUndefined();
  expect(p.read().task_sweep?.auto_reassign).toBeUndefined();
  expect(p.read()._autonomy).toBeUndefined();
  expect(p.read().approvals).toEqual({ notify: false });
  expect((await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status.consentedPeers).toEqual([]);
});

test("confirmed on replaces unissued metadata and issues fresh consent", async () => {
  const p = await fixture();
  writeFileSync(p.file, JSON.stringify({ permission_modes: { codex: "ask" }, _autonomy: { version: 0, owned: "forged" } }));
  const result = await p.on();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(p.read().permission_modes.codex).toBe("never-ask");
  expect(p.read()._autonomy.version).toBe(1);
  expect((await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status.consentedPeers).toContain("codex");
});

test("the preset turns the floor on and status reads the host verdict per class, never a guard it did not verify (#999 T3)", async () => {
  const p = await fixture();
  const before = (await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status;
  expect(before.peers.every((peer: any) => peer.floor.every((row: any) => row.status !== "structural-guard"))).toBe(true);
  expect((await p.on()).ok).toBe(true);
  expect(p.read().action_policy).toEqual({ floor: true });
  const status = (await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status;
  for (const peer of status.peers) {
    expect(peer.floor).toHaveLength(8);
    expect(peer.floor.every((row: any) => row.status !== "structural-guard")).toBe(true);
    // A class is hub-enforced only for a peer whose calls the hub sees first; the others name the guard they rest on and that the hub did not verify it.
    for (const row of peer.floor) if (row.status === "not-enforced") expect(row.reason.length).toBeGreaterThan(0);
  }
  const codex = status.peers.find((peer: any) => peer.id === "codex");
  expect(codex.floor.find((row: any) => row.class === "force-push").reason).toContain("GitHub branch protection");
  expect(codex.floor.find((row: any) => row.class === "force-push").reason).toContain("has not verified");
  expect(codex.floor.find((row: any) => row.class === "external-send").reason).toContain("no structural guard is named");
  expect((await p.person.request({ t: "autonomy", action: "off", environment: "headless", confirmed: true })).ok).toBe(true);
  expect(p.read().action_policy).toBeUndefined();
});
