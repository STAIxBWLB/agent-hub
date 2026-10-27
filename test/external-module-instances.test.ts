import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalModuleIdentity, externalModuleIdentityCurrent, loadExternalAdapterDefinitions, validateExternalDefinition } from "../src/adapters/external-modules.ts";
import { readInstanceConfigLayers } from "../src/hub/instance-config.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const source = (extra = "") => `({api:1,kind:"fixture",family:"fixture",displayName:"Fixture",transport:"acp",roles:["implementer","verifier","reviewer"],optional:true,defaultOnRoster:false,
trust:{onPrem:false,hubSandboxed:false},identity:{mcp:"acp-session"},permission:{genericAcp:{modes:{ask:"ask"},readOnly:"read-only"}},
start:{forms:["headless"],defaultForm:"headless",daemonPort:"acp",conductorStartable:true,hubSwitches:[],ownedFlags:[],
launch:ctx=>({cmd:"fixture-never-executed",args:[],metadata:{packageEntrypoint:ctx.entrypoint,argv:[],command:"fixture",env:{}}}),create:()=>{throw new Error("fixture not started")}},
session:{idField:"sessionId",currentId:()=>undefined},turnEnd:"adapter",cli:{command:"fixture",startWords:()=>["fixture"]},display:{palette:{fg:"white",bg:"black"}},${extra}})`;
function rawDefinition() {
  return {
    api: 1, kind: "fixture", family: "fixture", displayName: "Fixture", transport: "acp", roles: ["implementer", "verifier", "reviewer"], optional: true, defaultOnRoster: false,
    trust: { onPrem: false, hubSandboxed: false }, identity: { mcp: "acp-session" }, permission: { unmanaged: "fixture unmanaged" },
    start: { forms: ["headless"], defaultForm: "headless", daemonPort: "acp", conductorStartable: true, hubSwitches: [], ownedFlags: [],
      launch: () => { throw new Error("fixture launch not called"); }, create: () => { throw new Error("fixture factory not called"); } },
    session: { idField: "sessionId", currentId: () => undefined }, turnEnd: "adapter", cli: { command: "fixture", startWords: () => ["fixture"] }, display: { palette: { fg: "white", bg: "black" } },
  };
}
function fixture(extra: string) {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-module-instances-"))); cleanup.push(cwd);
  expect(hubGitSync(["init", "-q", cwd], { encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(cwd, ".agenthub", "adapters"), { recursive: true });
  const body = `export const definition=${source(extra)};`, entry = join(cwd, ".agenthub", "adapters", "fixture.mjs");
  writeFileSync(entry, body, { mode: 0o600 });
  const pin = createHash("sha256").update(body).digest("hex");
  writeFileSync(join(cwd, ".agenthub", "config.local.json"), JSON.stringify({ adapter_modules: [{ path: "./.agenthub/adapters/fixture.mjs", sha256: pin }] }), { mode: 0o600 });
  return { cwd, entry, pin };
}

test("#754 explicit external opt-in normalizes a frozen headless role ceiling", () => {
  const definition = validateExternalDefinition({ ...rawDefinition(), headlessInstances: { form: "headless", roles: ["implementer", "verifier", "reviewer"] } });
  expect(definition.headlessInstances).toEqual({ form: "headless", roles: ["implementer", "verifier", "reviewer"] });
  expect(definition.instances).toEqual({ mode: "headless", roles: ["implementer", "verifier", "reviewer"] });
  expect(Object.isFrozen(definition.headlessInstances?.roles)).toBe(true);
  expect(Object.isFrozen(definition.instances)).toBe(true);
  expect(externalModuleIdentity(definition)).toBeUndefined();
  expect(validateExternalDefinition(rawDefinition()).instances).toBeUndefined();
});

for (const policy of [
  undefined, null, { form: "tui", roles: ["reviewer"] }, { form: "headless", roles: [] },
  { form: "headless", roles: ["planner"] }, { form: "headless", roles: ["conductor"] },
  { form: "headless", roles: ["reviewer", "reviewer"] }, { form: "headless", roles: ["unknown"] },
  { form: "headless", roles: ["reviewer"], create: () => undefined }, { form: "headless", roles: ["reviewer"], fresh: true },
]) test("#754 unsupported external instance opt-in refuses", () => {
  expect(() => validateExternalDefinition({ ...rawDefinition(), headlessInstances: policy })).toThrow();
});

test("#754 an instance policy cannot exceed the module's own role subset", () => {
  expect(() => validateExternalDefinition({ ...rawDefinition(), roles: ["implementer"], headlessInstances: { form: "headless", roles: ["reviewer"] } })).toThrow(/role ceiling/);
});

test("#754 opt-in accessors and callback-bearing policy reject without invoking them", () => {
  let invoked = false;
  const policy = Object.defineProperty({ form: "headless" }, "roles", { enumerable: true, get() { invoked = true; return ["reviewer"]; } });
  expect(() => validateExternalDefinition({ ...rawDefinition(), headlessInstances: policy })).toThrow();
  const raw = Object.defineProperty(rawDefinition(), "headlessInstances", { enumerable: true, get() { invoked = true; return { form: "headless", roles: ["reviewer"] }; } });
  expect(() => validateExternalDefinition(raw)).toThrow();
  expect(invoked).toBe(false);
});

for (const instances of [undefined, { mode: "headless" }, { mode: "headless", roles: ["reviewer"] }]) test("#754 raw builtin instances policy is forbidden by presence", () => {
  expect(() => validateExternalDefinition({ ...rawDefinition(), instances })).toThrow(/builtin instance policy/);
});

test("#754 only captured startup definitions have immutable pin provenance", async () => {
  const f = fixture('headlessInstances:{form:"headless",roles:["implementer","verifier","reviewer"]}');
  const definition = (await loadExternalAdapterDefinitions(f.cwd, readInstanceConfigLayers(f.cwd)))[0]!;
  const identity = externalModuleIdentity(definition)!;
  expect(identity).toEqual({ projectRoot: f.cwd, modulePath: ".agenthub/adapters/fixture.mjs", sha256: f.pin, api: 1, capabilityDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(Object.isFrozen(identity)).toBe(true);
  expect(externalModuleIdentity({ ...definition })).toBeUndefined();
  expect(externalModuleIdentityCurrent({ ...definition })).toBe(false);
  expect(externalModuleIdentityCurrent(definition)).toBe(true);
  writeFileSync(f.entry, 'throw new Error("not the captured bundle");');
  expect(externalModuleIdentity(definition)).toBe(identity);
  expect(externalModuleIdentityCurrent(definition)).toBe(false);
});

for (const changed of ["pin", "path", "tracked", "duplicate", "missing"] as const) test(`#754 current module identity refuses changed ${changed} declaration`, async () => {
  const f = fixture('headlessInstances:{form:"headless",roles:["reviewer"]}');
  const definition = (await loadExternalAdapterDefinitions(f.cwd, readInstanceConfigLayers(f.cwd)))[0]!;
  const file = join(f.cwd, ".agenthub", "config.local.json");
  const declaration = { path: ".agenthub/adapters/fixture.mjs", sha256: f.pin };
  if (changed === "pin") writeFileSync(file, JSON.stringify({ adapter_modules: [{ ...declaration, sha256: "0".repeat(64) }] }));
  if (changed === "path") writeFileSync(file, JSON.stringify({ adapter_modules: [{ ...declaration, path: "other.mjs" }] }));
  if (changed === "tracked") expect(hubGitSync(["-C", f.cwd, "add", "-f", ".agenthub/config.local.json"], { encoding: "utf8" }).status).toBe(0);
  if (changed === "duplicate") writeFileSync(file, JSON.stringify({ adapter_modules: [declaration, declaration] }));
  if (changed === "missing") rmSync(file);
  expect(externalModuleIdentityCurrent(definition)).toBe(false);
});

test("#754 capability digests use normalized policy data and never factory source", async () => {
  const left = fixture('headlessInstances:{form:"headless",roles:["reviewer","implementer"]}');
  const right = fixture('headlessInstances:{roles:["implementer","reviewer"],form:"headless"},start:{...'+source()+'.start,create:()=>{throw new Error("different callback body")}}');
  const changed = fixture('headlessInstances:{form:"headless",roles:["implementer"]}');
  const a = (await loadExternalAdapterDefinitions(left.cwd, readInstanceConfigLayers(left.cwd)))[0]!;
  const b = (await loadExternalAdapterDefinitions(right.cwd, readInstanceConfigLayers(right.cwd)))[0]!;
  const c = (await loadExternalAdapterDefinitions(changed.cwd, readInstanceConfigLayers(changed.cwd)))[0]!;
  expect(externalModuleIdentity(a)?.capabilityDigest).toBe(externalModuleIdentity(b)?.capabilityDigest);
  expect(externalModuleIdentity(a)?.capabilityDigest).not.toBe(externalModuleIdentity(c)?.capabilityDigest);
  expect(externalModuleIdentity(a)?.sha256).not.toBe(externalModuleIdentity(b)?.sha256);
});
