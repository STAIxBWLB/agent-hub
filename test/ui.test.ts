import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { startDashboard } from "../src/hub/ui.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

function setup() {
  let time = 1_000;
  const snapshots: number[] = [];
  const actions: Record<string, unknown>[] = [];
  const ui = startDashboard({
    now: () => time,
    snapshot: (after) => { snapshots.push(after); return { events: [{ text: "private-test-event" }], cursor: 42 }; },
    action: async (input) => {
      actions.push(input);
      if (input.type === "throw") throw new Error("private-backend-error");
      return { ok: true };
    },
  });
  cleanup.push(ui.stop);
  function post(path: string, body: unknown = {}, overrides: Record<string, string | null> = {}) {
    const headers = new Headers({ origin: ui.origin, "content-type": "application/json" });
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) headers.delete(name); else headers.set(name, value);
    }
    return fetch(`${ui.origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  }
  async function session() {
    const ticket = new URL(ui.issue()).hash.slice(1);
    const response = await post("/session", { ticket });
    expect(response.status).toBe(200);
    return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, response, ticket };
  }
  return { ui, post, session, snapshots, actions, advance: (ms: number) => { time += ms; } };
}

test("dashboard shell is static, data-free and protected by browser response headers", async () => {
  const { ui, snapshots, actions } = setup();
  const url = new URL(ui.issue());
  expect(url.origin).toBe(ui.origin);
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.search).toBe("");
  expect(url.hash.slice(1)).toMatch(/^[a-f0-9]{64}$/);
  const response = await fetch(ui.origin);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).not.toContain(url.hash.slice(1));
  expect(html).not.toContain("private-test-event");
  expect(html).not.toContain("control-token");
  expect(snapshots).toEqual([]);
  expect(actions).toEqual([]);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  const csp = response.headers.get("content-security-policy")!;
  for (const directive of ["default-src 'none'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "sha256-"]) expect(csp).toContain(directive);
  expect(csp).not.toContain("unsafe-inline");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

test("ticket exchange creates a distinct HttpOnly Strict session and permits snapshot/action requests", async () => {
  const { post, session, snapshots, actions } = setup();
  const { cookie, response, ticket } = await session();
  const setCookie = response.headers.get("set-cookie")!;
  for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=3600"]) expect(setCookie).toContain(flag);
  expect(cookie).not.toContain(ticket);
  expect(await response.json()).toEqual({ ok: true });
  const snapshot = await post("/snapshot", { after: 7 }, { cookie });
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toEqual({ events: [{ text: "private-test-event" }], cursor: 42 });
  expect(snapshots).toEqual([7]);
  expect((await post("/snapshot", {}, { cookie })).status).toBe(200);
  expect(snapshots).toEqual([7, 0]);
  expect((await post("/action", { type: "pause", peer: "kimi" }, { cookie })).status).toBe(200);
  expect(actions).toEqual([{ type: "pause", peer: "kimi" }]);
  expect((await post("/session", { ticket })).status).toBe(401);
});

test("tickets expire at sixty seconds and sessions at one hour without sliding renewal", async () => {
  const { ui, post, session, advance } = setup();
  const old = new URL(ui.issue()).hash.slice(1);
  advance(60_000);
  expect((await post("/session", { ticket: old })).status).toBe(401);
  const { cookie } = await session();
  advance(3_599_999);
  expect((await post("/snapshot", {}, { cookie })).status).toBe(200);
  advance(1);
  expect((await post("/snapshot", {}, { cookie })).status).toBe(401);
  expect((await post("/action", {}, { cookie })).status).toBe(401);
  expect((await post("/snapshot")).status).toBe(401);
  expect((await post("/snapshot", {}, { cookie: "ahub_ui_fake=forged" })).status).toBe(401);
});

test("every endpoint enforces exact Host and every API enforces exact Origin before invoking callbacks", async () => {
  const { ui, post, session, snapshots, actions } = setup();
  const { cookie } = await session();
  const ticket = new URL(ui.issue()).hash.slice(1);
  for (const path of ["/session", "/snapshot", "/action"]) {
    for (const origin of [null, "null", "https://attacker.example", `${ui.origin}.attacker.example`, ui.origin.replace("127.0.0.1", "localhost")]) {
      const response = await post(path, { ticket }, { origin, cookie });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const host of ["attacker.example", new URL(ui.origin).host.replace("127.0.0.1", "localhost"), "127.0.0.1"]) {
      expect((await post(path, { ticket }, { host, cookie })).status).toBe(403);
    }
  }
  expect((await fetch(ui.origin, { headers: { host: "attacker.example" } })).status).toBe(403);
  expect((await fetch(ui.origin, { headers: { origin: "null" } })).status).toBe(403);
  expect(snapshots).toEqual([]);
  expect(actions).toEqual([]);
  // Rejected cross-origin requests must not consume a valid bootstrap ticket.
  expect((await post("/session", { ticket })).status).toBe(200);
});

test("API rejects wrong methods, types, malformed objects, invalid cursors and unknown paths", async () => {
  const { ui, post, session, snapshots, actions } = setup();
  const { cookie } = await session();
  for (const path of ["/session", "/snapshot", "/action"]) {
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
      const response = await fetch(`${ui.origin}${path}`, { method, headers: { origin: ui.origin, cookie } });
      expect(response.status).toBe(405);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const type of [null, "text/plain", "application/x-www-form-urlencoded"]) expect((await post(path, {}, { cookie, "content-type": type })).status).toBe(415);
    for (const body of [null, [], "hello", 5, true]) expect((await post(path, body, { cookie })).status).toBe(400);
    expect((await fetch(`${ui.origin}${path}`, { method: "POST", headers: { origin: ui.origin, cookie, "content-type": "application/json" }, body: "{" })).status).toBe(400);
  }
  for (const after of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) expect((await post("/snapshot", { after }, { cookie })).status).toBe(400);
  expect((await post("/unknown", {}, { cookie })).status).toBe(404);
  for (const path of ["/src/cli/main.ts", "/.agenthub/state/control-token", "/index.html"]) expect((await fetch(`${ui.origin}${path}`)).ok).toBe(false);
  expect(snapshots).toEqual([]);
  expect(actions).toEqual([]);
});

test("requests without Host are rejected even when Origin and session are valid", async () => {
  const { ui, session, snapshots, actions } = setup();
  const { cookie } = await session();
  for (const path of ["/session", "/snapshot", "/action"]) {
    const response = await new Promise<string>((resolve, reject) => {
      let raw = "";
      const socket = connect(Number(new URL(ui.origin).port), "127.0.0.1", () => {
        socket.write(`POST ${path} HTTP/1.1\r\nOrigin: ${ui.origin}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
      });
      socket.setTimeout(2_000, () => socket.destroy(new Error("HTTP response timed out")));
      socket.on("data", (chunk) => { raw += chunk.toString(); });
      socket.on("end", () => resolve(raw));
      socket.on("error", reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 (400|403) /);
    expect(response).not.toContain("Set-Cookie:");
  }
  expect(snapshots).toEqual([]);
  expect(actions).toEqual([]);
});

test("action errors never disclose backend text and stopped listeners lose their credentials", async () => {
  const { ui, post, session } = setup();
  const { cookie } = await session();
  const response = await post("/action", { type: "throw" }, { cookie });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("private-backend-error");
  ui.stop();
  await expect(fetch(ui.origin)).rejects.toThrow();
});

test("oversized API bodies are rejected before the action callback", async () => {
  const { post, session, actions } = setup();
  const { cookie } = await session();
  const response = await post("/action", { type: "message", body: "x".repeat(40 * 1024) }, { cookie });
  expect(response.ok).toBe(false);
  expect(actions).toEqual([]);
});
