import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { externalInstanceStateDir, readExternalInstanceRecord, writeExternalInstanceRecord, validExternalInstanceBinding, type ExternalInstanceBinding } from "../src/hub/external-instance.ts";

function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "external-instance-record-")));
  const state = join(root, "state"); mkdirSync(state);
  const binding: ExternalInstanceBinding = { schema: 1, projectRoot: root, instance: "fixture-writer", kind: "fixture", modulePath: ".agenthub/fixture.mjs", sha256: "a".repeat(64), api: 1, capabilityDigest: "b".repeat(64), policyDigest: "c".repeat(64), executionCwd: join(root, ".worktrees/fixture-writer") };
  return { root, state, binding, close: () => rmSync(root, { recursive: true, force: true }) };
}
test("#754 private records retain only stable identity and native correlation, with strict schema", () => {
  const f = fixture();
  try {
    expect(readExternalInstanceRecord(f.state, f.binding.instance)).toBeUndefined();
    writeExternalInstanceRecord(f.state, f.binding, "native-recorded");
    const file = join(f.state, "instances", f.binding.instance, "external-instance.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readExternalInstanceRecord(f.state, f.binding.instance)).toEqual({ externalInstance: f.binding, sessionId: "native-recorded" });
    for (const value of [{ ...f.binding, schema: 2 }, { ...f.binding, modulePath: "../outside" }, { ...f.binding, launchGeneration: "forged" }, { ...f.binding, capabilityDigest: "unknown" }]) expect(validExternalInstanceBinding(value)).toBe(false);
    const getter = { ...f.binding }; Object.defineProperty(getter, "kind", { enumerable: true, get: () => { throw new Error("must not invoke"); } });
    expect(validExternalInstanceBinding(getter)).toBe(false);
    writeFileSync(file, JSON.stringify({ externalInstance: { ...f.binding, instance: "fixture-other" }, sessionId: "native-recorded" }));
    expect(() => readExternalInstanceRecord(f.state, f.binding.instance)).toThrow("invalid external instance record");
  } finally { f.close(); }
});
test("#754 a symlinked namespace is refused before any outside-directory write", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(f.state, "instances"));
    expect(() => externalInstanceStateDir(f.state, f.binding.instance)).toThrow("namespace changed");
    expect(() => readExternalInstanceRecord(f.state, f.binding.instance)).toThrow("unreadable");
    expect(existsSync(join(outside, f.binding.instance))).toBe(false);
    expect(() => writeExternalInstanceRecord(f.state, f.binding, "native-recorded")).toThrow("namespace changed");
    expect(existsSync(join(outside, f.binding.instance))).toBe(false);
  } finally { f.close(); }
});
