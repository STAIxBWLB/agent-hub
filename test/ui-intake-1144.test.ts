import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { SourceRegistry } from "../src/hub/sources.ts";
import { realPath } from "../src/hub/project.ts";
import { startDashboard } from "../src/hub/ui.ts";

async function rig() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-ui-intake-"))), stateDir = join(cwd, "state");
  mkdirSync(join(cwd, ".agenthub"));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8")
    .replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"')
    .replace(/^pii_patterns = .*$/m, 'pii_patterns = ["INTAKE-PRIVATE"]')
    .replace('pii_screen = "local"', 'pii_screen = "off"');
  writeFileSync(join(cwd, ".agenthub/routing.toml"), routing);
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } } });
  const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  const registry = new SourceRegistry(stateDir);
  async function session(liveTest = false) {
    const opened = await client.request({ t: "ui", liveTest }), target = new URL(opened.url), origin = target.origin;
    const base = { origin, "content-type": "application/json" };
    const accepted = await fetch(`${origin}/session`, { method: "POST", headers: base, body: JSON.stringify({ ticket: target.hash.slice(1), liveTest: false }) });
    expect(accepted.status).toBe(200);
    const cookie = accepted.headers.get("set-cookie")!.split(";")[0]!;
    const post = (path: string, input: unknown) => fetch(`${origin}${path}`, { method: "POST", headers: { ...base, cookie }, body: JSON.stringify(input) });
    return { post };
  }
  return { client, registry, session, stop: async () => { client.close(); await daemon.stop(); rmSync(cwd, { recursive: true, force: true }); } };
}

test("dashboard source rows expose exactly the allowlisted metadata, including a private source (#1144)", async () => {
  const f = await rig();
  try {
    const publicSource = f.registry.add({ bytes: Buffer.from("PUBLIC-SOURCE-CONTENT"), text: "PUBLIC-SOURCE-CONTENT", kind: "url", origin: "https://source.invalid/private-origin", private: false, now: 123 });
    const privateSource = f.registry.add({ bytes: Buffer.from("PRIVATE-SOURCE-CONTENT"), text: "PRIVATE-SOURCE-CONTENT", kind: "file", origin: "/private/source/path.txt", private: true, now: 456 });
    const snapshot = await f.client.request({ t: "ui_snapshot", after: 0 });
    expect(snapshot.sources).toHaveLength(2);
    for (const row of snapshot.sources) {
      expect(Object.keys(row).sort()).toEqual(["added_at", "bytes", "hashPrefix", "id", "kind"]);
      expect(row.hashPrefix).toMatch(/^[a-f0-9]{12}$/);
      const meta = f.registry.get(row.id)!;
      expect(row).toEqual({ id: meta.id, kind: meta.kind, bytes: meta.bytes, hashPrefix: meta.sha256.slice(0, 12), added_at: meta.added_at });
    }
    expect(snapshot.sources.map((row: { id: string }) => row.id).sort()).toEqual([publicSource.id, privateSource.id].sort());
    const wire = JSON.stringify(snapshot.sources);
    for (const hidden of ["PUBLIC-SOURCE-CONTENT", "PRIVATE-SOURCE-CONTENT", "private-origin", "/private/source", "origins", '"private"', '"sha256"']) expect(wire).not.toContain(hidden);
    const ui = await f.session(), response = await ui.post("/snapshot", { after: 0 });
    expect((await response.json() as any).sources).toEqual(snapshot.sources);
  } finally { await f.stop(); }
});

test("ordinary dashboard intake creates the CLI's draft and public projection; invalid and delegated inputs have no effects (#1144)", async () => {
  const f = await rig();
  try {
    const source = f.registry.add({ bytes: Buffer.from("source"), text: "source", kind: "file", origin: "source.txt", private: false });
    const ui = await f.session();
    const saved = await ui.post("/action", { action: "intake", text: "Prepare the report", sources: [source.id] });
    expect(saved.status).toBe(200);
    const result = await saved.json() as any;
    expect(result).toMatchObject({ ok: true, draft: { title: "Intake: Prepare the report", state: "backlog", draft: true }, children: [] });
    expect(result.draft.detail).toContain(`Sources: ${source.id}`);
    expect(result.draft.owner).toBeNull();
    const before = await f.client.request({ t: "ui_snapshot", after: 0 });
    for (const input of [{ text: " " }, { text: "x".repeat(7001) }, { text: "unknown", sources: ["src:0123456789abcdef"] }, { text: "bad sources", sources: "src:0123456789abcdef" }]) {
      const refused = await ui.post("/action", { action: "intake", ...input });
      expect(refused.status).toBe(400);
      expect((await f.client.request({ t: "ui_snapshot", after: 0 })).tasks).toEqual(before.tasks);
    }
    const delegated = await f.session(true);
    for (const forged of [{ liveTest: false }, { session: { liveTest: false, settings: true } }, { settings: true }]) {
      const denied = await delegated.post("/action", { action: "intake", text: "must never create a draft", sources: [], ...forged });
      expect(denied.status).toBe(403);
      expect((await f.client.request({ t: "ui_snapshot", after: 0 })).tasks).toEqual(before.tasks);
    }
    const privateReply = await ui.post("/action", { action: "intake", text: "INTAKE-PRIVATE request", sources: [source.id] });
    expect(privateReply.status).toBe(200);
    const privateWire = await privateReply.text();
    expect(JSON.parse(privateWire).ok).toBe(true);
    expect(privateWire).not.toContain("INTAKE-PRIVATE");
    expect(privateWire).not.toContain(source.id);
  } finally { await f.stop(); }
});

test("daemon intake callback refuses a live-test session before task dispatch even when HTTP is bypassed (#1144)", async () => {
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async function uiAction("), end = source.indexOf("  const recoverySessionDigest", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  let calls = 0;
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`${source.slice(start, end)}\nglobalThis.extracted = uiAction;`);
  const context = { extracted: undefined as undefined | ((input: Record<string, unknown>, session: Record<string, unknown>) => Promise<unknown>), taskOp: () => { calls++; throw new Error("effect reached"); } };
  runInNewContext(script, context);
  const action = context.extracted!;
  expect(await action({ action: "intake", text: "forged", liveTest: false }, { settings: true, liveTest: true })).toMatchObject({ ok: false, error: expect.stringContaining("live-test") });
  expect(calls).toBe(0);
});

test("intake HTTP deadline keeps the CLI response margin and ordinary actions keep the default (#1144)", async () => {
  let handler!: (request: Request, server: unknown) => Promise<Response>;
  const serve = Bun.serve;
  let ui!: ReturnType<typeof startDashboard>;
  Reflect.set(Bun, "serve", (options: { fetch: typeof handler }) => { handler = options.fetch; return { port: 12345, stop() {} }; });
  try { ui = startDashboard({ snapshot: () => ({}), action: () => ({ ok: true }) }); }
  finally { Reflect.set(Bun, "serve", serve); }
  const deadlines: number[] = [], server = { timeout: (_req: Request, seconds: number) => deadlines.push(seconds) };
  const post = (path: string, body: unknown, cookie?: string) => handler(new Request(`${ui.origin}${path}`, { method: "POST", headers: { host: new URL(ui.origin).host, origin: ui.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }), server);
  try {
    const session = await post("/session", { ticket: new URL(ui.issue()).hash.slice(1) });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post("/action", { action: "intake", text: "request", sources: [] }, cookie)).status).toBe(200);
    expect(deadlines).toEqual([95]);
    expect((await post("/action", { action: "pause" }, cookie)).status).toBe(200);
    expect(deadlines).toEqual([95]);
  } finally { ui.stop(); }
});
