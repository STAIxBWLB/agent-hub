import { expect, test } from "bun:test";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { externalMetadataDefinitions, type ExternalInstanceCatalog } from "../src/adapters/external-metadata.ts";
import { parseConfiguredAcpArguments, runConfiguredAcpEntry, type ConfiguredAcpControl } from "../src/cli/configured-acp-entry.ts";
import type { DeclaredExternalInstance } from "../src/hub/instance-config.ts";

const catalog = createProjectAdapterCatalog();
const declared: readonly DeclaredExternalInstance[] = [{ id: "fixture-one", kind: "fixture", availability: "declared-unknown", refusalCode: "catalog-unavailable" }];
const liveCatalog = (): ExternalInstanceCatalog => ({ schema: 1, projectRoot: "/canonical-project", epoch: "current-daemon", fingerprint: "a".repeat(64), instances: [{
  id: "fixture-one", kind: "fixture", displayName: "Fixture", roles: ["reviewer"], form: "headless", readOnly: true, permissionState: "ask", availability: "offline",
}] });
function host(raw = ["--as", "fixture-one"]) {
  const requests: Record<string, unknown>[] = [], output: string[] = [];
  let connections = 0, closed = 0, catalogReads = 0;
  const hub: ConfiguredAcpControl = {
    features: ["configured_acp", "external_adapter_instances", "external_adapter_modules", "peer_instances"], instanceId: "current-daemon", isOpen: true,
    readExternalInstanceCatalog: async root => { expect(root).toBe("/canonical-project"); catalogReads++; return liveCatalog(); },
    request: async request => { requests.push(request); return request.t === "status" ? { status: { instanceId: "current-daemon", cwd: "/canonical-project", configuredAdapters: ["fixture"], activeInstances: ["fixture-one"] } } : { ok: true }; },
    close: () => { closed++; },
  };
  return { hub, requests, output, count: () => ({ connections, closed, catalogReads }), context: {
    kind: "fixture", raw, catalog, declaredExternalInstances: declared, projectRoot: "/canonical-project",
    connect: async () => { connections++; return hub; }, print: (text: string) => { output.push(text); },
  } };
}

test("external instance CLI can select an inert declared row for preview without a factory or connection", async () => {
  expect(catalog.definitionOf("fixture")).toBeUndefined();
  expect(parseConfiguredAcpArguments("fixture", ["--as", "fixture-one", "--dry-run"], catalog, undefined, declared)).toEqual({ peer: "fixture-one", mode: "headless", preview: true });
  const h = host(["--as", "fixture-one", "--session-id", "private-session", "--dry-run"]);
  h.context.connect = async () => { throw new Error("preview must not connect or evaluate a module"); };
  await runConfiguredAcpEntry(h.context);
  expect(h.requests).toEqual([]);
  expect(h.output.join("\n")).toContain("fixture-one");
  expect(h.output.join("\n")).not.toContain("private-session");
  expect(catalog.definitionOf("fixture-one")).toBeUndefined();
  expect(() => parseConfiguredAcpArguments("fixture", ["--as", "fixture-unknown"], catalog, undefined, declared)).toThrow();
});

test("external instance start uses authenticated current catalog before sending only a bounded request", async () => {
  const h = host(["--as", "fixture-one", "--session-id", "recorded-native-id"]);
  await runConfiguredAcpEntry(h.context);
  expect(h.count()).toEqual({ connections: 1, closed: 1, catalogReads: 1 });
  expect(h.requests).toEqual([{ t: "status" }, { t: "start", peer: "fixture-one", args: { mode: "headless", sessionId: "recorded-native-id" } }]);
});

test("online inert module labels still require the separate authenticated instance catalog", async () => {
  const metadataOnly = createProjectAdapterCatalog(undefined, externalMetadataDefinitions([{ kind: "fixture", displayName: "Fixture" }]));
  expect(metadataOnly.definitionOf("fixture")?.start.create).toBeUndefined();
  const h = host();
  await runConfiguredAcpEntry({ ...h.context, catalog: metadataOnly });
  expect(h.count().catalogReads).toBe(1);
});

for (const change of ["missing-feature", "closed", "missing-reader", "stale-epoch", "foreign-project", "foreign-kind", "undeclared-live", "refused-live"] as const) test(`inert external row grants no start when live catalog is ${change}`, async () => {
  const h = host();
  if (change === "missing-feature") h.hub.features = ["configured_acp", "peer_instances"];
  if (change === "closed") Object.assign(h.hub, { isOpen: false });
  if (change === "missing-reader") delete h.hub.readExternalInstanceCatalog;
  if (["stale-epoch", "foreign-project", "foreign-kind", "undeclared-live", "refused-live"].includes(change)) {
    h.hub.readExternalInstanceCatalog = async () => {
      const view = liveCatalog();
      if (change === "stale-epoch") return { ...view, epoch: "old-daemon" };
      if (change === "foreign-project") return { ...view, projectRoot: "/other-project" };
      if (change === "foreign-kind") return { ...view, instances: [{ ...view.instances[0]!, kind: "other" }] };
      if (change === "undeclared-live") return { ...view, instances: [] };
      return { ...view, instances: [{ ...view.instances[0]!, availability: "refused", refusalCode: "binding-changed" }] };
    };
  }
  await expect(runConfiguredAcpEntry(h.context)).rejects.toThrow();
  expect(h.requests.filter(request => request.t === "start")).toEqual([]);
  expect(h.count().closed).toBe(1);
});

test("external instance native start refusal is surfaced without retry or a fresh fallback", async () => {
  const h = host();
  const request = h.hub.request;
  h.hub.request = async message => message.t === "start" ? (h.requests.push(message), { ok: false, error: "recorded session did not echo" }) : request(message);
  await expect(runConfiguredAcpEntry(h.context)).rejects.toThrow("recorded session did not echo");
  expect(h.requests.filter(message => message.t === "start")).toHaveLength(1);
  expect(h.count().closed).toBe(1);
});
