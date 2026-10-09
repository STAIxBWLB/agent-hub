import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attribute, deliveryTask } from "../src/hub/attribution.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { newEnvelope, USER } from "../src/hub/envelope.ts";
import { readEvents } from "../src/hub/events.ts";
import { LocalPeer } from "../src/adapters/local-worker.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";

test("attribution applies delivery, single open, then unattributed without dividing usage", () => {
  expect(attribute(7, [1, 2])).toEqual({ task: 7, attribution: "delivery" });
  expect(attribute(7, [])).toEqual({ task: 7, attribution: "delivery" });
  expect(attribute(undefined, [2])).toEqual({ task: 2, attribution: "single_open" });
  expect(attribute(undefined, [1, 2])).toEqual({ attribution: "unattributed" });
  expect(attribute(undefined, [])).toEqual({ attribution: "unattributed" });
});

test("original delivery requires one distinct positive task, allowing unrelated envelopes", () => {
  const env = (task?: string) => newEnvelope(USER, "body", task === undefined ? {} : { refs: { task } });
  expect(deliveryTask([env("7"), env("7"), env()])).toBe(7);
  expect(deliveryTask([env(), env("0"), env("-1"), env("1.5"), env("oops")])).toBeUndefined();
  const mixed = deliveryTask([env("7"), env("8")]);
  expect(mixed).toBeUndefined();
  expect(attribute(mixed, [2])).toEqual({ task: 2, attribution: "single_open" });
  expect(attribute(mixed, [1, 2])).toEqual({ attribution: "unattributed" });
});

test("daemon writes delivery task on native tokens and turn_end even without ownership", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-attribution-"));
  const daemon = await startDaemon({
    cwd: join(import.meta.dir, ".."), stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false },
      kimi_cmd: ["bun", join(import.meta.dir, "fakes/acp-server.ts")] },
  });
  let client: ControlClient | undefined;
  try {
    client = await ControlClient.connect(stateDir, { role: "console" });
    expect((await client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
    // No task is owned by Kimi. Task ids from delivery still identify review/help work.
    daemon.bus.publish(newEnvelope(USER, "do the work", { to: ["kimi"], refs: { task: "77" } }));
    const file = join(stateDir, "events.jsonl");
    for (let i = 0; i < 300 && !readEvents(file).some(e => e.type === "turn_end" && e.task === 77); i++) await Bun.sleep(10);
    const events = readEvents(file);
    expect(events.find(e => e.type === "tokens" && e.task === 77)).toMatchObject({ peer: "kimi", n: 50, attribution: "delivery" });
    expect(events.find(e => e.type === "turn_end" && e.task === 77)).toMatchObject({ peer: "kimi", attribution: "delivery", tokens: 50 });
    // A later untagged turn must not inherit the previous delivered task.
    const before = events.filter(e => e.type === "tokens" && e.peer === "kimi").length;
    daemon.bus.publish(newEnvelope(USER, "more work", { to: ["kimi"] }));
    for (let i = 0; i < 300 && readEvents(file).filter(e => e.type === "tokens" && e.peer === "kimi").length <= before; i++) await Bun.sleep(10);
    expect(readEvents(file).filter(e => e.type === "tokens" && e.peer === "kimi").at(-1)).toMatchObject({ attribution: "unattributed" });
    const last = readEvents(file).findLast(e => e.type === "tokens" && e.peer === "kimi");
    expect(last?.type === "tokens" ? last.task : undefined).toBeUndefined();
  } finally {
    client?.close();
    await daemon.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("local usage carries the route policy task chosen from a multi-task delivery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agenthub-local-attribution-"));
  const keyFile = join(cwd, "key");
  writeFileSync(keyFile, "fake-test-key");
  const model = startFakeModelServer({ script: () => ({ content: "done" }) });
  const usage: { task?: number }[] = [];
  const peer = new LocalPeer("local", {
    cwd, omni: new OmniRoute({ urls: [model.url], access_hosts: [], api_key_file: keyFile }, () => {}), fixedModel: "vllm/fixed",
    tools: { deny: [], permit: async () => false },
    turnPolicy: () => ({ pii: false, task: "8" }), onUsage: record => { usage.push(record); },
  });
  try {
    await peer.start();
    await peer.deliver([newEnvelope(USER, "work", { refs: { task: "7" } }), newEnvelope(USER, "more", { refs: { task: "8" } })]);
    for (let i = 0; i < 300 && peer.state === "busy"; i++) await Bun.sleep(10);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.task).toBe(8);
  } finally {
    await peer.stop(); model.stop(); rmSync(cwd, { recursive: true, force: true });
  }
});
