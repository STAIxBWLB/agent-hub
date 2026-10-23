import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore, MemoryStore, memoryProjectKey, realPath } from "@staix/agent-mem";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean, message: string): Promise<void> {
  for (let n = 0; n < 400 && !check(); n++) await Bun.sleep(10);
  expect(check(), message).toBe(true);
}
/** Inspect only this test's tiny private memory directory, never the person's memory home. */
function captureArtifacts(memory: string): string[] {
  const artifacts: string[] = [];
  let visited = 0;
  const walk = (directory: string, relative = "", depth = 0) => {
    if (depth > 10) throw new Error("fixture directory depth exceeded");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 256) throw new Error("fixture directory bound exceeded");
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (/^capture\.db(?:-(?:wal|shm))?$/.test(entry.name) || /^spool(?:\.|$)/.test(entry.name) || entry.name === ".writing") artifacts.push(name);
      if (entry.isDirectory()) walk(join(directory, entry.name), name, depth + 1);
    }
  };
  walk(memory); return artifacts.sort();
}

test("an unavailable selected memory profile never falls back to raw capture while public local work and the bus continue", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-amem-profile-capture-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), stateDir = join(cwd, "state"), memoryDir = join(root, "private-memory");
  mkdirSync(stateDir, { recursive: true }); mkdirSync(memoryDir);
  writeFileSync(join(cwd, "public.txt"), "public fixture content\n");
  const malformed = "{invalid selected profile\n";
  writeFileSync(join(memoryDir, "profile.json"), malformed);
  const prior = { AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME, OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY };
  cleanup.push(() => { for (const key of ["AMEM_HOME", "AGENTHUB_HOME", "OMNIROUTE_API_KEY"] as const) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  process.env.AMEM_HOME = memoryDir; process.env.AGENTHUB_HOME = join(root, "private-hub-home"); process.env.OMNIROUTE_API_KEY = "profile-capture-fixture-key";
  const model = startFakeModelServer({ key: "profile-capture-fixture-key", script: body => body.messages.at(-1)?.role === "tool"
    ? { content: "public read complete" } : { tool_calls: [toolCall("read", { path: "public.txt" })] } });
  cleanup.push(model.stop);
  // Deliberately no memoryClient injection: this is the production local-library client and its actual profile fence.
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: true, native: true },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [model.url], access_hosts: [] },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  const status = await client.request({ t: "status" }); expect(status.status.memoryProfile.state).toBe("unavailable");
  expect(captureArtifacts(memoryDir)).toEqual([]);
  const answers: string[] = [];
  daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "local") answers.push(event.env.body); });
  expect((await client.request({ t: "start", peer: "local", args: { model: "vllm/test" } })).ok).toBe(true);
  for (const turn of [1, 2]) {
    expect((await client.request({ t: "send", body: `read public.txt for public turn ${turn}`, to: ["local"] })).ok).toBe(true);
    await until(() => answers.length === turn && daemon.bus.stateOf("local") === "idle", "the real local read turn completes despite unavailable memory");
    expect(answers[turn - 1]).toBe("public read complete");
    expect(captureArtifacts(memoryDir)).toEqual([]);
  }
  expect(model.requests).toHaveLength(4);
  for (const call of [model.requests[1], model.requests[3]]) {
    expect(call!.body.messages.findLast((message: { role: string }) => message.role === "tool").content).toBe("1\tpublic fixture content\n2\t");
  }
  expect((await client.request({ t: "status" })).status.memoryProfile.state).toBe("unavailable");
  await daemon.stop(); // SessionEnd must not bypass the same unavailable-profile fence either.
  expect(captureArtifacts(memoryDir)).toEqual([]);
  expect(readFileSync(join(memoryDir, "profile.json"), "utf8")).toBe(malformed);
});

test("a valid production amem profile recalls curated notes and captures a real local turn without contacting a configured legacy worker", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-amem-valid-daemon-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), stateDir = join(cwd, "state"), memoryDir = join(root, "private-memory");
  mkdirSync(stateDir, { recursive: true }); mkdirSync(memoryDir);
  const capturedOnly = "CaptureOnlyPayload", query = "CaptureFenceLocal";
  writeFileSync(join(cwd, "public.txt"), `${query} ${capturedOnly} from public file\n`);
  const prior = { AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME, OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY };
  cleanup.push(() => { for (const key of ["AMEM_HOME", "AGENTHUB_HOME", "OMNIROUTE_API_KEY"] as const) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  process.env.AMEM_HOME = memoryDir; process.env.AGENTHUB_HOME = join(root, "private-hub-home"); process.env.OMNIROUTE_API_KEY = "valid-amem-fixture-key";
  const project = memoryProjectKey(cwd);
  const seed = new MemoryStore({ memoryDir });
  const note = (() => {
    try { return seed.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", title: `${query} curated contract`, text: `${query}: preserve curated evidence independently of raw capture.`, about: ["path:public.txt"] });
    } finally { seed.close(); }
  })();
  const workerCalls: string[] = [];
  // This tripwire is deliberately a real test-only listener. The production client receives no injected fake.
  const legacy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { workerCalls.push(new URL(request.url).pathname); return Response.json({ status: "ok", version: "must-not-be-read" }); } });
  cleanup.push(() => legacy.stop(true));
  const model = startFakeModelServer({ key: "valid-amem-fixture-key", script: body => body.messages.at(-1)?.role === "tool"
    ? { content: "public read complete" } : { tool_calls: [toolCall("read", { path: "public.txt" })] } });
  cleanup.push(model.stop);
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: true, native: true, worker_url: `http://127.0.0.1:${legacy.port}` },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [model.url], access_hosts: [] },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  expect((await client.request({ t: "status" })).status.memoryProfile.state).toBe("ready");
  const answers: string[] = [];
  daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "local") answers.push(event.env.body); });
  expect((await client.request({ t: "start", peer: "local", args: { model: "vllm/test" } })).ok).toBe(true);
  expect((await client.request({ t: "send", body: "read public.txt once", to: ["local"] })).ok).toBe(true);
  await until(() => answers.length === 1 && daemon.bus.stateOf("local") === "idle", "the production memory-backed local turn completes");
  expect(answers).toEqual(["public read complete"]);
  expect(model.requests).toHaveLength(2);
  const firstRequest = JSON.stringify(model.requests[0]!.body);
  expect(firstRequest).toContain(note.slice(0, 8));
  expect(firstRequest).toContain(`${query}: preserve curated evidence`);
  expect(model.requests[1]!.body.messages.findLast((message: { role: string }) => message.role === "tool").content).toContain(capturedOnly);
  const beforeAsk = model.requests.length;
  const asked = await client.request({ t: "ask", question: query });
  expect(asked.ok).toBe(true); expect(asked.found).toBe(false); expect(asked.answer).toBeUndefined();
  expect(asked.evidence.some((item: { id: string }) => item.id === `mem:${note.slice(0, 8)}` || item.id === `mem:${note}`)).toBe(true);
  expect(JSON.stringify(asked.evidence)).not.toContain(capturedOnly);
  expect(model.requests).toHaveLength(beforeAsk); // evidence-only: inference is disabled, no extra provider turn
  await daemon.stop();
  const capture = new CaptureStore({ memoryDir, project, readOnly: true, maxReadRows: 128 });
  try {
    const rows = capture.rows({ project, limit: 128 });
    expect(rows.map(row => row.event)).toEqual(expect.arrayContaining(["SessionStart", "PostToolUse", "Stop", "SessionEnd"]));
    expect(rows.filter(row => row.event === "PostToolUse" && row.tool === "read")).toHaveLength(1);
    expect(rows.find(row => row.event === "PostToolUse")!.excerpt).toContain(capturedOnly);
  } finally { capture.close(); }
  const verified = new MemoryStore({ memoryDir });
  try { expect(verified.get(note, project)?.text).toBe(`${query}: preserve curated evidence independently of raw capture.`); }
  finally { verified.close(); }
  expect(workerCalls).toEqual([]);
});
