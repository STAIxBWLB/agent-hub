import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export interface DashboardOptions {
  snapshot: (after: number) => unknown;
  action: (input: Record<string, unknown>) => Promise<unknown>;
  /** Injectable clock for expiry tests; production uses wall time. */
  now?: () => number;
}

const TICKET_MS = 60_000;
const SESSION_MS = 60 * 60_000;
const LIMIT = 64;
const secret = () => randomBytes(32).toString("hex");

/** Separate browser surface. Only the authenticated control console may construct it and issue tickets. */
export function startDashboard(options: DashboardOptions) {
  const now = options.now ?? Date.now;
  const tickets = new Map<string, number>();
  const sessions = new Map<string, number>();
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  const hashes = (tag: string) => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))]
    .map((m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`).join(" ");
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; script-src ${hashes("script")}; style-src ${hashes("style")}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json", ...extra } });
  const reject = (status: number, error: string) => json({ ok: false, error }, status);
  function prune(map: Map<string, number>) {
    for (const [key, expires] of map) if (expires <= now()) map.delete(key);
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 32 * 1024,
    async fetch(req): Promise<Response> {
      if (req.headers.get("host") !== host) return reject(403, "forbidden host");
      const requestOrigin = req.headers.get("origin");
      if (requestOrigin !== null && requestOrigin !== origin) return reject(403, "forbidden origin");
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/") {
        return new Response(html, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
      }
      if (req.method !== "POST") return reject(405, "POST required");
      if (requestOrigin !== origin) return reject(403, "origin required");
      if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return reject(415, "JSON required");
      if (!["/session", "/snapshot", "/action"].includes(path)) return reject(404, "not found");
      prune(tickets);
      prune(sessions);
      let cookie: string | undefined;
      if (path !== "/session") {
        cookie = req.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
        if (!cookie || !sessions.has(cookie)) return reject(401, "session expired or missing; run ahub ui");
      }
      let input: Record<string, unknown>;
      try {
        const value = await req.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) return reject(400, "JSON object required");
        input = value as Record<string, unknown>;
      } catch {
        return reject(400, "invalid JSON");
      }
      prune(tickets);
      prune(sessions);
      if (path !== "/session" && (!cookie || !sessions.has(cookie))) return reject(401, "session expired; run ahub ui");
      if (path === "/session") {
        const ticket = typeof input.ticket === "string" ? input.ticket : "";
        if (!tickets.delete(ticket)) return reject(401, "ticket expired or used; run ahub ui");
        if (sessions.size >= LIMIT) return reject(429, "too many sessions; try later");
        const session = secret();
        sessions.set(session, now() + SESSION_MS);
        return json({ ok: true }, 200, { "Set-Cookie": `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      }
      if (path === "/snapshot") {
        const after = input.after ?? 0;
        if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) return reject(400, "invalid cursor");
        return json(options.snapshot(after));
      }
      try {
        return json(await options.action(input));
      } catch {
        // Exceptions may quote private task text or backend details. Never echo them to the page.
        return reject(400, "action failed; check its inputs and the terminal");
      }
    },
    error() {
      return reject(500, "dashboard request failed");
    },
  });
  const host = `127.0.0.1:${server.port}`;
  const origin = `http://${host}`;
  const cookieName = `ahub_ui_${server.port}`;
  return {
    origin,
    issue(): string {
      prune(tickets);
      if (tickets.size >= LIMIT) tickets.delete(tickets.keys().next().value!);
      const ticket = secret();
      tickets.set(ticket, now() + TICKET_MS);
      return `${origin}/#${ticket}`;
    },
    stop() {
      tickets.clear();
      sessions.clear();
      server.stop(true);
    },
  };
}
