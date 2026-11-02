import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { USER } from "../src/hub/envelope.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const fakePiiScreen = async () => ({ label: "clear" as const, ms: 0 });

async function project(extraSpecs = 0, includeSpecs = true) {
  const home = mkdtempSync(join(tmpdir(), "ahub-specs-daemon-")), projectRoot = join(home, "project"), stateDir = join(home, "state"), bin = join(home, "bin");
  mkdirSync(projectRoot, { recursive: true });
  const root = realPath(projectRoot);
  mkdirSync(join(root, ".agenthub"), { recursive: true }); mkdirSync(bin);
  const sharedConfig = join(root, ".agenthub", "config.json"), shared = {
    specs: { enabled: true, review: "require", roots: [], stamps_file: "" },
    memory: { enabled: false, native: false }, inference: { enabled: false, triage: false }, mlx: { enabled: false },
    snapshots: { enabled: false, keep: 1 }, pi: { enabled: false, auto_start: false }, batch_ms: 0,
  };
  writeFileSync(sharedConfig, `${JSON.stringify(shared, null, 2)}\n`);
  writeFileSync(join(root, "AGENTS.md"), "# Fixture project\n\nNo managed specs block is present.\n");
  mkdirSync(join(root, "src", "hub"), { recursive: true });
  mkdirSync(join(root, "docs", "design"), { recursive: true });
  writeFileSync(join(root, "src", "hub", "bus.ts"), "export const bus = 1;\n");
  if (includeSpecs) {
    writeFileSync(join(root, "docs", "design", "bus.md"), [
      "---", "id: bus", "type: module", "title: Bus", "parent: architecture", "status: active", "paths:", "  - src/hub/bus.ts", "---", "",
      "The bus sends bounded messages.", "",
    ].join("\n"));
    writeFileSync(join(root, "docs", "design", "architecture.md"), ["---", "id: architecture", "type: architecture", "title: Architecture", "parent: goal", "status: draft", "---", "", "Fixture architecture.", ""].join("\n"));
    writeFileSync(join(root, "docs", "design", "goal.md"), ["---", "id: goal", "type: goal", "title: Goal", "status: active", "paths: [docs/design]", "---", "", "Fixture goal.", ""].join("\n"));
    for (let i = 0; i < extraSpecs; i++) {
      writeFileSync(join(root, "docs", "design", `module-${i}.md`), ["---", `id: module-${i}`, "type: module", `title: Module ${i}`, "parent: architecture", "status: active", "---", "", "Fixture module.", ""].join("\n"));
    }
  }

  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", root, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr ?? ""}`);
    return (result.stdout ?? "").trim();
  };
  git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("config", "core.hooksPath", "/dev/null"); git("remote", "add", "origin", "https://example.invalid/fixture.git");
  git("add", "-A"); git("commit", "--quiet", "-m", "fixture base"); git("branch", "-M", "main");
  const base = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", base);
  if (includeSpecs) {
    writeFileSync(join(root, "src", "hub", "bus.ts"), "export const bus = 2;\n");
    git("add", "src/hub/bus.ts"); git("commit", "--quiet", "-m", "change bus implementation");
  }
  const head = git("rev-parse", "HEAD");

  const fake = join(import.meta.dir, "fakes", "fake-ripwire.ts"), ripwire = join(bin, "ripwire");
  writeFileSync(ripwire, `#!/bin/sh\nunset FAKE_RIPWIRE_MODE FAKE_RIPWIRE_RECORD FAKE_RIPWIRE_CHILD\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`);
  chmodSync(ripwire, 0o755);
  const previousPath = process.env.PATH;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const clients: ControlClient[] = [];
  cleanup.push(async () => {
    for (const client of clients) client.close();
    if (daemon) await daemon.stop();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const warmed = Bun.spawnSync([ripwire, "--version"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (warmed.exitCode !== 0) throw new Error("fake ripwire warm-up failed");
  daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, piiScreen: fakePiiScreen });
  const connect = async (role: "console" | "tools", peer?: string) => {
    const client = await ControlClient.connect(stateDir, { role, ...(peer ? { peer } : {}), projectRoot: root });
    clients.push(client); return client;
  };
  return { home, root, stateDir, sharedConfig, sharedBytes: readFileSync(sharedConfig, "utf8"), head, connect };
}

test("daemon control tools expose specs, require acknowledgements, and keep status opt-in", async () => {
  const f = await project(24), person = await f.connect("console"), codex = await f.connect("tools", "codex");
  const quietStatus = await person.request({ t: "status" });
  expect(quietStatus.status).not.toHaveProperty("specs");
  expect(JSON.parse(readFileSync(join(f.stateDir, "status.json"), "utf8"))).not.toHaveProperty("specs");
  const requestedStatus = await codex.request({ t: "status", specs: true });
  expect(requestedStatus.status.specs).toMatchObject({ specCount: 27, errors: 0, missingBlockHint: true });
  const repeatedStatus = await person.request({ t: "status", specs: true });
  expect(repeatedStatus.status.specs).not.toHaveProperty("missingBlockHint");

  const floor = await person.request({ t: "recovery", op: "inspect", expectedInstanceId: quietStatus.status.instanceId, targetFeatures: [] });
  expect(floor.error).toContain("target lacks design_specs");
  const supported = await person.request({ t: "recovery", op: "inspect", expectedInstanceId: quietStatus.status.instanceId, targetFeatures: DAEMON_FEATURES });
  expect(supported.ok).toBe(true);

  const proposed = await person.request({ t: "task", op: "hub_task_propose", args: { title: "change bus", class: "implement", backlog: true, refs: { paths: ["src/hub/bus.ts"] } } });
  expect(proposed.ok).toBe(true);
  expect(proposed.text).toContain("Specs covering these paths: bus (docs/design/bus.md)");
  const covered = await codex.request({ t: "task", op: "hub_specs", args: { action: "covers", paths: ["src/hub/bus.ts"] } });
  expect(covered.ok).toBe(true);
  expect(JSON.parse(covered.text).specs.map((spec: { id: string }) => spec.id)).toEqual(["bus"]);
  const checked = await codex.request({ t: "task", op: "hub_specs", args: { action: "check" } });
  expect(checked.ok).toBe(true);
  const checkReport = JSON.parse(checked.text);
  expect(checkReport.items.length + checkReport.freshness.length).toBeLessThanOrEqual(20);
  expect(checkReport.truncated).toBe(true);

  const board = new Board(join(f.stateDir, "hub.db"));
  const task = board.propose(USER, { title: "change bus", class: "implement", refs: { branch: "feature/specs", commit: f.head, paths: ["src/hub/bus.ts"] } });
  board.update(task.id, USER, "assigned", { owner: "codex", reviewer: USER }); board.close();
  const accepted = await codex.request({ t: "task", op: "hub_task_accept", args: { id: task.id, plan: { paths: ["src/hub/bus.ts"] } } });
  expect(accepted.ok).toBe(true);
  expect(accepted.text).toContain("Specs covering these paths: bus (docs/design/bus.md)");
  const refused = await codex.request({ t: "task", op: "hub_task_done", args: { id: task.id, summary: "changed the bus", refs: { commit: f.head, paths: ["src/hub/bus.ts"] } } });
  expect(refused.ok).toBe(false);
  expect(refused.error).toContain("spec not updated: bus");
  const completed = await codex.request({ t: "task", op: "hub_task_done", args: { id: task.id, summary: "changed the bus", refs: { commit: f.head, paths: ["src/hub/bus.ts"] }, spec_ack: [{ id: "bus", reason: "This change preserves the bus contract." }] } });
  expect(completed.ok).toBe(true);
  expect(completed.text).toContain("acknowledged: This change preserves the bus contract.");

  const db = new Board(join(f.stateDir, "hub.db"));
  const privateTask = db.propose(USER, { title: "private fixture", class: "implement", signals: ["pii_path"] });
  db.update(privateTask.id, USER, "assigned", { state: "in_progress", owner: "kimi" }); db.close();
  const kimi = await f.connect("tools", "kimi");
  const privateRead = await kimi.request({ t: "task", op: "hub_specs", args: { action: "check" } });
  expect(privateRead.ok).toBe(false);
  expect(privateRead.error).toContain("private turn");

  const sharedBefore = readFileSync(f.sharedConfig, "utf8");
  expect(sharedBefore).toBe(f.sharedBytes);
  const localDisable = await person.request({ t: "settings_set", key: "specs.enabled", value: false });
  expect(localDisable.ok).toBe(true);
  expect(readFileSync(f.sharedConfig, "utf8")).toBe(sharedBefore);
  expect(JSON.parse(readFileSync(join(f.root, ".agenthub", "config.local.json"), "utf8")).specs.enabled).toBe(false);
  const quiet = await person.request({ t: "task", op: "hub_task_propose", args: { title: "quiet bus work", class: "implement", backlog: true, refs: { paths: ["src/hub/bus.ts"] } } });
  expect(quiet.ok).toBe(true);
  expect(quiet.text).not.toContain("Specs covering these paths");
  const explicitReadAfterOff = await person.request({ t: "task", op: "hub_specs", args: { action: "covers", paths: ["src/hub/bus.ts"] } });
  expect(explicitReadAfterOff.ok).toBe(true);
  const disabledStatus = await person.request({ t: "status", specs: true });
  expect(disabledStatus.status).not.toHaveProperty("specs");
  const disabledFloor = await person.request({ t: "recovery", op: "inspect", expectedInstanceId: quietStatus.status.instanceId, targetFeatures: DAEMON_FEATURES.filter(feature => feature !== "design_specs") });
  expect(disabledFloor.ok).toBe(true);
});

test("opt-in status stays quiet for projects with no specs or stamps", async () => {
  const f = await project(0, false), person = await f.connect("console");
  const status = await person.request({ t: "status", specs: true });
  expect(status.status).not.toHaveProperty("specs");
});
