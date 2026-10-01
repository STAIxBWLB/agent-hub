import { afterEach, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { allowed, isInternal, startEgressProxy, type EgressProxy } from "../src/local/proxy.ts";

// issue #65: the local worker's commands reach the network only through this allowlisting CONNECT proxy.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const echo = () => new Promise<number>((resolve) => {
  const server: Server = createServer((c) => c.on("data", (d) => c.write(d)));
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  cleanup.push(() => server.close());
});

/** Send raw bytes to the proxy and collect what comes back until it closes or `until` matches. */
const talk = (proxy: EgressProxy, head: string, then?: string, until?: RegExp) => new Promise<string>((resolve) => {
  const sock = connect(proxy.port, "127.0.0.1");
  let got = "";
  const done = () => (sock.destroy(), resolve(got));
  sock.on("data", (d) => {
    got += d.toString();
    if (then && got.includes("200 Connection Established") && !got.includes(then)) sock.write(then);
    if (until?.test(got)) done();
  });
  sock.on("close", done);
  sock.write(head);
  setTimeout(done, 2000);
});

test("allowlist: a name also matches its subdomains, an address only itself, port 443 unless an entry names one", () => {
  const list = ["github.com", "127.0.0.1:8443", "Registry.NPMjs.org"];
  expect(allowed(list, "github.com", 443)).toBe(true);
  expect(allowed(list, "codeload.github.com", 443)).toBe(true);
  expect(allowed(list, "evilgithub.com", 443)).toBe(false);
  expect(allowed(list, "github.com", 22)).toBe(false);
  expect(allowed(list, "registry.npmjs.org.", 443)).toBe(true);
  expect(allowed(list, "127.0.0.1", 8443)).toBe(true);
  expect(allowed(list, "127.0.0.1", 443)).toBe(false);
  expect(allowed(list, "x.127.0.0.1", 8443)).toBe(false);
});

test("internal addresses: loopback, private, link-local, CGNAT and their IPv6 forms", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "fec0::1", "224.0.0.1", "255.255.255.255", "198.18.0.1"]) expect(isInternal(a)).toBe(true);
  for (const a of ["140.82.112.3", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) expect(isInternal(a)).toBe(false);
  // issue #82: behind the well-known NAT64 prefix the embedded IPv4 address counts; the local-use prefix is refused
  for (const a of ["64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "64:ff9b:0:0:0:0:c0a8:101", "64:ff9b::", "64:ff9b:1::808:808", "64:ff9b:1:ffff::1"]) expect(isInternal(a)).toBe(true);
  for (const a of ["64:ff9b::808:808", "64:ff9b::8c52:7003", "64:ff9b:0:0:0:0:808:808"]) expect(isInternal(a)).toBe(false);
});

test("the proxy tunnels to an allowed target and refuses the rest, logging each refusal by host only", async () => {
  const target = await echo();
  const lines: string[] = [];
  const proxy = await startEgressProxy({ allow: [`127.0.0.1:${target}`, `localhost:${target}`], log: (l) => lines.push(l) });
  cleanup.push(() => proxy.close());
  const ok = await talk(proxy, `CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n\r\n`, "ping", /ping/);
  expect(ok).toContain("HTTP/1.1 200 Connection Established");
  expect(ok).toContain("ping"); // echoed through the tunnel
  expect(await talk(proxy, "CONNECT example.invalid:443 HTTP/1.1\r\n\r\n")).toContain("403 Forbidden");
  expect(await talk(proxy, `CONNECT localhost:${target} HTTP/1.1\r\n\r\n`)).toContain("resolves to an internal address"); // a listed name, an internal address
  expect(await talk(proxy, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")).toContain("only CONNECT");
  // no path, query or userinfo reaches the log: they carry tokens
  expect(await talk(proxy, "GET http://user:pa55@example.com/up?token=SECRET-1 HTTP/1.1\r\n\r\n")).toContain("only CONNECT");
  expect(await talk(proxy, "CONNECT https://user:pa55@evil.example/x?token=SECRET-2 HTTP/1.1\r\n\r\n")).toContain("bad CONNECT target");
  expect(await talk(proxy, "CONNECT a/b?token=SECRET-3:443 HTTP/1.1\r\n\r\n")).toContain("bad CONNECT target");
  expect(lines.join("\n")).not.toMatch(/SECRET|pa55|\/up/);
  expect(lines).toContain("network: refused GET example.com (only CONNECT (https) goes through this proxy)");
  expect(lines).toContain("network: refused example.invalid:443 (example.invalid:443 is not in local.network_allow)");
  expect(lines.some((l) => l.includes(`localhost:${target}`) && l.includes("internal address"))).toBe(true);
});

test("the hub runs the proxy only with bash_network true, and closes it when it stops", async () => {
  const start = async (bash_network: boolean | "direct") => {
    const stateDir = mkdtempSync(join(tmpdir(), "agenthub-egress-hub-"));
    const daemon = await startDaemon({ cwd: process.cwd(), projectId: "egress", instanceId: `egress-${Math.random()}`, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, local: { ...DEFAULT_CONFIG.local, bash_network, network_allow: ["x.example"] } } });
    return { daemon, log: () => readFileSync(join(stateDir, "hub.log"), "utf8") };
  };
  const on = await start(true);
  const port = Number(/egress proxy on 127\.0\.0\.1:(\d+), 1 allowed host/.exec(on.log())?.[1]);
  expect(port).toBeGreaterThan(0);
  await on.daemon.stop();
  const refused = await new Promise<boolean>((resolve) => connect(port, "127.0.0.1").on("connect", () => resolve(false)).on("error", () => resolve(true)));
  expect(refused).toBe(true);
  for (const value of [false, "direct"] as const) {
    const off = await start(value);
    expect(off.log()).not.toContain("egress proxy");
    await off.daemon.stop();
  }
});

// issue #81: the two refusals that wrote nothing to hub.log, each logged once and without request content.
test("an oversized header and an unreachable allowlisted target are refused with one log line each", async () => {
  const closed = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
  });
  const lines: string[] = [];
  const proxy = await startEgressProxy({ allow: [`127.0.0.1:${closed}`], log: (l) => lines.push(l) });
  cleanup.push(() => proxy.close());
  // the header arrives in many chunks and never ends: one refusal, one line, nothing of the header in it
  const big = await new Promise<string>((resolve) => {
    // half-open, as a client that keeps sending after the answer would be
    const sock = connect({ port: proxy.port, host: "127.0.0.1", allowHalfOpen: true });
    let got = "";
    sock.on("data", (d) => (got += d.toString()));
    sock.on("close", () => resolve(got));
    sock.on("error", () => resolve(got));
    // apart, so each chunk is its own data event: past the limit, every one of them would refuse again
    let i = 0;
    const send = () => { if (i < 6 && !sock.destroyed) sock.write(`X-Token-${i++}: SECRET-${"z".repeat(3000)}\r\n`, () => setTimeout(send, 30)); };
    send();
    setTimeout(() => (sock.destroy(), resolve(got)), 1500);
  });
  expect(big).toContain("431");
  expect(await talk(proxy, `CONNECT 127.0.0.1:${closed} HTTP/1.1\r\n\r\n`)).toContain(`127.0.0.1:${closed} is unreachable, ECONNREFUSED`);
  expect(lines).toEqual(["network: refused a request (request header too large)", `network: refused 127.0.0.1:${closed} (127.0.0.1:${closed} is unreachable, ECONNREFUSED)`]);
  expect(lines.join("\n")).not.toContain("SECRET");
});
