import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { Registry } from "../src/hub/registry.ts";
import { appendRecords, projectKey, taskRecords, type TaskRecord } from "../src/hub/research.ts";
import { buildDataset, datasetInputFor, datasetTask, exportResearchDataset, refuseTarget, UNKNOWN_FAMILY } from "../src/hub/research-dataset.ts";
import { readEvidence } from "../src/hub/research-record.ts";
import { boardWith, cleanDirs, ev, familyOf, iso, minutes, PROJECT, scenarioBoard, scenarioDeliveries, scenarioEvents, taskEvent, tempDir } from "./helpers/research-fixture.ts";

// #1277 AC3: export --dataset writes manifest, tasks and quality files per project, --all covers two registered projects, and the privacy test holds.

const dirs: string[] = [];
afterEach(() => cleanDirs(dirs));
const writer = { version: "test", source: "backfill" as const };
const NOW = minutes(10_000);

/** A home with a hub home inside it, two projects with their own state directories, and records for both. */
function world() {
  const home = tempDir(dirs, "user"), hub = join(home, "hub-home");
  const make = (name: string) => {
    const root = join(home, name); mkdirSync(join(root, ".agenthub", "state"), { recursive: true });
    // A machine-local instance declaration counts only when git confirms the file is untracked, so the project is a repository.
    expect(hubGitSync(["init", "-q"], { cwd: root, encoding: "utf8", timeout: 5000, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).status).toBe(0);
    // The one instance of the scenario is declared here: its family is known only through the project's own config, never from its spelling.
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instances: { "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless" } } }));
    return { root, stateDir: join(root, ".agenthub", "state") };
  };
  return { home, hub, a: make("alpha"), b: make("beta") };
}
function seed(w: ReturnType<typeof world>, project: { root: string; stateDir: string }, id: string, board = scenarioBoard()) {
  boardWith(project.stateDir, board, scenarioDeliveries().map(d => ({ ...d, project: id })));
  const events = scenarioEvents();
  writeFileSync(join(project.stateDir, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  appendRecords(id, taskRecords(events, id, writer, { ...readEvidence(project.stateDir, id), familyOf }), w.hub);
}
const input = (project: { root: string; stateDir: string }, id: string, hub: string) => datasetInputFor({ id, ...project }, hub)!;
const OPTIONS = (home: string) => ({ home, now: () => NOW, hubVersion: "9.9.9" });

test("AC3: a project's dataset has a manifest, tasks.jsonl and quality.json under its hashed directory, with counts, family-only peers and the window", () => {
  const w = world(), out = join(w.home, "out");
  seed(w, w.a, "p_alpha");
  const [result] = exportResearchDataset(out, [input(w.a, "p_alpha", w.hub)], OPTIONS(w.home));
  expect(result!.projectKeyHash).toBe(projectKey("p_alpha"));
  const dir = join(out, projectKey("p_alpha"));
  expect(readdirSync(dir).sort()).toEqual(["manifest.json", "quality.json", "tasks.jsonl"]);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  expect(manifest).toEqual({ schema: "agent-hub.research-dataset/v1", hubVersion: "9.9.9", projectKeyHash: projectKey("p_alpha"), window: { since: null, until: iso(NOW) }, peers: ["claude", "codex", "kimi"], counts: { tasks: 4, approved: 1, cancelled: 3, labels: 0 }, recordedAt: iso(NOW) });
  const tasks = readFileSync(join(dir, "tasks.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as TaskRecord);
  expect(tasks.map(t => [t.task, t.outcome])).toEqual([[1, "approved"], [2, "cancelled"], [3, "cancelled"], [4, "cancelled"]]);
  expect(tasks[0]).toMatchObject({ owners: ["codex"], reviewer: "claude", review: { reviewerFamily: "claude", ownerFamily: "codex" } });
  expect(tasks[2]!.owners).toEqual(["codex"]); // the instance `codex-review` is its family in the dataset
  const quality = JSON.parse(readFileSync(join(dir, "quality.json"), "utf8"));
  expect(quality.schema).toBe("agent-hub.research-quality/v1");
  expect(quality.records).toBe(4);
  for (const f of ["tasks.jsonl", "manifest.json", "quality.json"]) expect(lstatSync(join(dir, f)).mode & 0o777).toBe(0o600);
  expect(lstatSync(dir).mode & 0o777).toBe(0o700);
});

test("AC3: a window keeps the records closed inside it, with the labels of those tasks only", () => {
  const w = world(), out = join(w.home, "out");
  seed(w, w.a, "p_alpha");
  const created = taskRecords(scenarioEvents(), "p_alpha", writer).find(r => r.task === 1)!.createdAt!;
  appendRecords("p_alpha", [{ schema: "agent-hub.research/v2", kind: "label", project: projectKey("p_alpha"), task: 1, createdAt: created, label: "ok", at: iso(NOW), by: "codex-review" }], w.hub);
  const [result] = exportResearchDataset(out, [input(w.a, "p_alpha", w.hub)], { ...OPTIONS(w.home), since: minutes(45) });
  expect(result!.counts).toEqual({ tasks: 2, approved: 0, cancelled: 2, labels: 0 });
  const all = exportResearchDataset(join(w.home, "all"), [input(w.a, "p_alpha", w.hub)], OPTIONS(w.home))[0]!;
  expect(all.counts.labels).toBe(1);
  const rows = readFileSync(join(all.dir, "tasks.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  expect(rows.at(-1)).toMatchObject({ kind: "label", by: "codex" }); // an agent's own label is attributed to its family
});

test("AC3: --all style export covers two registered projects, each in its own hashed directory", () => {
  const w = world(), out = join(w.home, "out");
  seed(w, w.a, "p_alpha"); seed(w, w.b, "p_beta");
  const results = exportResearchDataset(out, [input(w.a, "p_alpha", w.hub), input(w.b, "p_beta", w.hub)], OPTIONS(w.home));
  expect(results.map(r => r.projectKeyHash).sort()).toEqual([projectKey("p_alpha"), projectKey("p_beta")].sort());
  expect(readdirSync(out).sort()).toEqual([projectKey("p_alpha"), projectKey("p_beta")].sort());
  for (const r of results) expect(existsSync(join(r.dir, "manifest.json"))).toBe(true);
});

test("a project that was never researched has no input, and re-exporting replaces the files whole", () => {
  const w = world();
  expect(datasetInputFor({ id: "p_none", ...w.a }, w.hub)).toBeUndefined();
  seed(w, w.a, "p_alpha");
  const out = join(w.home, "out");
  const first = exportResearchDataset(out, [input(w.a, "p_alpha", w.hub)], OPTIONS(w.home))[0]!;
  const before = readFileSync(join(first.dir, "tasks.jsonl"), "utf8");
  exportResearchDataset(out, [input(w.a, "p_alpha", w.hub)], OPTIONS(w.home));
  expect(readFileSync(join(first.dir, "tasks.jsonl"), "utf8")).toBe(before);
  expect(readdirSync(first.dir).some(n => n.endsWith(".tmp"))).toBe(false);
});

test("the target is refused outside the home, at the home itself, inside a project or its state directory, around one, and through a symlink", () => {
  const w = world(), projects = [w.a, w.b];
  const refused = (target: string) => refuseTarget(target, projects, w.home);
  expect(refused(join(w.home, "fine", "deeper"))).toBeUndefined();
  expect(refused(tempDir(dirs, "elsewhere"))).toMatch(/inside your home/);
  expect(refused(w.home)).toMatch(/directory of its own/);
  expect(refused(join(w.a.root, "dataset"))).toMatch(/outside the project/);
  expect(refused(w.a.stateDir)).toMatch(/outside the project/);
  expect(refused(join(w.b.stateDir, "x", "y"))).toMatch(/outside the project/);
  // A directory that contains a project would put the project inside its own dataset.
  mkdirSync(join(w.home, "container", "proj"), { recursive: true });
  expect(refuseTarget(join(w.home, "container"), [{ root: join(w.home, "container", "proj"), stateDir: join(w.home, "container", "proj", "s") }], w.home)).toMatch(/outside the project/);
  // A symlink inside the home that points into a project, or out of the home, does not pass.
  symlinkSync(w.a.root, join(w.home, "link-in"));
  expect(refused(join(w.home, "link-in", "dataset"))).toMatch(/outside the project/);
  const outside = tempDir(dirs, "outside");
  symlinkSync(outside, join(w.home, "link-out"));
  expect(refused(join(w.home, "link-out", "dataset"))).toMatch(/inside your home/);
  // `..` is resolved before the check.
  expect(refused(join(w.home, "fine", "..", "..", "escape"))).toMatch(/inside your home/);
});

test("export refuses a refused target before writing anything, and a project directory that is a symlink", () => {
  const w = world();
  seed(w, w.a, "p_alpha");
  expect(() => exportResearchDataset(join(w.a.root, "dataset"), [input(w.a, "p_alpha", w.hub)], OPTIONS(w.home))).toThrow(/outside the project/);
  expect(existsSync(join(w.a.root, "dataset"))).toBe(false);
  const out = join(w.home, "out"), elsewhere = join(w.home, "elsewhere"); mkdirSync(out); mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(out, projectKey("p_alpha")));
  expect(() => exportResearchDataset(out, [input(w.a, "p_alpha", w.hub)], OPTIONS(w.home))).toThrow(/symbolic link/);
  expect(readdirSync(elsewhere)).toEqual([]);
});

test("the guard covers the project the command ran in as well as the ones exported", () => {
  const w = world();
  seed(w, w.a, "p_alpha");
  expect(() => exportResearchDataset(join(w.b.root, "dataset"), [input(w.a, "p_alpha", w.hub)], OPTIONS(w.home), [w.a, w.b])).toThrow(/outside the project/);
});

// The privacy test: text sits where the real stores hold it (title, detail, journal body, task path refs, profile and role names, peer instance ids, a PII task) and none of it reaches the dataset.
const CANARIES = ["CANARY-TITLE-9f3a", "/Users/secret/patient-records/ward7.txt", "CANARY-BODY-27c1", "CANARY-PROFILE-5d8e", "CANARY-INSTANCE-81bb", "CANARY-NOTE-4e02", "CANARY-ROLE-cc19"];

test("privacy: a PII task, a private envelope and a path-like title leave no title, path or body byte in any dataset file", () => {
  const w = world(), out = join(w.home, "out"), id = "p_canary";
  const events = [
    ...scenarioEvents(),
    // A PII task closed by an instance whose id the person chose, with a profile and a role name.
    taskEvent(100, 7, "proposed", "proposed", { pii: true, profile: "CANARY-PROFILE-5d8e", profileClass: "implement", role: "CANARY-ROLE-cc19" }),
    taskEvent(101, 7, "accepted", "in_progress", { pii: true, owner: "CANARY-INSTANCE-81bb", reviewer: "claude" }),
    taskEvent(102, 7, "done", "in_review", { pii: true, owner: "CANARY-INSTANCE-81bb", reviewer: "claude" }),
    taskEvent(103, 7, "approved", "approved", { pii: true, owner: "CANARY-INSTANCE-81bb", reviewer: "claude" }),
    ev(101, { type: "envelope", id: "priv", from: "CANARY-INSTANCE-81bb", priority: "normal", hop: 0, task: "7", private: true, bytes: 40 }),
    ev(101, { type: "tokens", peer: "CANARY-INSTANCE-81bb", n: 12, attribution: "delivery", task: 7, pii: true }),
    ev(101, { type: "quota", peer: "CANARY-INSTANCE-81bb", windows: [{ id: "5h", used: 3 }], hard: false }),
  ] as ReturnType<typeof scenarioEvents>;
  const board = [...scenarioBoard(),
    { id: 7, title: `CANARY-TITLE-9f3a ${CANARIES[1]}`, history: [
      { at: minutes(102), by: "CANARY-INSTANCE-81bb", event: "done", note: "CANARY-NOTE-4e02", withheld: true, reviewFindings: { head: "c".repeat(40), items: [{ id: "CANARY-NOTE-4e02", pass: "bugs", severity: "nit", disposition: "open" }] } },
      { at: minutes(103), by: "claude", event: "approved", note: "CANARY-NOTE-4e02", reviewerFamily: "claude" },
    ] }];
  boardWith(join(w.a.stateDir), board, [...scenarioDeliveries().map(d => ({ ...d, project: id })), { project: id, task: 7, state: "completed", createdAt: minutes(100), updatedAt: minutes(101), body: "CANARY-BODY-27c1" }]);
  appendRecords(id, taskRecords(events, id, writer, { ...readEvidence(w.a.stateDir, id), familyOf }), w.hub);
  writeFileSync(join(w.a.stateDir, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  const [result] = exportResearchDataset(out, [input(w.a, id, w.hub)], OPTIONS(w.home));
  expect(result!.counts.tasks).toBe(5);
  for (const file of readdirSync(result!.dir)) {
    const text = readFileSync(join(result!.dir, file), "utf8");
    for (const canary of CANARIES) expect(text, `${file} holds ${canary}`).not.toContain(canary);
    expect(text, `${file} holds a path`).not.toContain(w.home);
    expect(text, `${file} holds the project id`).not.toContain(id);
  }
  // The PII task is there as a record of ids and counts: its peer is `unknown` and its findings are withheld.
  const pii = readFileSync(join(result!.dir, "tasks.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)).find(r => r.task === 7);
  expect(pii).toMatchObject({ pii: true, outcome: "approved", owners: [UNKNOWN_FAMILY], review: { findings: null } });
  expect(pii).not.toHaveProperty("profile");
  expect(pii).not.toHaveProperty("role");
  expect(JSON.parse(readFileSync(join(result!.dir, "manifest.json"), "utf8")).peers).toEqual(["claude", "codex", "kimi", UNKNOWN_FAMILY]);
});

test("datasetTask folds peers into families, sums what falls together, and drops the fields that carry a project's own names", () => {
  const base = taskRecords(scenarioEvents(), PROJECT, writer)[0]!;
  const raw: TaskRecord = { ...base, profile: "p", role: "r", roleIdentity: { id: "r", layer: "project", hash: "h" }, sessionRoles: [{ peer: "codex", turn: "t", roles: null }], peers: ["codex", "codex-review", "claude"],
    tokens: { total: 30, byPeer: { codex: 10, "codex-review": 20 }, byAttribution: { delivery: 30 } },
    usage: { codex: { input: 1, output: null, cacheRead: null, total: 5 }, "codex-review": { input: 2, output: null, cacheRead: null, total: null } },
    tooling: { codex: [{ name: "ripwire", version: "1" }], "codex-review": [{ name: "ripwire", version: "1" }, { name: "ponytail", version: null }] } } as TaskRecord;
  const out = datasetTask(raw, familyOf);
  expect(out.tokens).toEqual({ total: 30, byPeer: { codex: 30 }, byAttribution: { delivery: 30 } });
  expect(out.usage).toEqual({ codex: { input: 3, output: null, cacheRead: null, total: 5 } });
  expect(out.peers).toEqual(["claude", "codex"]);
  expect(out.tooling!.codex!.map(a => a.name)).toEqual(["ripwire", "ponytail"]);
  for (const key of ["profile", "profileClass", "role", "roleIdentity", "sessionRoles"]) expect(out).not.toHaveProperty(key);
});

test("buildDataset is pure: nothing is written and the same input gives the same bytes", () => {
  const w = world();
  seed(w, w.a, "p_alpha");
  const a = buildDataset(input(w.a, "p_alpha", w.hub), OPTIONS(w.home)), b = buildDataset(input(w.a, "p_alpha", w.hub), OPTIONS(w.home));
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(existsSync(join(w.home, "out"))).toBe(false);
});

test("the registry-backed input for a registered project reads its own records and events", () => {
  const w = world();
  const previous = process.env.AGENTHUB_HOME; process.env.AGENTHUB_HOME = w.hub;
  try {
    const registry = new Registry(join(w.hub, "registry.db"));
    const project = registry.register(w.a.root, w.a.stateDir);
    registry.close();
    seed(w, project, project.id);
    const got = datasetInputFor(project, w.hub)!;
    expect(got.records.length).toBe(4);
    expect(got.events.length).toBe(scenarioEvents().length);
  } finally { if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});
