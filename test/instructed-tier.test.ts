import { expect, test } from "bun:test";
import { parseExactInstruction } from "../src/hub/instructed-exact.ts";

test("exact instructions require run and never interpret shell syntax", () => {
  expect(parseExactInstruction("run task assign 1055 jcode")).toEqual(["task", "assign", "1055", "jcode"]);
  expect(parseExactInstruction("  run   task assign 1055 jcode  ")).toEqual(["task", "assign", "1055", "jcode"]);
  for (const input of ["task assign 1055 jcode", "run", "run --as-user", "run task 'name'", "run task \"name\"", "run task \\name", "run task $HOME", "run task `id`", "run task a&b", "run task a<b", "run task a>b", "run task\nassign", "run task\tassign"]) {
    expect(parseExactInstruction(input)).toBeUndefined();
  }
});

test("exact-mode receipt consumption is atomic and closes on the first use", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { realPath } = await import("../src/hub/project.ts");
  const { InstructionReceipts, instructionHash } = await import("../src/hub/instruction-receipt.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-exact-")));
  const home = join(root, "home"), cwd = join(root, "project"); mkdirSync(home); mkdirSync(cwd);
  const session = "3004bef3-8884-4e54-bbf2-c5c760a52090", promptId = "3004bef3-8884-4e54-bbf2-c5c760a52091";
  const project = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(project, { recursive: true });
  const transcript = join(project, `${session}.jsonl`), now = Date.now();
  let clock = now + 2;
  const store = new InstructionReceipts(join(root, "hub.db"), async () => ({ session, transcript, home, cwd, peer: "claude" }), () => clock);
  try {
    expect(store.pending({ session, promptId, transcript, home, cwd, project: cwd, hash: instructionHash("run task assign 1055 jcode") }, now)).toBe(true);
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52092", sessionId: session, promptId, version: "2.1.329", timestamp: new Date(now + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>run task assign 1055 jcode</command-args>" } }) + "\n");
    const receipt = await store.forPeer("claude").confirmReceipt(session, now + 2);
    expect(receipt).toBeDefined();
    expect(store.consumeExact(receipt!.id, now + 2)).toBe(true);
    expect(store.consumeExact(receipt!.id, now + 2)).toBe(false);
    expect(store.consume(receipt!.id, now + 2)).toBe(false);
    expect(store.exactCurrent(receipt!.id, now + 2)).toBe(true);
    expect(store.exactCurrent(receipt!.id, now + 600_000)).toBe(false);
    const secondPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52093";
    expect(store.pending({ session, promptId: secondPrompt, transcript, home, cwd, project: cwd, hash: instructionHash("run task assign 1055 jcode") }, now + 3)).toBe(true);
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52094", sessionId: session, promptId: secondPrompt, version: "2.1.329", timestamp: new Date(now + 4).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>run task assign 1055 jcode</command-args>" } }) + "\n");
    clock = now + 5;
    const next = await store.forPeer("claude").confirmReceipt(session, now + 5);
    expect(next).toBeDefined(); expect(store.consumeExact(next!.id, now + 5)).toBe(true);
    store.stop(session); expect(store.exactCurrent(next!.id, now + 5)).toBe(false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("instructed mode defaults to exact and rejects unknown modes", async () => {
  const { instructedMode } = await import("../src/hub/instructed-exact.ts");
  expect(instructedMode(undefined)).toBe("exact");
  expect(instructedMode("off")).toBe("off");
  expect(instructedMode("exact")).toBe("exact");
  for (const value of [null, "intent", true, "EXACT"]) expect(() => instructedMode(value)).toThrow();
});

test("the exact form policy closes unknown forms and detects task scope", async () => {
  const { exactForm } = await import("../src/hub/instructed-exact.ts");
  expect(exactForm(["task", "assign", "1055", "jcode"])).toEqual({ argv: ["task", "assign", "1055", "jcode"], taskId: 1055 });
  expect(exactForm(["task", "unassign", "1055", "--role", "reviewer", "--revision", "3"])?.taskId).toBe(1055);
  expect(exactForm(["settings", "set", "tasks.auto_pull", "true", "--yes"])).toBeDefined();
  expect(exactForm(["settings", "set", "tasks.wip_limits.claude", "2"])).toBeDefined();
  expect(exactForm(["settings", "set", "tasks.queue_backpressure.max_queued", "4"])).toBeDefined();
  expect(exactForm(["stop", "jcode"])).toBeDefined();
  expect(exactForm(["pause", "jcode"])).toBeDefined();
  expect(exactForm(["resume", "jcode"])).toBeDefined();
  for (const key of ["budget.gate", "review.gate", "review.unknown_quota", "review.max_minutes"]) expect(exactForm(["settings", "set", key, "0.9"])).toBeUndefined();
  expect(exactForm(["model", "set", "jcode", "model-1"])).toBeDefined();
  expect(exactForm(["model", "clear", "jcode"])).toBeDefined();
  expect(exactForm(["backlog", "pull", "1055"])?.taskId).toBe(1055);
  for (const words of [["settings", "set", "instructed.mode", "off"], ["settings", "set", "permission.claude", "never-ask"], ["task", "assign", "1055", "jcode", "--as-user"], ["task", "assign", "1055", "jcode", "--project", "elsewhere"], ["task", "assign", "1055", "jcode", "--role", "owner", "--role", "reviewer"], ["agents", "trust", "jcode", "1.0"], ["permission", "claude", "never-ask"], ["settings", "set", "local.bash_network", "true"], ["reset"], ["broker", "room", "drop", "room"], ["sdlc", "authorize-release", "0.1.0"], ["sdlc", "merge", "1"], ["peer", "takeover", "claude"], ["recovery", "reattach", "1"], ["task", "claim", "1055"], ["unknown"]]) expect(exactForm(words)).toBeUndefined();
});


test("runtime guard refuses project roots, sandbox roots and any checkout ancestor", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { realPath } = await import("../src/hub/project.ts");
  const { instructedRuntimeAllowed } = await import("../src/hub/instructed-runtime.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-runtime-")));
  try {
    const installed = join(root, "installed"), project = join(root, "project"), worktree = join(root, "other");
    for (const dir of [installed, project, worktree]) mkdirSync(dir);
    expect(instructedRuntimeAllowed(installed, [project])).toBe(true);
    expect(instructedRuntimeAllowed(installed, [installed])).toBe(false);
    expect(instructedRuntimeAllowed(installed, [join(root, "missing")])).toBe(false);
    writeFileSync(join(worktree, ".git"), "gitdir: elsewhere");
    const nested = join(worktree, "package"); mkdirSync(nested);
    expect(instructedRuntimeAllowed(nested, [project])).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the daemon executes one confirmed assignment through its inherited installed CLI socket", async () => {
  const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { realPath } = await import("../src/hub/project.ts");
  const { Board } = await import("../src/hub/board.ts");
  const { startDaemon } = await import("../src/hub/daemon.ts");
  const { ControlClient, stateDirFor } = await import("../src/hub/control-client.ts");
  const { processSignature } = await import("../src/pi/process-signature.ts");
  const { instructionHash } = await import("../src/hub/instruction-receipt.ts");
  const { FakeMemoryClient, startFakeMemWorker } = await import("./fakes/mem-worker.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-exact-e2e-")));
  const install = join(root, "installed"), home = join(root, "home"), config = join(home, "claude"), cwd = join(root, "project");
  for (const dir of [install, home, config, cwd]) mkdirSync(dir);
  const { spawnSync } = await import("node:child_process");
  expect(spawnSync("git", ["init", "-q", cwd], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).status).toBe(0);
  const repo = join(import.meta.dir, "..");
  cpSync(join(repo, "src"), join(install, "src"), { recursive: true });
  cpSync(join(repo, "plugins"), join(install, "plugins"), { recursive: true });
  cpSync(join(repo, "templates"), join(install, "templates"), { recursive: true });
  cpSync(join(repo, "package.json"), join(install, "package.json"));
  const memoryFile = fileURLToPath(import.meta.resolve("@staix/agent-mem"));
  mkdirSync(join(install, "node_modules", "@staix"), { recursive: true });
  cpSync(dirname(dirname(memoryFile)), join(install, "node_modules", "@staix", "agent-mem"), { recursive: true });
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: true }, inference: { enabled: false }, mlx: { enabled: false }, task_sweep: { enabled: false } }));
  writeFileSync(join(cwd, ".agenthub/routing.toml"), readFileSync(join(repo, "templates/routing.toml"), "utf8").replace('pii = "local_only"', 'pii = "off"').replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"'));
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME"] as const, previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: config, AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "mem") });
  const stateDir = stateDirFor(cwd); mkdirSync(stateDir, { recursive: true });
  const board = new Board(join(stateDir, "hub.db"));
  const task = board.propose("user", { title: "instructed fixture", class: "implement" }); board.close();
  let captured: import("../src/hub/instruction-receipt.ts").InstructionReceipts | undefined;
  const worker = startFakeMemWorker(), memory = new FakeMemoryClient(worker.url);
  await memory.save({ text: "MEMORY-CONTROL", project: "fixture", metadata: {} });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({ cwd, stateDir, memoryClient: memory, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, instructedRuntimeForTest: { root: install, bun: process.execPath }, instructionReceiptStore: store => { captured = store; return store; } });
    const native = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
    const pushes: unknown[] = []; native.onPush = message => { pushes.push(message); };
    const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" });
    try {
      for (let n = 0; n < 100 && daemon.bus.stateOf("claude") !== "idle"; n++) await Bun.sleep(5);
      const session = "3004bef3-8884-4e54-bbf2-c5c760a52090", promptId = "3004bef3-8884-4e54-bbf2-c5c760a52091", launchId = "fixture-managed-launch";
      const folder = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); mkdirSync(folder, { recursive: true });
      const transcript = join(folder, `${session}.jsonl`); writeFileSync(transcript, "");
      const instanceId = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).instanceId;
      const dashboard = await ControlClient.connect(stateDir, { role: "console" });
      try {
        const dashboardReply = await dashboard.request({ t: "ui_action", instanceId, action: { action: "setting", key: "instructed.mode", value: "off" } });
        expect(dashboardReply.ok).toBe(false);
      } finally { dashboard.close(); }
      const unmanaged = await tools.request({ t: "instruction_execute", session });
      expect(unmanaged.error).toContain("this Claude session was not started by ahub claude");
      expect(unmanaged.error).toContain("ahub claude");
      writeFileSync(join(stateDir, "claude-launch.json"), JSON.stringify({ instanceId, launchId, permissionHook: true, launcherPid: process.pid, launcherSignature: processSignature(process.pid) }), { mode: 0o600 });
      const missing = await tools.request({ t: "instruction_execute", session });
      expect(missing.error).toContain("no session evidence for this Claude session yet");
      expect(missing.error).toContain("send one ordinary prompt");
      expect((await tools.request({ t: "facts", phase: "session", sessionId: session, transcriptPath: transcript, nativeInstanceId: instanceId, nativeLaunchId: launchId })).ok).toBe(true);
      expect((await tools.request({ t: "instruction_execute", session })).ok).toBe(false);
      expect((await tools.request({ t: "task", op: "task_assign", args: { id: task.id, peer: "claude" } })).ok).toBe(false);
      const args = `run task assign ${task.id} claude`, started = Date.now();
      expect(captured!.pending({ session, promptId, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(args) }, started)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52092", sessionId: session, promptId, version: "2.1.329", timestamp: new Date(started + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${args}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session, argv: ["task", "assign", "999", "claude"] })).ok).toBe(false);
      const result = await tools.request({ t: "instruction_execute", session }, 35_000);
      expect(result).toMatchObject({ ok: true });
      expect(result.exitCode).toBe(0);
      expect((await tools.request({ t: "instruction_execute", session })).ok).toBe(false);
      const audit = readFileSync(join(stateDir, "events.jsonl"), "utf8");
      expect(audit).toContain('"instructed":true'); expect(audit).toContain('"instructionReceipt":'); expect(audit).not.toContain(args);
      expect(readFileSync(join(stateDir, "hub.log"), "utf8")).not.toContain(args);
      expect(JSON.stringify(await tools.request({ t: "status" }))).not.toContain(args);
      expect(JSON.stringify(pushes)).not.toContain(args);
      expect(JSON.stringify(worker.calls)).toContain("MEMORY-CONTROL");
      expect(JSON.stringify(worker.calls)).not.toContain(args);
      const settingPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52095", settingArgs = "run settings set tasks.auto_pull true --yes", settingAt = Date.now();
      expect(captured!.pending({ session, promptId: settingPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(settingArgs) }, settingAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52096", sessionId: session, promptId: settingPrompt, version: "2.1.329", timestamp: new Date(settingAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${settingArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      const settingResult = await tools.request({ t: "instruction_execute", session }, 35_000);
      expect(settingResult).toMatchObject({ ok: true, exitCode: 0 });
      expect(JSON.parse(readFileSync(join(cwd, ".agenthub", "config.local.json"), "utf8")).tasks.auto_pull).toBe(true);
      const closedForms = ["run agents trust jcode 1.0", "run settings set local.bash_network true", "run reset", "run sdlc merge 1", "run peer takeover claude"];
      const admittedBefore = readFileSync(join(stateDir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"instructed":true')).length;
      for (const closed of closedForms) {
        const closedPrompt = crypto.randomUUID(), closedAt = Date.now();
        expect(captured!.pending({ session, promptId: closedPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(closed) }, closedAt)).toBe(true);
        writeFileSync(transcript, JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: session, promptId: closedPrompt, version: "2.1.329", timestamp: new Date(closedAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${closed}</command-args>` } }) + "\n");
        await Bun.sleep(5);
        const refused = await tools.request({ t: "instruction_execute", session }, 35_000);
        expect(refused.ok).toBe(false);
        expect(refused.error).toContain("not proven for instructed exact mode");
        expect(refused.error).toContain("cd '");
        expect(refused.error).toContain("Success:");
      }
      expect(readFileSync(join(stateDir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"instructed":true')).length).toBe(admittedBefore);
      const modePrompt = "3004bef3-8884-4e54-bbf2-c5c760a52103", modeArgs = "run settings set instructed.mode off", modeAt = Date.now();
      expect(captured!.pending({ session, promptId: modePrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(modeArgs) }, modeAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52104", sessionId: session, promptId: modePrompt, version: "2.1.329", timestamp: new Date(modeAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${modeArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session }, 35_000)).ok).toBe(false);
      expect((JSON.parse(readFileSync(join(cwd, ".agenthub", "config.local.json"), "utf8")).instructed ?? {}).mode).toBeUndefined();
      const installedEntry = join(install, "src/cli/main.js"), entry = readFileSync(installedEntry, "utf8");
      const floodPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52105", floodArgs = `run task unassign ${task.id}`, floodAt = Date.now();
      expect(captured!.pending({ session, promptId: floodPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(floodArgs) }, floodAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52106", sessionId: session, promptId: floodPrompt, version: "2.1.329", timestamp: new Date(floodAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${floodArgs}</command-args>` } }) + "\n");
      writeFileSync(installedEntry, 'process.stdout.write("x".repeat(65537));');
      await Bun.sleep(5);
      const flooded = await tools.request({ t: "instruction_execute", session }, 35_000);
      expect(flooded.ok).toBe(false); expect(flooded.error).toContain("output exceeded its limit");
      writeFileSync(installedEntry, entry);
      const pendingBoard = new Board(join(stateDir, "hub.db"));
      let pendingTask: number;
      try { pendingTask = pendingBoard.propose("user", { title: "stop race fixture", class: "implement" }).id; } finally { pendingBoard.close(); }
      writeFileSync(installedEntry, entry.replace("// Shell completion asks", "if (process.env.AGENTHUB_INSTRUCTED_IPC) await Bun.sleep(500);\n// Shell completion asks"));
      const stopPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52099", stopArgs = `run task assign ${pendingTask} claude`, stopAt = Date.now();
      expect(captured!.pending({ session, promptId: stopPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(stopArgs) }, stopAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52100", sessionId: session, promptId: stopPrompt, version: "2.1.329", timestamp: new Date(stopAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${stopArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      const running = tools.request({ t: "instruction_execute", session }, 35_000);
      const { Database } = await import("bun:sqlite"); const inspect = new Database(join(stateDir, "hub.db"), { readonly: true });
      let spent = false;
      try { for (let n = 0; n < 100 && !spent; n++) { spent = (inspect.query("SELECT state FROM instruction_receipts WHERE prompt_id = ?").get(stopPrompt) as { state: string } | null)?.state === "closed"; if (!spent) await Bun.sleep(5); } } finally { inspect.close(); }
      expect(spent).toBe(true);
      expect((await tools.request({ t: "instruction_hook", op: "stop", session })).ok).toBe(true);
      expect((await running).ok).toBe(false);
      const afterStop = new Board(join(stateDir, "hub.db"));
      try { expect(afterStop.get(pendingTask)!.owner).toBeNull(); } finally { afterStop.close(); }
      writeFileSync(installedEntry, entry);
      const offPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52097", offArgs = `run task unassign ${task.id}`, offAt = Date.now();
      expect(captured!.pending({ session, promptId: offPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(offArgs) }, offAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52098", sessionId: session, promptId: offPrompt, version: "2.1.329", timestamp: new Date(offAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${offArgs}</command-args>` } }) + "\n");
      expect((await tools.request({ t: "settings_set", key: "instructed.mode", value: "off" })).ok).toBe(false);
      const { personEnv } = await import("../src/hub/child-process.ts");
      let terminalOutput = "";
      const person = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "settings", "set", "instructed.mode", "off"], { cwd, env: { ...personEnv(process.env), AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd }, terminal: { cols: 100, rows: 20, data: (_term: unknown, bytes: Uint8Array) => { terminalOutput += new TextDecoder().decode(bytes); } } } as never);
      expect(await person.exited).toBe(0);
      expect(terminalOutput).toContain("witness off");
      const localConfig = join(cwd, ".agenthub", "config.local.json");
      const local = JSON.parse(readFileSync(localConfig, "utf8")); local.instructed = { mode: "off" }; writeFileSync(localConfig, JSON.stringify(local));
      await Bun.sleep(5);
      const disabled = await tools.request({ t: "instruction_execute", session }, 35_000);
      expect(disabled.ok).toBe(false); expect(disabled.error).toContain("instructed.mode is off");
      expect(disabled.error).toContain("ahub settings set instructed.mode exact"); expect(disabled.error).not.toContain(offArgs);
      local.instructed.mode = "exact"; writeFileSync(localConfig, JSON.stringify(local));
      // An agent's direct file edit cannot re-enable a mode the person disabled.
      expect((await tools.request({ t: "instruction_execute", session }, 35_000)).ok).toBe(false);
      const reenable = await ControlClient.connect(stateDir, { role: "console" });
      try {
        expect((await reenable.request({ t: "settings_set", key: "instructed.mode", value: "exact" })).ok).toBe(true);
        local.instructed.mode = "off"; writeFileSync(localConfig, JSON.stringify(local));
        const view = await reenable.request({ t: "settings_get" });
        expect(view.rows.find((row: { key: string }) => row.key === "instructed.mode").value).toBe("exact");
      } finally { reenable.close(); }
      const read = new Board(join(stateDir, "hub.db"));
      let privateId: number;
      try {
        const saved = read.get(task.id)!; expect(saved.owner).toBe("claude"); expect(saved.history.at(-1)).toMatchObject({ by: "user", instructed: true, instructedPeer: "claude" });
        privateId = read.propose("user", { title: "private fixture", class: "implement", signals: ["pii"] }).id;
      } finally { read.close(); }
      const privatePrompt = "3004bef3-8884-4e54-bbf2-c5c760a52093", privateArgs = `run task assign ${privateId} claude`, privateAt = Date.now();
      expect(captured!.pending({ session, promptId: privatePrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(privateArgs) }, privateAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52094", sessionId: session, promptId: privatePrompt, version: "2.1.329", timestamp: new Date(privateAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${privateArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session }, 35_000)).ok).toBe(false);
      const after = new Board(join(stateDir, "hub.db"));
      let publicId: number;
      try {
        expect(after.get(privateId)!.owner).toBeNull();
        after.update(privateId, "user", "assigned", { owner: "claude" });
        publicId = after.propose("user", { title: "public while private", class: "implement" }).id;
      } finally { after.close(); }
      const privateTurnPrompt = "3004bef3-8884-4e54-bbf2-c5c760a52101", privateTurnArgs = `run task assign ${publicId} claude`, privateTurnAt = Date.now();
      expect(captured!.pending({ session, promptId: privateTurnPrompt, transcript, home: config, cwd, project: cwd, peer: "claude", hash: instructionHash(privateTurnArgs) }, privateTurnAt)).toBe(true);
      writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "3004bef3-8884-4e54-bbf2-c5c760a52102", sessionId: session, promptId: privateTurnPrompt, version: "2.1.329", timestamp: new Date(privateTurnAt + 1).toISOString(), cwd, isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: `<command-message>agent-hub:ahub</command-message>\n<command-name>/agent-hub:ahub</command-name>\n<command-args>${privateTurnArgs}</command-args>` } }) + "\n");
      await Bun.sleep(5);
      expect((await tools.request({ t: "instruction_execute", session }, 35_000)).ok).toBe(false);
      const privateCheck = new Board(join(stateDir, "hub.db"));
      try { expect(privateCheck.get(publicId)!.owner).toBeNull(); } finally { privateCheck.close(); }
    } finally { tools.close(); native.close(); }
  } finally {
    await daemon?.stop(); worker.stop(); keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);


test("control client handshakes and exchanges a request over inherited Bun IPC", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ahub-ipc-control-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ controlPort: 12345, protocol: 17, protocolMin: 16, protocolMax: 17 }));
    writeFileSync(join(dir, "control-token"), "test-only");
    const module = import.meta.resolve("../src/hub/control-client.ts");
    const code = `const W=globalThis.WebSocket; globalThis.WebSocket=class extends W { constructor(){throw Error("unexpected websocket")} }; const {ControlClient}=await import(${JSON.stringify(module)}); const c=await ControlClient.connect(${JSON.stringify(dir)}, {role:"console"}); const result=await c.request({t:"probe"}); if(!result.ok) process.exit(2); c.close(); try { await ControlClient.connect(${JSON.stringify(dir)}, {role:"console"}); process.exit(3); } catch { process.exit(0); }`;
    const kinds: string[] = [];
    const child = Bun.spawn({ cmd: [process.execPath, "-e", code], env: { ...process.env, AGENTHUB_INSTRUCTED_IPC: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", serialization: "json", ipc(message, process) {
      kinds.push(message.t);
      process.send(message.t === "hello" ? { t: "welcome", ok: true, rid: message.rid, protocol: 17 } : { ok: message.t === "probe", rid: message.rid });
    } });
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exit, error, kinds }).toEqual({ exit: 0, error: "", kinds: ["hello", "probe"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("instructed mode is machine-local and cannot be changed by a tools CLI", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { loadConfig } = await import("../src/hub/daemon.ts");
  const { validateRawConfig } = await import("../src/hub/config-apply.ts");
  const { classifyPeerCommand } = await import("../src/cli/identity.ts");
  const root = mkdtempSync(join(tmpdir(), "ahub-exact-config-"));
  try {
    expect(spawnSync("git", ["init", "-q", root], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).status).toBe(0);
    mkdirSync(join(root, ".agenthub"));
    writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ instructed: { mode: "off" } }));
    expect(spawnSync("git", ["-C", root, "add", "-f", ".agenthub/config.json"]).status).toBe(0);
    expect(loadConfig(root).instructed?.mode).toBe("exact");
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instructed: { mode: "off" } }));
    expect(loadConfig(root).instructed?.mode).toBe("off");
    expect(() => validateRawConfig({ instructed: { mode: "off" } })).not.toThrow();
    expect(() => validateRawConfig({ instructed: { mode: "intent" } })).toThrow();
    expect(classifyPeerCommand("settings", ["set", "instructed.mode", "exact"])).toBe("console");
    expect(classifyPeerCommand("instructed", ["run"])).toBe("allowed");
    const { InstructionReceipts } = await import("../src/hub/instruction-receipt.ts");
    const witnessFile = join(root, "witness.db");
    const witness = new InstructionReceipts(witnessFile, async () => undefined);
    expect(witness.mode()).toBe("exact"); witness.setMode("off"); witness.close();
    const restarted = new InstructionReceipts(witnessFile, async () => undefined);
    try { expect(restarted.mode()).toBe("off"); restarted.seedMode(() => { throw new Error("display must not be read"); }); restarted.setMode("exact"); expect(restarted.mode()).toBe("exact"); } finally { restarted.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an instructed CLI bootstrap refuses WebSocket construction", async () => {
  const { mkdtempSync, copyFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "ahub-exact-bootstrap-"));
  try {
    copyFileSync(join(import.meta.dir, "../src/cli/main.js"), join(root, "main.js"));
    writeFileSync(join(root, "main.ts"), 'try { new WebSocket("ws://127.0.0.1:1"); console.log("opened"); } catch { console.log("blocked"); }');
    const child = Bun.spawn([process.execPath, join(root, "main.js"), "version"], { env: { ...process.env, AGENTHUB_INSTRUCTED_IPC: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect({ code, output: output.trim() }).toEqual({ code: 0, output: "blocked" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the exact spending-setting arity matches the real CLI parser", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { exactForm } = await import("../src/hub/instructed-exact.ts");
  const cwd = mkdtempSync(join(tmpdir(), "ahub-exact-arity-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(AGENTHUB_|CLAUDE|CODEX_|ORCA_|KIMI|QWEN|JCODE|PI_|OMNIROUTE|CI$)/.test(key)) env[key] = value;
  Object.assign(env, { HOME: cwd, AGENTHUB_HOME: join(cwd, "hub"), AMEM_HOME: join(cwd, "memory"), CLAUDE_CONFIG_DIR: join(cwd, "claude"), GIT_CONFIG_GLOBAL: "/dev/null" });
  try {
    for (const [argv, valid] of [
      [["settings", "set", "tasks.auto_pull", "true"], true],
      [["settings", "set", "tasks.auto_pull", "true", "--yes"], true],
      [["settings", "set", "tasks.auto_pull"], false],
      [["settings", "set", "tasks.auto_pull", "true", "extra"], false],
    ] as const) {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).not.toBe(0);
      expect(!!exactForm(argv)).toBe(valid);
      expect(error).toContain(valid ? "no hub running" : "usage: ahub settings");
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("the person-disabled mode witness survives a daemon restart and a file edit", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { realPath } = await import("../src/hub/project.ts");
  const { startDaemon } = await import("../src/hub/daemon.ts");
  const { ControlClient, stateDirFor } = await import("../src/hub/control-client.ts");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-mode-restart-"))), cwd = join(root, "project"), home = join(root, "home"); mkdirSync(cwd); mkdirSync(home); mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, task_sweep: { enabled: false } }));
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME"] as const, previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "mem") });
  const stateDir = stateDirFor(cwd); let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ instructed: { mode: "off" } }));
    daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false });
    let consoleClient = await ControlClient.connect(stateDir, { role: "console" });
    const initial = await consoleClient.request({ t: "settings_get" });
    expect(initial.rows.find((row: { key: string }) => row.key === "instructed.mode").value).toBe("off");
    writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ instructed: { mode: "exact" } }));
    expect((await consoleClient.request({ t: "settings_get" })).rows.find((row: { key: string }) => row.key === "instructed.mode").value).toBe("off");
    expect((await consoleClient.request({ t: "settings_set", key: "instructed.mode", value: "exact" })).ok).toBe(true);
    const localPath = join(cwd, ".agenthub/config.local.json");
    writeFileSync(localPath, "{");
    const failedOff = await consoleClient.request({ t: "settings_set", key: "instructed.mode", value: "off" });
    expect(failedOff.ok).toBe(false); expect(failedOff.error).toContain("witness is off");
    const failedExact = await consoleClient.request({ t: "settings_set", key: "instructed.mode", value: "exact" });
    expect(failedExact.ok).toBe(false); expect(failedExact.error).toContain("witness unchanged");
    writeFileSync(localPath, JSON.stringify({ instructed: { mode: "exact" } }));
    const older = consoleClient.features.filter(feature => feature !== "instructed_exact");
    const recovery = await consoleClient.request({ t: "recovery", op: "prepare", expectedInstanceId: consoleClient.instanceId, operationId: "mode-witness-floor", targetFeatures: older });
    expect(recovery.ok).toBe(false); expect(recovery.error).toContain("target lacks instructed_exact");
    consoleClient.close(); await daemon.stop(); daemon = undefined;
    writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ instructed: { mode: "exact" } }));
    daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false });
    consoleClient = await ControlClient.connect(stateDir, { role: "console" });
    try {
      const view = await consoleClient.request({ t: "settings_get" });
      expect(view.rows.find((row: { key: string }) => row.key === "instructed.mode").value).toBe("off");
    } finally { consoleClient.close(); }
  } finally {
    await daemon?.stop(); keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
