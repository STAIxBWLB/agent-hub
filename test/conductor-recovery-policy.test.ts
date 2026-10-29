import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";
import { captureRecoveryPolicy } from "../src/hub/recovery-policy.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "../src/hub/db-timeout.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";

function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-recovery-policy-")));
  const stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  const git = hubGitSync(["init", "-q", root], { encoding: "utf8" });
  if (git.status !== 0) throw new Error("fixture git init failed");
  let config: Record<string, unknown> = { roles: { codex: ["conductor", "implementer"] } };
  const write = (next: Record<string, unknown>) => { config = next; writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify(config)); };
  write(config);
  const db = new Database(join(stateDir, "hub.db"));
  db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
  db.run("CREATE TABLE tasks (id INTEGER PRIMARY KEY, state TEXT, owner TEXT, reviewer TEXT, signals TEXT, title TEXT)");
  const task = (id: number, owner: string, signals: string[] = [], reviewer: string | null = null, state = "in_progress") =>
    db.query("INSERT OR REPLACE INTO tasks VALUES (?, ?, ?, ?, ?, ?)").run(id, state, owner, reviewer, JSON.stringify(signals), "public fixture task");
  const project = { root, stateDir, id: "recovery-policy-fixture" };
  return { root, stateDir, db, project, task, write, config: () => config,
    capture: (peer = "codex") => captureRecoveryPolicy(project, peer, loadConfig(root)),
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

const refused = "conductor recovery authority unavailable; the person runs it in ahub console or a terminal";

test("conductor recovery policy ignores unrelated public writes and other actors' PII", () => {
  const f = fixture();
  try {
    f.task(1, "codex");
    const before = f.capture();
    f.task(2, "claude", ["pii_path"]);
    f.db.query("UPDATE tasks SET title = ? WHERE id = 1").run("public title changed during recovery wait");
    expect(f.capture()).toEqual(before);
    f.task(3, "claude", ["pii"], "codex");
    expect(() => f.capture()).toThrow(refused);
  } finally { f.close(); }
});

test("conductor recovery policy refuses fresh actor-private tasks but permits closed ones", () => {
  const f = fixture();
  try {
    const before = f.capture();
    f.task(1, "codex", ["pii_path"]);
    expect(() => f.capture()).toThrow(refused);
    f.task(1, "codex", ["pii_path"], null, "approved");
    expect(f.capture()).toEqual(before);
    f.task(2, "claude", ["pii_path"], "codex");
    expect(() => f.capture()).toThrow(refused);
  } finally { f.close(); }
});

test("conductor recovery privacy scan fails closed on unknown signals and bounded overflow", () => {
  const f = fixture();
  try {
    f.task(1, "codex");
    for (const signals of ["not json", "{}", JSON.stringify(["x".repeat(65536)])]) {
      f.db.query("UPDATE tasks SET signals = ? WHERE id = 1").run(signals);
      expect(() => f.capture()).toThrow(refused);
    }
    f.db.query("UPDATE tasks SET signals = '[]', state = NULL WHERE id = 1").run();
    expect(() => f.capture()).toThrow(refused);
    f.db.query("DELETE FROM tasks").run();
    f.db.transaction(() => { for (let id = 1; id <= 4097; id++) f.task(id, "codex"); })();
    expect(() => f.capture()).toThrow(refused);
  } finally { f.close(); }
});

test("conductor recovery policy rechecks unique role, roster and declared readOnly", () => {
  const f = fixture();
  try {
    const stale = loadConfig(f.root);
    f.write({ roles: { codex: ["implementer"] } });
    expect(() => captureRecoveryPolicy(f.project, "codex", stale)).toThrow(refused);
    f.write({ roles: { codex: ["conductor"], claude: ["conductor"] } });
    expect(() => captureRecoveryPolicy(f.project, "codex", stale)).toThrow(refused);
    f.write({ roles: { codex: ["conductor"] }, roster: { codex: false } });
    expect(() => f.capture()).toThrow(refused);
    f.write({ roles: { "nx-control": ["conductor"] }, adapters: { nx: { transport: "acp", command: "fixture-acp", displayName: "Fixture", roles: ["implementer"], readOnly: "read-only" } }, instances: { "nx-control": { kind: "nx", roles: ["conductor"], readOnly: true } } });
    expect(() => f.capture("nx-control")).toThrow(refused);
  } finally { f.close(); }
});

test("conductor recovery policy rejects unavailable external catalog without importing module code", () => {
  const f = fixture();
  try {
    // Host config with unresolved module provenance cannot authorize offline continuity.
    const config = loadConfig(f.root);
    expect(() => captureRecoveryPolicy(f.project, "codex", { ...config, adapter_modules: [{}] } as unknown as typeof config)).toThrow(refused);
    expect(() => f.capture("unresolved-control")).toThrow(refused);
  } finally { f.close(); }
});

test("conductor recovery policy fingerprints fresh routing and bounded config without database writes", () => {
  const f = fixture();
  try {
    f.task(1, "codex");
    const schema = f.db.query("SELECT sql FROM sqlite_master ORDER BY name").all();
    const rows = f.db.query("SELECT * FROM tasks ORDER BY id").all();
    const before = f.capture();
    writeFileSync(join(f.root, ".agenthub", "routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace('pii = "local_only"', 'pii = "off"'));
    const after = f.capture();
    expect(after.policyDigest).not.toBe(before.policyDigest);
    expect(after.boardDigest).toBe(before.boardDigest);
    expect(f.db.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(f.db.query("SELECT * FROM tasks ORDER BY id").all()).toEqual(rows);
    const config = loadConfig(f.root);
    writeFileSync(join(f.root, ".agenthub", "config.local.json"), " ".repeat(1024 * 1024 + 1));
    expect(() => captureRecoveryPolicy(f.project, "codex", config)).toThrow(refused);
  } finally { f.close(); }
});
