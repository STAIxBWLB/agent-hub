import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";
import { ALL_MACHINE_LOCAL, stripUntrusted } from "../src/hub/config-trust.ts";
import { configTier, structuralLeaf } from "../src/hub/config-tier.ts";
import { authorizeConfigLeaf, configApply, validateRawConfig } from "../src/hub/config-apply.ts";

const cleanup: string[] = [];
afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });
const registrations = () => ({ cpu: {
  publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  projects: ["fixture"], revoked: false,
} });
function fixture(name: string, runners: unknown, tracked = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-runner-config-")); cleanup.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "pipe" });
  git("init", "-q");
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub", name), JSON.stringify({ research: { enabled: false, runners } }));
  if (tracked) git("add", "--", `.agenthub/${name}`);
  return root;
}

test("runner registration loads only from untracked local config and remains separate from research logging", () => {
  const runners = registrations(), root = fixture("config.local.json", runners);
  expect(ALL_MACHINE_LOCAL).toContain("research.runners");
  expect(loadConfig(root).research).toEqual({ enabled: false, runners });
  expect(() => validateRawConfig({ research: { runners } })).not.toThrow();
  expect(() => loadConfig(fixture("config.local.json", { cpu: { ...runners.cpu, publicKey: "invalid" } }))).toThrow(/publicKey/);
});

for (const [name, tracked] of [["config.json", false], ["config.json", true], ["config.local.json", true]] as const) {
  for (const runners of [{}, null, []]) {
    test(`raw runner key refuses from ${tracked ? "tracked" : "shared"} ${name} even when empty or invalid: ${JSON.stringify(runners)}`, () => {
      const root = fixture(name, runners, tracked);
      expect(() => loadConfig(root)).toThrow(/research.runners requires untracked config.local.json/);
      expect(() => stripUntrusted({ research: { runners } }, {}, root, name)).toThrow(/research.runners requires untracked config.local.json/);
    });
  }
}

test("runner edits are live structural tier2 keys but only a confirmed person can publish them", () => {
  const key = "research.runners";
  expect(configTier("config.local.json", key.split("."))).toEqual({ tier: 2 });
  expect(configTier("config.local.json", ["research", "runners", "cpu", "revoked"])).toHaveProperty("refused");
  expect(structuralLeaf(key)).toBe(true);
  expect(configApply(key)).toEqual({ applies: "live" });
  expect(configApply("research.runners.cpu.revoked")).toEqual({ applies: "live" });
  const input = { key, before: false, after: true, source: "config" as const, sourceFile: "config.local.json", tracked: false,
    authority: "settings" as const, structural: true, confirmed: true };
  expect(authorizeConfigLeaf(input).allowed).toBe(true);
  expect(authorizeConfigLeaf({ ...input, authority: "ordinary" }).allowed).toBe(false);
  expect(authorizeConfigLeaf({ ...input, authority: "conductor" })).toMatchObject({ allowed: false, reason: "runner registration is person only" });
  expect(authorizeConfigLeaf({ ...input, confirmed: false }).allowed).toBe(false);
  for (const patch of [{ sourceFile: "config.json" }, { tracked: true }, { tracked: undefined }]) expect(authorizeConfigLeaf({ ...input, ...patch }).allowed).toBe(false);
  expect(authorizeConfigLeaf({ ...input, key: "research.runners.cpu.revoked", authority: "conductor" }).allowed).toBe(false);
});
