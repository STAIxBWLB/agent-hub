import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profile, proxyEnv, type SandboxNetwork } from "../src/local/sandbox.ts";
import { realPath } from "../src/hub/project.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const cwd = realPath(mkdtempSync(join(tmpdir(), "pi-loopback-"))); roots.push(cwd); return cwd; };

for (const network of [false, { proxyPort: 4321 }] satisfies SandboxNetwork[]) {
  test(`#1447 T5 Pi-only loopback bind/connect keeps external policy unchanged: ${JSON.stringify(network)}`, () => {
    const cwd = root(), ordinary = profile(cwd, network), pi = profile(cwd, network, [], [], [], true);
    expect(ordinary).not.toContain('(allow network-bind (local ip "localhost:*"))');
    expect(ordinary).not.toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(pi).toContain('(allow network-bind (local ip "localhost:*"))');
    expect(pi).toContain('(allow network-inbound (local ip "localhost:*"))');
    expect(pi).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(pi).not.toContain('(allow network*)');
    expect(pi).not.toContain('(allow network-outbound (local ip');
    expect(pi).not.toContain('(allow network-bind (local ip "*:*"))');
    if (typeof network === "object") expect(pi).toContain('(allow network-outbound (remote ip "localhost:4321"))');
    expect(pi).toContain('(deny file-write*');
  });
}

test("#1447 T5 only Pi's proxied shell bypasses the proxy for local fixtures", () => {
  const network = { proxyPort: 4321 };
  expect(proxyEnv(network).NO_PROXY).toBe("");
  expect(proxyEnv(false, true)).toEqual({});
  const pi = proxyEnv(network, true);
  expect(pi.HTTP_PROXY).toBe("http://127.0.0.1:4321");
  expect(pi.NO_PROXY).toContain("localhost");
  expect(pi.NO_PROXY).toContain("127.0.0.1");
  expect(pi.NO_PROXY).toContain("::1");
  expect(pi.NO_PROXY).toBe(pi.no_proxy);
  expect(pi.NO_PROXY).not.toContain("*");
});
