import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfigEditor, type ConfigEditHost } from "../src/hub/config-edit-host.ts";
import { configBackups, editRevisions } from "../src/hub/config-edit.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import type { HubEvent } from "../src/hub/events.ts";
import { gitProject } from "./fakes/git-project.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(text = 'mode = "off"\nrequired_checks = []\n') {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-instructed-sdlc-")), stateDir = join(cwd, ".agenthub/state"), file = join(cwd, ".agenthub/sdlc.toml");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  gitProject(cwd); mkdirSync(stateDir, { recursive: true }); writeFileSync(file, text);
  const events: HubEvent[] = [], intents: { by: string; paths: string[]; before: string }[] = [], notices: string[] = [];
  const control: { conductor?: string; held?: string; running: string; intent: boolean; result: "ok" | "false" | "throw" | "void"; checkHook?: () => void; intentHook?: () => void; changed: number } =
    { conductor: "claude", running: "off", intent: true, result: "ok", changed: 0 };
  const host: ConfigEditHost = { cwd, stateDir, held: () => control.held, conductor: () => control.conductor,
    runningSdlc: () => ({ mode: control.running, requiredChecks: [] }), fileSdlc: () => {
      try { const c = sdlcConfig(existsSync(file) ? Bun.TOML.parse(readFileSync(file, "utf8")) : undefined); return { mode: c.mode, requiredChecks: c.requiredChecks }; }
      catch (error) { return String(error); }
    },
    check: (_file, candidate) => { sdlcConfig(candidate === null ? undefined : Bun.TOML.parse(candidate)); control.checkHook?.(); },
    recordSdlcInstruction: (by, paths) => { intents.push({ by, paths, before: readFileSync(file, "utf8") }); control.intentHook?.(); return control.intent; },
    event: event => { if (control.result === "throw") throw new Error("synthetic audit unavailable"); if (control.result === "false") return false; if (control.result === "void") return; events.push(event); return true; },
    notify: line => { notices.push(line); }, changed: () => { control.changed++; }, pending: () => [], effective: () => undefined, declared: () => ({}), localConfig: () => ({}), reload: async () => ({ ok: true }) };
  const editor = createConfigEditor(host), read = () => readFileSync(file, "utf8");
  const configure = (input: unknown, by = "claude", current: () => void = () => {}) => editor.configureSdlc(by, input, current);
  return { cwd, stateDir, file, host, editor, control, events, intents, notices, read, configure };
}

test("instructed conductor off-to-advise uses loader, backup, durable prewrite intent and actual actor result audit", async () => {
  const original = 'mode = "off"\nrequired_checks = []\n[security]\npaths = ["src/**"]\n', f = fixture(original);
  const result = await f.configure({ mode: "advise", required_checks: ["CHECK_VALUE_CANARY", "lint"], instructionClaim: true });
  expect(result).toMatchObject({ ok: true, saved: true, by: "claude", instructionClaim: "person_direct_instruction" });
  expect(f.intents).toEqual([{ by: "claude", paths: ["sdlc.mode", "sdlc.required_checks"], before: original }]);
  expect(f.read()).toContain('mode = "advise"'); expect(f.read()).toContain('[security]\npaths = ["src/**"]');
  const backups = configBackups(f.stateDir); expect(backups).toHaveLength(1); expect(backups[0]?.file).toBe("sdlc.toml");
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({ type: "config_edit", by: "claude", source: "conductor", instructionClaim: "person_direct_instruction" });
  expect(JSON.stringify(f.events)).not.toContain("CHECK_VALUE_CANARY");
  const event = f.events[0] as Extract<HubEvent, { type: "config_edit" }>;
  expect(event.paths.map(row => row.path)).toEqual(["sdlc.mode", "sdlc.required_checks"]);
  for (const row of event.paths) { expect(row.before).toMatch(/^[a-f0-9]{16}$/); expect(row.after).toMatch(/^[a-f0-9]{16}$/); }
  expect(event.fileBefore).toMatch(/^[a-f0-9]{64}$/); expect(event.fileAfter).toMatch(/^[a-f0-9]{64}$/);
  expect(f.editor.view().sdlc).toMatchObject({ mode: "off", pending: true }); expect(f.control.changed).toBe(1);
});

test("advise-to-off and checks-only writes remain staged; person may use the narrow command too", async () => {
  const f = fixture('mode = "advise"\nrequired_checks = ["unit"]\n'); f.control.running = "advise";
  expect((await f.configure({ mode: "off", instructionClaim: true })).ok).toBe(true);
  expect((await f.configure({ required_checks: [], instructionClaim: true }, "user")).ok).toBe(true);
  expect(sdlcConfig(Bun.TOML.parse(f.read())).mode).toBe("off");
  expect(f.events[1]).toMatchObject({ by: "user", source: "terminal", instructionClaim: "person_direct_instruction" });
  expect(f.control.running).toBe("advise");
});

test("both actual-file enforce and running enforce refuse before intent, file mutation or backups", async () => {
  for (const side of ["file", "running"]) {
    const f = fixture(side === "file" ? 'mode = "enforce"\nrequired_checks = []\n' : undefined);
    if (side === "running") f.control.running = "enforce";
    if (side === "file") f.host.fileSdlc = () => ({ mode: "off", requiredChecks: [] }); // A display cache cannot hide the actual enforce file.
    const before = f.read();
    const inputs = [...(side === "file" ? [{ mode: "off", instructionClaim: true }] : []), { mode: "advise", instructionClaim: true }, { required_checks: ["unit"], instructionClaim: true }];
    for (const input of inputs) {
      const result = await f.configure(input); expect(result.ok).toBe(false); expect(String(result.error)).toContain("enforce");
      expect(f.read()).toBe(before); expect(configBackups(f.stateDir)).toEqual([]); expect(f.intents).toEqual([]); expect(f.events).toEqual([]);
    }
  }
});

test("missing claim, non-conductor and every protected field refuse without changing bytes", async () => {
  for (const input of [{ mode: "advise" }, { mode: "advise", instructionClaim: false }, { instructionClaim: true }, { mode: "enforce", instructionClaim: true },
    ...["security", "eval_check", "config_paths", "stages", "definitions", "workflow", "config.local.json", "set", "remove"].map(key => ({ mode: "advise", instructionClaim: true, [key]: "PROTECTED_CANARY" }))]) {
    const f = fixture(), before = f.read(); expect((await f.configure(input)).ok).toBe(false);
    expect(f.read()).toBe(before); expect(configBackups(f.stateDir)).toEqual([]); expect(f.intents).toEqual([]); expect(f.events).toEqual([]);
  }
  const f = fixture(); expect((await f.configure({ mode: "advise", instructionClaim: true }, "codex")).ok).toBe(false);
  f.control.conductor = undefined; expect((await f.configure({ mode: "advise", instructionClaim: true })).ok).toBe(false);
});

test("invalid check lists retain loader field paths with no backup or intent", async () => {
  for (const required_checks of [null, "unit", [null], [1], [""], ["unit", "unit"], ["x".repeat(121)], Array.from({ length: 33 }, (_, i) => `check-${i}`)]) {
    const f = fixture(), before = f.read(), result = await f.configure({ required_checks, instructionClaim: true });
    expect(result.ok).toBe(false); expect(result.field).toBe("sdlc.required_checks"); expect(String(result.error)).toContain("sdlc.required_checks");
    expect(f.read()).toBe(before); expect(f.intents).toEqual([]); expect(configBackups(f.stateDir)).toEqual([]);
  }
});

test("role, hold and session loss after candidate check or intent refuse before the write", async () => {
  for (const phase of ["check", "intent"] as const) for (const change of ["role", "hold", "session"] as const) {
    const f = fixture(), before = f.read(); let session = true;
    const mutate = () => { if (change === "role") f.control.conductor = "kimi"; if (change === "hold") f.control.held = "recovery"; if (change === "session") session = false; };
    if (phase === "check") f.control.checkHook = mutate; else f.control.intentHook = mutate;
    const result = await f.configure({ mode: "advise", instructionClaim: true }, "claude", () => { if (!session) throw new Error("session replaced"); });
    expect(result.ok).toBe(false); expect(f.read()).toBe(before); expect(configBackups(f.stateDir)).toEqual([]); expect(f.events).toEqual([]);
  }
});

test("failed intent prevents writes; false or thrown result audit failure reports saved true after the durable intent", async () => {
  const denied = fixture(), before = denied.read(); denied.control.intent = false;
  expect((await denied.configure({ mode: "advise", instructionClaim: true })).ok).toBe(false);
  expect(denied.read()).toBe(before); expect(configBackups(denied.stateDir)).toEqual([]);
  for (const resultAudit of ["false", "throw", "void"] as const) {
    const f = fixture(); f.control.result = resultAudit;
    const result = await f.configure({ mode: "advise", instructionClaim: true });
    expect(result).toMatchObject({ ok: false, saved: true }); expect(String(result.error)).toContain("result audit failed");
    expect(f.read()).toContain('mode = "advise"'); expect(f.intents).toHaveLength(1); expect(configBackups(f.stateDir)).toHaveLength(1);
  }
});

test("generic person-only settings behavior and legacy result event bytes stay unchanged", async () => {
  const f = fixture(), request = { file: "sdlc.toml", revision: editRevisions(f.cwd)["sdlc.toml"], set: [{ path: ["mode"], value: "enforce" }] };
  expect((await f.editor.apply(request, "ordinary")).ok).toBe(false);
  expect((await f.editor.apply(request, "terminal")).ok).toBe(true);
  expect(f.intents).toEqual([]); expect(f.events[0]).toMatchObject({ by: "person", source: "terminal" });
  expect(f.events[0]).not.toHaveProperty("instructionClaim");
});

test("closed top-level request rejects getters and proxies without executing instruction claims", async () => {
  const f = fixture(); let effects = 0;
  const getter = { mode: "advise" }; Object.defineProperty(getter, "instructionClaim", { enumerable: true, get() { effects++; return true; } });
  const proxy = new Proxy({}, { ownKeys() { effects++; return []; } });
  for (const input of [getter, proxy, [], { mode: "advise", instructionClaim: true, toJSON() { effects++; return {}; } }]) expect((await f.configure(input)).ok).toBe(false);
  expect(effects).toBe(0); expect(f.intents).toEqual([]); expect(configBackups(f.stateDir)).toEqual([]);
  const getterChecks: unknown[] = ["unit"]; Object.defineProperty(getterChecks, "0", { enumerable: true, get() { effects++; return "unit"; } });
  const proxyChecks = new Proxy(["unit"], { get() { effects++; return undefined; } });
  const customChecks = ["unit"]; Object.setPrototypeOf(customChecks, Object.create(Array.prototype, { map: { get() { effects++; return Array.prototype.map; } } }));
  for (const required_checks of [getterChecks, proxyChecks, customChecks]) expect((await f.configure({ required_checks, instructionClaim: true })).ok).toBe(false);
  expect(effects).toBe(0); expect(f.intents).toEqual([]);
});

test("an absent conductor port never turns an empty or undefined actor into authority", async () => {
  const f = fixture(); f.host.conductor = undefined;
  for (const by of ["", undefined]) {
    const result = await f.editor.configureSdlc(by as unknown as string, { mode: "advise", instructionClaim: true }, () => {});
    expect(result.ok).toBe(false);
  }
  expect(f.intents).toEqual([]); expect(configBackups(f.stateDir)).toEqual([]);
});

test("legacy generic apply still accepts void or expression-valued audit callbacks", async () => {
  for (const retained of [undefined, false]) {
    const f = fixture(); f.host.event = () => retained;
    const result = await f.editor.apply({ file: "sdlc.toml", revision: editRevisions(f.cwd)["sdlc.toml"], set: [{ path: ["mode"], value: "enforce" }] }, "terminal");
    expect(result).toMatchObject({ ok: true, saved: true }); expect(f.intents).toEqual([]);
  }
});

test("missing or throwing durable-intent ports never save or echo the port's failure text", async () => {
  for (const kind of ["missing", "throw"] as const) {
    const f = fixture(), before = f.read();
    f.host.recordSdlcInstruction = kind === "missing" ? undefined : () => { throw new Error("PRIVATE_AUDIT_FAILURE_CANARY"); };
    const result = await f.configure({ mode: "advise", instructionClaim: true });
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("PRIVATE_AUDIT_FAILURE_CANARY");
    expect(f.read()).toBe(before); expect(configBackups(f.stateDir)).toEqual([]); expect(f.events).toEqual([]);
  }
});

test("file replacement during check or intent cannot be overwritten or create a stale backup", async () => {
  for (const phase of ["check", "intent"] as const) {
    const f = fixture(), changed = 'mode = "enforce"\nrequired_checks = ["new-person-check"]\n';
    const replace = () => writeFileSync(f.file, changed);
    if (phase === "check") f.control.checkHook = replace; else f.control.intentHook = replace;
    const result = await f.configure({ mode: "advise", instructionClaim: true });
    expect(result.ok).toBe(false); expect(f.read()).toBe(changed); expect(configBackups(f.stateDir)).toEqual([]); expect(f.events).toEqual([]);
  }
});
