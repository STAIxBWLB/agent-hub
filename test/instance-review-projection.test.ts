import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { repoOf, Turns } from "../src/hub/snapshots.ts";
import { snapshotBytes } from "../src/hub/projected-diff.ts";
import { shellQuote } from "../src/cli/shell-quote.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class Reviewer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}
const freePort = () => { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = server.port!; server.stop(true); return port; };
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition(), label).toBe(true);
}
const document = (body: string) => Buffer.concat([Buffer.from([80, 75, 3, 4, 0]), Buffer.from(body + "\n")]);
const converter = (view: string) => `#!/bin/sh\nprintf '${view} '\n/usr/bin/tail -c +6 "$1"\n`;

async function fixture(readCanonicalCanary = false, privateDocument = false) {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-instance-projection-"))), project = join(base, "project"); mkdirSync(project);
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", project, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout;
  };
  git("init", "-q");
  writeFileSync(join(project, ".gitignore"), ".agenthub/\n.worktrees/\n");
  writeFileSync(join(project, "paper.docx"), document("BASELINE"));
  writeFileSync(join(project, "convert.sh"), converter("CANONICAL_VIEW"), { mode: 0o700 });
  git("add", ".gitignore", "paper.docx", "convert.sh"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const instance = "codex-worker", worktree = join(project, ".worktrees", instance);
  git("worktree", "add", "-b", "instance-projection", worktree, "HEAD");
  // A relative converter command must be resolved inside the selected execution worktree, independently of the canonical copy.
  const canary = join(project, "private-source.txt");
  if (readCanonicalCanary) {
    writeFileSync(join(project, ".git", "info", "exclude"), "private-source.txt\n");
    writeFileSync(canary, "CANONICAL_PRIVATE_MARKER\n");
    const probe = `#!/bin/sh\nprobe_text=$(/bin/cat ${shellQuote(canary)} 2>/dev/null || printf UNREADABLE)\nprintf 'WORKTREE_VIEW %s ' "$probe_text"\n/usr/bin/tail -c +6 "$1"\n`;
    writeFileSync(join(worktree, "convert.sh"), probe, { mode: 0o700 });
  } else writeFileSync(join(worktree, "convert.sh"), converter("WORKTREE_VIEW"), { mode: 0o700 });
  mkdirSync(join(project, ".agenthub"));
  const text_projection = { ".docx": ["./convert.sh", "{input}"] };
  writeFileSync(join(project, ".agenthub", "config.local.json"), JSON.stringify({ text_projection, ...(privateDocument ? { pii: { paths: ["paper.docx"] } } : {}), ...(readCanonicalCanary ? { local: { read_allow: [project] } } : {}) }));
  const bin = join(base, "fake-codex"), stateDir = join(project, ".agenthub", "state");
  writeFileSync(bin, `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "fakes/codex-bin.ts")).href)});\n`, { mode: 0o700 });
  const daemon = await startDaemon({ cwd: project, stateDir, controlPort: 0, codexAppPort: freePort(), codexProxyPort: freePort(),
    config: { ...DEFAULT_CONFIG, instances: { [instance]: { kind: "codex", roles: ["implementer"], start_mode: "headless", worktree } }, codex_bin: bin, batch_ms: 0,
      text_projection, ...(privateDocument ? { pii: { paths: ["paper.docx"] } } : {}), local: { ...DEFAULT_CONFIG.local, ...(readCanonicalCanary ? { read_allow: [project] } : {}) }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      approvals: { ...DEFAULT_CONFIG.approvals, notify: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: project }); cleanup.push(() => client.close());
  const reviewer = new Reviewer("claude"); daemon.bus.add(reviewer); await reviewer.start();
  const started = await client.request({ t: "start", peer: instance }); expect(started).toMatchObject({ ok: true });
  const seen: any[] = [], tui = new WebSocket(started.proxyUrl); cleanup.push(() => tui.close());
  tui.onmessage = event => seen.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => { tui.onopen = () => resolve(); tui.onerror = () => reject(new Error("fake TUI connection failed")); });
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "projection-instance-fixture" } } }));
  await until(() => seen.some(message => message.id === 1), "fake native initialization");
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => seen.some(message => message.id === 2 && message.result?.thread?.id) && daemon.bus.stateOf(instance) === "idle", "worktree owner native session");
  const op = async (name: string, args: Record<string, unknown>) => { const reply = await client.request({ t: "task", op: name, args }, 15000); expect(reply).toMatchObject({ ok: true }); return reply; };
  return { project, worktree, instance, stateDir, daemon, reviewer, git, op, canary };
}

for (const scope of ["relative", "absolute", "canonical"] as const) test.skipIf(process.platform !== "darwin")(`extra worktree review projects its own binary document and converter with ${scope} task paths`, async () => {
  const f = await fixture(), path = scope === "absolute" ? join(f.worktree, "paper.docx") : scope === "canonical" ? join(f.project, "paper.docx") : "paper.docx";
  const proposed = await f.op("hub_task_propose", { title: "Review isolated document", class: "implement", owner: f.instance, refs: { paths: [path] } });
  const id = Number(proposed.text.match(/task #(\d+)/)![1]);
  await until(() => f.daemon.bus.stateOf(f.instance) === "idle", "assignment delivery completed before document mutation");
  const shown = await f.op("task_show", { id }), task = JSON.parse(shown.text);
  const turns = new Turns(join(f.stateDir, "hub.db"), true);
  try {
    const baseline = turns.taskStart(id, task.history.find((entry: { event: string }) => entry.event === "proposed").at);
    expect(baseline).toBeDefined();
    expect(snapshotBytes(repoOf(f.project)!, baseline!, "paper.docx")).toEqual(document("BASELINE"));
  } finally { turns.close(); }
  writeFileSync(join(f.worktree, "paper.docx"), document("OWN_WORKTREE_REVISION"));
  await f.op("hub_task_done", { id, summary: "document updated" });
  await until(() => f.reviewer.got.some(env => env.kind === "review" && env.refs?.task === String(id)), "public review notice delivered");
  const notice = f.reviewer.got.find(env => env.kind === "review" && env.refs?.task === String(id))!;
  expect(notice.body).toContain("Projected text only");
  expect(notice.body).toContain("-WORKTREE_VIEW BASELINE");
  expect(notice.body).toContain("+WORKTREE_VIEW OWN_WORKTREE_REVISION");
  expect(notice.body).not.toContain("CANONICAL_VIEW");
  expect(notice.body).not.toContain("projection unavailable");
  expect(readFileSync(join(f.project, "paper.docx"))).toEqual(document("BASELINE"));
  expect(readFileSync(join(f.project, "convert.sh"), "utf8")).toBe(converter("CANONICAL_VIEW"));
  expect(f.git("status", "--porcelain")).toBe("");
  expect((await f.op("task_show", { id })).text).not.toContain("OWN_WORKTREE_REVISION");
}, 20_000);


test.skipIf(process.platform !== "darwin")("worktree document projection cannot read an ignored canonical project source", async () => {
  const f = await fixture(true);
  expect(f.git("check-ignore", "private-source.txt").trim()).toBe("private-source.txt");
  const proposed = await f.op("hub_task_propose", { title: "Review isolated projection privacy", class: "implement", owner: f.instance, refs: { paths: ["paper.docx"] } });
  const id = Number(proposed.text.match(/task #(\d+)/)![1]);
  await until(() => f.daemon.bus.stateOf(f.instance) === "idle", "assignment delivery completed before privacy probe mutation");
  const shown = await f.op("task_show", { id }), task = JSON.parse(shown.text);
  const turns = new Turns(join(f.stateDir, "hub.db"), true);
  try {
    const baseline = turns.taskStart(id, task.history.find((entry: { event: string }) => entry.event === "proposed").at);
    expect(baseline).toBeDefined();
    expect(snapshotBytes(repoOf(f.project)!, baseline!, "private-source.txt")).toBeNull();
  } finally { turns.close(); }
  writeFileSync(join(f.worktree, "paper.docx"), document("OWN_WORKTREE_REVISION"));
  await f.op("hub_task_done", { id, summary: "document updated" });
  await until(() => f.reviewer.got.some(env => env.kind === "review" && env.refs?.task === String(id)), "public privacy-probe review notice delivered");
  const notice = f.reviewer.got.find(env => env.kind === "review" && env.refs?.task === String(id))!;
  expect(notice.body).toContain("Projected text only");
  expect(notice.body).toContain("WORKTREE_VIEW");
  expect(notice.body).toContain("OWN_WORKTREE_REVISION");
  // The converter prepends the attempted read to each changed line, so a shared prefix cannot disappear as unchanged context.
  expect(notice.body).not.toContain("CANONICAL_PRIVATE_MARKER");
  expect(readFileSync(f.canary, "utf8")).toBe("CANONICAL_PRIVATE_MARKER\n");
  expect(readFileSync(join(f.project, "paper.docx"))).toEqual(document("BASELINE"));
  expect(f.git("status", "--porcelain")).toBe("");
}, 20_000);


test.skipIf(process.platform !== "darwin")("nonprivate worktree review omits a private document using the execution checkout policy root", async () => {
  const f = await fixture(false, true);
  const proposed = await f.op("hub_task_propose", { title: "Review public repository work", class: "implement", owner: f.instance, refs: { paths: [join(f.worktree, "paper.docx")] } });
  const id = Number(proposed.text.match(/task #(\d+)/)![1]);
  await until(() => f.daemon.bus.stateOf(f.instance) === "idle", "public assignment settled");
  writeFileSync(join(f.worktree, "paper.docx"), document("PRIVATE_DOCUMENT_REVISION"));
  await f.op("hub_task_done", { id, summary: "public work completed" });
  await until(() => f.reviewer.got.some(env => env.kind === "review" && env.refs?.task === String(id)), "nonprivate review delivered");
  const notice = f.reviewer.got.find(env => env.kind === "review" && env.refs?.task === String(id))!;
  expect(notice.private).not.toBe(true);
  expect(notice.body).not.toContain("PRIVATE_DOCUMENT_REVISION");
  expect(notice.body).not.toContain("WORKTREE_VIEW");
  expect(notice.body).not.toContain("CANONICAL_VIEW");
});
