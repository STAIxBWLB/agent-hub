import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { ALL_MACHINE_LOCAL } from "../src/hub/config-trust.ts";
import { authorizeConfigLeaf, configApply, validateRawConfig } from "../src/hub/config-apply.ts";
import { SETTINGS, checkSettingValue } from "../src/hub/settings.ts";
const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-action-config-")); cleanup.push(dir);
  expect(hubGitSync(["init", "-q"], { cwd: dir, encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(dir, ".agenthub"));
  return { dir, write: (name: string, value: unknown) => writeFileSync(join(dir, ".agenthub", name), JSON.stringify(value)),
    track: (name: string) => expect(hubGitSync(["add", "-f", `.agenthub/${name}`], { cwd: dir, encoding: "utf8" }).status).toBe(0) };
}

test("action policy overrides are local-only even when shared config is untracked", () => {
  const f = fixture(), chosen = { enabled: false, always_ask: [], budgets: { publish: 9 } };
  f.write("config.json", { action_policy: chosen });
  expect(loadConfig(f.dir).action_policy).toEqual(DEFAULT_CONFIG.action_policy);
  expect(loadConfig(f.dir).ignored?.join(" ")).toContain("only .agenthub/config.local.json");
  f.write("config.local.json", { action_policy: chosen });
  expect(loadConfig(f.dir).action_policy).toMatchObject(chosen);
  f.track("config.local.json");
  expect(loadConfig(f.dir).action_policy).toEqual(DEFAULT_CONFIG.action_policy);
  expect(loadConfig(f.dir).ignored?.join(" ")).toContain("committed to git");
  expect(ALL_MACHINE_LOCAL).toContain("action_policy");
});

test("action settings validate all configured leaves and require person confirmation to weaken", () => {
  const defs = SETTINGS.filter(def => def.key.startsWith("action_policy."));
  expect(defs).toHaveLength(6);
  for (const def of defs) {
    expect(def.store).toBe("config"); expect(configApply(def.key).applies).toBe("live");
    expect(() => checkSettingValue(def, def.type === "boolean" ? "no" : -1)).toThrow();
    const guard = { ...def };
    // the weakening direction: floor on is the weaker side of action_policy.floor, and its safe value false
    const weaker = def.key === "action_policy.floor", before = def.type === "boolean" ? !weaker : 1, after = def.type === "boolean" ? weaker : 2;
    expect(authorizeConfigLeaf({ key: def.key, before, after, source: "config", sourceFile: "config.local.json", tracked: false, authority: "ordinary", guard }).allowed).toBe(false);
    expect(authorizeConfigLeaf({ key: def.key, before, after, source: "config", sourceFile: "config.local.json", tracked: false, authority: "settings", confirmed: true, guard }).allowed).toBe(true);
    expect(authorizeConfigLeaf({ key: def.key, before, after: def.floor, source: "config", sourceFile: "config.local.json", tracked: true, authority: "settings", confirmed: true, guard }).allowed).toBe(false);
  }
  expect(() => validateRawConfig({ action_policy: { budgets: { publish: 1001 } } })).toThrow();
  expect(() => validateRawConfig({ action_policy: { always_ask: ["unknown"] } })).toThrow();
  expect(configApply("action_policy.always_ask").applies).toBe("live");
});


test("R2 action policy refuses shared reloads without offering confirmation or adopting their source", async () => {
  const f = fixture();
  const shared = { memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false },
    research: { enabled: false }, snapshots: { enabled: false }, pi: { enabled: false, auto_start: false }, approvals: { notify: false }, task_sweep: { enabled: false } };
  f.write("config.json", shared);
  const stateDir = join(f.dir, "state");
  const daemon = await startDaemon({ cwd: f.dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
  let client: ControlClient | undefined;
  try {
    client = await ControlClient.connect(stateDir, { role: "console" });
    f.write("config.json", { ...shared, action_policy: { enabled: false, budgets: { publish: 9 } } });
    const reply = await client.request({ t: "settings_reload" });
    expect(reply.ok).toBe(true);
    expect(reply.confirmation).toBeUndefined();
    expect(reply.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ key: "action_policy.enabled", reason: expect.stringContaining("config.local.json") })]));
    const { rows } = await client.request({ t: "settings_get" });
    const row = rows.find((item: { key: string }) => item.key === "action_policy.enabled");
    expect(row.source).toBe("default");
    expect(row.value).toBe(true);
    expect(row.hint).toBe("enforced for Claude (PreToolUse hook) and hub-owned ACP peers in ask mode; ahub status lists each peer that is not enforceable");
  } finally { client?.close(); await daemon.stop(); }
});


test("R2 action policy authorization requires the captured local filename before no-op or confirmation", () => {
  for (const sourceFile of [undefined, "config.json", "routing.local.toml"]) {
    const input = { key: "action_policy.enabled", before: true, after: true, source: "config" as const, sourceFile, tracked: false, authority: "terminal" as const, confirmed: true };
    expect(authorizeConfigLeaf(input)).toMatchObject({ allowed: false, reason: expect.stringContaining("config.local.json") });
    expect(authorizeConfigLeaf({ ...input, after: false }).allowed).toBe(false);
  }
});
