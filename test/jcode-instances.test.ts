import { createProjectAdapterCatalog as builtinProjectCatalog } from "../src/adapters/registry.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const native = validateInstances({ "jcode-local": { kind: "jcode", jcode_home: home, provider: "openai-compatible", model: "dgx/fast", provider_profile: "gateway", start_mode: "headless", roles: ["implementer"] } }, catalog);
  expect(native["jcode-local"]).toEqual({ kind: "jcode", jcode_home: home, provider: "openai-compatible", model: "dgx/fast", provider_profile: "gateway", start_mode: "headless", roles: ["implementer"] });
  expect(Object.isFrozen(native["jcode-local"])).toBe(true);
  const relayed = validateInstances({ "jcode-relay": { kind: "jcode", jcode_home: home, model_relay: "dgx/fast", start_mode: "headless" } }, catalog);
  expect(relayed["jcode-relay"]).toEqual({ kind: "jcode", jcode_home: home, model_relay: "dgx/fast", start_mode: "headless" });
  expect(validateInstances({ "jcode-plain": { kind: "jcode", jcode_home: home } }, catalog)["jcode-plain"]).toEqual({ kind: "jcode", jcode_home: home });
});

test("a Jcode instance without a usable home, or with a malformed field, is refused with the field named (#685)", () => {
  const refused = (entry: Record<string, unknown>, field: RegExp) => expect(() => validateInstances({ "jcode-local": { kind: "jcode", ...entry } }, catalog)).toThrow(field);
  refused({}, /jcode_home/); // missing
  refused({ jcode_home: "relative/home" }, /jcode_home/);
  refused({ jcode_home: "" }, /jcode_home/);
  refused({ jcode_home: `${home}\nx` }, /jcode_home/);
  refused({ jcode_home: 4 }, /jcode_home/);
  refused({ jcode_home: home, model_relay: "dgx/slow" }, /model_relay/);
  refused({ jcode_home: home, model_relay: "mlx/fast" }, /model_relay/);
  refused({ jcode_home: home, model: "" }, /model/);
  refused({ jcode_home: home, model: 3 }, /model/);
  refused({ jcode_home: home, provider: "bad provider" }, /provider/);
  refused({ jcode_home: home, provider_profile: "x".repeat(200) }, /provider_profile/);
  refused({ jcode_home: home, unknown_field: true }, /unsupported field/);
  refused({ jcode_home: home, start_mode: "tui" }, /start_mode/);
});

test("the Jcode-only fields belong to Jcode instances alone (#685)", () => {
  for (const kind of ["codex", "kimi", "pi", "local", "qwen"]) for (const field of ["jcode_home", "model_relay", "provider", "model", "provider_profile"]) {
    expect(() => validateInstances({ [`${kind}-worker`]: { kind, [field]: field === "model_relay" ? "dgx/fast" : "x" } }, catalog), `${kind} ${field}`).toThrow(/unsupported field/);
  }
});

test("a relay-backed instance picks its model from the relay: provider, model and profile cannot also be set to something else (#685)", () => {
  expect(() => validateInstances({ "jcode-local": { kind: "jcode", jcode_home: home, model_relay: "dgx/fast", provider: "openai" } }, catalog)).toThrow(/model_relay/);
  expect(() => validateInstances({ "jcode-local": { kind: "jcode", jcode_home: home, model_relay: "dgx/fast", provider_profile: "gateway" } }, catalog)).toThrow(/model_relay/);
  expect(() => validateInstances({ "jcode-local": { kind: "jcode", jcode_home: home, model_relay: "dgx/fast", model: "dgx/coding" } }, catalog)).toThrow(/model_relay/);
  expect(validateInstances({ "jcode-local": { kind: "jcode", jcode_home: home, model_relay: "dgx/coding", model: "dgx/coding" } }, catalog)["jcode-local"]?.model_relay).toBe("dgx/coding");
});

test("a Jcode instance may not share a home with the base Jcode or with another instance (#685)", () => {
  const two = validateInstances({ "jcode-a": { kind: "jcode", jcode_home: "/h/a" }, "jcode-b": { kind: "jcode", jcode_home: "/h/b" } }, catalog);
  expect(() => checkJcodeInstanceHomes(two, "/h/base")).not.toThrow();
  expect(() => checkJcodeInstanceHomes(two, "/h/a")).toThrow(/jcode-a.*base/);
  expect(() => checkJcodeInstanceHomes(validateInstances({ "jcode-a": { kind: "jcode", jcode_home: "/h/a" }, "jcode-b": { kind: "jcode", jcode_home: "/h/a/" } }, catalog), "/h/base")).toThrow(/jcode-b.*jcode-a|jcode-a.*jcode-b/);
  expect(() => checkJcodeInstanceHomes(validateInstances({ "jcode-a": { kind: "jcode", jcode_home: "/h/a" }, "jcode-b": { kind: "jcode", jcode_home: "/h/a/inner" } }, catalog), "/h/base")).toThrow(/nested|inside/);
  expect(() => checkJcodeInstanceHomes(validateInstances({ "jcode-a": { kind: "jcode", jcode_home: "/h/base/inner" } }, catalog), "/h/base")).toThrow(/nested|inside/);
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
