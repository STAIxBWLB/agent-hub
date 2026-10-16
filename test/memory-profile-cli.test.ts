import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, memoryProjectKey, migrate } from "@staix/agent-mem";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { memoryCommand, goalCommand } from "../src/cli/memory.ts";
import { realPath } from "../src/hub/project.ts";

const dirs: string[] = [], closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const value = realPath(mkdtempSync(join(tmpdir(), "ahub-profile-cli-"))); dirs.push(value); return value; };
const G = "d".repeat(32);
function fixture() {
  const home = temp(), cwd = temp(); mkdirSync(join(cwd, ".agenthub")); writeFileSync(join(cwd, ".agenthub", "config.json"), "{}\n");
  const project = memoryProjectKey(cwd), store = new MemoryStore({ home, deferPromotions: true });
  closes.push(() => store.close());
  const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "selected profile note", about: [] });
  return { home, cwd, project, store, id, memoryDir: store.dir };
}
async function selectGeneration(home: string, memoryDir: string) {
  await migrate({ memoryDir, generation: G, mode: "apply", authorizedPerson: true, tty: true });
  const store = new MemoryStore({ home, deferPromotions: true }); closes.push(() => store.close()); return store;
}

test("memory and goal person output reports the actual selected profile while JSON lists remain arrays", async () => {
  const f = fixture();
  expect(await memoryCommand(["list"], f.cwd, { store: f.store, person: true })).toContain("memory profile: shared-v1");
  expect(await goalCommand(["list"], f.cwd, { store: f.store, person: true })).toContain("memory profile: shared-v1");
  const memories = JSON.parse(await memoryCommand(["list", "--json"], f.cwd, { store: f.store, person: true }));
  const goals = JSON.parse(await goalCommand(["list", "--json"], f.cwd, { store: f.store, person: true }));
  expect(Array.isArray(memories)).toBe(true); expect(memories[0]?.id).toBe(f.id); expect(Array.isArray(goals)).toBe(true);
});

test("generation CLI receipts include nonzero skipped legacy rows and default-open goals close cleanly", async () => {
  const f = fixture();
  appendFileSync(join(f.memoryDir, "log", `${f.store.machine.id}.jsonl`), "malformed legacy line\n");
  const store = await selectGeneration(f.home, f.memoryDir);
  expect(await memoryCommand(["list"], f.cwd, { store, person: true })).toContain(`memory profile: generation ${G}; skipped malformed legacy rows: 1`);
  expect(await goalCommand(["list"], f.cwd, { store, person: true })).toContain(`memory profile: generation ${G}; skipped malformed legacy rows: 1`);
  const previous = process.env.AMEM_HOME; process.env.AMEM_HOME = f.memoryDir;
  try {
    expect(await memoryCommand(["list"], f.cwd, { person: true })).toContain(`memory profile: generation ${G}`);
    expect(await goalCommand(["list"], f.cwd, { person: true })).toContain(`memory profile: generation ${G}; skipped malformed legacy rows: 1`);
    expect(Array.isArray(JSON.parse(await memoryCommand(["list", "--json"], f.cwd)))).toBe(true);
  } finally { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; }
});

test("injected stale-profile stores refuse rather than silently falling back and retain caller close ownership", async () => {
  const f = fixture(); await selectGeneration(f.home, f.memoryDir);
  await expect(memoryCommand(["list"], f.cwd, { store: f.store, person: true })).rejects.toThrow("memory profile unavailable");
  await expect(goalCommand(["list"], f.cwd, { store: f.store, person: true })).rejects.toThrow("memory profile unavailable");
  expect(f.store.get(f.id)?.text).toBe("selected profile note");
});

test("invalid selected profile refuses before a default CLI open can create legacy storage effects", async () => {
  const home = temp(), cwd = temp(), memoryDir = join(home, "memory"); mkdirSync(memoryDir);
  writeFileSync(join(memoryDir, "profile.json"), JSON.stringify({ schema: "agent-mem.profile/v1", kind: "generation", generation: G }));
  const before = readFileSync(join(memoryDir, "profile.json"));
  const previous = process.env.AMEM_HOME; process.env.AMEM_HOME = memoryDir;
  try {
    await expect(memoryCommand(["list"], cwd)).rejects.toThrow();
    expect(existsSync(join(memoryDir, "machine.json"))).toBe(false);
    expect(existsSync(join(memoryDir, "index.db"))).toBe(false);
    expect(readFileSync(join(memoryDir, "profile.json"))).toEqual(before);
  } finally { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; }
});


test("profile-check is person-only and decay JSON alone carries additive profile metadata", async () => {
  expect(classifyPeerCommand("memory", ["profile-check"])).toBe("console");
  expect(classifyPeerCommand("memory", ["profile-check", "--json"])).toBe("console");
  expect(classifyPeerCommand("memory", ["--json", "profile-check"])).toBe("console");
  const f = fixture();
  const result = JSON.parse(await memoryCommand(["decay", "--json"], f.cwd, { store: f.store, person: true }));
  expect(result.memoryProfile).toMatchObject({ profile: "shared-v1", state: "ready" });
  expect(Array.isArray(result.candidates)).toBe(true);
  expect(JSON.parse(await memoryCommand(["list", "--json"], f.cwd, { store: f.store, person: true }))[0]?.memoryProfile).toBeUndefined();
});


test("agent memory and goal reads reveal only profile kind and generation prefix, never person-only skip totals", async () => {
  const f = fixture();
  appendFileSync(join(f.memoryDir, "log", `${f.store.machine.id}.jsonl`), "malformed legacy line\n");
  const store = await selectGeneration(f.home, f.memoryDir);
  for (const args of [["list"], ["search", "selected"], ["show", f.id]]) {
    const text = await memoryCommand(args, f.cwd, { store, person: false });
    expect(text).toContain(`memory profile: generation ${G.slice(0, 8)}`);
    expect(text).not.toContain(G); expect(text).not.toContain("skipped"); expect(text).not.toContain(f.memoryDir);
  }
  const goals = await goalCommand(["list"], f.cwd, { store, person: false });
  expect(goals).toContain(`memory profile: generation ${G.slice(0, 8)}`);
  expect(goals).not.toContain(G); expect(goals).not.toContain("skipped");
  const rows = JSON.parse(await memoryCommand(["list", "--json"], f.cwd, { store, person: false }));
  expect(Array.isArray(rows)).toBe(true); expect(rows[0]?.memoryProfile).toBeUndefined();
  await expect(memoryCommand(["decay", "--json"], f.cwd, { store, person: false })).rejects.toThrow("person authority");
  expect(await memoryCommand(["list"], f.cwd, { store, person: true })).toContain(`generation ${G}; skipped malformed legacy rows: 1`);
});

test("direct memory wrapper defaults marked agent sessions to the reduced profile projection", async () => {
  const f = fixture(), store = await selectGeneration(f.home, f.memoryDir), previous = process.env.AGENTHUB_PEER_ID;
  process.env.AGENTHUB_PEER_ID = "codex";
  try {
    const text = await memoryCommand(["list"], f.cwd, { store });
    expect(text).toContain(`generation ${G.slice(0, 8)}`); expect(text).not.toContain(G);
  } finally { if (previous === undefined) delete process.env.AGENTHUB_PEER_ID; else process.env.AGENTHUB_PEER_ID = previous; }
});
