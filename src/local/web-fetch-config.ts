// agent-hub #515 (hub task #332): the `local.web_fetch` config block and the host matcher both the tool and the egress proxy use. Pure on purpose: the config schema reaches the
// Claude channel bundle, so this file imports nothing that touches the file system, opens a socket or spawns a process. The tool is in `web-fetch.ts`, the proxy in `proxy.ts`.
import { isIP } from "node:net";

/** `host` or `host:port`; a name also matches its subdomains, an address only itself. Port 443 unless named. */
export function allowed(list: string[], host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.some((raw) => {
    const entry = raw.trim().toLowerCase();
    const at = entry.lastIndexOf(":");
    const [name, p] = at > 0 && !entry.includes("]") && /^\d+$/.test(entry.slice(at + 1)) ? [entry.slice(0, at), Number(entry.slice(at + 1))] : [entry, 443];
    if (!name || p !== port) return false;
    return h === name || (!isIP(name) && h.endsWith(`.${name}`));
  });
}
/** At most this many hosts: a list is a small, deliberate thing. */
export const MAX_WEB_HOSTS = 64;
/**
 * Why one `local.web_fetch.allow` entry is not accepted, or undefined. An entry is a host name, optionally `:port`: letters, digits, `-` and `.`, at least one dot, never an
 * address, a URL, a path, a wildcard or a bare top-level name (`com` would open every site). Checked when the config loads, so a typo fails there and not in a turn.
 */
export function webHostProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 253 + 6) return "a host is a non-empty name of at most 253 characters";
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match) return "a host is a name such as docs.example.org or docs.example.org:8443: no scheme, path, wildcard, spaces or bare top-level name";
  if (isIP(match[1]!)) return "a host is a name, never an address";
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return "a port is 1 to 65535";
  return undefined;
}

/** The checked `local.web_fetch.allow`. Nothing here reads the network or the disk. */
export function webFetchAllow(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_WEB_HOSTS) throw new Error(`local.web_fetch.allow takes a list of at most ${MAX_WEB_HOSTS} hosts`);
  const seen = new Set<string>(), out: string[] = [];
  input.forEach((host, index) => {
    const problem = webHostProblem(host);
    if (problem) throw new Error(`local.web_fetch.allow[${index}]: ${problem}`);
    const key = (host as string).toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(key); }
  });
  return out;
}
