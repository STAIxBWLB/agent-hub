import { createProjectAdapterCatalog as builtinProjectCatalog } from "../src/adapters/registry.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkJcodeInstanceHomes, validateInstances } from "../src/hub/instances.ts";
import { readInstanceConfig } from "../src/hub/instance-config.ts";

// issue #685: extra builtin Jcode instances, declared only in the untracked config.local.json.
const cleanups: (() => unknown)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const catalog = builtinProjectCatalog();
const home = "/Users/person/.jcode-local";

test("a Jcode instance declares its own home and optional model fields, and keeps them frozen (#685)", () => {
  const native = validateInstances({ "jcode-local": { kind: "jcode", jcode_home: home, provider: "claude", model: "claude-sonnet-5-5", provider_profile: "work", start_mode: "headless", roles: ["implementer"] } }, catalog);
  expect(native["jcode-local"]).toEqual({ kind: "jcode", jcode_home: home, provider: "claude", model: "claude-sonnet-5-5", provider_profile: "work", start_mode: "headless", roles: ["implementer"] });
  expect(Object.isFrozen(native["jcode-local"])).toBe(true);
  expect(validateInstances({ "jcode-plain": { kind: "jcode", jcode_home: home } }, catalog)["jcode-plain"]).toEqual({ kind: "jcode", jcode_home: home });
});

test("a Jcode instance without a usable home, or with a malformed field, is refused with the field named (#685)", () => {
  const refused = (entry: Record<string, unknown>, field: RegExp) => expect(() => validateInstances({ "jcode-local": { kind: "jcode", ...entry } }, catalog)).toThrow(field);
  refused({}, /jcode_home/); // missing
  refused({ jcode_home: "relative/home" }, /jcode_home/);
  refused({ jcode_home: "" }, /jcode_home/);
  refused({ jcode_home: `${home}\nx` }, /jcode_home/);
  refused({ jcode_home: 4 }, /jcode_home/);
  refused({ jcode_home: home, model_relay: "dgx/fast" }, /unsupported field/); // the hub has no model relay for Jcode (#685, scope update 2)
  refused({ jcode_home: home, model_source: { kind: "native" } }, /unsupported field/);
  refused({ jcode_home: home, api_key: "x" }, /unsupported field/); // the hub handles no model credential
  refused({ jcode_home: home, model: "" }, /model/);
  refused({ jcode_home: home, model: 3 }, /model/);
  refused({ jcode_home: home, provider: "bad provider" }, /provider/);
  refused({ jcode_home: home, provider_profile: "x".repeat(200) }, /provider_profile/);
  refused({ jcode_home: home, unknown_field: true }, /unsupported field/);
  refused({ jcode_home: home, start_mode: "tui" }, /start_mode/);
});

test("the Jcode-only fields belong to Jcode instances alone (#685)", () => {
  for (const kind of ["codex", "kimi", "pi", "local", "qwen"]) for (const field of ["jcode_home", "provider", "model", "provider_profile"]) {
    expect(() => validateInstances({ [`${kind}-worker`]: { kind, [field]: "x" } }, catalog), `${kind} ${field}`).toThrow(/unsupported field/);
  }
});

test("at most 8 Jcode instances are declared per project, and other kinds do not count toward it (#685)", () => {
  const declare = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`jcode-n${i}`, { kind: "jcode", jcode_home: `/h/n${i}` }]));
  expect(Object.keys(validateInstances(declare(8), catalog))).toHaveLength(8);
  expect(() => validateInstances(declare(9), catalog)).toThrow(/at most 8 extra Jcode instances/);
  expect(Object.keys(validateInstances({ ...declare(8), "codex-worker": { kind: "codex" } }, catalog))).toHaveLength(9);
});

test("a Jcode instance may not share a home with the base Jcode or with another instance (#685)", () => {
  const two = validateInstances({ "jcode-a": { kind: "jcode", jcode_home: "/h/a" }, "jcode-b": { kind: "jcode", jcode_home: "/h/b" } }, catalog);
  expect(() => checkJcodeInstanceHomes(two, "/h/base")).not.toThrow();
  expect(() => checkJcodeInstanceHomes(two, "/h/a")).toThrow(/jcode-a.*base/);
  expect(() => checkJcodeInstanceHomes(validateInstances({ "jcode-a": { kind: "jcode", jcode_home: "/h/a" }, "jcode-b": { kind: "jcode", jcode_home: "/h/a/" } }, catalog), "/h/base")).toThrow(/jcode-b.*jcode-a|jcode-a.*jcode-b/);
  expect(() => checkJcodeInstanceHomes(validateInstances({ "jcode-a": { kind: "jcode", jcode_home: "/h/a" }, "jcode-b": { kind: "jcode", jcode_home: "/h/a/inner" } }, catalog), "/h/base")).toThrow(/nested|inside/);
  expect(() => checkJcodeInstanceHomes(validateInstances({ "jcode-a": { kind: "jcode", jcode_home: "/h/base/inner" } }, catalog), "/h/base")).toThrow(/nested|inside/);
});

test("a symlink, a system alias or a case-only alias of another Jcode home is the same home and is refused (#685 review)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-jcode-home-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, "Base"), other = join(dir, "other"); mkdirSync(base); mkdirSync(other);
  const declare = (...homes: string[]) => validateInstances(Object.fromEntries(homes.map((jcode_home, i) => [`jcode-n${i}`, { kind: "jcode", jcode_home }])), catalog);
  // A symlink to the base home, and a symlink to an instance's home.
  symlinkSync(base, join(dir, "link-to-base")); symlinkSync(other, join(dir, "link-to-other"));
  expect(() => checkJcodeInstanceHomes(declare(join(dir, "link-to-base")), base)).toThrow(/jcode-n0.*base/);
  expect(() => checkJcodeInstanceHomes(declare(other, join(dir, "link-to-other")), base)).toThrow(/jcode-n1.*jcode-n0|same home/);
  // A symlinked ancestor makes a nested home too.
  expect(() => checkJcodeInstanceHomes(declare(join(dir, "link-to-base", "inner")), base)).toThrow(/nested|inside/);
  // A system alias: /var and /private/var (and /tmp and /private/tmp) name one directory on macOS. Both spellings of this directory are tried.
  const real = realpathSync(dir), spelled = real.startsWith("/private/") ? real.slice("/private".length) : `/private${real}`;
  mkdirSync(join(real, "x"));
  if (statSync(spelled, { throwIfNoEntry: false })?.ino === statSync(real).ino) expect(() => checkJcodeInstanceHomes(declare(join(spelled, "x")), join(real, "x"))).toThrow(/jcode-n0.*base/);
  // A case-only alias on a volume that folds case (macOS APFS by default); a case-sensitive volume has distinct directories.
  const swapped = base.replace(/Base$/, "bASE");
  let folds = false; try { folds = statSync(swapped).ino === statSync(base).ino; } catch { /* distinct on a case-sensitive volume */ }
  if (folds) expect(() => checkJcodeInstanceHomes(declare(swapped), base)).toThrow(/jcode-n0.*base/);
  else expect(() => checkJcodeInstanceHomes(declare(join(dir, "other2")), base)).not.toThrow();
  // A home that does not exist yet is judged through its nearest existing ancestor.
  expect(() => checkJcodeInstanceHomes(declare(join(dir, "link-to-base", "new-home")), base)).toThrow(/nested|inside/);
  expect(() => checkJcodeInstanceHomes(declare(join(dir, "fresh")), base)).not.toThrow();
});

test("a Jcode instance in a tracked config file is ignored with a reason; only config.local.json declares it (#685)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-jcode-inst-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const declaration = { instances: { "jcode-local": { kind: "jcode", jcode_home: home } } };
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify(declaration));
  const tracked = readInstanceConfig(dir);
  expect(tracked.instances).toBeUndefined();
  expect(tracked.ignored.join("\n")).toContain("machine-local config.local.json");
});

test("a declared Jcode instance is a known roster peer, while an undeclared jcode-<name> key stays an unsupported typo (#685)", async () => {
  const { peerRosterConfig } = await import("../src/hub/roster.ts");
  const declared = validateInstances({ "jcode-local": { kind: "jcode", jcode_home: home } }, catalog);
  expect(peerRosterConfig({ "jcode-local": true }, declared, catalog)).toEqual({ "jcode-local": true });
  expect(() => peerRosterConfig({ "jcode-local": true }, undefined, catalog)).toThrow("unsupported peer");
});

test("a Claude implementer's model in a tracked config file is ignored with a reason; only config.local.json grants it (#844)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-claude-model-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const declaration = { instances: { "claude-impl": { kind: "claude", roles: ["implementer"], start_mode: "headless", worktree: ".worktrees/claude-impl", permission_mode: "ask", model: "claude-sonnet-5-5" } } };
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify(declaration));
  const tracked = readInstanceConfig(dir);
  expect(tracked.instances).toBeUndefined();
  expect(tracked.ignored.join("\n")).toContain("machine-local config.local.json");
  // The positive leg, a trusted config.local.json granting the model, is covered end to end in test/claude-implementer-daemon.test.ts.
});
