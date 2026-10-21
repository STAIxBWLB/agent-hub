import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adapterModuleDeclarations, assertModuleBundle, loadExternalAdapterDefinitions, readAdapterModuleDeclarations, validateExternalDefinition } from "../src/adapters/external-modules.ts";
import { externalAdapterMetadata } from "../src/adapters/external-metadata.ts";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { readInstanceConfig, readInstanceConfigLayers } from "../src/hub/instance-config.ts";
import { hubGitSync as gitSync } from "../src/hub/git.ts";
const hubGitSync = (args: string[]) => gitSync(args, { encoding: "utf8" });
import { configApply, validateRawConfig } from "../src/hub/config-apply.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { parseConfigSources, configSourceTexts } from "../src/hub/config-reload.ts";
import { settingDef } from "../src/hub/settings.ts";
import { peerRosterConfig, rosterAllows } from "../src/hub/roster.ts";

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = (source: string) => createHash("sha256").update(source).digest("hex");
const definitionSource = (extra = "") => `({api:1,kind:"fixture",family:"fixture",displayName:"Fixture",transport:"acp",roles:["implementer"],optional:true,defaultOnRoster:false,
trust:{onPrem:false,hubSandboxed:false},identity:{mcp:"acp-session"},permission:{unmanaged:"fixture unmanaged"},
start:{forms:["headless"],defaultForm:"headless",daemonPort:"acp",conductorStartable:true,hubSwitches:[],ownedFlags:[],
launch:ctx=>({cmd:"fixture-never-executed",args:[],metadata:{packageEntrypoint:ctx.entrypoint,argv:[],command:"fixture",env:{}}}),create:()=>{throw new Error("fixture factory not started")}},
session:{idField:"sessionId",currentId:()=>undefined},turnEnd:"adapter",cli:{command:"fixture",startWords:()=>["fixture"]},display:{palette:{fg:"white",bg:"black"}},${extra}})`;
function fixture(source = `export const definition=${definitionSource()};`) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-module-")); cleanup.push(cwd);
  expect(hubGitSync(["init", "-q", cwd]).status).toBe(0);
  mkdirSync(join(cwd, ".agenthub", "adapters"), { recursive: true });
  const entry = join(cwd, ".agenthub", "adapters", "fixture.mjs");
  writeFileSync(entry, source, { mode: 0o600 });
  const declaration = { path: ".agenthub/adapters/fixture.mjs", sha256: sha(source) };
  const save = (value: unknown, name = "config.local.json") => writeFileSync(join(cwd, ".agenthub", name), JSON.stringify({ adapter_modules: value }), { mode: 0o600 });
  save([declaration]);
  return { cwd, entry, declaration, save, layers: () => readInstanceConfigLayers(cwd) };
}

test("A4 a pinned local bundle loads once into an immutable project catalog", async () => {
  const f = fixture(), definitions = await loadExternalAdapterDefinitions(f.cwd, f.layers());
  expect(definitions).toHaveLength(1);
  expect(Object.isFrozen(definitions)).toBe(true);
  expect(Object.isFrozen(definitions[0]?.start)).toBe(true);
  const catalog = createProjectAdapterCatalog(undefined, definitions);
  expect(catalog.definitionOf("fixture")?.displayName).toBe("Fixture");
  expect(createProjectAdapterCatalog().definitionOf("fixture")).toBeUndefined();
  expect(() => createProjectAdapterCatalog(undefined, [...definitions, ...definitions])).toThrow(/collision/);
});
test("A4 builtin instance namespaces cannot be claimed by an external kind", async () => {
  const f = fixture(`export const definition=${definitionSource().replaceAll('"fixture"', '"codex-helper"')};`);
  await expect(loadExternalAdapterDefinitions(f.cwd, f.layers())).rejects.toThrow(/reserved/);
});

for (const name of ["config.json", "config.local.json"] as const) test(`A4 ${name} cannot load module code when shared or tracked`, async () => {
  const marker = "__a4_untrusted_" + name;
  delete (globalThis as Record<string, unknown>)[marker];
  const f = fixture(`globalThis[${JSON.stringify(marker)}]=true;export const definition=${definitionSource()};`);
  f.save([], "config.local.json"); f.save([f.declaration], name);
  if (name === "config.local.json") expect(hubGitSync(["-C", f.cwd, "add", "-f", ".agenthub/config.local.json"]).status).toBe(0);
  const capture = readAdapterModuleDeclarations(f.cwd, f.layers());
  expect(capture.modules).toHaveLength(0); expect(capture.ignored.join(" ")).toContain("ignored");
  expect(await loadExternalAdapterDefinitions(f.cwd, f.layers())).toHaveLength(0);
  expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
});

test("A4 a cloned tracked local config never evaluates its pinned entry", async () => {
  const marker = "__a4_cloned_module";
  delete (globalThis as Record<string, unknown>)[marker];
  const f = fixture(`globalThis[${JSON.stringify(marker)}]=true;export const definition=${definitionSource()};`);
  expect(hubGitSync(["-C", f.cwd, "add", "-f", "--all"]).status).toBe(0);
  expect(hubGitSync(["-C", f.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]).status).toBe(0);
  const clone = mkdtempSync(join(tmpdir(), "ahub-module-clone-")); cleanup.push(clone);
  expect(hubGitSync(["clone", "-q", "--no-local", f.cwd, clone]).status).toBe(0);
  expect(await loadExternalAdapterDefinitions(clone, readInstanceConfigLayers(clone))).toHaveLength(0);
  expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
});

test("A4 wrong hash refuses before any module side effect", async () => {
  const f = fixture(), marker = join(f.cwd, "evaluated");
  writeFileSync(f.entry, `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"ran");export const definition=${definitionSource()};`);
  await expect(loadExternalAdapterDefinitions(f.cwd, f.layers())).rejects.toThrow(/hash/);
  expect(existsSync(marker)).toBe(false);
});

for (const mode of ["outside", "file symlink", "directory symlink", "world writable", "directory", "missing", "oversized"] as const) test(`A4 module path refuses ${mode}`, async () => {
  const f = fixture(), source = readFileSync(f.entry, "utf8");
  if (mode === "outside") { const outside = mkdtempSync(join(tmpdir(), "ahub-module-outside-")); cleanup.push(outside); const target = join(outside, "entry.mjs"); writeFileSync(target, source); f.save([{ path: target, sha256: sha(source) }]); }
  if (mode === "file symlink") { const target = join(f.cwd, "target.mjs"); writeFileSync(target, source); rmSync(f.entry); symlinkSync(target, f.entry); }
  if (mode === "directory symlink") { const target = join(f.cwd, "other"); mkdirSync(target); writeFileSync(join(target, "fixture.mjs"), source); rmSync(join(f.cwd, ".agenthub", "adapters"), { recursive: true }); symlinkSync(target, join(f.cwd, ".agenthub", "adapters")); }
  if (mode === "world writable") chmodSync(f.entry, 0o666);
  if (mode === "directory") { rmSync(f.entry); mkdirSync(f.entry); }
  if (mode === "missing") rmSync(f.entry);
  if (mode === "oversized") { const large = " ".repeat(2 * 1024 * 1024 + 1); writeFileSync(f.entry, large); f.save([{ ...f.declaration, sha256: sha(large) }]); }
  await expect(loadExternalAdapterDefinitions(f.cwd, f.layers())).rejects.toThrow(/external adapter/);
});

for (const source of [
  'import "./sibling.mjs";', 'import "some-package";', 'import "@staix/agent-hub/conformance";', 'import "bun:ffi";', 'import "bun:test";', 'import("node:fs");', 'const name="node:fs";import(name);',
  'require("node:fs");', 'const r=require;r("node:fs");', 'eval("1");', 'const e=eval;e("1");', 'new Function("return 1")();',
]) test(`A4 unbundled or dynamic loading is rejected: ${source}`, () => {
  expect(() => assertModuleBundle(source)).toThrow();
});

for (const declaration of [{ path: "x" }, { path: "x", sha256: "x" }, { path: "", sha256: "a".repeat(64) }, { path: "x", sha256: "a".repeat(64), command: "evil" }]) test("A4 module declarations require exactly a bounded path and content pin", () => {
  expect(() => adapterModuleDeclarations([declaration])).toThrow();
});
test("A4 declaration accessors and proxies are rejected without invoking them", () => {
  let ran = false;
  const getter = Object.defineProperty({}, "path", { enumerable: true, get() { ran = true; return "x"; } });
  expect(() => adapterModuleDeclarations([getter])).toThrow();
  expect(() => adapterModuleDeclarations(new Proxy([], { get() { ran = true; return 0; } }))).toThrow();
  expect(ran).toBe(false);
});

for (const extra of ['api:999', 'kind:"codex"', 'family:"claude"', 'trust:{onPrem:true,hubSandboxed:false}', 'defaultOnRoster:true', 'roles:["conductor"]', 'instances:{mode:"headless"}', 'routing:{}', 'reviewer:{}', 'hooks:{factsHook:{}}', 'projection:{plannerEligible:true}', 'start:{daemonPort:"pi-rpc"}']) test(`A4 incompatible or privileged definition refuses ${extra}`, async () => {
  const f = fixture(`export const definition=${definitionSource(extra)};`);
  await expect(loadExternalAdapterDefinitions(f.cwd, f.layers())).rejects.toThrow();
});
test("A4 source errors are withheld even when they impersonate a loader error", async () => {
  const f = fixture('throw new Error("external adapter: PRIVATE_SOURCE_CANARY");');
  let error = ""; try { await loadExternalAdapterDefinitions(f.cwd, f.layers()); } catch (e) { error = (e as Error).message; }
  expect(error).toContain("details withheld"); expect(error).not.toContain("PRIVATE_SOURCE_CANARY");
});
test("A4 sync configuration reads never execute an external bundle", () => {
  const f = fixture('throw new Error("MUST_NOT_IMPORT_IN_CLI");');
  expect(readInstanceConfig(f.cwd).adapter_modules).toEqual([f.declaration]);
  expect(readInstanceConfig(f.cwd).catalog.definitionOf("fixture")).toBeUndefined();
});
test("A4 unresolved module roster rows retain only bounded booleans and grant no roster admission", () => {
  const catalog = createProjectAdapterCatalog();
  const roster = peerRosterConfig({ fixture: true }, undefined, catalog, true);
  expect(roster).toEqual({ fixture: true });
  expect(rosterAllows(roster, "fixture", false, undefined, catalog, true)).toBe(false);
  expect(rosterAllows(roster, "unrelated-client", false, undefined, catalog, true)).toBe(true);
  expect(() => peerRosterConfig({ fixture: "true" }, undefined, catalog, true)).toThrow();
  expect(() => peerRosterConfig({ "bad/id": true }, undefined, catalog, true)).toThrow();
  expect(() => peerRosterConfig({ fixture: true }, undefined, catalog)).toThrow();
});
test("A4 module settings are never editable and changes require restart", () => {
  expect(settingDef("adapter_modules")).toContain("never editable");
  expect(configApply("adapter_modules").applies).toBe("restart");
  expect(() => externalAdapterMetadata([{ kind: "fixture", displayName: "Fixture", path: "private" }])).toThrow();
});


test("A4 definition accessors are rejected without invocation", () => {
  let ran = false;
  expect(() => validateExternalDefinition(Object.defineProperty({}, "api", { enumerable: true, get() { ran = true; return 1; } }))).toThrow();
  expect(ran).toBe(false);
});

test("A4 captured bundle bytes survive a source replacement after scanning", async () => {
  const f = fixture(), original = Bun.Transpiler;
  let replaced = false;
  const shim = new Proxy(original, { construct(target, args) {
    const transpiler = Reflect.construct(target, args);
    return new Proxy(transpiler, { get(object, property) {
      const value = Reflect.get(object, property);
      if (property === "transformSync") return (...input: unknown[]) => {
        const result = value.apply(object, input);
        writeFileSync(f.entry, 'throw new Error("UNPINNED_REPLACEMENT_MUST_NOT_RUN");');
        replaced = true;
        return result;
      };
      return typeof value === "function" ? value.bind(object) : value;
    } });
  } });
  Object.defineProperty(Bun, "Transpiler", { value: shim });
  try {
    const definitions = await loadExternalAdapterDefinitions(f.cwd, f.layers());
    expect(replaced).toBe(true); expect(definitions[0]?.kind).toBe("fixture");
    expect(readFileSync(f.entry, "utf8")).toContain("UNPINNED_REPLACEMENT");
  } finally { Object.defineProperty(Bun, "Transpiler", { value: original }); }
});

for (const name of ["launch", "create", "preflight", "version"] as const) test(`A4 external ${name} callback diagnostics cannot expose source text`, async () => {
  const callback = name === "preflight" || name === "version" ? '()=>"PRIVATE_CALLBACK_CANARY"' : '()=>{throw new Error("PRIVATE_CALLBACK_CANARY")}';
  const f = fixture(`export const definition=${definitionSource(`start:{...${definitionSource()}.start,${name}:${callback}}`)};`);
  const definition = (await loadExternalAdapterDefinitions(f.cwd, f.layers()))[0]!;
  let diagnostic = "";
  try {
    if (name === "preflight") diagnostic = definition.start.preflight!({ instance: "fixture" }) ?? "";
    else if (name === "version") diagnostic = definition.start.version!({ instance: "fixture", env: {} }) ?? "";
    else if (name === "launch") definition.start.launch!({ instance: "fixture", form: "headless", projectRoot: f.cwd, stateDir: f.cwd, entrypoint: "fixture", userArgs: [], unattended: false, env: {} });
    else definition.start.create!({ instance: "fixture", projectRoot: f.cwd, stateDir: f.cwd, kindConfig: undefined, permission: "ask", mcpServers: [], daemon: { acp: { cwd: f.cwd, cmd: ["not-started"] } } });
  } catch (error) { diagnostic = (error as Error).message; }
  expect(diagnostic).toContain("details withheld"); expect(diagnostic).not.toContain("PRIVATE_CALLBACK_CANARY");
});

test("A4 external session callback failure stays unknown without exposing its exception", async () => {
  const f = fixture(`export const definition=${definitionSource('session:{idField:"sessionId",currentId:()=>{throw new Error("PRIVATE_SESSION_CANARY")}}')};`);
  const definition = (await loadExternalAdapterDefinitions(f.cwd, f.layers()))[0]!;
  const peer = { id: "fixture", state: "offline" as const, start: async () => {}, stop: async () => {}, deliver: async () => {} };
  expect(definition.session.currentId(peer)).toBeUndefined();
});

for (const words of ['()=>undefined', '()=>{throw new Error("PRIVATE_WORDS_CANARY")}', '()=>["fixture","--unattended"]']) test("A4 invalid external command words refuse before reaching UI snapshots", async () => {
  const f = fixture(`export const definition=${definitionSource(`cli:{command:"fixture",startWords:${words}}`)};`);
  let error = ""; try { await loadExternalAdapterDefinitions(f.cwd, f.layers()); } catch (e) { error = (e as Error).message; }
  expect(error).toContain("external adapter"); expect(error).not.toContain("PRIVATE_WORDS_CANARY");
});


test("A4 per-daemon imports do not share one module-global instance", async () => {
  const f = fixture(), first = await loadExternalAdapterDefinitions(f.cwd, f.layers()), second = await loadExternalAdapterDefinitions(f.cwd, f.layers());
  expect(first[0]!.start.create).not.toBe(second[0]!.start.create);
});

for (const body of ['await import("node:fs");', 'require("node:fs");', 'eval("1");', 'new Function("return 1")();']) test("A4 startup rejects dynamic loading before bundle effects", async () => {
  const marker = "__a4_dynamic_module";
  delete (globalThis as Record<string, unknown>)[marker];
  const f = fixture(`${body}globalThis[${JSON.stringify(marker)}]=true;export const definition=${definitionSource()};`);
  await expect(loadExternalAdapterDefinitions(f.cwd, f.layers())).rejects.toThrow();
  expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
});


test("A4 raw untrusted module declarations cannot enable inert roster validation (#290)", () => {
  const raw = { adapter_modules: [{ path: "ignored.mjs", sha256: "0".repeat(64) }], roster: { unresolved: true } };
  expect(() => validateRawConfig(raw)).toThrow(/unsupported peer/);
  expect(() => validateRawConfig(raw, undefined, createProjectAdapterCatalog(), false)).toThrow(/unsupported peer/);
  expect(() => validateRawConfig(raw, undefined, createProjectAdapterCatalog(), true)).not.toThrow();
});

test("A4 tracked module config agrees between load and reload parsing (#290)", () => {
  const f = fixture();
  rmSync(join(f.cwd, ".agenthub", "config.local.json"));
  writeFileSync(join(f.cwd, ".agenthub", "config.json"), JSON.stringify({ adapter_modules: [f.declaration], roster: { unresolved: true } }));
  expect(hubGitSync(["-C", f.cwd, "add", ".agenthub/config.json"]).status).toBe(0);
  expect(() => loadConfig(f.cwd)).toThrow(/unsupported peer/);
  expect(() => parseConfigSources(configSourceTexts(f.cwd), undefined, f.cwd)).toThrow(/unsupported peer/);
});
