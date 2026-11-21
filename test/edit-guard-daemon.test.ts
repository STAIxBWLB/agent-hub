import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";

test("local route guard refuses before a classified shell write", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "edit-guard-daemon-"))), stateDir = join(cwd, "state");
  const previous = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "fixture-key";
  mkdirSync(join(cwd, ".agenthub")); writeFileSync(join(cwd, ".agenthub", "routing.toml"), '[local]\nfixed_model="vllm/test"\n[classes.implement]\npeers=["local"]\n');
  const model = startFakeModelServer({ key: "fixture-key", models: ["vllm/test"], script: body => body.messages.at(-1)?.role === "tool" ? { content: `result: ${body.messages.at(-1)?.content}` } : String(body.messages.at(-1)?.content).includes("exercise guard") ? { tool_calls: [toolCall("bash", { command: "echo changed > a.txt" })] } : { content: "no action" } });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, agent: ControlClient | undefined;
  try {
    daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, unattended: true,
      config: { ...DEFAULT_CONFIG, batch_ms: 0, edit_governance: { arm: "route_guard" }, supervision: { mode: "shadow" }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, omniroute: { urls: [model.url], access_hosts: [] } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    expect((await person.request({ t: "start", peer: "local", args: { model: "vllm/test" } })).ok).toBe(true);
    expect((await person.request({ t: "task", op: "hub_task_propose", args: { title: "guard fixture", class: "summarize", owner: "local" } })).ok).toBe(true);
    const assigned = await person.request({ t: "task", op: "task_assign", args: { id: 1, peer: "local", role: "owner" } });
    expect(assigned.ok, JSON.stringify(assigned)).toBe(true);
    agent = await ControlClient.connect(stateDir, { role: "tools", peer: "local" });
    const acceptance = await agent.request({ t: "task", op: "hub_task_accept", args: { id: 1 } });
    expect(acceptance.ok, JSON.stringify(acceptance)).toBe(true);
    const peer = daemon.bus.peers.get("local")!; for (let i = 0; i < 100 && peer.state === "busy"; i++) await Bun.sleep(10);
    await peer.deliver([newEnvelope("user", "exercise guard", { refs: { task: "1" }, to: ["local"] })]);
    for (let i = 0; i < 300 && !model.requests.some(request => JSON.stringify(request.body.messages).includes("shell write refused")); i++) await Bun.sleep(10);
    expect(model.requests.some(request => JSON.stringify(request.body.messages).includes("shell write refused"))).toBe(true);
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
  } finally {
    agent?.close(); person?.close(); await daemon?.stop(); model.stop();
    if (previous === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("local OCC refuses a blind write and accepts a current read", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "edit-occ-daemon-"))), stateDir = join(cwd, "state");
  const previous = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "fixture-key";
  mkdirSync(join(cwd, ".agenthub")); writeFileSync(join(cwd, ".agenthub", "routing.toml"), '[local]\nfixed_model="vllm/test"\n');
  writeFileSync(join(cwd, "a.txt"), "before");
  const model = startFakeModelServer({ key: "fixture-key", models: ["vllm/test"], script: body => {
    if (!body.messages.some(message => String(message.content).includes("exercise OCC"))) return { content: "no action" };
    const results = body.messages.filter(message => message.role === "tool");
    if (results.length === 0) return { tool_calls: [toolCall("write", { path: "a.txt", content: "after" })] };
    if (results.length === 1) return { tool_calls: [toolCall("read", { path: "a.txt" })] };
    if (results.length === 2) return { tool_calls: [toolCall("write", { path: "a.txt", content: "after" })] };
    return { content: "finished" };
  } });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, agent: ControlClient | undefined;
  try {
    daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, unattended: true,
      config: { ...DEFAULT_CONFIG, batch_ms: 0, edit_governance: { arm: "occ_guard" }, supervision: { mode: "shadow" }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, omniroute: { urls: [model.url], access_hosts: [] } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    expect((await person.request({ t: "start", peer: "local", args: { model: "vllm/test" } })).ok).toBe(true);
    expect((await person.request({ t: "task", op: "hub_task_propose", args: { title: "OCC fixture", class: "summarize" } })).ok).toBe(true);
    const assigned = await person.request({ t: "task", op: "task_assign", args: { id: 1, peer: "local", role: "owner" } }); expect(assigned.ok, JSON.stringify(assigned)).toBe(true);
    agent = await ControlClient.connect(stateDir, { role: "tools", peer: "local" });
    const acceptance = await agent.request({ t: "task", op: "hub_task_accept", args: { id: 1 } }); expect(acceptance.ok, JSON.stringify(acceptance)).toBe(true);
    const peer = daemon.bus.peers.get("local")!; for (let i = 0; i < 100 && peer.state === "busy"; i++) await Bun.sleep(10);
    await peer.deliver([newEnvelope("user", "exercise OCC", { refs: { task: "1" }, to: ["local"] })]);
    for (let i = 0; i < 300 && !model.requests.some(request => request.body.messages.filter((message: { role: string }) => message.role === "tool").length >= 3); i++) await Bun.sleep(10);
    const request = model.requests.findLast(item => item.body.messages.filter((message: { role: string }) => message.role === "tool").length >= 3);
    expect(request).toBeDefined(); const results = request!.body.messages.filter((message: { role: string; content?: unknown }) => message.role === "tool");
    expect(String(results[0]!.content)).toContain("blind or stale"); expect(String(results[2]!.content)).toContain("wrote a.txt");
  } finally {
    agent?.close(); person?.close(); await daemon?.stop(); model.stop();
    if (previous === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Pi route guard refuses before its bridge executes a classified write", async () => {
  const { Board } = await import("../src/hub/board.ts");
  const cwd = realPath(mkdtempSync(join(tmpdir(), "edit-pi-daemon-"))), stateDir = join(cwd, "state");
  mkdirSync(stateDir); mkdirSync(join(cwd, ".agenthub"));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, board: InstanceType<typeof Board> | undefined;
  try {
    daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, unattended: true,
      config: { ...DEFAULT_CONFIG, batch_ms: 0, edit_governance: { arm: "combined_guard" }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    expect((await person.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
    board = new Board(join(stateDir, "hub.db")); const row = board.propose("user", { title: "Pi guard", class: "summarize" });
    board.update(row.id, "pi", "accepted", { owner: "pi", state: "in_progress" });
    const peer = daemon.bus.peers.get("pi")! as any;
    await peer.deliver([newEnvelope("user", "exercise Pi guard", { refs: { task: String(row.id) }, to: ["pi"] })]);
    const launch = peer.tuiLaunch, headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_start", generation: 1 }) });
    const call = async (name: string, args: object, id: string) => (await (await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, { method: "POST", headers, body: JSON.stringify({ name, args, toolCallId: id, sessionId: peer.recoveryMetadata().sessionId, generation: 1 }) })).json()) as { text: string };
    expect((await call("bash", { command: "echo changed > a.txt" }, "shell")).text).toContain("shell write refused");
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
    writeFileSync(join(cwd, "a.txt"), "before");
    expect((await call("write", { path: "a.txt", content: "after" }, "blind")).text).toContain("blind or stale");
    expect((await call("read", { path: "a.txt" }, "read")).text).toContain("before");
    expect((await call("write", { path: "a.txt", content: "after" }, "write")).text).toContain("wrote a.txt");
  } finally { board?.close(); person?.close(); await daemon?.stop(); rmSync(cwd, { recursive: true, force: true }); }
});

test("local resolves the guard again after accepting in the same turn", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "edit-accept-daemon-"))), stateDir = join(cwd, "state");
  const previous = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "fixture-key";
  mkdirSync(join(cwd, ".agenthub")); writeFileSync(join(cwd, ".agenthub", "routing.toml"), '[local]\nfixed_model="vllm/test"\n');
  const model = startFakeModelServer({ key: "fixture-key", models: ["vllm/test"], script: body => {
    if (!body.messages.some(message => String(message.content).includes("exercise accept"))) return { content: "no action" };
    const results = body.messages.filter(message => message.role === "tool");
    if (!results.length) return { tool_calls: [toolCall("hub_task_accept", { id: 1 })] };
    if (results.length === 1) return { tool_calls: [toolCall("bash", { command: "echo changed > a.txt" })] };
    return { content: "finished" };
  } });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined;
  try {
    daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, unattended: true,
      config: { ...DEFAULT_CONFIG, batch_ms: 0, edit_governance: { arm: "route_guard" }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, omniroute: { urls: [model.url], access_hosts: [] } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    expect((await person.request({ t: "start", peer: "local", args: { model: "vllm/test" } })).ok).toBe(true);
    expect((await person.request({ t: "task", op: "hub_task_propose", args: { title: "accept fixture", class: "summarize" } })).ok).toBe(true);
    const assigned = await person.request({ t: "task", op: "task_assign", args: { id: 1, peer: "local", role: "owner" } }); expect(assigned.ok, JSON.stringify(assigned)).toBe(true);
    const peer = daemon.bus.peers.get("local")!; for (let i = 0; i < 100 && peer.state === "busy"; i++) await Bun.sleep(10);
    await peer.deliver([newEnvelope("user", "exercise accept", { refs: { task: "1" }, to: ["local"] })]);
    for (let i = 0; i < 300 && !model.requests.some(request => request.body.messages.filter((message: { role: string }) => message.role === "tool").length >= 2); i++) await Bun.sleep(10);
    const request = model.requests.findLast(item => item.body.messages.filter((message: { role: string }) => message.role === "tool").length >= 2);
    expect(request).toBeDefined(); const results = request!.body.messages.filter((message: { role: string; content?: unknown }) => message.role === "tool");
    expect(String(results[0]!.content)).toContain("in_progress"); expect(String(results[1]!.content)).toContain("shell write refused");
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
  } finally {
    person?.close(); await daemon?.stop(); model.stop();
    if (previous === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});
