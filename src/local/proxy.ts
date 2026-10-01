import { lookup } from "node:dns/promises";
import { isIP, connect, createServer, type Server, type Socket } from "node:net";

/**
 * The only way out for the local worker's commands when `local.bash_network` is on (issue #65): an HTTP CONNECT proxy
 * on loopback that opens tunnels to allowlisted hosts only. CONNECT only, so TLS stays end to end; plain HTTP is
 * refused. A name that resolves to a loopback, private or link-local address is refused unless it is listed as an
 * address: claude-mem and the Codex app-server listen on loopback without auth.
 */

/** What a project gets unless `local.network_allow` says otherwise: package registries and code hosts. */
export const DEFAULT_NETWORK_ALLOW = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
];

export interface EgressProxy {
  port: number;
  url: string;
  close(): Promise<void>;
}

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

/** Loopback, private (RFC 1918, unique local), link-local, unspecified or carrier-grade NAT. */
export function isInternal(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    if (a.startsWith("::ffff:")) return isInternal(a.slice(7));
    return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb");
  }
  const [x = 0, y = 0] = address.split(".").map(Number);
  return x === 127 || x === 10 || x === 0 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
}

export function startEgressProxy(opts: { allow: string[]; log: (line: string) => void }): Promise<EgressProxy> {
  const sockets = new Set<Socket>();
  // Half-open on both sides: a client that sends its request and shuts its write side still gets the answer.
  const server: Server = createServer({ allowHalfOpen: true }, (client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 8192) refuse(client, 431, "request header too large");
        return;
      }
      client.off("data", onData);
      client.pause();
      const rest = head.subarray(end + 4);
      const [method = "", target = "", version = ""] = head.subarray(0, end).toString("latin1").split("\r\n")[0]!.split(" ");
      // Answer in the version asked (macOS nc wants HTTP/1.0 back); curl and git take either.
      void tunnel(client, method, target, rest, version === "HTTP/1.0" ? "HTTP/1.0" : "HTTP/1.1");
    };
    client.on("data", onData);
  });

  const refuse = (client: Socket, code: number, why: string, target = "") => {
    if (target) opts.log(`network: refused ${target} (${why})`);
    client.end(`HTTP/1.1 ${code} ${code === 403 ? "Forbidden" : "Bad Request"}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nagent-hub: ${why}\n`);
  };

  const tunnel = async (client: Socket, method: string, target: string, rest: Buffer, http: string) => {
    if (method.toUpperCase() !== "CONNECT") return refuse(client, 403, "only CONNECT (https) goes through this proxy", `${method} ${target}`.slice(0, 200));
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target);
    if (!m) return refuse(client, 400, "bad CONNECT target", target.slice(0, 200));
    const host = m[1]!.replace(/^\[|\]$/g, "");
    const port = Number(m[2]);
    if (!allowed(opts.allow, host, port)) return refuse(client, 403, `${host}:${port} is not in local.network_allow`, `${host}:${port}`);
    let address = host;
    if (!isIP(host)) {
      try {
        address = (await lookup(host)).address;
      } catch {
        return refuse(client, 403, `${host} does not resolve`, `${host}:${port}`);
      }
      // A listed name must not lead back into this machine or its network (DNS can say anything).
      if (isInternal(address)) return refuse(client, 403, `${host} resolves to an internal address`, `${host}:${port}`);
    }
    const upstream = connect({ host: address, port, allowHalfOpen: true });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      client.write(`${http} 200 Connection Established\r\n\r\n`);
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on("error", () => (client.writable && !client.destroyed ? refuse(client, 403, `${host}:${port} is unreachable`) : client.destroy()));
    client.on("close", () => upstream.destroy());
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
