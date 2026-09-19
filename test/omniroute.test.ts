import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRouting } from "../src/hub/routing.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.AGENTHUB_OMNIROUTE_URL;
});
const secretFile = (value: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "agenthub-")), "secret");
  writeFileSync(file, `${value}\n`);
  return file;
};

test("the first healthy candidate wins; key comes from the file; provider header and no reasoning come back", async () => {
  const down = startFakeModelServer({ healthy: false });
  const up = startFakeModelServer({ key: "sk-file-key" });
  cleanup.push(down.stop, up.stop);
  const lines: string[] = [];
  const client = new OmniRoute({ urls: [down.url, up.url], api_key_file: secretFile("sk-file-key"), access_hosts: [] }, (l) => lines.push(l));

  const res = await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
  expect(res.message).toEqual({ role: "assistant", content: "echo: hi" });
  expect(res.provider).toBe("vllm");
  expect(down.requests).toHaveLength(0);
  expect(lines.join("\n")).not.toContain("sk-file-key");
});

test("preference order wins even when the preferred candidate answers last; an Access-style 403 is not healthy", async () => {
  const slowPreferred = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => (new URL(req.url).pathname === "/v1/models" ? (await Bun.sleep(300), Response.json({ data: [] })) : Response.json({ choices: [{ message: { role: "assistant", content: "from preferred" } }] })) });
  const fastFallback = startFakeModelServer();
  const forbidden = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("access denied", { status: 403 }) });
  cleanup.push(() => slowPreferred.stop(true), fastFallback.stop, () => forbidden.stop(true));
  process.env.OMNIROUTE_API_KEY = "k";
  const preferred = `http://127.0.0.1:${slowPreferred.port}/v1`;
  expect(await new OmniRoute({ urls: [preferred, fastFallback.url], access_hosts: [] }).base()).toBe(preferred);
  expect(await new OmniRoute({ urls: [`http://127.0.0.1:${forbidden.port}/v1`, fastFallback.url], access_hosts: [] }).base()).toBe(fastFallback.url);
  expect(await new OmniRoute({ urls: [`http://127.0.0.1:${forbidden.port}/v1`], access_hosts: [] }).base()).toBeUndefined();
});

test("env key beats the file; a wrong key fails without echoing it; no key is an error before any request", async () => {
  const up = startFakeModelServer({ key: "sk-env" });
  cleanup.push(up.stop);
  const client = new OmniRoute({ urls: [up.url], api_key_file: secretFile("sk-wrong"), access_hosts: [] });
  await expect(client.chat({ model: "m", messages: [] })).rejects.toThrow(/HTTP 401/);
  await client.chat({ model: "m", messages: [] }).catch((e: Error) => expect(e.message).not.toContain("sk-wrong"));
  process.env.OMNIROUTE_API_KEY = "sk-env";
  expect((await client.chat({ model: "m", messages: [{ role: "user", content: "x" }] })).message.content).toBe("echo: x");

  delete process.env.OMNIROUTE_API_KEY;
  await expect(new OmniRoute({ urls: [up.url], access_hosts: [] }).chat({ model: "m", messages: [] })).rejects.toThrow(/no OmniRoute API key/);
});

test("Cloudflare Access headers go only to listed hosts", async () => {
  const up = startFakeModelServer();
  cleanup.push(up.stop);
  process.env.OMNIROUTE_API_KEY = "k";
  const files = { cf_client_id_file: secretFile("cf-id"), cf_client_secret_file: secretFile("cf-secret") };
  await new OmniRoute({ urls: [up.url], access_hosts: ["127.0.0.1"], ...files }).chat({ model: "m", messages: [] });
  await new OmniRoute({ urls: [up.url], access_hosts: ["gateway.example.edu"], ...files }).chat({ model: "m", messages: [] });
  expect(up.requests[0]!.headers["cf-access-client-id"]).toBe("cf-id");
  expect(up.requests[0]!.headers["cf-access-client-secret"]).toBe("cf-secret");
  expect(up.requests[1]!.headers["cf-access-client-id"]).toBeUndefined();
});

test("through the sidecar: no key is sent, the session id is, the selected model is read", async () => {
  const sidecar = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) =>
      Response.json(
        { choices: [{ message: { role: "assistant", content: `auth=${req.headers.get("authorization")} session=${req.headers.get("x-switchyard-session-id")}` } }] },
        { headers: { "x-model-router-selected-model": "vllm/x" } },
      ),
  });
  cleanup.push(() => sidecar.stop(true));
  process.env.OMNIROUTE_API_KEY = "sk-must-not-leak";
  const res = await new OmniRoute().chat({ model: "sy/coding", messages: [] }, { via: `http://127.0.0.1:${sidecar.port}/v1`, sessionId: "s1" });
  expect(res.message.content).toBe("auth=null session=s1");
  expect(res.selectedModel).toBe("vllm/x");
});

test("routing.toml: shipped default loads; a project file wins; a file without fixed_model is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  const routing = loadRouting(dir);
  expect(routing.local.route).toBe("sy/coding");
  expect(routing.routes["sy/coding"]).toEqual({ type: "passthrough", target: "dsv4f" });
  expect(routing.targets.dsv4f!.id).toBe(routing.local.fixed_model);

  Bun.spawnSync(["mkdir", "-p", join(dir, ".agenthub")]);
  writeFileSync(join(dir, ".agenthub", "routing.toml"), '[local]\nfixed_model = "mine"\n');
  expect(loadRouting(dir).local.fixed_model).toBe("mine");
  writeFileSync(join(dir, ".agenthub", "routing.toml"), '[local]\nroute = "sy/x"\n');
  expect(() => loadRouting(dir)).toThrow(/fixed_model is required/);
});

test("on campus is a positive finding: an unreachable gateway is not on campus, an Access host is off campus", async () => {
  const up = startFakeModelServer();
  cleanup.push(up.stop);
  process.env.OMNIROUTE_API_KEY = "k";
  expect(await new OmniRoute({ urls: [up.url], access_hosts: [] }).onCampus()).toBe(true);
  expect(await new OmniRoute({ urls: [up.url], access_hosts: ["127.0.0.1"] }).onCampus()).toBe(false);
  const dead = new OmniRoute({ urls: ["http://127.0.0.1:9/v1"], access_hosts: [] });
  expect(await dead.onCampus()).toBe(false);
  expect(await dead.offCampus()).toBe(false); // which is why PII decisions must not use !offCampus()
  expect(dead.isAccessHost("not a url")).toBe(true);
});
