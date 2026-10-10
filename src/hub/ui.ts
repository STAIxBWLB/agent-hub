import { taskProgress } from "../ui/task-progress.ts";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/** What a request's session may do (#269): `settings` while a session opened by `ahub ui --settings` is inside its window. */
export interface DashboardSession { settings: boolean; settingsUntil?: number }
export interface DashboardOptions {
  snapshot: (after: number, input?: Record<string, unknown>, session?: DashboardSession) => unknown | Promise<unknown>;
  action: (input: Record<string, unknown>, session?: DashboardSession) => unknown | Promise<unknown>;
  projects?: () => unknown | Promise<unknown>;
  selectedProjectId?: string;
  /** Injectable clock for expiry tests; production uses wall time. */
  now?: () => number;
}

const TICKET_MS = 60_000;
const SESSION_MS = 60 * 60_000;
/** How long a session opened by `ahub ui --settings` may change settings that raise authority; it stays an ordinary session after. */
export const SETTINGS_MS = 15 * 60_000;
const LIMIT = 64;
const secret = () => randomBytes(32).toString("hex");

/** Separate browser surface. Only the authenticated control console may construct it and issue tickets. */
export function startDashboard(options: DashboardOptions) {
  const now = options.now ?? Date.now;
  const tickets = new Map<string, { expires: number; settings: boolean }>();
  const sessions = new Map<string, { expires: number; settingsUntil?: number }>();
  // Inject the same pure public-board model used by the console before computing CSP hashes.
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8")
    .replace("/* TASK_PROGRESS_MODEL */", () => `const taskProgress = ${taskProgress.toString()};`);
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
  function prune(map: Map<string, { expires: number }>) {
    for (const [key, entry] of map) if (entry.expires <= now()) map.delete(key);
  }
  const sessionOf = (cookie: string | undefined): DashboardSession => {
    const until = cookie ? sessions.get(cookie)?.settingsUntil : undefined;
    return until !== undefined && until > now() ? { settings: true, settingsUntil: until } : { settings: false };
  };
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
      if (!["/session", "/projects", "/snapshot", "/action"].includes(path)) return reject(404, "not found");
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
        const issued = tickets.get(ticket);
        if (!issued || !tickets.delete(ticket)) return reject(401, "ticket expired or used; run ahub ui");
        if (sessions.size >= LIMIT) return reject(429, "too many sessions; try later");
        const session = secret();
        sessions.set(session, { expires: now() + SESSION_MS, ...(issued.settings ? { settingsUntil: now() + SETTINGS_MS } : {}) });
        return json({ ok: true }, 200, { "Set-Cookie": `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      }
      if (path === "/projects") {
        if (!options.projects) {
          const result: Record<string, unknown> = { ok: true, mode: "project" };
          if (options.selectedProjectId) result.selectedProjectId = options.selectedProjectId;
          return json(result);
        }
        try {
          return json(await options.projects());
        } catch {
          return reject(400, "project listing failed; check its inputs and the terminal");
        }
      }
      if (path === "/snapshot") {
        const after = input.after ?? 0;
        if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) return reject(400, "invalid cursor");
        try {
          const result = await options.snapshot(after, input, sessionOf(cookie));
          if (!result || typeof result !== "object" || Array.isArray(result)) return json(result);
          const response = { ...(result as Record<string, unknown>) };
          if (typeof response.projectId === "string" && typeof input.projectId === "string" && response.projectId !== input.projectId) return reject(409, "snapshot project changed; refresh the dashboard");
          if (typeof response.instanceId === "string" && typeof input.instanceId === "string" && response.instanceId !== input.instanceId) return reject(409, "snapshot instance changed; refresh the dashboard");
          if (typeof input.projectId === "string" && response.projectId === undefined) response.projectId = input.projectId;
          if (typeof input.instanceId === "string" && response.instanceId === undefined) response.instanceId = input.instanceId;
          return json(response);
        } catch {
          return reject(400, "snapshot failed; check its inputs and the terminal");
        }
      }
      try {
        return json(await options.action(input, sessionOf(cookie)));
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
    /** `settings`: the ticket of `ahub ui --settings`, whose session may raise authority for SETTINGS_MS (#269). */
    issue(settings = false): string {
      prune(tickets);
      if (tickets.size >= LIMIT) tickets.delete(tickets.keys().next().value!);
      const ticket = secret();
      tickets.set(ticket, { expires: now() + TICKET_MS, settings });
      return `${origin}/#${ticket}`;
    },
    stop() {
      tickets.clear();
      sessions.clear();
      server.stop(true);
    },
  };
}
