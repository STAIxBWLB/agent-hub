import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createProjectAdapterCatalog, definitionOf, isFixedBuiltinDefinition } from "../src/adapters/registry.ts";
import { isCodexPeer } from "../src/adapters/codex-appserver.ts";

const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
function hostFunction(name: string, next: string, ports: Record<string, unknown>): (...args: any[]) => any {
  const start = source.indexOf(`  ${name}`), end = source.indexOf(`  ${next}`, start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const functionName = name.replace(/^(?:async )?function /, "").split("(")[0]!;
  return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end)) + `\n${functionName}`, ports);
}
function hostBinding(name: string, ports: Record<string, unknown>): (...args: any[]) => any {
  const start = source.indexOf(`  const ${name} =`), end = source.indexOf(";\n", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end + 1)) + `\n${name}`, ports);
}

test("#625 Claude launch proof is unreadable under a same-name foreign definition", () => {
  const builtin = definitionOf("claude")!;
  for (const definition of [builtin, { ...builtin }]) {
    let reads = 0;
    const proof = { launchId: "fixture", permissionHook: true, unattended: false };
    const read = hostFunction("function claudePermissionLaunch(", "async function changePermission(", {
      isFixedBuiltinDefinition, definitionOf: () => definition, opts: { stateDir: "/unopened/state" }, instanceId: "fixture",
      readClaudeLaunchProof: () => { reads++; return proof; },
    });
    expect(read("claude")).toBe(isFixedBuiltinDefinition(definition) ? proof : undefined);
    expect(reads).toBe(isFixedBuiltinDefinition(definition) ? 1 : 0);
  }
});

test("#625 offline Codex clear reads native proof state only under the fixed resolved definition", async () => {
  const builtin = definitionOf("codex")!;
  for (const definition of [builtin, { ...builtin }]) {
    const owner = builtin.start.create!({ instance: "codex", projectRoot: "/unopened/fixture", stateDir: "/unopened/state", kindConfig: {}, permission: "ask", mcpServers: [],
      daemon: { codex: { cwd: "/unopened/fixture", appPort: 0, proxyPort: 0 } } });
    expect(isCodexPeer(owner)).toBe(true);
    let clears = 0;
    Object.defineProperty(owner, "clearPermissionMode", { value: () => { clears++; return false; } });
    const policyPorts = { declarations: { locked: { readOnly: true } }, adapterCatalog: createProjectAdapterCatalog() };
    const isSupportedPeer = hostBinding("isSupportedPeer", policyPorts), readOnlyPeer = hostBinding("readOnlyPeer", policyPorts);
    expect(isSupportedPeer("codex")).toBe(true); expect(isSupportedPeer("foreign-unregistered")).toBe(false);
    expect(readOnlyPeer("locked")).toBe(true); expect(readOnlyPeer("codex")).toBe(false);
    const run = hostFunction("async function changePermission(", "async function confirmPermissionDefault(", {
      isFixedBuiltinDefinition, isCodexPeer, definitionOf: () => definition, isSupportedPeer, readOnlyPeer,
      requestedPeerStops: new Set(), bus: { peers: new Map([["codex", owner]]) },
      permissionMode: () => "ask", permissionModes: new Map(), permissionModeSources: new Map(), pendingPermissionDefaults: new Map(),
      event: () => {}, log: () => {}, writeStatus: () => {},
    });
    const result = await run("codex", "ask", true);
    expect(result).toMatchObject({ ok: true, peer: "codex", permissionMode: "ask" });
    expect(clears).toBe(isFixedBuiltinDefinition(definition) ? 1 : 0);
    expect(result.note !== undefined).toBe(isFixedBuiltinDefinition(definition));
  }
});
