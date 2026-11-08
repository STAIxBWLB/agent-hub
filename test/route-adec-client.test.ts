import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { isAdecRouteEndpoint, requestAdecRoute, type AdecDecision, type AdecPair, type AdecRouteRequest } from "../src/models/route/adec.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pairs: AdecPair[] = [{ alias: "fast", effort: "low" }, { alias: "strong", effort: "high" }];
const input = (): AdecRouteRequest => ({ policyId: "ahub.chat", turnId: "turn-1", evidence: "synthetic evidence only",
  constraints: { contextTokens: 12, pii: false, private: false } });
const answer = (): AdecDecision => ({ id: "a".repeat(32), policyId: "ahub.chat", alias: "fast", effort: "low", margin: 0.8,
  abstain: false, reason: "ok", fallbackApplied: false, pinned: false, rules: [], estimatedCost: 0,
  decider: { provider: "fixture", kind: "logits", model: "fixture-model", latencyMs: 1 } });
const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
async function fake(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  let calls = 0; const sockets = new Set<Socket>();
  const server = createServer((req, res) => { calls++; req.on("error", () => {}); res.on("error", () => {}); handler(req, res); });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/route`, calls: () => calls };
}
const call = (endpoint: string, value = input(), allowed: readonly AdecPair[] = pairs, signal = new AbortController().signal, ms = 1000) => requestAdecRoute(endpoint, value, allowed, signal, ms);

test("endpoint accepts literal loopback route URLs only", () => {
  for (const url of ["http://127.0.0.1:8740/v1/route", "http://[::1]:8740/v1/route", "http://127.0.0.1/v1/route"]) expect(isAdecRouteEndpoint(url)).toBe(true);
  for (const url of [null, "http://localhost:8740/v1/route", "https://127.0.0.1:8740/v1/route", "http://127.1:8740/v1/route", "http://2130706433/v1/route",
    "http://0.0.0.0:8740/v1/route", "http://127.0.0.1:0/v1/route", "http://127.0.0.1:65536/v1/route", "http://user:pass@127.0.0.1:8740/v1/route",
    "http://127.0.0.1:8740/v1/route?key=synthetic", "http://127.0.0.1:8740/v1/route#fragment", "http://127.0.0.1:8740/a/../v1/route", "http://127.0.0.1:8740/v1/route/"]) expect(isAdecRouteEndpoint(url)).toBe(false);
});
test("one bounded JSON POST has no Origin, credentials or cookies and returns only projected data", async () => {
  let captured!: { headers: IncomingMessage["headers"]; method?: string; path?: string; body: unknown };
  const f = await fake((req, res) => {
    const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
      captured = { headers: req.headers, method: req.method, path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
      json(res, { ...answer(), error: "synthetic-server-error-canary" });
    });
  });
  const result = await call(f.endpoint);
  expect(result).toEqual({ ok: true, decision: answer() }); expect(f.calls()).toBe(1);
  expect(captured.body).toEqual(input()); expect(captured.method).toBe("POST"); expect(captured.path).toBe("/v1/route");
  expect(captured.headers["content-type"]).toBe("application/json");
  for (const name of ["origin", "authorization", "proxy-authorization", "cookie"]) expect(captured.headers[name]).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("synthetic-server-error-canary");
});
test("invalid request and configured pairs refuse before any HTTP effect or accessor execution", async () => {
  const f = await fake((_req, res) => json(res, answer()));
  const bad: unknown[] = [null, { ...input(), policyId: "UPPER" }, { ...input(), turnId: "bad turn" }, { ...input(), extra: "hidden" },
    { ...input(), evidence: "a".repeat(65537) }, { ...input(), evidence: "한".repeat(30000) },
    { ...input(), constraints: { ...input().constraints, contextTokens: Infinity } }, { ...input(), constraints: { ...input().constraints, private: undefined } },
    { ...input(), constraints: { ...input().constraints, explicit: { alias: "outside", effort: "low" } } }, { ...input(), candidates: ["outside"] }, { ...input(), candidates: ["fast", "fast"] }];
  let reads = 0;
  bad.push(Object.defineProperty({ ...input() }, "evidence", { enumerable: true, get() { reads++; throw Error("accessor must not execute"); } }));
  bad.push(new Proxy(input(), { get() { reads++; throw Error("proxy must not execute"); } }));
  for (const value of bad) expect(await call(f.endpoint, value as AdecRouteRequest)).toEqual({ ok: false, reason: "caller_error" });
  for (const allowed of [[], [...pairs, pairs[0]!], [{ alias: "bad alias", effort: "low" }], Array.from({ length: 27 }, (_, i) => ({ alias: `a${i}`, effort: "low" }))]) {
    expect(await call(f.endpoint, input(), allowed)).toEqual({ ok: false, reason: "caller_error" });
  }
  for (const ms of [0, -1, NaN, Infinity, 2_147_483_648]) expect(await call(f.endpoint, input(), pairs, new AbortController().signal, ms)).toEqual({ ok: false, reason: "caller_error" });
  expect(reads).toBe(0); expect(f.calls()).toBe(0);
});
test("HTTP 400 is caller error, redirects are not followed, and other errors expose no server prose", async () => {
  const target = await fake((_req, res) => json(res, answer()));
  const redirect = await fake((_req, res) => { res.writeHead(302, { location: target.endpoint }); res.end(); });
  expect(await call(redirect.endpoint)).toEqual({ ok: false, reason: "http" }); expect(target.calls()).toBe(0);
  for (const status of [400, 404, 500]) {
    const f = await fake((_req, res) => json(res, { error: "synthetic-secret-error-canary" }, status));
    expect(await call(f.endpoint)).toEqual({ ok: false, reason: status === 400 ? "caller_error" : "http" });
  }
});
test("valid fallback and no_candidate remain valid decisions, distinct from transport failure", async () => {
  const fallback: AdecDecision = { ...answer(), reason: "timeout", abstain: true, fallbackApplied: true };
  const f = await fake((_req, res) => json(res, fallback)); expect(await call(f.endpoint)).toEqual({ ok: true, decision: fallback });
  const none: AdecDecision = { ...answer(), alias: null, effort: null, reason: "no_candidate", abstain: true, decider: null };
  const n = await fake((_req, res) => json(res, none)); expect(await call(n.endpoint)).toEqual({ ok: true, decision: none });
  const noKind: AdecDecision = { ...answer(), decider: { provider: "fixture", model: "fixture-model", latencyMs: 1 } };
  const k = await fake((_req, res) => json(res, noKind)); expect(await call(k.endpoint)).toEqual({ ok: true, decision: noKind });
});
test("policy echo, alias-effort membership, request narrowing and malformed decision states fail closed", async () => {
  let value: unknown;
  const f = await fake((_req, res) => json(res, value));
  for (const bad of [null, { ...answer(), policyId: "other" }, { ...answer(), margin: 2 }, { ...answer(), margin: null }, { ...answer(), reason: "server prose" },
    { ...answer(), rules: ["unknown"] }, { ...answer(), rules: ["ctx_max", "ctx_max"] }, { ...answer(), alias: null },
    { ...answer(), reason: "no_candidate" }, { ...answer(), abstain: true }, { ...answer(), decider: { ...answer().decider, model: "server prose with spaces" } },
    { ...answer(), decider: { ...answer().decider, latencyMs: -1 } }, { ...answer(), estimatedCost: -1 }, { ...answer(), unknown: "hidden" }]) {
    value = bad; expect(await call(f.endpoint)).toEqual({ ok: false, reason: "malformed" });
  }
  for (const bad of [{ ...answer(), alias: "outside" }, { ...answer(), effort: "high" }]) { value = bad; expect(await call(f.endpoint)).toEqual({ ok: false, reason: "outside_options" }); }
  value = { ...answer(), alias: "strong", effort: "high" };
  expect(await call(f.endpoint, { ...input(), candidates: ["fast"] })).toEqual({ ok: false, reason: "outside_options" });
});
test("declared and streamed response size caps and non-JSON bodies are refused", async () => {
  const declared = await fake((_req, res) => { res.writeHead(200, { "content-type": "application/json", "content-length": 65537 }); res.end("{}"); });
  expect(await call(declared.endpoint)).toEqual({ ok: false, reason: "malformed" });
  const streamed = await fake((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write(" ".repeat(65536)); res.end(JSON.stringify(answer())); });
  expect(await call(streamed.endpoint)).toEqual({ ok: false, reason: "malformed" });
  const wrongType = await fake((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(JSON.stringify(answer())); });
  expect(await call(wrongType.endpoint)).toEqual({ ok: false, reason: "malformed" });
  const badJson = await fake((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("not-json-synthetic-canary"); });
  expect(await call(badJson.endpoint)).toEqual({ ok: false, reason: "malformed" });
});
async function heldBody() {
  let entered!: (entry: { closed: Promise<void> }) => void;
  const seen = new Promise<{ closed: Promise<void> }>(resolve => { entered = resolve; });
  const f = await fake((req, res) => {
    const closed = new Promise<void>(resolve => req.socket.once("close", () => resolve()));
    res.writeHead(200, { "content-type": "application/json" }); res.write("{"); entered({ closed });
  });
  return { ...f, seen };
}
test("the total deadline includes a stalled response body and closes the owned socket", async () => {
  const f = await heldBody(), pending = call(f.endpoint);
  const entry = await f.seen;
  expect(await pending).toEqual({ ok: false, reason: "timeout" }); await entry.closed;
});
test("parent abort closes an in-flight body and pre-aborted signals make no request", async () => {
  const controller = new AbortController(), f = await heldBody();
  const pending = call(f.endpoint, input(), pairs, controller.signal);
  const entry = await f.seen; controller.abort();
  expect(await pending).toEqual({ ok: false, reason: "aborted" }); await entry.closed;
  expect(f.calls()).toBe(1);
  const before = new AbortController(); before.abort();
  expect(await call(f.endpoint, input(), pairs, before.signal)).toEqual({ ok: false, reason: "aborted" }); expect(f.calls()).toBe(1);
});
test("ambient proxy variables do not redirect the explicit numeric connection", async () => {
  const proxy = await fake((_req, res) => json(res, { error: "proxy must not be contacted" }));
  const target = await fake((_req, res) => json(res, answer()));
  // Bun may retain a proxy environment observation in its transport. Keep those observations
  // in an owned child so this negative control cannot redirect later gateway fixtures.
  const code = `import { requestAdecRoute } from ${JSON.stringify(join(import.meta.dir, "../src/models/route/adec.ts"))};
    const result = await requestAdecRoute(${JSON.stringify(target.endpoint)}, ${JSON.stringify(input())}, ${JSON.stringify(pairs)}, new AbortController().signal, 1000);
    process.stdout.write(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1;`;
  const home = mkdtempSync(join(tmpdir(), "ahub-adec-proxy-")); cleanup.push(async () => rmSync(home, { recursive: true, force: true }));
  const env: Record<string, string> = { HOME: home, TMPDIR: home, AGENTHUB_HOME: home, PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[name] = proxy.endpoint;
  const child = Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(stderr).toBe(""); expect(JSON.parse(stdout).ok).toBe(true);
    expect(proxy.calls()).toBe(0); expect(target.calls()).toBe(1);
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}, 20_000);

test("caller mutation while the reply is pending cannot widen the captured request or configured pairs", async () => {
  let received!: (res: ServerResponse) => void;
  const entered = new Promise<ServerResponse>(resolve => { received = resolve; });
  const f = await fake((_req, res) => received(res));
  const allowed = [{ alias: "fast", effort: "low" }], request = input();
  const pending = call(f.endpoint, request, allowed);
  const res = await entered;
  allowed[0]!.alias = "outside"; request.policyId = "changed";
  json(res, { ...answer(), alias: "outside" });
  expect(await pending).toEqual({ ok: false, reason: "outside_options" });
});

test("a connection closed before HTTP headers becomes a closed transport failure", async () => {
  const f = await fake(req => req.socket.destroy());
  expect(await call(f.endpoint)).toEqual({ ok: false, reason: "http" }); expect(f.calls()).toBe(1);
});

test("merged adec policy terminal rule markers are accepted as closed metadata", async () => {
  for (const rule of ["explicit", "no_candidate", "pinned", "single"] as const) {
    const expected: AdecDecision = rule === "no_candidate"
      ? { id: answer().id, policyId: answer().policyId, alias: null, effort: null, reason: "no_candidate", margin: 0, abstain: true, fallbackApplied: false, pinned: false, decider: null, rules: [rule] }
      : { ...answer(), reason: rule, pinned: rule === "pinned", decider: null, rules: [rule] };
    const f = await fake((_req, res) => json(res, expected)), request = input();
    if (rule === "explicit") request.constraints.explicit = { alias: "fast", effort: "low" };
    expect(await call(f.endpoint, request)).toEqual({ ok: true, decision: expected });
  }
});


test("optional pinned decider version is preserved only when present", async () => {
  for (const version of [undefined, "v1.2.3"] as const) {
    const expected = { ...answer(), decider: { ...answer().decider!, ...(version === undefined ? {} : { version }) } };
    const f = await fake((_req, res) => json(res, expected));
    expect(await call(f.endpoint)).toEqual({ ok: true, decision: expected });
  }
  for (const version of ["", "latest", "provider-latest", "LATEST", "not pinned", "x".repeat(129)]) {
    const f = await fake((_req, res) => json(res, { ...answer(), decider: { ...answer().decider!, version } }));
    expect(await call(f.endpoint)).toEqual({ ok: false, reason: "malformed" });
  }
});
