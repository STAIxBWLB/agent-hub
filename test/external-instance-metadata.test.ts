import { validateExternalDefinition } from "../src/adapters/external-modules.ts";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalInstanceCatalog, externalMetadataDefinitions, type ExternalInstanceCatalog } from "../src/adapters/external-metadata.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { readInstanceConfig, readInstanceRoleConfig } from "../src/hub/instance-config.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const projection = (): ExternalInstanceCatalog => ({ schema: 1, projectRoot: "/project", epoch: "daemon-one", fingerprint: "a".repeat(64), instances: [{
  id: "fixture-review", kind: "fixture", displayName: "External fixture", roles: ["reviewer"], form: "headless", readOnly: true,
  permissionState: "ask", availability: "ready",
}] });

test("external instance projection is bounded own data without executable definition fields", () => {
  const parsed = externalInstanceCatalog(projection());
  expect(parsed.instances[0]?.roles).toEqual(["reviewer"]);
  expect(Object.isFrozen(parsed.instances[0])).toBe(true);
  expect(Object.isFrozen(parsed.instances)).toBe(true);
  expect(JSON.stringify(parsed)).not.toMatch(/create|argv|nativeSession|sha256/);
  const mutations: ((value: Record<string, any>) => void)[] = [
    value => { value.instances = Array.from({ length: 65 }, (_, i) => ({ ...value.instances[0], id: `fixture-${i}` })); },
    value => { value.instances[0].displayName = "한".repeat(86); },
    value => { value.instances[0].kind = "f".repeat(33); },
    value => { value.instances[0].roles = ["conductor"]; },
    value => { value.instances[0].permissionState = "allow-everything"; },
    value => { value.instances[0].refusalCode = "native-error-payload"; },
    value => { value.instances[0].argv = ["secret"]; },
    value => { value.instances.push({ ...value.instances[0] }); },
    value => { value.fingerprint = "not-a-fingerprint"; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(projection()); mutate(value);
    expect(() => externalInstanceCatalog(value)).toThrow();
  }
  let invoked = false;
  const accessor = structuredClone(projection());
  Object.defineProperty(accessor.instances[0]!, "roles", { enumerable: true, get: () => { invoked = true; return ["reviewer"]; } });
  expect(() => externalInstanceCatalog(accessor)).toThrow();
  expect(invoked).toBe(false);
});

test("offline module instances stay declared/unknown and cannot gain id-keyed roles without imports", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-module-metadata-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  expect(hubGitSync(["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(root, ".agenthub"));
  const marker = join(root, "module-imported");
  const source = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad"); throw new Error("must never evaluate");`;
  writeFileSync(join(root, "module.mjs"), source);
  writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({
    adapter_modules: [{ path: "module.mjs", sha256: createHash("sha256").update(source).digest("hex") }],
    instances: { "fixture-review": { kind: "fixture", roles: ["reviewer"], start_mode: "headless", worktree: ".worktrees/fixture-review" }, "codex-extra": { kind: "codex", roles: ["verifier"] } },
    roles: { "fixture-review": ["implementer"], fixture: ["reviewer"] },
  }));
  const view = readInstanceConfig(root);
  expect(view.declaredExternalInstances).toEqual([{ id: "fixture-review", kind: "fixture", availability: "declared-unknown", refusalCode: "catalog-unavailable" }]);
  expect(view.instances?.["fixture-review"]).toBeUndefined();
  expect(view.instances?.["codex-extra"]?.roles).toEqual(["verifier"]);
  expect(view.catalog.definitionOf("fixture-review", view.instances)).toBeUndefined();
  expect(readInstanceRoleConfig(root).roles["fixture-review"]).toBeUndefined();
  expect(readInstanceRoleConfig(root).roles.fixture).toBeUndefined();
  expect(existsSync(marker)).toBe(false);
  // A startup refusal is scoped to the missing module's rows, not to the builtin catalog.
  const refused = readInstanceConfig(root, undefined, []);
  expect(refused.declaredExternalInstances).toEqual([{ id: "fixture-review", kind: "fixture", availability: "refused", refusalCode: "module-refused" }]);
  expect(refused.instances?.["fixture-review"]).toBeUndefined();
  expect(refused.instances?.["codex-extra"]?.roles).toEqual(["verifier"]);
  expect(refused.catalog.definitionOf("fixture-review", refused.instances)).toBeUndefined();
  expect(existsSync(marker)).toBe(false);
});

test("a partial startup catalog keeps good module and builtin instances executable and refused module rows inert", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-partial-module-catalog-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  expect(hubGitSync(["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(root, ".agenthub"));
  const local = { adapter_modules: [{ path: "good.mjs", sha256: "a".repeat(64) }, { path: "missing.mjs", sha256: "b".repeat(64) }], instances: {
    "good-worker": { kind: "good", roles: ["implementer"], start_mode: "headless", worktree: ".worktrees/good-worker" },
    "missing-worker": { kind: "missing", roles: ["verifier"], start_mode: "headless", worktree: ".worktrees/missing-worker" },
    "codex-extra": { kind: "codex", roles: ["verifier"] },
  } };
  writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify(local));
  const base = externalMetadataDefinitions([{ kind: "good", displayName: "Good fixture" }])[0]!;
  let calls = 0;
  const definition = (optIn: boolean) => validateExternalDefinition({ ...base, roles: ["implementer"],
    ...(optIn ? { headlessInstances: { form: "headless", roles: ["implementer"] } } : {}),
    start: { ...base.start, daemonPort: "acp", create: () => { calls++; throw new Error("factory must not run during config reads"); },
      launch: () => { calls++; throw new Error("launch must not run during config reads"); } },
  });
  const view = readInstanceConfig(root, undefined, [definition(true)]);
  expect(view.instances?.["good-worker"]?.roles).toEqual(["implementer"]);
  expect(view.instances?.["codex-extra"]?.roles).toEqual(["verifier"]);
  expect(view.instances?.["missing-worker"]).toBeUndefined();
  expect(view.declaredExternalInstances).toEqual([{ id: "missing-worker", kind: "missing", availability: "refused", refusalCode: "module-refused" }]);
  expect(view.catalog.definitionOf("good-worker", view.instances)?.kind).toBe("good");
  expect(view.catalog.definitionOf("missing-worker", view.instances)).toBeUndefined();
  expect(calls).toBe(0);
  expect(() => readInstanceConfig(root, undefined, [definition(false)])).toThrow(/opted/);
  expect(calls).toBe(0);
});

async function catalogServer(options: { feature?: boolean; statusEpoch?: string; catalogEpoch?: string; catalogRoot?: string } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-live-module-metadata-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const srv = Bun.serve<{}>({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request, { data: {} }) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.t === "hello") ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", protocol: PROTOCOL, instanceId: "daemon-one", projectId: "project", cwd: "/project", features: options.feature === false ? [] : ["external_adapter_instances", "external_adapter_modules", "peer_instances"] }));
      else ws.send(JSON.stringify({ rid: msg.rid, t: "status", status: { instanceId: options.statusEpoch ?? "daemon-one", cwd: "/project", externalInstanceCatalog: { ...projection(), epoch: options.catalogEpoch ?? "daemon-one", projectRoot: options.catalogRoot ?? "/project" } } }));
    } },
  });
  cleanup.push(() => srv.stop(true));
  writeFileSync(join(stateDir, "control-token"), "test-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ protocol: PROTOCOL, controlPort: srv.port, instanceId: "daemon-one", projectId: "project", cwd: "/project" }));
  const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: "/project" }, 1000);
  cleanup.push(() => client.close());
  return client;
}

test("instance catalog is accepted only from a matching authenticated live epoch and project", async () => {
  const current = await catalogServer();
  expect((await current.readExternalInstanceCatalog("/project")).instances[0]?.id).toBe("fixture-review");
  current.close();
  await expect(current.readExternalInstanceCatalog("/project")).rejects.toThrow();
  for (const options of [{ feature: false }, { statusEpoch: "new-daemon" }, { catalogEpoch: "old-daemon" }, { catalogRoot: "/other-project" }]) {
    const client = await catalogServer(options);
    await expect(client.readExternalInstanceCatalog("/project")).rejects.toThrow();
    client.close();
  }
});
