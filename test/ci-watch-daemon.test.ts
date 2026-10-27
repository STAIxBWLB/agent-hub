import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";

// #785 P1b through the real path: a started daemon, hub_task_done over the control socket as the owner, and a `gh` executable on PATH.
// The shim reads the CI conclusion from a file, so the test flips it exactly as GitHub would, and logs every call.
const head = "a".repeat(40);
const NAMES = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"];
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition: () => boolean | Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (!(await condition()) && Date.now() < end) await sleep(20); return await condition(); };

async function rig(initial: "IN_PROGRESS" | "SUCCESS" = "IN_PROGRESS") {
  const root = mkdtempSync(join(tmpdir(), "ahub-ci-watch-daemon-")), project = join(root, "project"), bin = join(root, "bin"), stateDir = join(project, "state");
  mkdirSync(stateDir, { recursive: true }); mkdirSync(bin);
  const conclusion = join(root, "conclusion"), calls = join(root, "calls.jsonl");
  writeFileSync(conclusion, initial);
  const git = (args: string[]) => expect(hubGitSync(args, { cwd: project, encoding: "utf8", timeout: 5000 }).status).toBe(0);
  git(["init", "-q"]);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "ci-watch-fixture", version: "1.0.0" }));
  git(["add", "package.json"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  mkdirSync(join(project, ".agenthub"));
  writeFileSync(join(project, ".agenthub", "sdlc.toml"), `mode = "advise"\nrequired_checks = ${JSON.stringify(NAMES)}\n`);
  const board = new Board(join(stateDir, "hub.db"));
  const task = board.propose("user", { title: "watched implementation", class: "implement" });
  board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "pi", state: "in_progress", refs: { commit: head }, sdlc: { stage: "build", repo: "o/r", issue: 1, pr: 1, head, localHead: head, localResult: "passed" } });
  board.close();
  // gh: `pr view ... headRefOid,state,statusCheckRollup` is the watcher's poll; `api graphql` is the review admission's readiness read.
  const shim = `#!${process.execPath}
const fs = require("node:fs"), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const running = fs.readFileSync(${JSON.stringify(conclusion)}, "utf8").trim() === "IN_PROGRESS", names = ${JSON.stringify(NAMES)};
const rows = names.map(name => ({ name, status: running ? "IN_PROGRESS" : "COMPLETED", conclusion: running ? "" : "SUCCESS" }));
if (args[0] === "pr") process.stdout.write(JSON.stringify(args.some(a => a.includes("statusCheckRollup") && !a.includes("files")) && args.join(" ").includes("headRefOid,state,statusCheckRollup")
  ? { headRefOid: ${JSON.stringify(head)}, state: "OPEN", statusCheckRollup: rows }
  : { headRefOid: ${JSON.stringify(head)}, state: "OPEN", statusCheckRollup: [], reviewRequests: [], files: [], changedFiles: 0 }));
else process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { headRefOid: ${JSON.stringify(head)}, state: "OPEN",
  commits: { nodes: [{ commit: { oid: ${JSON.stringify(head)}, tree: { oid: ${JSON.stringify("c".repeat(40))} }, statusCheckRollup: { contexts: { nodes: rows, pageInfo: { hasNextPage: false } } } } }] },
  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }));
`;
  writeFileSync(join(bin, "gh"), shim); chmodSync(join(bin, "gh"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  cleanup.push(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  const daemon = await startDaemon({ cwd: project, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, notifier: () => {}, ciWatch: { pollMs: 40, deadlineMs: 20_000 }, config: {
    ...DEFAULT_CONFIG, roles: { codex: ["implementer"], pi: ["reviewer"], claude: ["planner"] }, roster: { ...DEFAULT_CONFIG.roster, codex: true, pi: true, claude: false, kimi: false, qwen: false, jcode: false, local: false }, batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    snapshots: { enabled: false, keep: 1 }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false } } });
  let stopped = false;
  cleanup.push(async () => { if (!stopped) await daemon.stop(); rmSync(root, { recursive: true, force: true }); });
  const owner = await ControlClient.connect(stateDir, { role: "tools", peer: "codex" }); cleanup.push(() => owner.close());
  const pollCount = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(line => line.includes("headRefOid,state,statusCheckRollup")).length : 0;
  // The daemon logs every published envelope as `msg <from> -> <to> ...: <body>`: the hub's own record of what it told whom.
  const ciNotices = async (peer: string) => {
    const log = existsSync(join(stateDir, "hub.log")) ? readFileSync(join(stateDir, "hub.log"), "utf8") : "";
    return log.split("\n").filter(line => line.includes(`msg hub -> ${peer} `) && line.includes("ci_completed: #")).length;
  };
  return { daemon, owner, conclusion, pollCount, ciNotices, task, markStopped: () => { stopped = true; } };
}

test("a real daemon starts one watcher at hub_task_done, tells owner and reviewer once on green, reads nothing after (#785 AC3, AC5)", async () => {
  const { owner, conclusion, pollCount, ciNotices, task } = await rig("IN_PROGRESS");
  const done = await owner.request({ t: "task", op: "hub_task_done", args: { id: task.id, summary: "ready", refs: { commit: head, branch: "fix/watched" } } });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(await until(() => pollCount() >= 2)).toBe(true); // the daemon's own watcher is reading while CI is pending
  expect(await ciNotices("codex") + await ciNotices("pi")).toBe(0);

  writeFileSync(conclusion, "SUCCESS");
  const got = await until(async () => await ciNotices("codex") === 1 && await ciNotices("pi") === 1);
  expect(got).toBe(true); // once each, through the real bus and journal
  const settled = pollCount();
  await sleep(300);
  expect(pollCount()).toBe(settled); // the watcher ended on the result: no periodic gh read
  expect(await ciNotices("codex")).toBe(1); expect(await ciNotices("pi")).toBe(1);

  // A second hub_task_done at the same head after the result starts no new watcher and sends no second notice.
  await owner.request({ t: "task", op: "hub_task_done", args: { id: task.id, summary: "again", refs: { commit: head } } }).catch(() => undefined);
  await sleep(300);
  expect(await ciNotices("codex")).toBe(1);

}, 40_000);

test("daemon shutdown ends a watcher that is still waiting on a pending head: no gh read after stop (#785 AC5)", async () => {
  const { daemon, owner, pollCount, task, markStopped } = await rig("IN_PROGRESS");
  const done = await owner.request({ t: "task", op: "hub_task_done", args: { id: task.id, summary: "ready", refs: { commit: head, branch: "fix/watched" } } });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(await until(() => pollCount() >= 2)).toBe(true); // still pending and still being read
  await daemon.stop(); markStopped();
  // What this observes is the outcome: no gh read after the daemon has stopped. It does not prove the explicit `tasks.stopCiWatchers()` call in stopOnce: the board closes
  // a few milliseconds after `hub stopping`, and a tick that finds it closed ends its watcher (CiWatchers.tick fails closed), so removing the call is not visible here.
  // The method is unit-tested (test/ci-watch.test.ts), but no test pins the daemon's call to it: a mutation that removes the call still passes (checked), because the closed board ends the watcher anyway.
  const afterStop = pollCount();
  await sleep(300);
  expect(pollCount()).toBe(afterStop);
}, 40_000);
