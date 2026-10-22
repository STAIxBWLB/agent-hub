import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { configureJcodeMcp } from "../src/cli/jcode-mcp.ts";

// issue #685: an extra Jcode instance, started through the daemon, served by the hub's model relay from a fake gateway.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-jcode-relay-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const fake = [process.execPath, join(import.meta.dir, "fakes/jcode-instance-agent.ts")];
const rows = (file: string) => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(10); expect(condition()).toBe(true); };

/** A gateway the hub's OmniRoute client accepts as "on campus": it answers /models and chat completions, and records every request. */
function gateway() {
  const seen: { path: string; auth: string | null; model?: string }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), body = req.method === "POST" ? await req.json() as { model?: string } : undefined;
    seen.push({ path: url.pathname, auth: req.headers.get("authorization"), ...(body?.model ? { model: body.model } : {}) });
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "dgx/fast", object: "model" }, { id: "dgx/coding", object: "model" }] });
    const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    return new Response(chunk({ id: "c1", object: "chat.completion.chunk", model: "dgx-fast-served", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })
      + chunk({ id: "c1", object: "chat.completion.chunk", model: "dgx-fast-served", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream", "x-omniroute-provider": "dgx" } });
  } });
  cleanups.push(() => server.stop(true));
  return { seen, url: `http://127.0.0.1:${server.port}/v1` };
}

async function hub(extra: Record<string, unknown>, gatewayUrl: string | undefined, extraInstance?: Record<string, unknown>) {
  const dir = root(), stateDir = join(dir, "state"), baseHome = join(dir, "home-base"), localHome = join(dir, "home-local"), record = join(dir, "record.jsonl");
  for (const home of [baseHome, localHome]) { mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}"); }
  const priorUrl = process.env.AGENTHUB_OMNIROUTE_URL, priorKey = process.env.OMNIROUTE_API_KEY;
  if (gatewayUrl) process.env.AGENTHUB_OMNIROUTE_URL = gatewayUrl; else delete process.env.AGENTHUB_OMNIROUTE_URL;
  process.env.OMNIROUTE_API_KEY = "gateway-key-stays-in-the-hub";
  cleanups.push(() => { if (priorUrl === undefined) delete process.env.AGENTHUB_OMNIROUTE_URL; else process.env.AGENTHUB_OMNIROUTE_URL = priorUrl; if (priorKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = priorKey; });
  // A verifier runs in the project root; an extra implementer would need an explicit managed worktree (instance-execution.ts), which Jcode instances share.
  const instances = { "jcode-local": { kind: "jcode", jcode_home: localHome, model_relay: "dgx/fast", start_mode: "headless", roles: ["verifier"], ...(extraInstance ?? {}) } };
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, instances, jcode_cmd: [...fake, "--record", record], jcode_home: baseHome, roster: { jcode: true, "jcode-local": true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, ...extra } as never });
  cleanups.push(() => daemon.stop());
  configureJcodeMcp(dir, stateDir, join(import.meta.dir, "../plugins/agent-hub/server.js"));
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => console_.close());
  return { dir, stateDir, daemon, console_, record, baseHome, localHome };
}

test("an instance with model_relay refuses to start when no gateway is confirmed on campus, and nothing is started (#685)", async () => {
  const { console_, record, daemon } = await hub({}, undefined);
  const reply = await console_.request({ t: "start", peer: "jcode-local", args: { mode: "headless" } });
  expect(reply.ok).toBe(false); expect(String(reply.error)).toMatch(/campus/);
  expect(() => readFileSync(record, "utf8")).toThrow(); // the fake jcode never ran
  expect(daemon.bus.peers.get("jcode-local")?.state ?? "offline").toBe("offline");
});

test("an on-campus relay instance starts with its own home, the relay's loopback URL and a per-launch token, never the gateway key (#685)", async () => {
  const gw = gateway();
  const { console_, record, localHome, daemon } = await hub({}, gw.url);
  const reply = await console_.request({ t: "start", peer: "jcode-local", args: { mode: "headless" } });
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  for (const role of ["serve", "acp"] as const) {
    const row = rows(record).find(entry => entry.kind === "launch" && entry.role === role);
    expect(row.home).toBe(localHome); expect(row.peer).toBe("jcode-local");
    expect(row.argv).toEqual(expect.arrayContaining(["-p", "openai-compatible", "--model", "dgx/fast"]));
    expect(row.compatBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/); expect(row.compatBase).not.toBe(gw.url);
    expect(row.compatKey).toBeString(); expect(row.compatKey).not.toBe("gateway-key-stays-in-the-hub");
    expect(row.gatewayKey).toBeUndefined();
  }
  expect(daemon.bus.stateOf("jcode-local")).not.toBe("offline");
  // The instance is a cloud peer: the relay never makes it on-prem.
  expect(JSON.stringify(daemon.status?.() ?? {})).not.toContain("gateway-key-stays-in-the-hub");
});

test("an extra Jcode implementer needs a managed worktree like every extra implementer; the refusal starts nothing (#685)", async () => {
  const { console_, record } = await hub({}, gateway().url, { roles: ["implementer"] });
  const reply = await console_.request({ t: "start", peer: "jcode-local", args: { mode: "headless" } });
  expect(reply.ok).toBe(false); expect(String(reply.error)).toContain("managed worktree");
  expect(() => readFileSync(record, "utf8")).toThrow();
});
