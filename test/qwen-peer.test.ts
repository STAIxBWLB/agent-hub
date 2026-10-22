import { createProjectAdapterCatalog as builtinProjectCatalog } from "../src/adapters/registry.ts";
import { crashPlan, writeSessions } from "../src/hub/crash.ts";
import { afterEach, expect, test, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpPeer } from "../src/adapters/acp.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { QWEN_MODE_IDS, permissionBoundary, permissionGrant } from "../src/hub/permission-mode.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { launcherPreview } from "../src/cli/preview.ts";
import { roleContract, DEFAULT_ROLES } from "../src/hub/hub-tools.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { peerRosterConfig, rosterAllows } from "../src/hub/roster.ts";

const FAKE = [process.execPath, join(import.meta.dir, "fakes/acp-server.ts"), "--agent-name", "qwen-code", "--agent-version", "0.25.0", "--modes", "default,auto-edit,yolo"];
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (condition: () => boolean, diagnostic?: () => string) => { for (let i = 0; i < 300 && !condition(); i++) await Bun.sleep(10); expect(condition(), diagnostic?.()).toBe(true); };

for (const version of ["0.25.0", "0.26.0"]) for (const mode of ["ask", "ask-when-needed", "never-ask"] as const) test(`Qwen ${version} uses its own ${mode} table and exact hub-tool binding (#256)`, async () => {
  const root = mkdtempSync(join(tmpdir(), "qwen-mode-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const record = join(root, "modes"), calls: string[] = [], answers: string[] = [];
  const cmd = [...FAKE]; cmd[cmd.indexOf("--agent-version") + 1] = version;
  const peer = new AcpPeer("qwen", { cmd: [...cmd, "--mode-ack-record", record, "--new-mode", "yolo"], cwd: root, qwen025: true, permissionMode: mode,
    mcpServers: [{ name: "agent-hub", command: "unused", args: [], env: [] }],
    autoApprove: title => { calls.push(title); return title === "mcp__agent-hub__hub_send"; } }); cleanups.push(() => peer.stop());
  peer.onMessage = body => answers.push(body);
  await peer.start(); expect(peer.permissionModeState).toBe(mode);
  expect(readFileSync(record, "utf8").trim()).toBe(QWEN_MODE_IDS[mode]);
  await peer.deliver([newEnvelope("user", "PERMISSION QWEN", { to: ["qwen"] })]);
  await until(() => answers.length === 1);
  expect(answers[0]).toContain("permission=yes"); expect(calls).toContain("mcp__agent-hub__hub_send");
  await peer.setPermissionMode("ask"); expect(readFileSync(record, "utf8").trim().split("\n").at(-1)).toBe("default");
});

test("production Qwen refuses wrong native identity/version while legacy benchmark ACP stays unmanaged (#256)", async () => {
  const root = mkdtempSync(join(tmpdir(), "qwen-native-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const version of ["0.24.7", "0.24.1", "0.27.0"]) {
    const cmd = [...FAKE]; cmd[cmd.indexOf("--agent-version") + 1] = version;
    const peer = new AcpPeer("qwen", { cmd, cwd: root, qwen025: true }); cleanups.push(() => peer.stop());
    await expect(peer.start()).rejects.toThrow("native identity is not verified"); expect(peer.state).toBe("offline");
  }
  const record = join(root, "unmanaged");
  const peer = new AcpPeer("qwen", { cmd: [...FAKE, "--mode-ack-record", record, "--new-mode", "auto-edit"], cwd: root }); cleanups.push(() => peer.stop());
  await peer.start(); expect(peer.permissionModeState).toBe("unmanaged"); expect(existsSync(record)).toBe(false);
  await expect(peer.setPermissionMode("never-ask")).rejects.toThrow("no verified mode mapping");
});

test("Qwen is optional on the roster, role-guided, previewed without execution and stopped as an owned ACP (#256)", async () => {
  const root = mkdtempSync(join(tmpdir(), "qwen-hub-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false } }));
  expect(rosterAllows(peerRosterConfig(undefined), "qwen", false, undefined, builtinProjectCatalog())).toBe(false);
  expect(DEFAULT_ROLES.qwen).toEqual(["implementer", "verifier"]); expect(roleContract("qwen", DEFAULT_ROLES)).toContain("qwen");
  expect(classifyPeerCommand("qwen", [])).toBe("conductor"); expect(permissionBoundary("qwen", undefined, builtinProjectCatalog())).toContain("NO hub sandbox");
  expect(permissionGrant("qwen", "never-ask")).toContain("every tool");
  const preview = launcherPreview("qwen", ["--print-command"], root, stateDir, false);
  expect(preview.cmd).toBe("qwen"); expect(preview.args).toEqual(["--acp"]);
  expect(() => launcherPreview("qwen", ["--mode", "tui"], root, stateDir, false)).toThrow("not offered");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, qwen_cmd: FAKE, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } }); cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
  expect((await client.request({ t: "start", peer: "qwen" })).error).toContain("ahub roster add qwen");
  expect((await client.request({ t: "settings_set", key: "roster.qwen", value: true })).ok).toBe(true);
  expect((await client.request({ t: "start", peer: "qwen", args: { mode: "tui" } })).error).toContain("not offered");
  expect((await client.request({ t: "start", peer: "qwen" })).ok).toBe(true);
  const replies: string[] = []; daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "qwen") replies.push(event.env.body); });
  daemon.bus.publish(newEnvelope("user", "qwen ping", { to: ["qwen"] })); await until(() => replies.length === 1);
  expect(replies[0]).toContain("qwen ping");
  expect((await client.request({ t: "permission", peer: "qwen", mode: "ask-when-needed" })).permissionMode).toBe("ask-when-needed");
  expect((await client.request({ t: "peer_stop", peer: "qwen" })).ok).toBe(true); expect(daemon.bus.peers.get("qwen")!.state).toBe("offline");
});


test("a crashed owned Qwen resumes its recorded ACP session instead of claiming self-reconnect (#256)", async () => {
  const root = mkdtempSync(join(tmpdir(), "qwen-crash-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), record = join(root, "loaded"); mkdirSync(stateDir);
  expect(crashPlan([{ peer: "qwen", meta: { sessionId: "qwen-saved", launch: { model: "qwen-model" } } }])[0]?.resume).toEqual({ sessionId: "qwen-saved", model: "qwen-model" });
  expect(crashPlan([{ peer: "qwen", meta: {} }])[0]?.how).toContain("identity unavailable");
  writeSessions(stateDir, { instanceId: "crashed", at: Date.now(), peers: [{ peer: "qwen", meta: { sessionId: "qwen-saved", launch: { model: "qwen-model" } } }] });
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, qwen_cmd: [...FAKE, "--record-load", record], roster: { qwen: true },
      recovery: { ...DEFAULT_CONFIG.recovery, auto_resume_after_crash: true },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } }); cleanups.push(() => daemon.stop());
  await until(() => daemon.bus.peers.get("qwen")?.state === "idle" && existsSync(record), () => readFileSync(join(stateDir, "hub.log"), "utf8"));
  expect(readFileSync(record, "utf8")).toBe("qwen-saved");
  expect(daemon.bus.peers.get("qwen")?.recoveryMetadata?.().sessionId).toBe("qwen-saved");
  const preview = launcherPreview("qwen", ["--session-id", "private-session"], root, stateDir, false);
  expect(JSON.stringify(preview)).not.toContain("private-session");
});


// Captured from the published 0.26.0 permission callback in #373; no model-generated tool turn is claimed.
test("Qwen 0.26.0 native permission shape maps offered once, cancellation and unknown choices (#373)", async () => {
  const root = mkdtempSync(join(tmpdir(), "qwen-native-shape-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cmd = [...FAKE]; cmd[cmd.indexOf("--agent-version") + 1] = "0.26.0";
  let choice: string | undefined = "proceed_once";
  const asked: { title: string; options: { optionId: string; kind: string }[] }[] = [], sent: any[] = [];
  const peer = new AcpPeer("qwen", { cmd, cwd: root, qwen025: true,
    onPermission: async request => { asked.push(request); return choice; } }); cleanups.push(() => peer.stop());
  await peer.start();
  const writer = spyOn(peer as any, "send").mockImplementation((message: any) => { sent.push(message); });
  try {
    const params = { sessionId: "s1", toolCall: { toolCallId: "fixture-call", status: "pending", title: 'hub_task_show (agent-hub MCP Server): {"task":373}',
      content: [], locations: [], kind: "other", rawInput: { task: 373 }, _meta: { toolName: "mcp__agent-hub__hub_task_show" } },
      options: [{ optionId: "proceed_always_project", name: "Always Allow in project", kind: "allow_always" },
        { optionId: "proceed_always_user", name: "Always Allow for user", kind: "allow_always" },
        { optionId: "proceed_once", name: "Allow", kind: "allow_once" }, { optionId: "cancel", name: "Reject", kind: "reject_once" }] };
    for (const [id, picked] of [[90,"proceed_once"],[91,undefined],[92,"not-offered"]] as const) {
      choice = picked;
      (peer as any).onLine(JSON.stringify({ jsonrpc: "2.0", id, method: "session/request_permission", params }));
      await until(() => sent.some(reply => reply.id === id));
      expect(sent.find(reply => reply.id === id).result.outcome).toEqual(id === 90 ? { outcome: "selected", optionId: "proceed_once" } : { outcome: "cancelled" });
    }
    expect(asked).toHaveLength(3);
    expect(asked[0]!.title).toContain('{"task":373}');
    expect(asked[0]!.options.find(option => option.kind === "allow_once")?.optionId).toBe("proceed_once");
  } finally { writer.mockRestore(); }
});
