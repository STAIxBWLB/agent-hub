import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitEnv, hubGitSync } from "../src/hub/git.ts";
import { hostExecutable } from "../src/hub/host-executable.ts";
import { shellQuote } from "../src/cli/shell-quote.ts";
import { realPath } from "../src/hub/project.ts";
import { completeJsonLines } from "./fakes/jsonl.ts";

const nativeCanary = "NATIVE_FAILURE_DETAIL_CANARY", inputCanary = "PRIVATE_PERMISSION_INPUT_CANARY";
async function until(condition: () => boolean, leg: string): Promise<void> {
  for (let index = 0; index < 400 && !condition(); index++) await Bun.sleep(5);
  expect(condition(), leg).toBe(true);
}
async function fixture(piiTransition = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-failure-stage-"))), peer = "claude-worker", tree = join(root, ".worktrees", peer);
  const stateDir = join(root, ".agenthub", "state"), calls = join(root, "calls.jsonl"), home = join(root, "home"), bin = join(root, "bin");
  const hostBin = realPath(mkdtempSync(join(tmpdir(), "ahub-failure-stage-git-")));
  const old = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, PATH: process.env.PATH, AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const clients: ControlClient[] = [];
  const cleanup = async () => {
    for (const client of clients) client.close(); await daemon?.stop();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true }); rmSync(hostBin, { recursive: true, force: true });
  };
  try {
    mkdirSync(stateDir, { recursive: true }); mkdirSync(home); mkdirSync(bin);
    const git = hostExecutable("git", root, old.PATH ?? "/usr/bin:/bin");
    writeFileSync(join(hostBin, "git"), `#!/bin/sh\nexport GIT_CONFIG_SYSTEM=/dev/null\nexport GIT_CONFIG_GLOBAL=/dev/null\nfor arg in "$@"; do if [ "$arg" = push ]; then exit 88; fi; done\nexec ${shellQuote(git)} "$@"\n`, { mode: 0o700 });
    const env = hubGitEnv({ ...process.env, HOME: home, PATH: `${hostBin}:${old.PATH ?? "/usr/bin:/bin"}` }, { repositoryIsolation: true });
    const runGit = (cwd: string, args: string[]) => hubGitSync(["-C", cwd, ...args], { encoding: "utf8", env });
    for (const args of [["init", "-q"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], ["worktree", "add", "-qb", "worker", tree],
      ["update-ref", "refs/remotes/origin/main", "HEAD"], ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], ["remote", "add", "origin", "https://github.com/fixture/repo.git"]]) expect(runGit(root, args).status).toBe(0);
    const fake = resolve(import.meta.dir, "fakes/fake-claude-implementer.ts");
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nif(process.argv.includes("--version")){console.log("2.1.309 (Claude Code)");process.exit(0)}\nprocess.argv=[process.argv[0],${JSON.stringify(fake)},${JSON.stringify(calls)},"staged-error",...process.argv.slice(2)];\nawait import(${JSON.stringify(fake)});\n`, { mode: 0o700 });
    process.env.HOME = home; process.env.AMEM_HOME = join(home, "memory"); process.env.AGENTHUB_HOME = join(home, "hub"); process.env.CLAUDE_CONFIG_DIR = join(home, ".claude"); process.env.PATH = `${bin}:${hostBin}:${old.PATH ?? "/usr/bin:/bin"}`;
    const routingFile = join(root, ".agenthub", "routing.toml");
    const routing = (pii: "off" | "local_only") => `[local]\nfixed_model = "fixture"\n[classes.test]\npeers = ["claude-worker"]\n[signals]\npii_patterns = ["PRIVACY_TRANSITION"]\npii_screen = "off"\n[constraints]\npii = "${pii}"\n`;
    if (piiTransition) writeFileSync(routingFile, routing("off"));
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instances: { [peer]: { kind: "claude", roles: ["implementer"], start_mode: "headless", worktree: `.worktrees/${peer}`, permission_mode: "ask-when-needed" } }, roles: { [peer]: ["implementer"] }, roster: { [peer]: true }, memory: { enabled: false, native: false }, inference: { enabled: false }, snapshots: { enabled: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false }, task_sweep: { enabled: false }, batch_ms: 0 }));
    const config = loadConfig(root); config.action_policy = { enabled: false, always_ask: [], budgets: { publish: 1, destroy: 3, install: 2, "external-write": 5 } };
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, permissionTimeoutMs: 5000, configWatch: false, snapshotClock: () => 0, config, shellDefaultBranchProbe: async () => "main" });
    const console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); clients.push(console_);
    const instanceId = (await console_.request({ t: "status" })).status.instanceId;
    expect(await console_.request({ t: "start", peer })).toMatchObject({ ok: true, executionCwd: tree });
    const proposed = await console_.request({ t: "task", op: "hub_task_propose", args: { title: piiTransition ? "PRIVACY_TRANSITION fixture" : "bounded diagnostic fixture", class: "test", owner: peer } });
    expect(proposed).toMatchObject({ ok: true });
    const taskId = Number(String(proposed.text).match(/task #(\d+)/)?.[1]); expect(taskId).toBeGreaterThan(0);
    await until(() => existsSync(calls) && completeJsonLines(readFileSync(calls, "utf8")).length > 0, "owned fake received turn");
    const call = completeJsonLines(readFileSync(calls, "utf8"))[0] as any;
    const tools = await ControlClient.connect(stateDir, { role: "tools", peer, launchId: call.launchId, projectRoot: root }); clients.push(tools);
    const readLog = () => readFileSync(join(stateDir, "hub.log"), "utf8");
    return { root, tree, peer, stateDir, calls, daemon, console_, tools, taskId, call, instanceId, runGit, readLog,
      async finish() {
        writeFileSync(calls + ".finish", "release this fixture only");
        await until(() => readLog().includes("Claude implementer turn failed"), "native failed result rendered");
        await until(() => daemon!.bus.peers.get(peer)?.state === "idle", "owned fake cleanup completed");
        return readLog().split("\n").filter(line => line.includes("Claude implementer turn failed")).at(-1)!;
      },
      async tightenPrivacy() {
        writeFileSync(routingFile, routing("local_only"));
        const result = await console_.request({ t: "settings_reload" });
        expect(result).toMatchObject({ ok: true });
        expect(result.applied).toContain("routing.constraints.pii");
        expect(Array.isArray(result.rejected)).toBe(true);
        expect(result.rejected).not.toContainEqual(expect.objectContaining({ key: "routing.constraints.pii" }));
      },
      close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}

test("#551 owned native failure before host permission observations reports absence without raw native text", async () => {
  const f = await fixture();
  try {
    const line = await f.finish();
    expect(line).toContain("stage=pre_permission"); expect(line).toContain(`instance=${f.instanceId}`); expect(line).toContain("native=2.1.309");
    expect(f.readLog()).not.toContain(nativeCanary); expect(line).not.toContain(f.call.launchId);
  } finally { await f.close(); }
}, 20_000);

test("#551 only host-validated malformed probes record a stage and never create approval or echo native input", async () => {
  const f = await fixture();
  try {
    expect(await f.console_.request({ t: "permission_failure_probe", request: null })).toMatchObject({ ok: false });
    await expect(ControlClient.connect(f.stateDir, { role: "tools", peer: f.peer, launchId: "00000000-0000-4000-8000-000000000000", projectRoot: f.root })).rejects.toThrow();
    const reply = await f.tools.request({ t: "permission_failure_probe", request: { tool_name: "Bash", input: { command: inputCanary }, tool_use_id: "", stage: inputCanary } });
    expect(reply.ok).toBe(true); expect(JSON.stringify(reply)).not.toContain(inputCanary);
    const snapshot = await f.console_.request({ t: "ui_snapshot", after: 0 });
    expect(snapshot.permissions).toEqual([]);
    const line = await f.finish(); expect(line).toContain("stage=invalid_permission_request");
    expect(line).not.toContain("request="); expect(f.readLog()).not.toContain(inputCanary); expect(f.readLog()).not.toContain(nativeCanary);
    expect(await f.tools.request({ t: "permission_failure_probe", request: null })).toMatchObject({ ok: false });
    expect(f.readLog().split("\n").filter(row => row.includes("stage=invalid_permission_request"))).toHaveLength(1);
  } finally { await f.close(); }
}, 20_000);

test("#551 oversize and exhausted host probes leave failure stage unclaimed", async () => {
  const f = await fixture();
  try {
    expect(await f.tools.request({ t: "permission_failure_probe", request: { tool_name: "Read", input: {}, tool_use_id: "native-not-an-error" } })).toMatchObject({ ok: false });
    for (let index = 0; index < 3; index++) expect(await f.tools.request({ t: "permission_failure_probe", request: { padding: inputCanary.repeat(300) } })).toMatchObject({ ok: false });
    expect(await f.tools.request({ t: "permission_failure_probe", request: { tool_name: "Bash", input: {}, tool_use_id: "" } })).toMatchObject({ ok: false });
    const line = await f.finish(); expect(line).toContain("stage=pre_permission"); expect(f.readLog()).not.toContain(inputCanary);
  } finally { await f.close(); }
}, 20_000);

test("#551 manual queue expiry records the actual daemon permission id after withdrawal", async () => {
  const f = await fixture();
  try {
    expect(await f.tools.request({ t: "permission_request", tool: "Write", input: { file_path: inputCanary } })).toMatchObject({ behavior: "deny", message: "no person answered" });
    const id = f.readLog().match(/permission ([a-f0-9]{8}) requested by/)?.[1]; expect(id).toBeDefined();
    expect(await f.console_.request({ t: "permit", id, option: "allow" })).toMatchObject({ ok: false });
    const line = await f.finish(); expect(line).toContain("stage=manual_queue_expired"); expect(line).toContain(`request=${id}`);
    expect(f.readLog()).not.toContain(inputCanary);
  } finally { await f.close(); }
}, 20_000);

test("#551 a new valid person-approved attempt clears an older stage instead of inventing a native cause", async () => {
  const f = await fixture();
  try {
    expect(await f.tools.request({ t: "permission_failure_probe", request: null })).toMatchObject({ ok: true });
    const pending = f.tools.request({ t: "permission_request", tool: "Read", input: { file_path: "fixture.ts" } });
    await until(() => /permission ([a-f0-9]{8}) requested by/.test(f.readLog()), "registered person request");
    const id = f.readLog().match(/permission ([a-f0-9]{8}) requested by/)?.[1];
    expect(await f.console_.request({ t: "permit", id, option: "allow" })).toMatchObject({ ok: true });
    expect(await pending).toMatchObject({ behavior: "allow" });
    const line = await f.finish(); expect(line).toContain("stage=native_error"); expect(line).toContain(`request=${id}`);
  } finally { await f.close(); }
}, 20_000);

test("#551 matched wrapper execution refusal is distinct from ordinary proof fallback", async () => {
  const f = await fixture();
  try {
    expect(await f.tools.request({ t: "task", op: "hub_task_accept", args: { id: f.taskId } })).toMatchObject({ ok: true });
    const grant = await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "git push origin worker" }, wrapperProtocol: 1 });
    expect(grant).toMatchObject({ ok: true, behavior: "allow", wrapperProtocol: 1 });
    expect(f.runGit(f.tree, ["checkout", "-qb", "changed"]).status).toBe(0);
    const child = Bun.spawn(["/bin/sh", "-c", grant.updatedInput.command], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).not.toBe(0); expect(stdout).toBe("");
    const line = await f.finish(); expect(line).toContain("stage=wrapper_refused"); expect(line).not.toContain(grant.updatedInput.command);
  } finally { await f.close(); }
}, 20_000);

test("#551 failure rendering rechecks current PII policy and emits only the fixed stub", async () => {
  const f = await fixture(true);
  try {
    expect(await f.tools.request({ t: "permission_failure_probe", request: null })).toMatchObject({ ok: true });
    await f.tightenPrivacy();
    const line = await f.finish(); expect(line.endsWith("Claude implementer turn failed (details withheld)")).toBe(true);
    for (const hidden of ["stage=", "request=", "instance=", "native=", f.call.launchId, nativeCanary]) expect(line).not.toContain(hidden);
  } finally { await f.close(); }
}, 20_000);
