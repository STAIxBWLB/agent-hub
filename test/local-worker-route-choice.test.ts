import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "agenthub-local-route-choice-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/routing.toml"), `
[local]
fixed_model = "vllm/fixed"
[classes.implement]
peers = ["local"]
[hub_routes."hub/cli"]
type = "stage"
efficient = "vllm/routed"
capable = "vllm/routed"
[routes.coding]
type = "passthrough"
target = "old"
`);
  const priorKey = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "local-route-choice-key";
  cleanup.push(() => {
    if (priorKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = priorKey;
  });
  const model = startFakeModelServer({ key: "local-route-choice-key", models: ["vllm/fixed", "vllm/routed"], script: () => ({ content: "route fixture done" }) });
  cleanup.push(model.stop);
  const stateDir = join(cwd, "state");
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, omniroute: { urls: [model.url], access_hosts: [] } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => person.close());
  return { daemon, person, model };
}

test("#553 a task class without route or fixed_model keeps the person's explicit local hub route", async () => {
  const { daemon, person, model } = await fixture();
  expect((await person.request({ t: "start", peer: "local", args: { route: "hub/cli" } })).ok).toBe(true);
  expect((await person.request({ t: "task", op: "hub_task_propose", args: { title: "route-choice task fixture", class: "implement", owner: "local" } })).ok).toBe(true);
  // Deliver a correlated task envelope directly, so this routing test does not depend on
  // the separate proposal/acceptance delivery lifecycle or on a scheduled digest.
  const peer = daemon.bus.peers.get("local")!;
  for (let i = 0; i < 100 && peer.state === "busy"; i++) await Bun.sleep(10);
  expect(peer.state).toBe("idle");
  await peer.deliver([newEnvelope("user", "route-choice task fixture", { refs: { task: "1" }, to: ["local"] })]);
  const taskCalls = () => model.requests.filter(request => JSON.stringify(request.body.messages).includes("route-choice task fixture"));
  for (let i = 0; i < 100 && taskCalls().length === 0; i++) await Bun.sleep(10);
  expect(taskCalls().length).toBeGreaterThan(0);
  expect(taskCalls().every(request => request.body.model === "vllm/routed")).toBe(true);
});

test("#553 an unprefixed retired route starts the local worker with the fixed alias", async () => {
  const { daemon, person } = await fixture();
  const started = await person.request({ t: "start", peer: "local", args: { route: "coding" } });
  expect(started.ok).toBe(true);
  expect(daemon.bus.peers.get("local")?.recoveryMetadata?.()).toMatchObject({ launch: { kind: "local", route: "coding", model: "vllm/fixed" } });
});
