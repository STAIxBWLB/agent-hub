import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAutonomyDefaults, writeAutonomyDefaults, writeMachineResearch, writeMachineStartAgents } from "../src/hub/autonomy-defaults.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "ahub-defaults-")); roots.push(root); const home = join(root, "hub"), project = join(root, "repo"); mkdirSync(project); return { root, home, project, file: join(home, "defaults.json") }; }
test("missing machine defaults retain shipped ask and explicit writes are owner-only opt-ins", () => {
  const p = fixture();
  expect(readAutonomyDefaults(p.home)).toEqual({ enabled: false, fingerprint: "absent" });
  writeAutonomyDefaults(p.home, true, "absent", [p.project]);
  expect(statSync(p.file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(p.file, "utf8"))).toEqual({ schema: 1, autonomy: true });
  const held = readAutonomyDefaults(p.home, [p.project]);
  expect(held.enabled).toBe(true);
  writeAutonomyDefaults(p.home, false, held.fingerprint, [p.project]);
  expect(readAutonomyDefaults(p.home).enabled).toBe(false);
});
test("writable, non-owner-only, linked and malformed defaults are ignored with a notice", () => {
  for (const mode of [0o666, 0o620, 0o644]) {
    const p = fixture(); mkdirSync(p.home); writeFileSync(p.file, '{"schema":1,"autonomy":true}', { mode }); chmodSync(p.file, mode);
    expect(readAutonomyDefaults(p.home)).toMatchObject({ enabled: false, notice: expect.any(String) });
  }
  for (const linked of [true, false]) {
    const p = fixture(); mkdirSync(p.home); const original = join(p.root, "original"); writeFileSync(original, '{"schema":1,"autonomy":true}', { mode: 0o600 });
    if (linked) symlinkSync(original, p.file); else linkSync(original, p.file);
    expect(readAutonomyDefaults(p.home)).toMatchObject({ enabled: false, notice: expect.any(String) });
  }
  const p = fixture(); mkdirSync(p.home); writeFileSync(p.file, '{"schema":1,"autonomy":true,"permission_modes":{"codex":"never-ask"}}', { mode: 0o600 });
  expect(readAutonomyDefaults(p.home)).toMatchObject({ enabled: false, notice: expect.any(String) });
});
test("foreign ownership, project-local defaults and changed previews cannot authorize a write", () => {
  const p = fixture(); writeAutonomyDefaults(p.home, true, "absent");
  const uid = process.getuid!;
  try { process.getuid = () => uid() + 1; expect(readAutonomyDefaults(p.home)).toMatchObject({ enabled: false, notice: expect.any(String) }); }
  finally { process.getuid = uid; }
  expect(readAutonomyDefaults(p.home, [p.root])).toMatchObject({ enabled: false, notice: expect.any(String) });
  expect(() => writeAutonomyDefaults(p.home, false, "absent")).toThrow("unsafe or changed");
  expect(readAutonomyDefaults(p.home).enabled).toBe(true);
});


test("#1328 machine research is optional and every CAS writer preserves the other choices", () => {
  const p = fixture();
  writeMachineResearch(p.home, false, "absent", [p.project]);
  expect(readAutonomyDefaults(p.home).researchEnabled).toBe(false);
  writeMachineStartAgents(p.home, ["codex"], readAutonomyDefaults(p.home).fingerprint, [p.project]);
  writeAutonomyDefaults(p.home, true, readAutonomyDefaults(p.home).fingerprint, [p.project]);
  expect(JSON.parse(readFileSync(p.file, "utf8"))).toEqual({ schema: 1, autonomy: true, start: { agents: ["codex"] }, research: { enabled: false } });
  const held = readAutonomyDefaults(p.home);
  writeMachineResearch(p.home, true, held.fingerprint, [p.project]);
  expect(() => writeMachineResearch(p.home, false, held.fingerprint, [p.project])).toThrow("unsafe or changed");
  expect(readAutonomyDefaults(p.home)).toMatchObject({ enabled: true, startAgents: ["codex"], researchEnabled: true });
  writeAutonomyDefaults(p.home, false, readAutonomyDefaults(p.home).fingerprint, [p.project]);
  writeMachineStartAgents(p.home, [], readAutonomyDefaults(p.home).fingerprint, [p.project]);
  expect(JSON.parse(readFileSync(p.file, "utf8"))).toEqual({ schema: 1, autonomy: false, start: { agents: [] }, research: { enabled: true } });
  expect(() => writeMachineResearch(p.home, false, readAutonomyDefaults(p.home).fingerprint, [p.root])).toThrow("unsafe or changed");
});

test("#1328 research does not widen the closed defaults schema or owner-only trust", () => {
  for (const research of [true, {}, { enabled: "true" }, { enabled: true, extra: false }]) {
    const p = fixture(); mkdirSync(p.home); writeFileSync(p.file, JSON.stringify({ schema: 1, autonomy: true, research }), { mode: 0o600 });
    expect(readAutonomyDefaults(p.home)).toMatchObject({ enabled: false, fingerprint: "untrusted" });
    expect(readAutonomyDefaults(p.home).researchEnabled).toBeUndefined();
    expect(() => writeMachineResearch(p.home, true, "untrusted", [p.project])).toThrow();
  }
  const p = fixture(); writeMachineResearch(p.home, true, "absent", [p.project]); chmodSync(p.file, 0o644);
  expect(readAutonomyDefaults(p.home)).toMatchObject({ enabled: false, fingerprint: "untrusted" });
  expect(readAutonomyDefaults(p.home).researchEnabled).toBeUndefined();
});
