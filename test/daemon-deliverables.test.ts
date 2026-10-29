import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { USER } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";

// #509a through the real daemon and its control socket: the tool ops pass `deliverables` through, the owner's root is the project here, and
// `task_show` reports the live state. A plain folder: no git repository is initialised.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function rig() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-daemon-deliverables-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, peers: { kimi: { start_mode: "headless" } }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false }, kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")], local: { ...DEFAULT_CONFIG.local, deny: ["secret"] } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "kimi" }); cleanup.push(() => tools.close());
  const claude = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => claude.close()); // an attached reviewer candidate
  const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
  const op = (client: ControlClient, name: string, args: Record<string, unknown>) => client.request({ t: "task", op: name, args }, 15000);
  const propose = async (reviewer = false) => {
    const made = await op(console_, "hub_task_propose", { title: "write the report", class: "implement", owner: "kimi" });
    expect(made.ok).toBe(true);
    const id = Number(/#(\d+)/.exec(String(made.text))![1]);
    expect((await op(tools, "hub_task_accept", { id })).ok).toBe(true);
    // Only a task with a reviewer reaches in_review: without one, done approves directly and there is no verdict to give.
    if (reviewer) expect((await op(console_, "task_assign", { id, peer: "claude", role: "reviewer" })).ok).toBe(true);
    return id;
  };
  const show = async (id: number) => JSON.parse((await op(console_, "task_show", { id })).text);
  return { root, daemon, console_, tools, write, op, propose, show };
}

test("hub_task_done passes deliverables through, the hub hashes them, and task_show reports them live (plain folder, no git)", async () => {
  const r = await rig(); r.write("out/report.md", "# Report v1\n");
  const id = await r.propose();
  const done = await r.op(r.tools, "hub_task_done", { id, summary: "wrote the report", deliverables: [{ path: "out/report.md", format: "md", version: "v1" }] });
  expect(done.ok, String(done.error ?? done.text)).toBe(true);
  const shown = await r.show(id);
  expect(shown.deliverables).toMatchObject({ state: "delivered", changedSinceReview: false, files: [{ path: "out/report.md", format: "md", version: "v1", sha256: sha("# Report v1\n"), state: "unchanged" }] });
  expect(shown.history.find((h: any) => h.event === "done").deliverables[0]).toMatchObject({ sha256: sha("# Report v1\n"), bytes: 12 });
  r.write("out/report.md", "# Report v1, edited\n");
  expect((await r.show(id)).deliverables).toMatchObject({ changedSinceReview: true, files: [{ state: "changed" }] });
});

test("an approval over the control socket after an edit binds the current hashes and says the files changed since delivery", async () => {
  const r = await rig(); r.write("report.md", "reviewed bytes");
  const id = await r.propose(true);
  expect((await r.op(r.tools, "hub_task_done", { id, summary: "done", deliverables: [{ path: "report.md", format: "md" }] })).ok).toBe(true);
  r.write("report.md", "edited after the review request");
  const approved = await r.op(r.console_, "hub_review", { id, verdict: "approved", note: "ok" });
  expect(approved.ok).toBe(true); // the person approves the bytes on disk now
  const shown = await r.show(id);
  expect(shown.state).toBe("approved");
  expect(shown.history.findLast((h: any) => h.event === "approved").deliverables[0].sha256).toBe(sha("edited after the review request"));
  expect(shown.history.findLast((h: any) => h.event === "approved").note).toContain("Approved with the deliverable files changed since delivery");
});

test("a claimed hash, a denied path and a path outside the project are refused over the socket with nothing recorded", async () => {
  const r = await rig(); r.write("report.md", "x"); r.write("notes/secret.txt", "s");
  const id = await r.propose();
  const before = JSON.stringify((await r.show(id)).history);
  for (const [deliverables, why] of [
    [[{ path: "report.md", format: "md", sha256: sha("x") }], /a claimed hash is not used/],
    [[{ path: "notes/secret.txt", format: "txt" }], /denylist/],
    [[{ path: "../outside.md", format: "md" }], /\.\. segments/],
    [[{ path: "absent.md", format: "md" }], /does not exist/],
  ] as const) {
    const result = await r.op(r.tools, "hub_task_done", { id, summary: "done", deliverables });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(why);
  }
  expect(JSON.stringify((await r.show(id)).history)).toBe(before);
});

test("hub_sdlc_record carries deliverables through recordSdlc, and a peer's task_show shows a private record by id, hash and size only", async () => {
  const r = await rig(); r.write("deck.pptx", "slides");
  const id = await r.propose();
  const recorded = await r.op(r.tools, "hub_sdlc_record", { id, receipt: { deliverables: [{ path: "deck.pptx", format: "pptx" }] } });
  expect(recorded.ok, String(recorded.error ?? recorded.text)).toBe(true);
  expect((await r.show(id)).history.find((h: any) => h.event === "lifecycle").deliverables[0]).toMatchObject({ sha256: sha("slides"), path: "deck.pptx" });
  const peer = await r.op(r.tools, "task_show", { id });
  expect(peer.ok).toBe(true);
  expect(JSON.parse(peer.text).deliverables).toMatchObject({ state: "delivered", files: [{ sha256: sha("slides"), state: "unchanged" }] });
});

// ---- #317: `ahub deliverables` (the `deliverables` task op) and the dashboard snapshot field

const uiSnapshot = async (daemonConsole: ControlClient) => {
  const opened = await daemonConsole.request({ t: "ui" }), url = new URL(opened.url);
  const headers: Record<string, string> = { origin: url.origin, "content-type": "application/json" };
  const session = await fetch(`${url.origin}/session`, { method: "POST", headers, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
  expect(session.status).toBe(200); headers.cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const response = await fetch(`${url.origin}/snapshot`, { method: "POST", headers, body: JSON.stringify({ after: 0 }) });
  expect(response.status).toBe(200);
  return await response.json() as { tasks: { id: number; deliverables?: any }[] };
};

test("the deliverables op lists the board's records for the person, opens no file without check, and measures with check", async () => {
  const r = await rig(); r.write("out/report.md", "# Report v1\n");
  const id = await r.propose(true);
  expect((await r.op(r.tools, "hub_task_done", { id, summary: "wrote it", deliverables: [{ path: "out/report.md", format: "md", version: "v1" }] })).ok).toBe(true);
  expect((await r.op(r.console_, "hub_review", { id, verdict: "approved", note: "ok" })).ok).toBe(true);
  r.write("out/report.md", "# Report v1, edited after approval\n");
  const plain = JSON.parse((await r.op(r.console_, "deliverables", {})).text);
  expect(plain).toHaveLength(1);
  expect(plain[0]).toMatchObject({ task: id, state: "approved", checked: false, files: [{ path: "out/report.md", version: "v1", sha256: sha("# Report v1\n"), bytes: 12 }] });
  expect(plain[0]).not.toHaveProperty("changedSinceReview");
  const checked = JSON.parse((await r.op(r.console_, "deliverables", { check: true, task: id })).text);
  expect(checked[0]).toMatchObject({ checked: true, changedSinceReview: true, files: [{ state: "changed", sha256: sha("# Report v1\n") }] });
  expect(JSON.parse((await r.op(r.console_, "deliverables", { approved: true })).text)).toHaveLength(1);
  expect(JSON.parse((await r.op(r.console_, "deliverables", { task: 4242 })).text)).toEqual([]);
});

test("the deliverables op gives an agent only the rows hub_task_show would show it (#933), and a malformed task is refused before any read", async () => {
  const r = await rig(); r.write("report.md", "x");
  const id = await r.propose();
  expect((await r.op(r.tools, "hub_task_done", { id, summary: "done", deliverables: [{ path: "report.md", format: "md" }] })).ok).toBe(true);
  // The owner sees its own task's row through the same public records as the person; a peer hub_task_show refuses sees none.
  const owner = JSON.parse(String((await r.op(r.tools, "deliverables", {})).text));
  expect(owner).toEqual(JSON.parse(String((await r.op(r.console_, "deliverables", {})).text)));
  expect(owner).toHaveLength(1); expect(owner[0]).toMatchObject({ task: id, files: [{ path: "report.md", sha256: sha("x") }] });
  const outsider = await ControlClient.connect(join(r.root, "state"), { role: "tools", peer: "codex" }); cleanup.push(() => outsider.close());
  expect(await r.op(outsider, "hub_task_show", { id })).toMatchObject({ ok: false });
  expect(JSON.parse(String((await r.op(outsider, "deliverables", {})).text))).toEqual([]);
  expect(JSON.parse(String((await r.op(outsider, "deliverables", { task: id, check: true })).text))).toEqual([]);
  for (const bad of [0, -1, 1.5, "1", null]) for (const client of [r.console_, r.tools]) {
    const refused = await r.op(client, "deliverables", { task: bad });
    expect(refused.ok, `task=${String(bad)}`).toBe(false); expect(String(refused.error)).toContain("positive integer");
  }
});

test("the dashboard snapshot carries a deliverables badge from the board, never opens a file, and shows a measurement only after a live read", async () => {
  const r = await rig(); r.write("report.md", "reviewed");
  const id = await r.propose();
  expect((await r.op(r.tools, "hub_task_done", { id, summary: "done", deliverables: [{ path: "report.md", format: "md" }] })).ok).toBe(true);
  r.write("report.md", "edited behind the board's back");
  const first = (await uiSnapshot(r.console_)).tasks.find(task => task.id === id)!;
  expect(first.deliverables).toMatchObject({ state: "delivered", files: [{ path: "report.md", sha256: sha("reviewed") }] });
  expect(first.deliverables).not.toHaveProperty("checked");                                  // the poll hashed nothing, so it says nothing about change
  await r.show(id);                                                                          // task_show is a live read
  const second = (await uiSnapshot(r.console_)).tasks.find(task => task.id === id)!;
  expect(second.deliverables).toMatchObject({ checked: { result: "changed" } });
  const made = await r.op(r.console_, "hub_task_propose", { title: "no files here", class: "implement" });   // a task with no deliverables carries no field
  expect(made.ok).toBe(true);
  const plain = Number(/#(\d+)/.exec(String(made.text))![1]);
  const tasks = (await uiSnapshot(r.console_)).tasks;
  expect(tasks.find(task => task.id === plain)).toBeDefined(); expect(tasks.find(task => task.id === plain)).not.toHaveProperty("deliverables");
});

// ---- #317 through the real `ahub deliverables` command

async function ahub(root: string, args: string[], markers: Record<string, string> = {}) {
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR"]) delete process.env[name];
Object.assign(process.env, ${JSON.stringify(markers)}, { AGENTHUB_STATE_DIR: ${JSON.stringify(join(root, "state"))}, COLUMNS: "200", NO_COLOR: "1", AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))} });
process.argv = [process.execPath, ${JSON.stringify(join(import.meta.dir, "../src/cli/main.ts"))}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(join(import.meta.dir, "../src/cli/main.ts"))});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test("ahub deliverables prints the records, --check marks a change since review, --json is the same rows, bad flags are usage errors", async () => {
  const r = await rig(); r.write("out/report.md", "# Report v1\n");
  const id = await r.propose(true);
  expect((await r.op(r.tools, "hub_task_done", { id, summary: "wrote it", deliverables: [{ path: "out/report.md", format: "md", version: "v1" }] })).ok).toBe(true);
  expect((await r.op(r.console_, "hub_review", { id, verdict: "approved", note: "ok" })).ok).toBe(true);
  const plain = await ahub(r.root, ["deliverables"]);
  expect(plain.code, plain.stderr).toBe(0);
  expect(plain.stdout).toContain(`#${id} write the report [approved]`); expect(plain.stdout).not.toContain(`#${id} #${id}`);
  expect(plain.stdout).toContain(`out/report.md  md v1  12 B  sha256 ${sha("# Report v1\n")}`);
  expect(plain.stdout).toContain("add --check to measure the files now");
  expect(plain.stdout).not.toContain("changed since review");                              // not measured, so not claimed
  r.write("out/report.md", "# Report v1, edited after approval\n");
  const checked = await ahub(r.root, ["deliverables", "--check", "--task", String(id)]);
  expect(checked.code, checked.stderr).toBe(0);
  expect(checked.stdout).not.toContain("add --check");                                     // the hint is for a list that was not measured
  expect(checked.stdout).toContain("[approved (changed since review)]");
  rmSync(join(r.root, "out/report.md"));                                                    // now the only file is gone: it must read as missing, not unchanged
  const gone = await ahub(r.root, ["deliverables", "--check", "--task", String(id)]);
  expect(gone.code, gone.stderr).toBe(0);
  expect(gone.stdout).toContain("[approved (a file is missing)]"); expect(gone.stdout).not.toContain("(unchanged)"); expect(gone.stdout).toMatch(/sha256 [0-9a-f]{64}  missing\n/);
  expect(JSON.parse((await ahub(r.root, ["deliverables", "--check", "--json"])).stdout)[0]).toMatchObject({ result: "missing", changedSinceReview: false });
  r.write("out/report.md", "# Report v1, edited after approval\n");
  expect(checked.stdout).toMatch(/sha256 [0-9a-f]{64}  changed\n/);
  const json = JSON.parse((await ahub(r.root, ["deliverables", "--approved", "--json"])).stdout);
  expect(json).toHaveLength(1); expect(json[0]).toMatchObject({ task: id, state: "approved", checked: false });
  const empty = await ahub(r.root, ["deliverables", "--task", "999"]);
  expect(empty.code).toBe(0); expect(empty.stdout).toContain("task #999 has no deliverables");
  for (const bad of [["--task"], ["--task", "0"], ["--task", "abc"], ["extra"], ["--task", "1", "--task", "2"]]) {
    const refused = await ahub(r.root, ["deliverables", ...bad]);
    expect(refused.code, bad.join(" ")).toBe(1); expect(refused.stderr).toMatch(/usage: ahub deliverables|needs a value|more than once|repeated/); expect(refused.stdout).toBe("");
  }
});

test("ahub deliverables from an agent shell shows only the rows hub_task_show would show that agent (#933), and live-test never borrows the person's view", async () => {
  const r = await rig(); r.write("report.md", "secret-looking text");
  const id = await r.propose();
  expect((await r.op(r.tools, "hub_task_done", { id, summary: "done", deliverables: [{ path: "report.md", format: "md" }] })).ok).toBe(true);
  const owner = await ahub(r.root, ["deliverables"], { AGENTHUB_PEER_ID: "kimi" });
  expect(owner.code, owner.stderr).toBe(0); expect(owner.stdout).toContain("report.md"); expect(owner.stdout).toContain(sha("secret-looking text"));
  for (const argv of [["deliverables"], ["--live-test", "deliverables"]]) {
    const outsider = await ahub(r.root, argv, { AGENTHUB_PEER_ID: "codex" });
    expect(outsider.code, outsider.stderr).toBe(0); expect(outsider.stdout).not.toContain("report.md"); expect(outsider.stdout).not.toContain(sha("secret-looking text"));
  }
});
