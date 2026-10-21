import { expect, test } from "bun:test";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { parseConfiguredAcpArguments, runConfiguredAcpEntry } from "../src/cli/configured-acp-entry.ts";

const adapters = { fixture: { transport: "acp", command: "secret-executable", args: ["secret-token"], displayName: "Fixture", roles: ["verifier"], identity: { name: "Fixture", version: "1" } } };
const catalog = createProjectAdapterCatalog(adapters);
const declarations = { "fixture-one": { kind: "fixture", start_mode: "headless" as const } };
const host = (raw: string[] = [], status: unknown = { configuredAdapters: ["fixture"], activeInstances: ["fixture-one"] }, features = ["configured_acp", "peer_instances"]) => {
  const requests: any[] = [], output: string[] = [], timeouts: (number | undefined)[] = [];
  let connected = 0, closed = 0;
  return { requests, output, timeouts, count: () => ({ connected, closed }), context: {
    kind: "fixture", raw, catalog, instances: declarations,
    connect: async () => { connected++; return { features, request: async (request: any, timeout?: number) => { requests.push(request); timeouts.push(timeout); return request.t === "status" ? { status } : { ok: true }; }, close: () => { closed++; } }; },
    print: (value: string) => { output.push(value); },
  } };
};

test("configured ACP CLI parses only bounded headless options and explicit instances", () => {
  expect(parseConfiguredAcpArguments("fixture", ["--as", "fixture-one", "--mode=headless", "--session-id", "session-1"], catalog, declarations)).toEqual({ peer: "fixture-one", mode: "headless", sessionId: "session-1", preview: false });
  expect(parseConfiguredAcpArguments("fixture", [], catalog)).toEqual({ peer: "fixture", mode: "headless", preview: false });
});
for (const raw of [["--mode", "tui"], ["--model", "anything"], ["--unattended"], ["--leader=x"], ["--as", "fixture-missing"], ["--as", "codex"], ["--session-id", "bad\nvalue"], ["--mode", "headless", "--mode", "headless"], ["--command", "anything"], ["nativearg"]]) test(`configured ACP CLI refuses overrides ${JSON.stringify(raw)}`, () => {
  expect(() => parseConfiguredAcpArguments("fixture", raw, catalog, declarations)).toThrow();
});

test("configured ACP preview is read-only and withholds configured argv and session identity", async () => {
  const h = host(["--dry-run", "--session-id", "sensitive-session"]);
  await runConfiguredAcpEntry(h.context);
  expect(h.count().connected).toBe(0); expect(h.requests).toEqual([]);
  const text = h.output.join("\n");
  expect(text).not.toContain("secret-executable"); expect(text).not.toContain("secret-token"); expect(text).not.toContain("sensitive-session");
  expect(text).toContain("headless"); expect(text).toContain("[redacted]");
});

test("configured ACP CLI checks daemon feature and active catalog before a headless start", async () => {
  const h = host(["--as", "fixture-one", "--session-id", "session-1"]);
  await runConfiguredAcpEntry(h.context);
  expect(h.requests[0]).toEqual({ t: "status" });
  expect(h.requests[1]).toMatchObject({ t: "start", peer: "fixture-one", args: { mode: "headless", sessionId: "session-1" } });
  expect(h.timeouts.at(-1)).toBe(70_000);
  expect(h.count()).toEqual({ connected: 1, closed: 1 });
});
for (const [status, features] of [[{ configuredAdapters: [] }, ["configured_acp"]], [{}, ["configured_acp"]], [{ configuredAdapters: ["fixture"] }, []], [{ configuredAdapters: ["fixture"], activeInstances: [] }, ["configured_acp", "peer_instances"]]] as const) test(`configured ACP CLI refuses stale/old daemon ${JSON.stringify(status)} ${features}`, async () => {
  const h = host(["--as", "fixture-one"], status, [...features]);
  await expect(runConfiguredAcpEntry(h.context)).rejects.toThrow();
  expect(h.requests.filter(request => request.t === "start")).toEqual([]);
  expect(h.count().closed).toBe(1);
});

test("configured ACP CLI surfaces hub refusal without retrying or invoking native commands", async () => {
  const h = host();
  h.context.connect = async () => ({ features: ["configured_acp"], request: async (request: any) => { h.requests.push(request); return request.t === "status" ? { status: { configuredAdapters: ["fixture"] } } : { ok: false, error: "off roster" }; }, close: () => {} });
  await expect(runConfiguredAcpEntry(h.context)).rejects.toThrow("off roster");
  expect(h.requests.filter(request => request.t === "start")).toHaveLength(1);
});

test("configured command classification retains tools/conductor authority and safe audit labels", async () => {
  const { classifyPeerCommand, cliCommandLabel, detectCliIdentity } = await import("../src/cli/identity.ts");
  expect(classifyPeerCommand("fixture", [], catalog)).toBe("conductor");
  expect(classifyPeerCommand("fixture", ["--as-user"], catalog)).toBe("console");
  expect(cliCommandLabel("fixture", ["private-value"], catalog)).toBe("fixture");
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "fixture" })).toEqual({ role: "tools", peer: "fixture" });
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "fixture", CLAUDECODE: "1" }).role).toBe("invalid");
});
for (const kind of ["status", "help", "task", "recovery-run", "stop", "backlog"]) test(`configured kind cannot shadow core CLI command ${kind}`, () => {
  expect(() => createProjectAdapterCatalog({ [kind]: adapters.fixture })).toThrow(/reserved|collides/);
});

for (const field of ["retainedConfig", "pendingRestart"] as const) test(`configured ACP warns before start about ${field} without exposing retained values`, async () => {
  const h = host([], { configuredAdapters: ["fixture"], [field]: [{ key: "adapters.fixture.args", reason: "PRIVATE_RETAINED_REASON", before: ["PRIVATE_OLD_ARG"], after: ["PRIVATE_NEW_ARG"] }] });
  const connect = h.context.connect;
  h.context.connect = async () => {
    const hub = await connect(), request = hub.request;
    hub.request = async (message: any) => {
      if (message.t === "start") {
        expect(h.output).toHaveLength(1);
        expect(h.output[0]).toContain("Restart the hub");
        expect(h.output[0]).toContain("running definition");
      }
      return request(message);
    };
    return hub;
  };
  await runConfiguredAcpEntry(h.context);
  const printed = h.output.join("\n");
  expect(printed).not.toContain("PRIVATE_");
  expect(printed).not.toContain("secret-executable");
  expect(printed).not.toContain("secret-token");
  expect(catalog.definitionOf("fixture")!.cli.launchConfigKeys).toEqual(["adapters.fixture.command", "adapters.fixture.args"]);
});
