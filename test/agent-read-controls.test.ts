import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const PRIVATE_HEAD = "d".repeat(40), PUBLIC_HEAD = "a".repeat(40);
async function until(check: () => boolean) { for (let n = 0; n < 150 && !check(); n++) await Bun.sleep(5); expect(check()).toBe(true); }
async function rig() {
  const temp = realPath(mkdtempSync(join(tmpdir(), "ahub-agent-read-"))), root = join(temp, "project"), stateDir = join(root, "state"), bin = join(temp, "bin");
  mkdirSync(stateDir, { recursive: true }); mkdirSync(bin); cleanup.push(() => rmSync(temp, { recursive: true, force: true }));
  const prior = { HOME: process.env.HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME, PATH: process.env.PATH };
  process.env.HOME = join(temp, "home"); mkdirSync(process.env.HOME); process.env.AGENTHUB_HOME = join(temp, "hubs");
  cleanup.push(() => { for (const key of ["HOME", "AGENTHUB_HOME", "PATH"] as const) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  const git = (args: string[]) => { const result = hubGitSync(args, { cwd: root, encoding: "utf8", timeout: 1000 }); expect(result.status).toBe(0); };
  git(["init", "-q"]); git(["remote", "add", "origin", "https://github.com/Owner/Repo.git"]); writeFileSync(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}'); git(["add", "package.json"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/sdlc.toml"), 'mode = "advise"\nrequired_checks = ["gate"]\n[repos."Configured/Repo"]\nrequired_checks = ["gate"]\n');
  const template = readFileSync(new URL("../templates/routing.toml", import.meta.url), "utf8").replaceAll("hub/stage", "hub/secret-location-alias").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"');
  writeFileSync(join(root, ".agenthub/routing.toml"), template);
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ codex_bin: "SECRET_PROGRAM_LOCATOR", jcode_home: join(temp, "SECRET_ACCOUNT_LOCATOR"), memory: { worker_url: "https://secret-location.invalid" } }));
  const board = new Board(join(stateDir, "hub.db"));
  const priv = board.propose("user", { title: "PRIVATE_TITLE_CANARY", detail: "PRIVATE_BODY_CANARY", class: "implement", signals: ["pii_path"], refs: { paths: ["private-note.txt"], commit: PRIVATE_HEAD } });
  const pub = board.propose("user", { title: "public read fixture", class: "implement", deps: [priv.id] });
  board.update(pub.id, "user", "fixture lifecycle", { sdlc: { stage: "implement", repo: "owner/repo", issue: 1, pr: 1 } });
  board.update(priv.id, "user", "fixture lifecycle", { sdlc: { stage: "release", repo: "owner/repo", issue: 999, pr: 999, reviewedHead: PRIVATE_HEAD } });
  const release = board.newRelease("public-train", "public release goal", 1);
  board.updateRelease(release.id, { train: { scope: [priv.id], history: [{ at: 1, by: "user", event: "configured", scope: [priv.id] }] } }, release.revision);
  board.close();
  const calls = join(temp, "gh-calls.jsonl"), hold = join(temp, "hold"), entered = join(temp, "entered");
  const snapshots = [1,999].map(number => ({number, headRefOid:number === 999 ? PRIVATE_HEAD : PUBLIC_HEAD, baseRefName:"main",baseRefOid:PUBLIC_HEAD}));
  const pr = {headRefOid:PUBLIC_HEAD,state:"OPEN",isDraft:false,baseRefName:"main",baseRefOid:PUBLIC_HEAD,changedFiles:0,files:[],statusCheckRollup:[],reviewDecision:"APPROVED",reviewRequests:[]};
  const api = {data:{repository:{pullRequest:{headRefOid:PUBLIC_HEAD,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}},issue:{number:1,labels:{nodes:[],pageInfo:{hasNextPage:false}}},pullRequests:{nodes:snapshots,pageInfo:{hasNextPage:false}}}}};
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(fs.existsSync(${JSON.stringify(hold)})){fs.writeFileSync(${JSON.stringify(entered)},'entered');const until=Date.now()+2000;while(fs.existsSync(${JSON.stringify(hold)})&&Date.now()<until)await Bun.sleep(5);}
let value=[];if(args[0]==='pr')value=args[1]==='list'?${JSON.stringify(snapshots)}:${JSON.stringify(pr)};else if(args[0]==='api')value=${JSON.stringify(api)};process.stdout.write(JSON.stringify(value));\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${prior.PATH ?? "/usr/bin:/bin"}`;
  const probe = Bun.spawnSync([join(bin, "gh"), "pr", "list"], { stdout: "pipe", stderr: "pipe" }); expect(probe.exitCode, probe.stderr.toString()).toBe(0); expect(JSON.parse(probe.stdout.toString()).map((row:any)=>row.number)).toEqual([1,999]);
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, notifier: () => {}, config: {
    ...DEFAULT_CONFIG, roles: { claude: ["planner"], codex: ["implementer"], pi: ["implementer"] }, roster: { ...DEFAULT_CONFIG.roster, pi: true },
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { enabled: false, keep: 1 },
    pii: { ...DEFAULT_CONFIG.pii, paths: ["private-note.txt"] }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
  } }); cleanup.push(() => { rmSync(hold, { force: true }); return daemon.stop(); });
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  const agent = async (peer: "codex" | "pi" = "codex") => { const client = await ControlClient.connect(stateDir, { role: "tools", peer }); cleanup.push(() => client.close()); return client; };
  return { temp, root, stateDir, daemon, person, agent, pub, priv, release, calls, hold, entered };
}

for (const peer of ["codex", "pi"] as const) test(`${peer} ordinary tools reads public queue/settings/roster/lifecycle/release without console authority`, async () => {
  const r = await rig(), agent = await r.agent(peer);
  r.daemon.bus.publish(newEnvelope("user", "PRIVATE_QUEUE_BODY_CANARY", { to: ["codex"], private: true, refs: { task: String(r.priv.id) } }));
  const queue = await agent.request({ t: "queue", op: "list" }); expect(queue.ok).toBe(true); expect(JSON.stringify(queue)).not.toContain("PRIVATE_QUEUE_BODY_CANARY");
  expect((await agent.request({ t: "queue", op: "list", peer: "codex" })).ok).toBe(true);
  const settings = await agent.request({ t: "settings_get" }); expect(settings.ok).toBe(true); expect(settings.public).toBe(true);
  expect(settings.rows.find((row: any) => row.key === "research.enabled").value).toBe(false); expect(settings.roster.some((row: any) => row.peer === "codex")).toBe(true);
  const route = settings.rows.find((row: any) => row.key === "routing.classes.implement.route"); expect(route.value).toBe("[withheld]"); expect(route.values).toEqual([]);
  const encoded = JSON.stringify(settings); for (const hidden of ["SECRET_PROGRAM_LOCATOR", "SECRET_ACCOUNT_LOCATOR", "secret-location", r.root, "config.local.json"]) expect(encoded).not.toContain(hidden);
  expect(settings).not.toHaveProperty("undo"); expect(settings).not.toHaveProperty("configEdit");
  const status = await agent.request({ t: "sdlc", op: "status" }); expect(status.ok).toBe(true); expect(status.rows.find((row: any) => row.id === r.pub.id).receipt.pr).toBe(1);
  const privateStatus = await agent.request({ t: "sdlc", op: "explain", id: r.priv.id }); expect(privateStatus.ok).toBe(true); expect(privateStatus.rows).toEqual([{ id: r.priv.id, title: `#${r.priv.id} [pii]`, private: true }]);
  const delivery = await agent.request({ t: "sdlc", op: "queue", repo: "owner/repo" }); expect(delivery.ok).toBe(true); expect(delivery.report.rows.find((row:any)=>row.private)).toMatchObject({ private: true, ready: false }); expect(delivery.report.rows.find((row:any)=>row.private)).not.toHaveProperty("pr"); expect(delivery.report.rows.find((row:any)=>row.pr===1)).toMatchObject({ready:false,after:[],blockers:["private dependency evidence unavailable"]}); expect(JSON.stringify(delivery.report)).not.toContain("999");
  const release = await agent.request({ t: "sdlc", op: "release", repo: "owner/repo" }); expect(release.ok).toBe(true); expect(release.report).not.toHaveProperty("authorization");
  const shown = await agent.request({ t: "task", op: "release_show", args: { name: "public-train" } }); expect(shown.ok).toBe(true); const publicRelease = JSON.parse(shown.text); expect(publicRelease.name).toBe("public-train"); expect(publicRelease.complete).toBe(false); expect(publicRelease).not.toHaveProperty("train"); expect(publicRelease).not.toHaveProperty("tasks");
  for (const result of [status, privateStatus, delivery, release, shown]) { const text = JSON.stringify(result); for (const hidden of ["PRIVATE_TITLE_CANARY", "PRIVATE_BODY_CANARY", "private-note.txt", PRIVATE_HEAD]) expect(text).not.toContain(hidden); }
  const full = await r.person.request({ t: "task", op: "release_show", args: { name: "public-train" } }); expect(JSON.parse(full.text).train.scope).toEqual([r.priv.id]);
  const personSettings = await r.person.request({ t: "settings_get" }); expect(personSettings.rows.find((row: any) => row.key === "routing.classes.implement.route").value).toBe("hub/secret-location-alias"); expect(personSettings).toHaveProperty("configEdit");
});

for (const peer of ["codex", "pi"] as const) test(`${peer} public GitHub reads are limited to repositories already named by this project`, async () => {
  const r = await rig(), agent = await r.agent(peer);
  const board = new Board(join(r.stateDir, "hub.db"));
  try {
    board.propose("user", { title: "public imported task", class: "implement", external: { provider: "github", repo: "External/Repo", issue: 3, url: "https://github.com/External/Repo/issues/3" } });
    const receiptOnly = board.propose("user", { title: "receipt is not host authorization", class: "implement" });
    board.update(receiptOnly.id, "user", "fixture lifecycle", { sdlc: { stage: "implement", repo: "Receipt-Only/Repo" } });
    const privateOnly = board.propose("user", { title: "private source", class: "implement", signals: ["pii_path"] });
    board.update(privateOnly.id, "user", "fixture lifecycle", { sdlc: { stage: "implement", repo: "Private-Only/Repo", pr: 2 } });
    board.propose("user", { title: "private external source", class: "implement", signals: ["pii_path"], external: { provider: "github", repo: "Private-External/Repo", issue: 4, url: "https://github.com/Private-External/Repo/issues/4" } });
    board.propose("user", { title: "refs do not authorize GitHub reads", class: "implement", refs: { repo: "Refs-Only/Repo" } });
  } finally { board.close(); }
  for (const op of ["queue", "release"] as const) {
    for (const repo of ["unknown/repo", "receipt-only/repo", "PRIVATE-ONLY/REPO", "private-external/repo", "refs-only/repo", " owner/repo", "https://github.com/owner/repo"]) {
      const before = readFileSync(r.calls, "utf8");
      const result = await agent.request({ t: "sdlc", op, repo, ...(op === "release" ? { liveIssues: [1, 2] } : {}) });
      expect(result).toMatchObject({ ok: false, error: "public repository unavailable for this project" });
      expect(readFileSync(r.calls, "utf8"), `${op}: ${repo}`).toBe(before); // Refusal precedes every host gh call.
      expect(JSON.stringify(result)).not.toContain(repo);
    }
    for (const repo of ["OWNER/REPO", "external/REPO", "CONFIGURED/repo"]) {
      const before = readFileSync(r.calls, "utf8");
      expect((await agent.request({ t: "sdlc", op, repo })).ok).toBe(true);
      expect(readFileSync(r.calls, "utf8")).not.toBe(before);
    }
  }
});

class ClaimFixturePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envelopes: Envelope[]) { /* An owned transport fixture receives task context without running a native account. */ }
}

test("agent-owned lifecycle receipts and forged external fields cannot mint repository authority", async () => {
  const r = await rig(), agent = await r.agent();
  const peer = new ClaimFixturePeer("codex"); r.daemon.bus.add(peer); await peer.start();
  const created = await agent.request({ t: "task", op: "hub_task_propose", args: { title: "agent-originated repo claim", class: "implement", owner: "codex", external: { provider: "github", repo: "forged-external/repo", issue: 5, url: "https://github.com/forged-external/repo/issues/5" } } });
  expect(created.ok, String(created.error)).toBe(true);
  const inspect = new Board(join(r.stateDir, "hub.db"));
  let id: number;
  try {
    const task = inspect.list().find(row => row.title === "agent-originated repo claim")!;
    expect(task.owner).toBe("codex"); expect(task.external).toBeUndefined(); id = task.id;
  } finally { inspect.close(); }
  const recorded = await agent.request({ t: "task", op: "hub_sdlc_record", args: { id, receipt: { repo: "agent-recorded/repo" } } });
  expect(recorded.ok, String(recorded.error)).toBe(true);
  const check = new Board(join(r.stateDir, "hub.db"));
  try { expect(check.get(id)?.sdlc?.repo).toBe("agent-recorded/repo"); expect(check.get(id)?.external).toBeUndefined(); } finally { check.close(); }
  const before = readFileSync(r.calls, "utf8");
  for (const repo of ["agent-recorded/repo", "forged-external/repo"]) {
    for (const op of ["queue", "release"] as const) expect(await agent.request({ t: "sdlc", op, repo })).toMatchObject({ ok: false, error: "public repository unavailable for this project" });
  }
  expect(readFileSync(r.calls, "utf8")).toBe(before);
  expect((await agent.request({ t: "task", op: "github_import", args: { repo: "forged-external/repo", label: "task" } })).ok).toBe(false);
  expect(readFileSync(r.calls, "utf8")).toBe(before);
});

test("ordinary public read access never grants adjacent mutations or planner-only reports", async () => {
  const r = await rig(), agent = await r.agent();
  const before = (await r.person.request({ t: "task", op: "hub_task_list", args: {} })).text;
  for (const request of [
    { t: "queue", op: "show", id: "missing" }, { t: "queue", op: "resolve", id: "missing", revision: 0, action: "discard", reason: "fixture" }, { t: "queue", op: "discard", peer: "codex", confirmed: true, reason: "fixture" },
    { t: "settings_set", key: "research.enabled", value: true }, { t: "settings_preview", key: "research.enabled", value: true }, { t: "settings_undo" }, { t: "settings_reload" }, { t: "config_edit_get" }, { t: "ui", settings: true },
    { t: "sdlc", op: "accept", id: r.pub.id, issue: 1 }, { t: "sdlc", op: "authorize-release", version: "1.0.0", commit: PUBLIC_HEAD }, { t: "sdlc", op: "accept-departure", id: r.pub.id, head: PUBLIC_HEAD, reason: "fixture" }, { t: "sdlc", op: "merge", id: r.pub.id }, { t: "sdlc", op: "export", id: r.pub.id },
    { t: "task", op: "release_new", args: { name: "bad", goal: "bad", order: 2 } }, { t: "task", op: "release_change", args: { id: r.release.id, revision: 0, fields: { state: "active" } } },
    { t: "task", op: "hub_release_list", args: {} }, { t: "task", op: "hub_backlog_list", args: {} }, { t: "task", op: "hub_sdlc_costs", args: {} }, { t: "task", op: "hub_sdlc_metrics", args: {} },
  ]) expect((await agent.request(request)).ok, JSON.stringify(request)).toBe(false);
  expect((await r.person.request({ t: "task", op: "hub_task_list", args: {} })).text).toBe(before);
});

test("public lifecycle reads recheck caller membership after remote awaits", async () => {
  const r = await rig(), agent = await r.agent(); writeFileSync(r.hold, "hold");
  const pending = agent.request({ t: "sdlc", op: "explain", id: r.pub.id }); await until(() => existsSync(r.entered));
  const removed = await r.person.request({ t: "settings_set", key: "roster.codex", value: false, confirm: "codex", now: true }); expect(removed.ok).toBe(true);
  rmSync(r.hold); const result = await pending; expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(PUBLIC_HEAD);
});


test("public lifecycle reads discard evidence when task privacy changes during remote awaits", async () => {
  const r = await rig(), agent = await r.agent(); writeFileSync(r.hold, "hold");
  const pending = agent.request({ t: "sdlc", op: "explain", id: r.pub.id }); await until(() => existsSync(r.entered));
  const board = new Board(join(r.stateDir, "hub.db"));
  try { board.update(r.pub.id, "user", "fixture privacy changed", { signals: ["pii_path"] }); } finally { board.close(); }
  rmSync(r.hold); const result = await pending; expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(PUBLIC_HEAD); expect(JSON.stringify(result)).not.toContain("public read fixture");
});

test("agent-shell CLI exercises every promoted read form without console identity or task mutation", async () => {
  const r = await rig();
  const cli = async (args: string[]) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "QWEN_CODE", "QWEN_CODE_SESSION_ID", "KIMI_CODE"].includes(key)) delete env[key];
    Object.assign(env, { AGENTHUB_HOME: process.env.AGENTHUB_HOME, AGENTHUB_PEER_ID: "codex", AGENTHUB_STATE_DIR: r.stateDir, AGENTHUB_PROJECT_DIR: r.root });
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: r.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  const before = (await r.person.request({ t: "task", op: "hub_task_list", args: {} })).text;
  for (const args of [["queue", "list", "--json"], ["queue", "list", "--peer", "codex", "--json"], ["roster", "--json"],
    ["settings", "--json"], ["settings", "list", "--json"], ["settings", "get", "research.enabled", "--json"],
    ["sdlc", "status"], ["sdlc", "explain", String(r.pub.id)], ["sdlc", "queue", "owner/repo"], ["sdlc", "release", "owner/repo"],
    ["sdlc", "status", "--json"], ["sdlc", "explain", String(r.pub.id), "--json"], ["sdlc", "queue", "owner/repo", "--json"], ["sdlc", "release", "owner/repo", "--json"], ["sdlc", "status", "--color=never"], ["release", "show", "public-train"]]) {
    const result = await cli(args); expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(0); expect(result.stdout.trim()).not.toBe("");
    for (const hidden of ["PRIVATE_TITLE_CANARY", "PRIVATE_BODY_CANARY", "private-note.txt", PRIVATE_HEAD, "SECRET_ACCOUNT_LOCATOR", "SECRET_PROGRAM_LOCATOR", "secret-location-alias"]) expect(result.stdout).not.toContain(hidden);
    if (args[0] === "settings") expect(result.stdout).toContain("research.enabled");
    if (args.includes("--json")) expect(() => JSON.parse(result.stdout)).not.toThrow();
  }
  for (const args of [["settings", "set", "research.enabled", "true"], ["roster", "remove", "codex", "--yes"], ["settings", "undo"], ["sdlc", "accept", String(r.pub.id), "--issue", "1"]]) {
    const result = await cli(args); expect(result.code).toBe(1); expect(result.stderr).toContain("the person runs it in ahub console or a terminal");
  }
  expect((await r.person.request({ t: "task", op: "hub_task_list", args: {} })).text).toBe(before);
}, 20_000);

test("ordinary public lifecycle reads do not promote authorize-release into a read or mint consent", async () => {
  const r = await rig(), agent = await r.agent();
  const head = hubGitSync(["rev-parse", "HEAD"], { cwd: r.root, encoding: "utf8", timeout: 1000 }); expect(head.status).toBe(0);
  const calls = readFileSync(r.calls, "utf8"), events = readFileSync(join(r.stateDir, "events.jsonl"), "utf8");
  const denied = await agent.request({ t: "sdlc", op: "authorize-release", version: "1.0.0", commit: head.stdout.trim() });
  expect(denied).toMatchObject({ ok: false, error: "only the console user or the configured conductor may authorize a release" });
  expect(denied).not.toHaveProperty("authorization");
  expect(readFileSync(r.calls, "utf8")).toBe(calls);
  expect(readFileSync(join(r.stateDir, "events.jsonl"), "utf8").includes('"type":"release_authorization"')).toBe(false);
  expect(events.includes('"type":"release_authorization"')).toBe(false);
  expect((await agent.request({ t: "sdlc", op: "status" })).ok).toBe(true);
}, 20_000);
