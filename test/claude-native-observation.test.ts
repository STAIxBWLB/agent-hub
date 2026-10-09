import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, stateDirFor } from "../src/hub/control-client.ts";
import { startDaemon } from "../src/hub/daemon.ts";
import { readEvents } from "../src/hub/events.ts";
import { formatReport, summarize } from "../src/hub/report.ts";
import { buildLaunch, claudeObservationHooks } from "../src/cli/launch.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { nativeHookIdentity } from "../src/cli/facts-hook.ts";
import { claudeReportedTokens, readClaudeTranscriptUsage } from "../src/hub/usage.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
test("managed Claude launcher and genuine command hooks register a non-Orca session and count only native Stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-native-hooks-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ roles: { claude: ["conductor", "reviewer"] }, conductor: { feed: "own" }, memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, task_sweep: { enabled: false } }));
  const configDir = join(dir, "claude-config"), projects = join(configDir, "projects", "fixture"); mkdirSync(projects, { recursive: true });
  const previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = configDir;
  cleanup.push(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  const stateDir = stateDirFor(dir);
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 }); cleanup.push(() => daemon.stop());
  const native = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => native.close());
  for (let n = 0; n < 100 && daemon.bus.stateOf("claude") !== "idle"; n++) await Bun.sleep(5);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const capture = join(dir, "native-launch.json");
  const oldRecovery = JSON.stringify([{ peer: "claude", projectRoot: dir, instanceId: JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).instanceId, launchId: "previous-orca-launch", handle: "preserved-orca-handle", worktreeId: "preserved-worktree", incarnationId: "preserved-incarnation", launcherPid: 1, launcherSignature: "preserved-signature" }]);
  writeFileSync(join(stateDir, "terminal-recovery.json"), oldRecovery);
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nimport {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),instanceId:process.env.AGENTHUB_INSTANCE_ID,launchId:process.env.AGENTHUB_LAUNCH_ID,peer:process.env.AGENTHUB_PEER_ID,stateDir:process.env.AGENTHUB_STATE_DIR}));\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: configDir };
  for (const key of Object.keys(env)) if (key.startsWith("ORCA_") || key.startsWith("AGENTHUB_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete (env as any)[key];
  const launch = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", dir, "claude"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  const launchError = await new Response(launch.stderr).text(); expect(await launch.exited).toBe(0); expect(launchError).not.toContain("cannot run");
  const registered = JSON.parse(readFileSync(capture, "utf8")); expect(registered.peer).toBe("claude"); expect(registered.instanceId).toBeDefined(); expect(registered.launchId).toBeDefined();
  expect(JSON.parse(readFileSync(join(stateDir, "claude-launch.json"), "utf8")).launchId).toBe(registered.launchId);
  expect(readFileSync(join(stateDir, "terminal-recovery.json"), "utf8")).toBe(oldRecovery); // ordinary replacement preserves unrelated recovery authority
  const settings = JSON.parse(registered.args[registered.args.indexOf("--settings") + 1]);
  for (const kind of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) expect(settings.hooks[kind]).toBeDefined();
  const sessionId = "native-session", transcript = join(projects, `${sessionId}.jsonl`); writeFileSync(transcript, "");
  const hook = async (kind: string, override: Record<string, string> = {}) => {
    const command = settings.hooks[kind][0].hooks[0].command;
    const process_ = Bun.spawn(["/bin/sh", "-c", command], { cwd: dir, env: { ...env, AGENTHUB_PEER_ID: "claude", AGENTHUB_INSTANCE_ID: registered.instanceId, AGENTHUB_LAUNCH_ID: registered.launchId, ...override }, stdin: Buffer.from(JSON.stringify({ hook_event_name: kind, session_id: sessionId, transcript_path: transcript, tool_name: "Read", tool_input: {}, prompt: "UNTRANSFERRED-PRIVATE-PROMPT" })), stdout: "pipe", stderr: "pipe" });
    await new Response(process_.stdout).text(); await new Response(process_.stderr).text(); expect(await process_.exited).toBe(0);
  };
  const nativeIdle = async () => {
    for (let n = 0; n < 400 && daemon.bus.stateOf("claude") !== "idle"; n++) await Bun.sleep(5);
  };
  await hook("SessionStart"); expect(JSON.parse(readFileSync(join(stateDir, "claude-session.json"), "utf8"))).toMatchObject({ sessionId, instanceId: registered.instanceId, launchId: registered.launchId, transcriptPath: transcript });
  const deliveries: any[] = []; native.onPush = msg => { if (msg.t === "deliver") deliveries.push(msg); };
  daemon.bus.publish(newEnvelope(HUB, "test supervision", { to: ["claude"], kind: "task", priority: "important", refs: { supervision: true, supervisionKey: "supervision:claude:test" } }));
  for (let n = 0; n < 100 && !deliveries.length; n++) await Bun.sleep(5);
  expect(deliveries).toHaveLength(1);
  expect((await native.request({ t: "delivery_receipt", deliveryId: deliveries[0].deliveryId, generation: deliveries[0].generation, state: "accepted" })).ok).toBe(true);
  writeFileSync(transcript, JSON.stringify({ type: "assistant", sessionId, timestamp: "2026-01-01T00:00:00.000Z", message: { id: "historical-message", stop_reason: "end_turn" } }) + "\n");
  await hook("Stop");
  expect(readEvents(join(stateDir, "events.jsonl")).some(event => event.type === "native_turn_end" || event.type === "supervision_turn")).toBe(false);
  expect(summarize(readEvents(join(stateDir, "events.jsonl"))).peers.claude?.turns).toBeNull();
  await hook("UserPromptSubmit"); expect(daemon.bus.stateOf("claude")).toBe("busy");
  await hook("PreToolUse"); await hook("PostToolUse");
  await native.request({ t: "task", op: "hub_task_list", args: {} }); await native.request({ t: "send", body: "[FYI] tool finished" });
  expect(daemon.bus.stateOf("claude")).toBe("busy"); expect(readEvents(join(stateDir, "events.jsonl")).some(event => event.type === "native_turn_end")).toBe(false);
  await native.request({ t: "facts", phase: "stop", sessionId, transcriptPath: transcript });
  const unbound = readEvents(join(stateDir, "events.jsonl"));
  expect(unbound.some(event => event.type === "native_turn_end" || event.type === "supervision_turn")).toBe(false);
  expect(summarize(unbound).peers.claude?.turns).toBeNull(); expect(daemon.bus.stateOf("claude")).toBe("busy");
  await hook("Stop", { AGENTHUB_LAUNCH_ID: "stale-launch" }); expect(daemon.bus.stateOf("claude")).toBe("busy");
  writeFileSync(transcript, JSON.stringify({ type: "assistant", sessionId, timestamp: new Date().toISOString(), message: { id: "intermediate-tool-message", stop_reason: "tool_use" } }) + "\n");
  await hook("Stop"); expect(daemon.bus.stateOf("claude")).toBe("busy");
  expect(readEvents(join(stateDir, "events.jsonl")).some(event => event.type === "native_turn_end" || event.type === "supervision_turn")).toBe(false);
  writeFileSync(transcript, JSON.stringify({ type: "assistant", sessionId, timestamp: new Date().toISOString(), message: { id: "completed-message", stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } } }) + "\n");
  const beforeStopLog = readFileSync(join(stateDir, "hub.log"), "utf8").length;
  await hook("Stop"); await nativeIdle();
  if (daemon.bus.stateOf("claude") !== "idle") {
    const json = (file: string): Record<string, unknown> | undefined => { try { return JSON.parse(readFileSync(join(stateDir, file), "utf8")); } catch { return undefined; } };
    const marker = json("claude-launch.json"), metadata = json("claude-session.json");
    const suffix = readFileSync(join(stateDir, "hub.log"), "utf8").slice(beforeStopLog);
    const classes = ["current native turn start unavailable", "completed transcript message unavailable", "completion predates current native turn", "completion still matches start baseline", "completion timestamp precedes native start", "native start superseded during completion wait"];
    const refusals = classes.filter(reason => suffix.includes(`native Stop refused for claude: ${reason}`));
    // This fixture is synthetic. Print only fixed classes/binding booleans, never IDs, paths, transcript/tool text.
    console.error("native Stop synthetic fixture diagnostics: " + JSON.stringify({ refusals,
      markerInstanceMatches: marker ? marker.instanceId === registered.instanceId : null,
      markerLaunchMatches: marker ? marker.launchId === registered.launchId : null,
      sessionMatches: metadata ? metadata.sessionId === sessionId : null,
      sessionLaunchMatches: metadata ? metadata.launchId === registered.launchId : null,
      transcriptMatches: metadata ? metadata.transcriptPath === transcript : null,
      completedRecordAvailable: readClaudeTranscriptUsage(sessionId, transcript).some(record => record.completedTurn),
      clockAhead: Date.now() - new Date().getTime() > 1000,
      controlOperationFailed: suffix.includes("control operation failed"),
    }));
  }
  expect(daemon.bus.stateOf("claude")).toBe("idle");
  await hook("Stop"); const events = readEvents(join(stateDir, "events.jsonl"));
  expect(events.filter(event => event.type === "native_turn_end" && event.peer === "claude")).toHaveLength(1);
  expect(events.filter(event => event.type === "supervision_turn" && event.peer === "claude")).toHaveLength(1);
  expect(summarize(events).peers.claude).toMatchObject({ turns: 1, turnSource: "native-stop", tokens: 5 });
  expect(JSON.stringify(events)).not.toContain("UNTRANSFERRED-PRIVATE-PROMPT");
  expect(daemon.bus.stateOf("claude")).toBe("idle"); // duplicate completion A remains a no-op after its start is consumed
  appendFileSync(transcript, JSON.stringify({ type: "assistant", sessionId, timestamp: new Date().toISOString(), message: { id: "completion-without-new-start", stop_reason: "end_turn" } }) + "\n");
  await hook("Stop");
  const consumed = readEvents(join(stateDir, "events.jsonl"));
  expect(consumed.filter(event => event.type === "native_turn_end")).toHaveLength(1);
  expect(consumed.filter(event => event.type === "supervision_turn")).toHaveLength(1); // completion B cannot reuse consumed start A
  await hook("UserPromptSubmit"); await hook("PreToolUse"); expect(daemon.bus.stateOf("claude")).toBe("busy");
  await hook("Stop"); expect(daemon.bus.stateOf("claude")).toBe("busy");
  expect(readEvents(join(stateDir, "events.jsonl")).filter(event => event.type === "native_turn_end")).toHaveLength(1);
  const replacement = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => replacement.close());
  for (let n = 0; n < 100 && daemon.bus.stateOf("claude") !== "idle"; n++) await Bun.sleep(5);
  appendFileSync(transcript, JSON.stringify({ type: "assistant", sessionId, timestamp: new Date().toISOString(), message: { id: "unobserved-start-completion", stop_reason: "end_turn" } }) + "\n");
  await hook("Stop");
  expect(readEvents(join(stateDir, "events.jsonl")).filter(event => event.type === "native_turn_end")).toHaveLength(1); // a new receiver cannot reuse the old generation's start
  await hook("UserPromptSubmit"); await hook("PreToolUse"); await hook("Stop");
  expect(daemon.bus.stateOf("claude")).toBe("busy");
  expect(readEvents(join(stateDir, "events.jsonl")).filter(event => event.type === "native_turn_end")).toHaveLength(1);
  appendFileSync(transcript, JSON.stringify({ type: "assistant", sessionId, timestamp: new Date().toISOString(), message: { id: "completed-message-2", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } }) + "\n");
  await hook("Stop"); await nativeIdle(); expect(daemon.bus.stateOf("claude")).toBe("idle");
  expect(summarize(readEvents(join(stateDir, "events.jsonl"))).peers.claude).toMatchObject({ turns: 2, turnSource: "native-stop", tokens: 7 });
  await hook("UserPromptSubmit"); await hook("PreToolUse");
  await hook("Stop"); // ACK and hook exit must release the producer before its final transcript append
  expect(daemon.bus.stateOf("claude")).toBe("busy");
  expect(readEvents(join(stateDir, "events.jsonl")).filter(event => event.type === "native_turn_end")).toHaveLength(2);
  await Bun.sleep(80); // baseline is an already certified completion, still not the new turn's proof
  appendFileSync(transcript, JSON.stringify({ type: "assistant", sessionId, timestamp: new Date().toISOString(), message: { id: "delayed-completed-message", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } }) + "\n");
  await nativeIdle(); expect(daemon.bus.stateOf("claude")).toBe("idle"); // the same Stop observer certifies after hook exit
  expect(summarize(readEvents(join(stateDir, "events.jsonl"))).peers.claude).toMatchObject({ turns: 3, tokens: 9 });
  await hook("UserPromptSubmit"); await hook("PreToolUse");
  await hook("Stop"); await Bun.sleep(80);
  await hook("UserPromptSubmit"); // a new observed start invalidates the older Stop's pending wait
  appendFileSync(transcript, JSON.stringify({ type: "assistant", sessionId, timestamp: new Date().toISOString(), message: { id: "new-start-completed-message", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } }) + "\n");
  await Bun.sleep(80); expect(daemon.bus.stateOf("claude")).toBe("busy");
  expect(readEvents(join(stateDir, "events.jsonl")).filter(event => event.type === "native_turn_end")).toHaveLength(3);
  await hook("Stop"); await nativeIdle(); expect(daemon.bus.stateOf("claude")).toBe("idle");
  expect(summarize(readEvents(join(stateDir, "events.jsonl"))).peers.claude).toMatchObject({ turns: 4, tokens: 11 });
}, 20_000);

test("conductor native hooks preserve explicit caller settings and report missing completion as unknown", () => {
  const paths = { script: "/candidate/facts-hook.ts", stateDir: "/candidate/state" };
  const hooks = claudeObservationHooks({ coordination: "advisory", roles: { claude: ["conductor"] }, task_sweep: { enabled: false } }, paths)!;
  expect(hooks.observeNative).toBe(true);
  const own = buildLaunch("claude", ["--settings", "{}"], { unattended: false, statusLine: { script: "/candidate/tee.ts", stateDir: paths.stateDir }, facts: hooks });
  expect(own.args.filter(arg => arg === "--settings")).toHaveLength(1); expect(own.warning).toContain("native session/turn observation hooks are off");
  const report = summarize([{ v: 1, at: "2026-10-09T00:00:00.000Z", type: "state", peer: "claude", state: "idle" }]);
  expect(report.peers.claude?.turns).toBeNull(); expect(formatReport(report).join("\n")).toContain("turns unknown");
});

test("ordinary facts and idle opt-ins observe a managed pure-text turn without any tool Pre hook", async () => {
  for (const [coordination, idle] of [["turn-free", false], ["advisory", true]] as const) {
    const dir = mkdtempSync(join(tmpdir(), "ahub-ordinary-hooks-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".agenthub"));
    writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ coordination, roles: { claude: ["planner", "reviewer"] }, memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, task_sweep: { enabled: idle } }));
    const configDir = join(dir, "claude-config"), projects = join(configDir, "projects", "fixture"); mkdirSync(projects, { recursive: true });
    const previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = configDir;
    cleanup.push(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
    const stateDir = stateDirFor(dir);
    const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 }); cleanup.push(() => daemon.stop());
    const native = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => native.close());
    for (let n = 0; n < 100 && daemon.bus.stateOf("claude") !== "idle"; n++) await Bun.sleep(5);
    const instanceId = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).instanceId;
    const launchId = crypto.randomUUID(), sessionId = "ordinary-session", transcript = join(projects, `${sessionId}.jsonl`); writeFileSync(transcript, "");
    writeFileSync(join(stateDir, "claude-launch.json"), JSON.stringify({ instanceId, launchId }));
    const paths = { script: join(import.meta.dir, "../src/cli/facts-hook.ts"), stateDir };
    const observed = claudeObservationHooks({ coordination, task_sweep: { enabled: idle }, roles: { claude: ["planner", "reviewer"] } }, paths)!;
    expect(observed.observeNative).toBe(true);
    const launch = buildLaunch("claude", [], { unattended: false, statusLine: { script: join(import.meta.dir, "../src/cli/statusline-tee.ts"), stateDir }, facts: observed });
    const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
    for (const kind of ["SessionStart", "UserPromptSubmit", "Stop"]) expect(settings.hooks[kind]).toBeDefined();
    const hook = async (kind: string) => {
      const child = Bun.spawn(["/bin/sh", "-c", settings.hooks[kind][0].hooks[0].command], { cwd: dir,
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, AGENTHUB_PEER_ID: "claude", AGENTHUB_INSTANCE_ID: instanceId, AGENTHUB_LAUNCH_ID: launchId },
        stdin: Buffer.from(JSON.stringify({ hook_event_name: kind, session_id: sessionId, transcript_path: transcript })), stdout: "pipe", stderr: "pipe" });
      expect(await new Response(child.stdout).text()).toBe(""); await new Response(child.stderr).text(); expect(await child.exited).toBe(0);
    };
    await hook("SessionStart"); await hook("UserPromptSubmit"); expect(daemon.bus.stateOf("claude")).toBe("busy");
    await hook("Stop"); expect(daemon.bus.stateOf("claude")).toBe("busy"); // ACK releases the pure-text producer, not the strict completion fence
    appendFileSync(transcript, JSON.stringify({ type: "assistant", sessionId, timestamp: new Date().toISOString(), message: { id: "ordinary-text-final", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "completed" }] } }) + "\n");
    for (let n = 0; n < 400 && daemon.bus.stateOf("claude") !== "idle"; n++) await Bun.sleep(5);
    expect(daemon.bus.stateOf("claude")).toBe("idle");
    const events = readEvents(join(stateDir, "events.jsonl"));
    expect(events.filter(event => event.type === "native_turn_end" && event.peer === "claude")).toHaveLength(1);
    expect(summarize(events).peers.claude).toMatchObject({ turns: 1, turnSource: "native-stop", tokens: 2 });
    expect(events.filter(event => event.type === "fact")).toHaveLength(0); // no fabricated tool observation/fact injection
  }
}, 20_000);

test("Claude report uses unique native Stops over logical ends and labels legacy logical counts", () => {
  const at = "2026-10-09T00:00:00.000Z";
  const mixed = summarize([
    { v: 1, at, type: "turn_end", peer: "claude", turn: "logical-1", ms: 60_000 },
    { v: 1, at, type: "native_turn_end", peer: "claude", id: "native-1" },
    { v: 1, at, type: "native_turn_end", peer: "claude", id: "native-1" },
    { v: 1, at, type: "native_turn_end", peer: "claude", id: "native-2" },
  ]);
  expect(mixed.peers.claude).toMatchObject({ turns: 2, busyMinutes: 1, turnSource: "native-stop" });
  const legacy = summarize([{ v: 1, at, type: "turn_end", peer: "claude", turn: "old-logical", ms: 1000 }]);
  expect(legacy.peers.claude).toMatchObject({ turns: 1, turnSource: "logical-state" });
  expect(formatReport(legacy).join("\n")).toContain("logical state, native completion unobserved");
  const unbound = summarize([{ v: 1, at, type: "state", peer: "claude", state: "idle" }, { v: 1, at, type: "native_turn_end", peer: "claude" }]);
  expect(unbound.peers.claude?.turns).toBeNull(); expect(unbound.peers.claude?.turnSource).toBe("unknown");
});

test("library hook calls do not forward a different native launch's environment identity", () => {
  const env = { AGENTHUB_STATE_DIR: "/other/state", AGENTHUB_PEER_ID: "claude", AGENTHUB_INSTANCE_ID: "other-instance", AGENTHUB_LAUNCH_ID: "other-launch" };
  expect(nativeHookIdentity("/target/state", "claude", env)).toEqual({});
  expect(nativeHookIdentity("/other/state", "codex", env)).toEqual({});
  expect(nativeHookIdentity("/other/state", "claude", env)).toEqual({ nativeInstanceId: "other-instance", nativeLaunchId: "other-launch" });
});

test("Claude reported categories count without an explicit total and absent input/output stay unknown", () => {
  expect(claudeReportedTokens({ inputTokens: 3, outputTokens: 2 })).toBe(5);
  expect(claudeReportedTokens({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 })).toBe(10);
  expect(claudeReportedTokens({ inputTokens: 3 })).toBeUndefined();
  expect(claudeReportedTokens({ outputTokens: 2 })).toBeUndefined(); expect(claudeReportedTokens(undefined)).toBeUndefined();
  expect(claudeReportedTokens({ totalTokens: 0 })).toBe(0);
});
