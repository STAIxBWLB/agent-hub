import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { makeRecoveryDriver, restoredTerminalArgv } from "../src/cli/upgrade-runtime.ts";
import { VERSION } from "../src/version.ts";
import type { PlannedProject, ProjectProgress, RecoveryOperation } from "../src/cli/upgrade.ts";

test("Pi terminal restoration builds a TUI command with the saved session selector", () => {
  const argv = restoredTerminalArgv("/target/src/cli/main.js", "/project", {
    peer: "pi", handle: "h", incarnationId: "i", worktreeId: "w", projectRoot: "/project", sessionId: "sid", sessionFile: "/state/pi-session.json", backend: "dgx", model: "dgx/coding",
    launch: { packageEntrypoint: "/old/main.js", command: "old", argv: [], env: {} }, launchMetadata: { packageEntrypoint: "/old/main.js", command: "old", argv: [], env: {} },
  });
  expect(argv).toEqual([process.execPath, "/target/src/cli/main.js", "--project", "/project", "pi", "--mode", "tui", "--backend", "dgx", "--model", "dgx/coding", "--session-file", "/state/pi-session.json"]);
});

test("recovery driver uses the source manifest protocol for a protocol-8 prepare", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-source-v8-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "ahub-source-v8-project-"));
  const seenVersions: number[] = [];
  const server = Bun.serve<any>({
    hostname: "127.0.0.1", port: 0,
    fetch(_request, srv) { return srv.upgrade(_request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) { const msg = JSON.parse(String(data)); if (msg.t === "hello") { seenVersions.push(msg.v); ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: "p8", instanceId: "i8", cwd: projectRoot, protocol: 8 })); } else { ws.send(JSON.stringify({ rid: msg.rid, t: "recovery", ok: true })); } } },
  });
  writeFileSync(join(stateDir, "control-token"), "source-v8-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: 8, projectId: "p8", instanceId: "i8", cwd: projectRoot }));
  try {
    const driver = makeRecoveryDriver();
    await driver.prepare({ id: "p8", root: projectRoot, stateDir, basePort: 4600 } as any, "op8", "i8");
    expect(seenVersions).toEqual([8]);
  } finally { server.stop(true); rmSync(stateDir, { recursive: true, force: true }); rmSync(projectRoot, { recursive: true, force: true }); }
});

for (const change of ["incarnation", "session"] as const) {
  test(`production recovery verification rejects a changed ${change} without terminal mutation`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-review-runtime-")));
    const stateDir = join(root, "state");
    const daemon = await startDaemon({ cwd: root, stateDir, projectId: "p-review", instanceId: "i-review", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
    const consoleClient = await ControlClient.connect(stateDir, { role: "console" });
    const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
    try {
      writeFileSync(join(stateDir, "claude-session.json"), JSON.stringify({ instanceId: "i-review", sessionId: "session-original" }));
      expect((await consoleClient.request({ t: "recovery", op: "prepare", expectedInstanceId: "i-review", operationId: "op-review" })).ok).toBe(true);
      const terminal = { handle: "term-review", incarnationId: "inc-original", worktreeId: `repo::${root}`, worktreePath: root,
        agentIdentity: "claude", sessionId: "session-original", connected: true };
      const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
      const binding = { ...terminal, peer: "claude" as const, projectRoot: root, launch, launchMetadata: launch };
      const planned: PlannedProject = { project: { id: "p-review", root, stateDir, instanceId: "i-review", pid: process.pid, basePort: 0 },
        source: { state: "running", peers: [{ id: "claude", state: "idle", sessionId: "session-original" }], blockers: [] }, terminals: [binding], blockers: [] };
      const progress: ProjectProgress = { id: "p-review", instanceId: "i-review", phase: "peers-restored", terminals: { "restored:claude": binding } };
      const operation = { id: "op-review", plan: { version: VERSION } } as RecoveryOperation;
      const calls: string[][] = [];
      const driver = makeRecoveryDriver(async (argv) => {
        calls.push(argv);
        const current = { ...terminal, incarnationId: change === "incarnation" ? "inc-replaced" : "inc-original" };
        let result: unknown;
        if (argv[2] === "list") result = { terminals: [current] };
        else if (argv[2] === "show") result = { terminal: current };
        else if (argv[2] === "wait") {
          writeFileSync(join(stateDir, "claude-session.json"), JSON.stringify({ instanceId: "i-review", sessionId: "session-replaced" }));
          result = { wait: { satisfied: true } };
        } else throw new Error("unexpected terminal mutation");
        return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
      });
      await expect(driver.verify(planned, progress, operation)).rejects.toThrow(change === "incarnation" ? "saved terminal identity changed" : "daemon session changed");
      expect(calls.some((args) => ["close", "create", "send"].includes(args[2]!))).toBe(false);
      expect(JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).instanceId).toBe("i-review");
    } finally {
      peer.close(); consoleClient.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true });
    }
  });
}
