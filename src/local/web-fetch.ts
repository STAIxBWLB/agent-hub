import { isIP } from "node:net";
import { sanitize } from "../hub/envelope.ts";
import { OUTPUT_CAP } from "./sandbox.ts";
import { allowed } from "./web-fetch-config.ts";
export { MAX_WEB_HOSTS, webFetchAllow, webHostProblem } from "./web-fetch-config.ts";

// agent-hub #515 (hub task #332): the local worker's `web_fetch`. Spec: "On-prem web reading (#515)", the owner decision of 2026-10-22.
// It is refused for the whole turn of a PII task, whatever the host: the URL or a query string could carry PII to the web, and `pii.paths` and `sanitize()` cover
// what comes back, not what goes out. Outside a PII turn it runs only through the egress proxy, to hosts the person listed for this project, and returns bounded,
// sanitized text only. Off by default.

/** The refusal for a PII turn. It is the same text for every URL, so it says nothing about the request. */
export const WEB_FETCH_PII = "error: web_fetch is not available in a PII task turn, whatever the host: the URL or a query could carry PII to the web. Use doc_read or read for what the project already holds";

/** What the daemon hands the worker when a project opts in (`local.web_fetch.allow` names at least one host). Getters, so a policy reload applies to the next call. */
export interface WebFetchPort {
  /** `local.web_fetch.allow`: hosts (`host` or `host:port`, subdomains included for a name) the model may read. */
  allow: () => readonly string[];
  /** The loopback URL of the egress proxy that opens tunnels to `allow` and nothing else; undefined while it is not running. */
  proxyUrl: () => string | undefined;
  /** Test seam: the fetch to use. Production leaves it unset (the global `fetch`). */
  fetch?: (url: string, init: { proxy: string; redirect: "manual"; signal: AbortSignal; headers: Record<string, string>; method: "GET" }) => Promise<Response>;
}
/** The port as a tool call sees it: with whether this turn is a PII task turn. */
export interface WebFetchContext extends WebFetchPort { pii: boolean }

export const WEB_FETCH_TIMEOUT_MS = 15_000;
/** Bytes read from a response, however large it says it is. Text past it is cut, never buffered. */
export const WEB_FETCH_MAX_BYTES = 512 * 1024;
export const WEB_FETCH_MAX_URL = 2000;
/** Redirects followed, each one re-checked against the allowlist before it is requested. */
export const WEB_FETCH_MAX_REDIRECTS = 3;
export const DEFAULT_WEB_LINES = 2000;

const TEXT_TYPE = /^(?:text\/[a-z0-9.+-]+|application\/(?:json|xml|xhtml\+xml|[a-z0-9.+-]+\+(?:json|xml)))(?:\s*;.*)?$/i;

/**
 * Whether a URL may be requested at all: https, a host the list names, port 443 unless the entry says otherwise, no userinfo, no address literal, no fragment-only tricks.
 * A reason string, never a throw. The reason names the host (the model already wrote it) and never anything the person configured beyond "not in the list".
 */
export function checkWebUrl(raw: string, allow: readonly string[]): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof raw !== "string" || !raw.trim() || raw.length > WEB_FETCH_MAX_URL || /[\x00-\x20\x7f]/.test(raw)) return { ok: false, reason: "url must be one https URL of at most 2000 characters with no spaces or control characters" };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: "url is not a valid URL" }; }
  if (url.protocol !== "https:") return { ok: false, reason: "only https URLs are fetched" };
  if (url.username || url.password) return { ok: false, reason: "a URL with a user name or password is not fetched" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return { ok: false, reason: "an address is not a host: name the site, and the person lists it in local.web_fetch.allow" };
  const port = url.port ? Number(url.port) : 443;
  if (!allowed([...allow], host, port)) return { ok: false, reason: `${host}:${port} is not in local.web_fetch.allow` };
  url.hash = "";
  return { ok: true, url };
}

/** The decoded text of a response body, read at most `WEB_FETCH_MAX_BYTES` bytes deep. */
async function readBounded(res: Response): Promise<{ text: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", cut: false };
  const chunks: Uint8Array[] = [];
  let total = 0, cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > WEB_FETCH_MAX_BYTES) { chunks.push(value.subarray(0, WEB_FETCH_MAX_BYTES - total)); total = WEB_FETCH_MAX_BYTES; cut = true; void reader.cancel().catch(() => undefined); break; }
    chunks.push(value); total += value.length;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)), cut };
}

/** Markup reduced to its text, enough to read a page: scripts and styles go, tags go, entities are decoded for the few that matter, runs of blank lines collapse. */
export function htmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br|pre|blockquote|table)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * One page as text. Never throws: every refusal is text for the model. Order matters and is the contract:
 *   1. a PII task turn is refused before the URL is read at all, whatever it says, so no host check, error or timing differs for it;
 *   2. the URL must be an allowed https host, and the proxy must be running (without it there is no way out, so no request is made);
 *   3. the request is a bare GET through the proxy, with no header or body from the model, and no redirect is followed without being checked again;
 *   4. only a text type is read, bounded in bytes and time, then `sanitize()` quotes a forged hub header and the output is cut at the shared output cap.
 */
export async function webFetch(url: string, args: Record<string, unknown>, port: WebFetchContext, signal?: AbortSignal): Promise<string> {
  if (port.pii) return WEB_FETCH_PII;
  const proxy = port.proxyUrl();
  let current = checkWebUrl(url, port.allow());
  if (!current.ok) return `error: ${current.reason}`;
  if (!proxy) return "error: web_fetch has no egress proxy right now, so nothing was requested";
  const doFetch = port.fetch ?? ((target, init) => fetch(target, init as RequestInit & { proxy: string }));
  let response: Response | undefined;
  try {
    for (let hop = 0; ; hop++) {
      const abort = AbortSignal.any([AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
      response = await doFetch(current.url.toString(), { method: "GET", proxy, redirect: "manual", signal: abort, headers: { accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.1", "user-agent": "agent-hub-web-fetch" } });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      void response.body?.cancel().catch(() => undefined);
      if (!location) return `error: the server answered ${response.status} with no location`;
      if (hop >= WEB_FETCH_MAX_REDIRECTS) return `error: more than ${WEB_FETCH_MAX_REDIRECTS} redirects`;
      let next: string;
      try { next = new URL(location, current.url).toString(); } catch { return "error: the server sent a redirect that is not a URL"; }
      const checked = checkWebUrl(next, port.allow());
      if (!checked.ok) return `error: the page redirects to a URL that is not allowed (${checked.reason})`;
      current = checked;
    }
  } catch (error) {
    if (signal?.aborted) return "error: turn cancelled before the page was read";
    const name = (error as { name?: string; code?: string })?.name, code = (error as { code?: string })?.code;
    if (name === "TimeoutError" || name === "AbortError") return `error: the page did not answer within ${WEB_FETCH_TIMEOUT_MS / 1000} seconds`;
    return `error: the page could not be fetched${typeof code === "string" && /^[A-Z_]{3,40}$/.test(code) ? ` (${code})` : ""}`;
  }
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); return `error: the server answered ${response.status}`; }
  const type = response.headers.get("content-type") ?? "";
  if (!TEXT_TYPE.test(type)) { void response.body?.cancel().catch(() => undefined); return `error: ${type.split(";")[0] || "an unknown type"} is not text: only text, JSON and XML pages are read`; }
  let body: { text: string; cut: boolean };
  try { body = await readBounded(response); } catch { return "error: the page could not be read to the end"; }
  const isHtml = /^text\/html|^application\/xhtml\+xml/i.test(type);
  const text = sanitize((isHtml ? htmlText(body.text) : body.text).replace(/\0/g, ""));
  const lines = text.split(/\r?\n/);
  const from = Math.max(1, Math.floor(Number(args.offset)) || 1), limit = Math.max(1, Math.floor(Number(args.limit)) || DEFAULT_WEB_LINES);
  if (from > lines.length) return `error: offset ${from} is past the end (${lines.length} lines)`;
  let out = "", shownTo = from - 1;
  for (let i = from - 1; i < Math.min(lines.length, from - 1 + limit); i++) {
    const row = `${i + 1}\t${lines[i]}\n`;
    if (out.length + row.length > OUTPUT_CAP) { if (!out) out = row.slice(0, OUTPUT_CAP); break; }
    out += row; shownTo = i + 1;
  }
  if (!shownTo || shownTo < from) shownTo = from;
  out = out.replace(/\n$/, "");
  const more = shownTo < lines.length ? `(lines ${from}-${shownTo} of ${lines.length}; read again with offset=${shownTo + 1})` : body.cut ? `(the page was cut at ${WEB_FETCH_MAX_BYTES / 1024} KiB)` : "";
  return more ? `${out}\n${more}` : out;
}
