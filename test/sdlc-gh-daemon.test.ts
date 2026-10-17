import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

for (const trusted of [false, true]) test(`#449 embedded daemon SDLC reads ${trusted ? "retain trusted host gh" : "refuse its project PATH shim"} when opts.cwd differs`, async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-sdlc-gh-daemon-"));
  const project = join(root, "project"), host = join(root, "host"), stateDir = join(project, "state"), marker = join(root, "calls.jsonl");
  mkdirSync(stateDir, { recursive: true }); mkdirSync(host);
  expect(realPath(project)).not.toBe(realPath(process.cwd()));
  const git = (args: string[]) => {
    const result = hubGitSync(args, { cwd: project, encoding: "utf8", timeout: 1000 });
    expect(result.status).toBe(0);
  };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const oldPath = process.env.PATH;
  try {
    git(["init", "-q"]);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "sdlc-gh-fixture", version: "1.0.0" }));
    git(["add", "package.json"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    mkdirSync(join(project, ".agenthub")); writeFileSync(join(project, ".agenthub", "sdlc.toml"), 'mode = "advise"\nrequired_checks = ["gate"]\n');
    const board = new Board(join(stateDir, "hub.db"));
    const task = board.propose("user", { title: "readback fixture", class: "implement" });
    board.update(task.id, "user", "lifecycle", { sdlc: { repo: "owner/repo", issue: 2, pr: 1, stage: "implement" } }); board.close();
    const binary = join(trusted ? host : project, "gh"), head = "a".repeat(40);
    writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({args,cwd:process.cwd()})+'\\n'); const value=args[0]==='pr'&&args[1]==='view'?{headRefOid:${JSON.stringify(head)},state:'OPEN',reviewDecision:'APPROVED',reviewRequests:[],statusCheckRollup:[],files:[],changedFiles:0}:args[0]==='api'?{data:{repository:{pullRequest:{headRefOid:${JSON.stringify(head)},reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}}:[]; process.stdout.write(JSON.stringify(value));`);
    chmodSync(binary, 0o755);
    daemon = await startDaemon({ cwd: project, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, pi: false, local: false }, batch_ms: 0,
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { enabled: false, keep: 1 } } });
    client = await ControlClient.connect(stateDir, { role: "console" });
    process.env.PATH = `${trusted ? host : project}:${oldPath ?? ""}`;
    const status = await client.request({ t: "sdlc", op: "status", id: task.id });
    const queue = await client.request({ t: "sdlc", op: "queue", repo: "owner/repo" });
    const release = await client.request({ t: "sdlc", op: "release", repo: "owner/repo" });
    expect(status.ok).toBe(true); expect(queue.ok).toBe(true); expect(release.ok).toBe(true);
    if (trusted) {
      const calls: { args: string[]; cwd: string }[] = readFileSync(marker, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(calls.some(call => call.args[0] === "pr" && call.args[1] === "view")).toBe(true);
      expect(calls.some(call => call.args[0] === "pr" && call.args[1] === "list")).toBe(true);
      expect(calls.some(call => call.args[0] === "release" && call.args[1] === "list")).toBe(true);
      expect(calls.every(call => call.cwd === realPath(project))).toBe(true);
    } else {
      expect(existsSync(marker)).toBe(false);
      expect(status.rows[0].blockers).toContain("current PR evidence unknown");
      expect(queue.report.complete).toBe(false);
      expect(release.report.blockers).toContain("published release identity unknown");
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    client?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true });
  }
});
