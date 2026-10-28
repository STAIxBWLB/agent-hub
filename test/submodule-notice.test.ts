import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { readEvents } from "../src/hub/events.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { repoOf, snapshot, submodulePaths, Turns } from "../src/hub/snapshots.ts";
import { renderTurns } from "../src/cli/output.ts";

// agent-hub#798 steps 2 to 5: a submodule's own edits never move the superproject's gitlink, so the hub names what it cannot see instead of reporting nothing.
const ROOT = join(import.meta.dir, "..");
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(10);
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
};

/** A superproject with one submodule `sub` (and a plain `top.md`), committed, plus the project with no submodule at all. */
function workspace(withSubmodule = true) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "ahub-submodule-")));
  cleanups.push(() => rmSync(top, { recursive: true, force: true }));
  const root = join(top, "super"), origin = join(top, "origin");
  const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { stdout: "pipe", stderr: "pipe" });
  mkdirSync(origin); git(origin, "init", "-q");
  writeFileSync(join(origin, "f.md"), "one\n"); git(origin, "add", "-A"); git(origin, "commit", "-qm", "sub base");
  mkdirSync(root); git(root, "init", "-q");
  writeFileSync(join(root, "top.md"), "one\n"); writeFileSync(join(root, ".gitignore"), ".agenthub/\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  if (withSubmodule) { git(root, "submodule", "add", "-q", origin, "sub"); git(root, "commit", "-qm", "add sub"); }
  return { top, root, git: (...args: string[]) => git(root, ...args) };
}

async function hub(root: string, extra: { snapshots?: boolean; piiPaths?: string[]; profile?: "writing"; snapshot?: (repo: import("../src/hub/snapshots.ts").Repo, budget?: import("../src/hub/snapshots.ts").SnapshotBudget) => string | undefined } = {}) {
  const stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true });
  const daemon = await startDaemon({
    cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, snapshotClock: () => 0, ...(extra.snapshot ? { snapshot: extra.snapshot } : {}),
    config: { ...DEFAULT_CONFIG, batch_ms: 0, peers: {}, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: extra.snapshots ?? true, keep: 20 }, tasks: { ...DEFAULT_CONFIG.tasks }, ...(extra.piiPaths ? { pii: { paths: extra.piiPaths } } : {}), ...(extra.profile ? { profile: extra.profile } : {}) },
  });
  cleanups.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  cleanups.push(() => console_.close());
  const op = async (name: string, args: unknown) => (await console_.request({ t: "task", op: name, args })) as { ok: boolean; text?: string; error?: string };
  return { stateDir, daemon, console_, op };
}

/** A peer whose turn runs `work` (a shell-made edit: no tool event says so). */
class Worker extends BasePeer {
  constructor(id: string, private readonly work: () => void) { super(id); }
  async start() { this.setState("idle"); }
  async deliver() { this.setState("busy"); this.work(); setTimeout(() => this.setState("idle"), 5); }
  async stop() { this.setState("offline"); }
}
async function runTurn(h: Awaited<ReturnType<typeof hub>>, peer: string, work: () => void): Promise<string> {
  const worker = new Worker(peer, work);
  h.daemon.bus.add(worker); await worker.start();
  expect((await h.console_.request({ t: "send", body: "work please", to: [peer] })).ok).toBe(true);
  const file = join(h.stateDir, "events.jsonl");
  await until(() => readEvents(file).some(e => e.type === "turn_end" && e.peer === peer), `${peer}'s turn`);
  return (readEvents(file).find(e => e.type === "turn_end" && e.peer === peer) as { turn: string }).turn;
}
const turnsDb = (h: Awaited<ReturnType<typeof hub>>) => { const turns = new Turns(join(h.stateDir, "hub.db"), true); cleanups.push(() => turns.close()); return turns; };

test("AC1: a turn that edits only a submodule's files lists the submodule as changed-unobserved, and still counts no changed file", async () => {
  const { root } = workspace();
  const h = await hub(root);
  const id = await runTurn(h, "editor", () => { writeFileSync(join(root, "sub", "f.md"), "edited\n"); writeFileSync(join(root, "sub", "new.md"), "fresh\n"); });
  const record = turnsDb(h).get(id)!;
  expect(record.changed).toEqual([]);            // the gitlink did not move: this is the blindness the issue describes
  expect(record.unobserved).toEqual(["sub"]);    // ...and the hub now says so
  const rendered = renderTurns([record], 120, Date.now()).map(line => line.map(span => span.text).join("")).join("\n");
  expect(rendered).toContain("sub (changed, contents unobserved)");
  expect(rendered).not.toMatch(/\b0 files\b(?!:)/);
});

test("AC1: a clean turn, and a turn that edits only a top-level file, record no unobserved submodule", async () => {
  const { root } = workspace();
  const h = await hub(root);
  const idle = await runTurn(h, "idler", () => {});
  const top = await runTurn(h, "toper", () => writeFileSync(join(root, "top.md"), "two\n"));
  expect(turnsDb(h).get(idle)!.unobserved).toEqual([]);
  expect(turnsDb(h).get(top)).toMatchObject({ changed: ["top.md"], unobserved: [] });
});

test("AC1: a turn that edits a file and a submodule lists both, and the file is still the only restorable one", async () => {
  const { root } = workspace();
  const h = await hub(root);
  const id = await runTurn(h, "both", () => { writeFileSync(join(root, "top.md"), "two\n"); writeFileSync(join(root, "sub", "f.md"), "edited\n"); });
  expect(turnsDb(h).get(id)).toMatchObject({ changed: ["top.md"], unobserved: ["sub"] });
});

test("AC4: without .gitmodules a turn makes exactly the git calls it made before the submodule check, and with one it makes exactly one more", async () => {
  // A counting `git` first on PATH: the daemon and the hub's own git calls all go through it, so the count is the real per-turn cost.
  const count = async (withSubmodule: boolean) => {
    const { top, root } = workspace(withSubmodule);
    const real = Bun.spawnSync(["which", "git"]).stdout.toString().trim();
    const bin = join(top, "bin"), log = join(top, "git-calls.log");
    mkdirSync(bin); writeFileSync(log, "");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`); chmodSync(join(bin, "git"), 0o755);
    const h = await hub(root);
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before}`;
    cleanups.push(() => { process.env.PATH = before; });
    try {
      writeFileSync(log, ""); // from here on: one turn
      await runTurn(h, `peer${withSubmodule ? "s" : "p"}`, () => writeFileSync(join(root, "top.md"), "two\n"));
    } finally { process.env.PATH = before; }
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return { calls, status: calls.filter(line => / status( |$)/.test(line) && line.includes("--porcelain=v2") && line.includes("--ignore-submodules=none")) };
  };
  const plain = await count(false), withSub = await count(true);
  expect(plain.status).toHaveLength(0);                                 // D4: no .gitmodules, no status probe
  expect(withSub.status).toHaveLength(1);                               // one probe per turn end, not per snapshot, and never at the turn's start
  expect(withSub.calls.length - plain.calls.length).toBe(1);            // everything else identical: the probe is the only extra call
});

test("AC2: a declared path inside a submodule gets the notice at propose and at accept, and nothing is refused", async () => {
  const { root } = workspace();
  const h = await hub(root, { snapshots: false });
  const proposed = await h.op("hub_task_propose", { title: "edit the sub notes", class: "implement", owner: "claude", refs: { paths: ["sub/f.md", "top.md"] }, plan: { paths: ["sub/deep/x.md"], sections: ["sub/f.md#intro"] } });
  expect(proposed.ok, proposed.error).toBe(true);
  expect(proposed.text).toContain("inside submodule sub: facts, overlap and undo do not observe it");
  expect(proposed.text!.match(/inside submodule sub:/g)).toHaveLength(1); // once per submodule, not per path
  expect(proposed.text).not.toContain("top.md");
  const id = Number(/task #(\d+)/.exec(proposed.text!)![1]);
  // The owner's accept carries the notice again, and the task is accepted, not refused.
  const accepted = await h.op("hub_task_accept", { id, plan: { paths: ["sub/f.md"] } }); // the console user may accept for an owner that is not attached
  expect(accepted.ok, accepted.error ?? "").toBe(true);
  expect(accepted.text ?? "").toContain("inside submodule sub: facts, overlap and undo do not observe it");
  const listed = JSON.parse((await h.op("hub_task_list", {})).text!) as { id: number; state: string }[];
  const state = listed.find(task => task.id === id)?.state ?? "missing";
  expect(["in_progress", "proposed"]).toContain(state);
});

test("AC2: each place a task declares a path counts on its own: refs, plan paths, and the file part of a plan section", async () => {
  const { root } = workspace();
  const h = await hub(root, { snapshots: false, profile: "writing" }); // plan sections exist in the document profiles only
  const only = async (fields: Record<string, unknown>) => (await h.op("hub_task_propose", { title: "one place", class: "implement", owner: "claude", ...fields })).text ?? "";
  expect(await only({ refs: { paths: ["sub/f.md"] } })).toContain("inside submodule sub:");
  expect(await only({ refs: { paths: ["top.md"] }, plan: { paths: ["sub/deep/x.md"] } })).toContain("inside submodule sub:");
  expect(await only({ refs: { paths: ["top.md"] }, plan: { sections: ["sub/f.md#intro"] } })).toContain("inside submodule sub:");
  expect(await only({ refs: { paths: ["top.md"] }, plan: { paths: ["top.md"], sections: ["top.md#intro"] } })).not.toContain("submodule");
});

test("AC2: a task that names another repository gets no notice, because this project's .gitmodules does not describe it", async () => {
  const { root } = workspace();
  const h = await hub(root, { snapshots: false });
  const other = await h.op("hub_task_propose", { title: "other repo", class: "implement", owner: "codex", refs: { repo: "owner/elsewhere", paths: ["sub/f.md"] } });
  expect(other.ok, other.error).toBe(true); expect(other.text ?? "").not.toContain("submodule");
});

test("AC2: a submodule declared with an inline comment in .gitmodules still gets the notice", async () => {
  const { root } = workspace();
  writeFileSync(join(root, ".gitmodules"), readFileSync(join(root, ".gitmodules"), "utf8").replace(/path = sub\n/, "path = sub # the notes\n"));
  const h = await hub(root, { snapshots: false });
  const commented = await h.op("hub_task_propose", { title: "edit the sub notes", class: "implement", owner: "claude", refs: { paths: ["sub/f.md"] } });
  expect(commented.ok, commented.error).toBe(true);
  expect(commented.text).toContain("inside submodule sub:");
});

test("AC2: a backlog proposal gets the notice too, and an absolute path inside the project resolves to the same submodule", async () => {
  const { root } = workspace();
  const h = await hub(root, { snapshots: false });
  const backlog = await h.op("hub_task_propose", { title: "later sub work", class: "implement", backlog: true, refs: { paths: [join(root, "sub", "f.md")] } });
  expect(backlog.ok, backlog.error).toBe(true);
  expect(backlog.text).toContain("inside submodule sub:");
});

test("AC2: a path outside every submodule, a project with no submodule, and a path that only shares a prefix get no notice", async () => {
  const { root } = workspace();
  const h = await hub(root, { snapshots: false });
  const outside = await h.op("hub_task_propose", { title: "plain work", class: "implement", owner: "claude", refs: { paths: ["top.md", "subtle/readme.md", "sub.md"] } });
  expect(outside.ok, outside.error).toBe(true); expect(outside.text).not.toContain("submodule");
  const bare = workspace(false), h2 = await hub(bare.root, { snapshots: false });
  const none = await h2.op("hub_task_propose", { title: "plain work", class: "implement", owner: "claude", refs: { paths: ["sub/f.md"] } });
  expect(none.ok, none.error).toBe(true); expect(none.text).not.toContain("submodule");
});

test("AC2: a PII task gets no notice at propose or accept", async () => {
  const { root } = workspace();
  const h = await hub(root, { snapshots: false, piiPaths: ["sub/private/**"] });
  // A path under the PII policy makes the task private: its refs are never echoed to anyone.
  const pii = await h.op("hub_task_propose", { title: "private notes", class: "implement", refs: { paths: ["sub/private/a.md", "sub/f.md"] } });
  expect(pii.ok, pii.error).toBe(true);
  expect(pii.text ?? "").not.toContain("submodule");
  const id = Number(/task #(\d+)/.exec(pii.text!)![1]);
  const accepted = await h.op("hub_task_accept", { id, plan: { paths: ["sub/private/a.md"] } });
  expect(accepted.text ?? accepted.error ?? "").not.toContain("submodule");
  // The same submodule, not private: the notice is there (the control).
  const open = await h.op("hub_task_propose", { title: "public notes", class: "implement", refs: { paths: ["sub/f.md"] } });
  expect(open.text).toContain("inside submodule sub:");
});

test("submodulePaths reads .gitmodules without a git call, resolves a subdirectory project, and ignores what is not the project's", () => {
  const { root } = workspace();
  expect(submodulePaths(repoOf(root)!)).toEqual(["sub"]);
  writeFileSync(join(root, ".gitmodules"), `[submodule "a"]\n\tpath = mods/a\n\turl = x\n[submodule "b"]\n\tpath = "quoted dir/b"\n[submodule "c"]\n\tpath = ../escape\n[submodule "d"]\n\tpath = /abs\n[submodule "e"]\n\tpath = mods/a/\n[submodule "f"]\n\t# path = commented\n`);
  expect(submodulePaths(repoOf(root)!)).toEqual(["mods/a", "quoted dir/b"]);
  // Checked against `git config -f .gitmodules --get-regexp` on this exact file: git reads the same five paths and an empty one for `f`.
  // git's own comment rules (a reviewer's catch on #934): an unquoted # or ; ends the value, a quoted one does not, and blanks around an unquoted value are not part of it.
  writeFileSync(join(root, ".gitmodules"), `[submodule "a"]\n\tpath = sub # a comment\n[submodule "b"]\n\tpath = other ; a comment\n[submodule "c"]\n\tpath = "has # hash"  # and a comment\n[submodule "d"]\n\tpath =   spaced   \n[submodule "e"]\n\tpath = "q\\"uote"\n[submodule "f"]\n\tpath = # nothing\n`);
  expect(submodulePaths(repoOf(root)!)).toEqual(['has # hash', 'other', 'q"uote', 'spaced', 'sub']);
  const top = repoOf(root)!;
  writeFileSync(join(root, ".gitmodules"), `[submodule "a"]\n\tpath = mods/a\n`);
  expect(submodulePaths({ ...top, prefix: "mods/" })).toEqual(["a"]);       // a project inside the repository sees only what is under it, project-relative
  expect(submodulePaths({ ...top, prefix: "other/" })).toEqual([]);
  expect(submodulePaths({ ...top, shadow: true })).toEqual([]);
  const plain = workspace(false);
  expect(submodulePaths(repoOf(plain.root)!)).toEqual([]);
});

async function cli(h: Awaited<ReturnType<typeof hub>>, root: string, ...args: string[]) {
  // `ahub undo` is the person's: a test run from inside an agent session must not inherit that agent's markers (the CLI refuses them by design).
  const env: Record<string, string | undefined> = { ...process.env, AGENTHUB_STATE_DIR: h.stateDir, COLUMNS: "100" };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") && key !== "AGENTHUB_STATE_DIR" && key !== "AGENTHUB_HOME" || ["CODEX_THREAD_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID"].includes(key)) delete env[key];
  const p = Bun.spawn([process.execPath, join(ROOT, "src/cli/main.js"), ...args], { cwd: root, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

test("AC3: undo of a turn that edited only a submodule says its contents cannot be restored, never 'changed no files' or 'already undone'", async () => {
  const { root } = workspace();
  const h = await hub(root);
  const id = await runTurn(h, "editor", () => writeFileSync(join(root, "sub", "f.md"), "edited\n"));
  const dry = await cli(h, root, "undo", id);
  expect(dry.code, dry.err).toBe(0);
  expect(dry.out).toContain("cannot be restored");
  expect(dry.out).toContain("sub");
  expect(dry.out).not.toMatch(/changed no files(?! the hub can restore)/);
  expect(dry.out).toContain("changed no files the hub can restore");
  expect(dry.out).not.toContain("already undone");
  const yes = await cli(h, root, "undo", id, "--yes");
  expect(yes.code, yes.err).toBe(0);
  expect(readFileSync(join(root, "sub", "f.md"), "utf8")).toBe("edited\n"); // nothing inside the submodule was touched
  expect(yes.out).not.toContain("restored to their state");
});

test("AC3: undo of a turn that changed a file and a submodule restores the file and still says the submodule cannot be restored", async () => {
  const { root } = workspace();
  const h = await hub(root);
  const id = await runTurn(h, "both", () => { writeFileSync(join(root, "top.md"), "two\n"); writeFileSync(join(root, "sub", "f.md"), "edited\n"); });
  const yes = await cli(h, root, "undo", id, "--yes");
  expect(yes.code, yes.err).toBe(0);
  expect(readFileSync(join(root, "top.md"), "utf8")).toBe("one\n");
  expect(readFileSync(join(root, "sub", "f.md"), "utf8")).toBe("edited\n");
  expect(yes.out).toContain("restored to their state");
  expect(yes.out).toContain("cannot be restored");
});

test("AC3: undoing a turn again after its files were restored still says the submodule cannot be restored, never only 'already undone'", async () => {
  const { root } = workspace();
  const h = await hub(root);
  const id = await runTurn(h, "both", () => { writeFileSync(join(root, "top.md"), "two\n"); writeFileSync(join(root, "sub", "f.md"), "edited\n"); });
  expect((await cli(h, root, "undo", id, "--yes")).code).toBe(0);
  const again = await cli(h, root, "undo", id);
  expect(again.code, again.err).toBe(0);
  expect(again.out).toContain("cannot be restored");
  expect(again.out).toContain("sub");
  expect(again.out).not.toContain("is already undone");
  // Without a submodule edit the old wording stands (the submodule is clean again first).
  Bun.spawnSync(["git", "-C", join(root, "sub"), "checkout", "--", "f.md"]);
  const plain = await runTurn(h, "plain", () => writeFileSync(join(root, "top.md"), "three\n"));
  expect((await cli(h, root, "undo", plain, "--yes")).code).toBe(0);
  expect((await cli(h, root, "undo", plain)).out).toContain("is already undone");
});

test("AC3: undo of a turn with no submodule edit keeps its old wording exactly", async () => {
  const { root } = workspace();
  const h = await hub(root);
  const quiet = await runTurn(h, "quiet", () => {});
  expect((await cli(h, root, "undo", quiet)).out).toContain("changed no files");
  expect((await cli(h, root, "undo", quiet)).out).not.toContain("submodule");
});

test("a turn recorded before this change, or one git could not answer for, has no unobserved list: unknown is never none", async () => {
  const { root } = workspace();
  const h = await hub(root);
  const id = await runTurn(h, "known", () => {});
  const turns = new Turns(join(h.stateDir, "hub.db")); cleanups.push(() => turns.close());
  expect(turns.unobserved(id)).toEqual([]);
  turns.begin("old#1.1", "old", "a".repeat(40)); turns.end("old#1.1", "b".repeat(40), [], 20); // the pre-change call shape: no list passed
  expect(turns.unobserved("old#1.1")).toBeUndefined();
  expect("unobserved" in turns.get("old#1.1")!).toBe(false);
  expect(renderTurns([turns.get("old#1.1")!], 120, Date.now()).map(line => line.map(span => span.text).join("")).join("\n")).not.toContain("unobserved");
});

test("a probe that git cannot answer, and a turn whose start snapshot failed, record no list at all: unknown is never none", async () => {
  // 1. git's status fails for the submodule probe only (a shim in front of PATH): the turn still ends with its trees, and the list stays unknown.
  const failing = workspace();
  const real = Bun.spawnSync(["which", "git"]).stdout.toString().trim();
  const bin = join(failing.top, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --ignore-submodules=none "*) exit 1;; esac\nexec '${real}' "$@"\n`); chmodSync(join(bin, "git"), 0o755);
  const h = await hub(failing.root);
  const before = process.env.PATH; process.env.PATH = `${bin}:${before}`;
  let id: string;
  try { id = await runTurn(h, "blind", () => writeFileSync(join(failing.root, "sub", "f.md"), "edited\n")); } finally { process.env.PATH = before; }
  const record = turnsDb(h).get(id)!;
  expect(record.end_tree).toBeTruthy();
  expect("unobserved" in record).toBe(false);
  expect(turnsDb(h).unobserved(id)).toBeUndefined();
  // 2. the turn's start snapshot failed: its trees are unknown, so nothing about the turn is claimed, this list included.
  const { root } = workspace();
  let failNext = false;
  const h2 = await hub(root, { snapshot: (repo, budget) => { if (failNext) { failNext = false; return undefined; } return snapshot(repo, budget); } });
  failNext = true;
  const noStart = await runTurn(h2, "nostart", () => writeFileSync(join(root, "sub", "f.md"), "edited\n"));
  const unknown = turnsDb(h2).get(noStart)!;
  expect(unknown.start_tree).toBeNull();
  expect("unobserved" in unknown).toBe(false);
});

test("a snapshot of a project with a submodule is unchanged by the submodule check: it never reads or writes the submodule", () => {
  const { root } = workspace();
  const r = repoOf(root)!, before = snapshot(r)!;
  writeFileSync(join(root, "sub", "f.md"), "edited\n");
  expect(snapshot(r)).toBe(before);                 // the contents are invisible to snapshots, which is the whole point of naming them
  expect(existsSync(join(root, "sub", "f.md"))).toBe(true);
});
