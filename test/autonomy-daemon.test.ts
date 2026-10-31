import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { createHash } from "node:crypto";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-autonomy-daemon-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub"));
  expect(hubGitSync(["init", "-q"], { cwd, encoding: "utf8", timeout: 1000 }).status).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, research: { enabled: false }, pi: { auto_start: false } }));
  const stateDir = join(cwd, "state"), file = join(cwd, ".agenthub/config.local.json");
  const options = { cwd, stateDir, projectId: `project-${cwd.split("/").at(-1)}`, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false };
  let daemon = await startDaemon({ ...options, config: loadConfig(cwd) });
  cleanups.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => person.close());
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" }); cleanups.push(() => tools.close());
  const on = async (client = person) => {
    const preview = await client.request({ t: "autonomy", action: "preview", environment: "headless" });
    return client.request({ t: "autonomy", action: "on", environment: "headless", confirmed: true, confirmation: preview.confirmation });
  };
  return { person, tools, cwd, file, stateDir, on, read: () => JSON.parse(readFileSync(file, "utf8")), restart: async () => {
    await daemon.stop();
    daemon = await startDaemon({ ...options, config: loadConfig(cwd) });
    const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
    return client;
  } };
}

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

test("forged restoration metadata cannot invent the prior mode off restores", async () => {
  const p = await fixture();
  expect((await p.on()).ok).toBe(true);
  const forged = p.read();
  forged._autonomy.owned.find((row: any) => row.key === "permission_modes.codex").previous = "ask-when-needed";
  writeFileSync(p.file, JSON.stringify(forged));
  const result = await p.person.request({ t: "autonomy", action: "off", environment: "headless" });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("not authenticated");
  expect(p.read().permission_modes.codex).toBe("never-ask");
  expect((await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status.consentedPeers).toEqual([]);
});

test("a forged project-state undo row is not a host-issued preset transaction", async () => {
  const p = await fixture();
  expect((await p.on()).ok).toBe(true);
  const current = readFileSync(p.file, "utf8");
  writeFileSync(join(p.stateDir, "settings-undo.json"), JSON.stringify({ file: "config.local.json", key: "autonomy.preset", previous: '{"action_policy":{"enabled":false}}', written: createHash("sha256").update(current).digest("hex"), at: Date.now(), keys: ["action_policy.enabled"] }));
  const result = await p.person.request({ t: "settings_undo", confirm: "autonomy" });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("not authenticated");
  expect(readFileSync(p.file, "utf8")).toBe(current);
});

test("mode consent remains valid when the person's separate action policy or start default changes", async () => {
  const p = await fixture();
  expect((await p.on()).ok).toBe(true);
  expect(p.read().action_policy).toBeUndefined();
  expect((await p.person.request({ t: "settings_set", key: "action_policy.enabled", value: false })).ok).toBe(true);
  expect((await p.person.request({ t: "settings_set", key: "peers.codex.start_mode", value: "tui" })).ok).toBe(true);
  const status = (await p.person.request({ t: "autonomy", action: "status", environment: "headless" })).status;
  expect(status.consentedPeers).toContain("codex");
  expect(status.peers.find((peer: any) => peer.id === "codex").floor.every((row: any) => row.status === "not-enforced" && row.reason.includes("#582"))).toBe(true);
});
