import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Capture } from "../src/memory/capture.ts";
import type { MemoryClient } from "../src/memory/client.ts";
import { SourceRegistry } from "../src/hub/sources.ts";
import { sourceRead } from "../src/hub/source-read.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import type { PiiVerdict } from "../src/hub/inference.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function rig(options: { modelUrl?: string; accessHosts?: string[]; piiScreen?: (text: string) => Promise<PiiVerdict> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-source-read-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agenthub"));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8")
    .replace(/^pii_patterns = .*$/m, 'pii_patterns = ["\\\\b\\\\d{6}-\\\\d{7}\\\\b", "SOURCE-PRIVATE"]')
    .replace('pii_screen = "off"', `pii_screen = "${options.piiScreen ? "local" : "off"}"`);
  writeFileSync(join(root, ".agenthub/routing.toml"), routing);
  const stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: options.modelUrl ? [options.modelUrl] : [], access_hosts: options.accessHosts ?? [] },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } },
    ...(options.piiScreen ? { piiScreen: options.piiScreen } : {}) });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  const registry = new SourceRegistry(stateDir);
  const op = (client: ControlClient, args: Record<string, unknown>) => client.request({ t: "task", op: "hub_source_read", args });
  return { root, stateDir, daemon, console_, registry, op };
}

async function localWorkerRead(accessHosts: string[]) {
  const key = "source-read-onprem-fixture-key";
  const bytes = "PRIVATE_SOURCE_CANARY: on-prem-only source body";
  let sourceId = "";
  const model = startFakeModelServer({ key, models: ["vllm/x"], script: body => {
    const last = body.messages.at(-1);
    if (last?.role === "tool") return { content: `read result: ${String(last.content)}` };
    return { tool_calls: [toolCall("hub_source_read", { id: sourceId })] };
  } });
  cleanup.push(model.stop);
  const oldKey = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = key;
  cleanup.push(() => { if (oldKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = oldKey; });
  const f = await rig({ modelUrl: model.url, accessHosts });
  sourceId = f.registry.add({ bytes: Buffer.from(bytes), text: bytes, kind: "file", origin: "private.md", private: true }).id;
  const delivered: string[] = [];
  f.daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "local") delivered.push(event.env.body); });
  expect((await f.console_.request({ t: "start", peer: "local", args: { model: "vllm/x" } })).ok).toBe(true);
  expect((await f.console_.request({ t: "task", op: "hub_task_propose", args: { title: "patient 900101-1234567 source lookup", class: "implement" } })).ok).toBe(true);
  for (let n = 0; n < 400 && (!delivered.length || f.daemon.bus.stateOf("local") !== "idle"); n++) await Bun.sleep(10);
  expect(delivered.length).toBeGreaterThan(0);
  expect(f.daemon.bus.stateOf("local")).toBe("idle");
  expect(readFileSync(join(f.stateDir, "hub.log"), "utf8")).not.toContain(bytes);
  return { ...f, model, delivered, bytes };
}

test("daemon source reads are public across peers, read-only, and permanently upgrade regex matches to private", async () => {
  const f = await rig();
  const publicText = "Public source content for every project peer.";
  const publicSource = f.registry.add({ bytes: Buffer.from(publicText), text: publicText, kind: "file", origin: "public.md", private: false });
  const privateText = "SOURCE-PRIVATE source content must not be returned.";
  const screenedSource = f.registry.add({ bytes: Buffer.from(privateText), text: privateText, kind: "file", origin: "screened.md", private: false });
  const codex = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanup.push(() => codex.close());
  const claude = await ControlClient.connect(f.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => claude.close());

  for (const caller of [codex, claude]) {
    const result = await f.op(caller, { id: publicSource.id, range: { offset: 7, length: 6 } });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ id: publicSource.id, private: false, text: "source [cut]", next: 13 });
  }
  expect(f.registry.get(publicSource.id)?.private).toBe(false);

  const screened = await f.op(codex, { id: screenedSource.id });
  expect(screened.ok).toBe(true);
  expect(JSON.parse(screened.text)).toEqual({ id: screenedSource.id, kind: "file", private: true });
  expect(f.registry.get(screenedSource.id)?.private).toBe(true);
  expect(JSON.stringify(await f.op(claude, { id: screenedSource.id }))).not.toContain("must not be returned");

  // A normal control-socket caller gets no private-read authority even while a local-owned PII task exists.
  const made = await f.console_.request({ t: "task", op: "hub_task_propose", args: { title: "SOURCE-PRIVATE task", class: "implement", owner: "local" } });
  expect(made.ok).toBe(true);
  const pretendLocal = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanup.push(() => pretendLocal.close());
  const explicitlyPrivate = f.registry.add({ bytes: Buffer.from("opaque private text"), text: "opaque private text", kind: "file", origin: "private.md", private: true });
  const denied = await f.op(pretendLocal, { id: explicitlyPrivate.id });
  expect(denied.ok).toBe(true);
  expect(JSON.parse(denied.text)).toEqual({ id: explicitlyPrivate.id, kind: "file", private: true });
  expect(denied.text).not.toContain("opaque private text");
});

test("source read rechecks source identity and policy after async screening and private authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-source-read-fence-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const registry = new SourceRegistry(root);
  const body = "deferred source contents";
  const source = registry.add({ bytes: Buffer.from(body), text: body, kind: "file", origin: "source.txt", private: false });
  let releaseScreen!: (clear: boolean) => void;
  const screening = new Promise<boolean>(resolve => { releaseScreen = resolve; });
  const pending = sourceRead(registry, { id: source.id }, { valid: () => true, screen: () => screening, canReadPrivate: async () => false });
  registry.add({ bytes: Buffer.from(body), text: body, kind: "file", origin: "private-upgrade.txt", private: true });
  releaseScreen(true);
  await expect(pending).resolves.toEqual({ id: source.id, kind: "file", private: true });

  let releaseAuthorization!: (allowed: boolean) => void;
  const authorization = new Promise<boolean>(resolve => { releaseAuthorization = resolve; });
  let valid = true;
  const privateRead = sourceRead(registry, { id: source.id }, { valid: () => valid, screen: async () => true, canReadPrivate: () => authorization });
  valid = false;
  releaseAuthorization(true);
  await expect(privateRead).rejects.toThrow("source read unavailable");
});

test("the in-process local worker can read a private source inside a PII task only on campus", async () => {
  const onCampus = await localWorkerRead([]);
  const toolResult = onCampus.model.requests.flatMap(request => request.body.messages as { role: string; content?: unknown }[])
    .filter(message => message.role === "tool").map(message => String(message.content));
  expect(toolResult.some(result => result.includes(onCampus.bytes))).toBe(true);
  expect(onCampus.delivered.every(body => body.includes("task #1") && !body.includes(onCampus.bytes))).toBe(true);

  const offCampus = await localWorkerRead(["127.0.0.1"]);
  const offCampusToolResult = offCampus.model.requests.flatMap(request => request.body.messages as { role: string; content?: unknown }[])
    .filter(message => message.role === "tool").map(message => String(message.content));
  expect(offCampusToolResult.some(result => result.includes('"private":true'))).toBe(true);
  expect(offCampusToolResult.some(result => result.includes(offCampus.bytes))).toBe(false);
  expect(offCampus.delivered.every(body => !body.includes(offCampus.bytes))).toBe(true);
});

test("an unknown model PII screen permanently upgrades a public source and returns no text", async () => {
  const f = await rig({ piiScreen: async () => ({ label: "unknown", miss: "unreadable", ms: 1 }) });
  const text = "Ordinary prose that only an unknown model screen can classify.";
  const source = f.registry.add({ bytes: Buffer.from(text), text, kind: "file", origin: "unknown-screen.md", private: false });
  const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanup.push(() => tools.close());
  const result = await f.op(tools, { id: source.id });
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.text)).toEqual({ id: source.id, kind: "file", private: true });
  expect(f.registry.get(source.id)?.private).toBe(true);
  expect(result.text).not.toContain(text);
});

test("capture suppresses source reads in native and namespaced tool forms, while keeping unrelated reads", async () => {
  const writes: Record<string, unknown>[] = [];
  const client = { appendCapture: (record: Record<string, unknown>) => { writes.push(record); return Promise.resolve(undefined); } } as unknown as MemoryClient;
  const capture = new Capture(client, { project: "agent-hub", cwd: import.meta.dir });
  capture.init("source-read-session", "session prompt");
  for (const tool of ["hub_source_read", "mcp__agent-hub__hub_source_read"]) {
    capture.observe({ tool, args: "PRIVATE_SOURCE_ID", output: "PRIVATE_SOURCE_TEXT", id: tool, paths: [] });
  }
  capture.observe({ tool: "read", args: "public.txt", output: "public control", id: "ordinary-read", paths: ["public.txt"] });
  await Promise.resolve();
  expect(writes.filter(record => record.event === "PostToolUse")).toHaveLength(1);
  expect(writes.filter(record => record.event === "PostToolUse")[0]).toMatchObject({ tool: "read", excerpt: "public.txt\npublic control" });
  expect(JSON.stringify(writes)).not.toContain("PRIVATE_SOURCE");
});
