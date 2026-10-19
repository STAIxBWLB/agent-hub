import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { SWITCHYARD, STRIDE } from "../src/hub/ports.ts";
import { DEFAULT_INFERENCE, Inference } from "../src/hub/inference.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

for (const withConfig of [false, true]) test(`#553 legacy tables are retired without rewriting routing, config present=${withConfig}`, () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-retired-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agenthub"));
  if (withConfig) writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const file = join(root, ".agenthub/routing.toml");
  const text = '[local]\nroute="sy/old"\nfixed_model="coding"\n[targets.old]\nid="coding"\n[routes."sy/old"]\ntype="passthrough"\ntarget="old"\n';
  writeFileSync(file, text);
  const retired = loadConfig(root).retired ?? [];
  expect(retired.some(line => line.includes("targets") && line.includes("retired"))).toBe(true);
  expect(retired.some(line => line.includes("routes") && line.includes("retired"))).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(text);
});

test("#553 optional hub inference ignores the former sidecar endpoint and calls its current fixed alias", async () => {
  const prior = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "k";
  cleanups.push(() => { if (prior === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = prior; });
  const model = startFakeModelServer({ key: "k", script: () => ({ content: "fixed answer" }) }); cleanups.push(model.stop);
  let endpoints = 0;
  const deps = { omni: new OmniRoute({ urls: [model.url], access_hosts: [] }), fixedModel: () => "fast", log: () => {},
    route: "sy/fast", sidecar: () => ({ endpoint: async () => { endpoints++; return undefined; } }) };
  const inference = new Inference(DEFAULT_INFERENCE, deps as any);
  expect(await inference.complete("bounded system", "untrusted input", 8)).toBe("fixed answer");
  expect(endpoints).toBe(0);
  expect(model.requests.map(request => request.body.model)).toEqual(["fast"]);
});


test("#553 retired tables reload without activation, config rewrites or status sidecars", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-retired-reload-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, pi: { enabled: false }, task_sweep: { enabled: false } }));
  const file = join(root, ".agenthub/routing.toml");
  const initial = '[local]\nfixed_model="coding"\n'; writeFileSync(file, initial);
  const daemon = await startDaemon({ cwd: root, stateDir: join(root, "state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
  cleanups.push(() => daemon.stop());
  const person = await ControlClient.connect(join(root, "state"), { role: "console" }); cleanups.push(() => person.close());
  const legacy = initial + '[targets.old]\nextra="ignored legacy target"\n[routes."sy/old"]\ncustom="ignored legacy route"\n';
  writeFileSync(file, legacy);
  const result = await person.request({ t: "settings_reload" });
  expect(result.ok).toBe(true);
  expect((await person.request({ t: "status" })).status).not.toHaveProperty("switchyard");
  expect(readFileSync(file, "utf8")).toBe(legacy);
  expect(loadConfig(root).retired?.join("\n")).toContain("[targets]");
  writeFileSync(file, initial);
  expect((await person.request({ t: "settings_reload" })).ok).toBe(true);
  expect(loadConfig(root).retired ?? []).toEqual([]);
  expect(SWITCHYARD).toBe(3); expect(STRIDE).toBe(10);
});
