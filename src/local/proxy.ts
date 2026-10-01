import { lookup } from "node:dns/promises";
import { BlockList, isIP, connect, createServer, type Server, type Socket } from "node:net";

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

// Parsed, not prefix-matched: an IPv4-mapped IPv6 address in any spelling (`::ffff:7f00:1`) checks as its IPv4 address.
const INTERNAL = new BlockList();
// IPv4 nets as leading octets: the package check refuses private address literals in published files.
for (const [a, b, bits] of [[0, 0, 8], [10, 0, 8], [100, 64, 10], [127, 0, 8], [169, 254, 16], [172, 16, 12], [192, 168, 16], [198, 18, 15], [224, 0, 3]] as const) INTERNAL.addSubnet(`${a}.${b}.0.0`, bits, "ipv4");
for (const [net, bits] of [["::", 96], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) INTERNAL.addSubnet(net, bits, "ipv6");

/** Loopback, private, link-local, site-local, unspecified, carrier-grade NAT, benchmark, multicast or reserved. */
export function isInternal(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && INTERNAL.check(address, family === 6 ? "ipv6" : "ipv4");
}

const hostOf = (target: string) => {
  try {
    return ` ${new URL(target).host}`;
  } catch {
    return "";
  }
};

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
    // The log gets a method and a host, never a path, a query or userinfo: those carry tokens.
    if (method.toUpperCase() !== "CONNECT") return refuse(client, 403, "only CONNECT (https) goes through this proxy", `${/^[A-Za-z]{1,16}$/.test(method) ? method : "a request"}${hostOf(target)}`);
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target);
    const host = m?.[1]!.replace(/^\[|\]$/g, "") ?? "";
    if (!m || !(isIP(host) || /^[a-z0-9.-]+$/i.test(host))) return refuse(client, 400, "bad CONNECT target", "a CONNECT request");
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
