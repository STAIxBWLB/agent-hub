import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { readAllTasks } from "../src/cli/board-read.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const MAIN = join(import.meta.dir, "../src/cli/main.ts");

async function hub(count: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-board-paged-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, ".agenthub", "state"); mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  const seed = new Board(join(stateDir, "hub.db"));
  try { for (let index = 0; index < count; index++) seed.propose("user", { title: `board fixture ${index}`, class: "implement" }); }
  finally { seed.close(); }
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, notifier: () => {}, config: { ...DEFAULT_CONFIG,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
    research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false } } });
  cleanup.push(() => daemon.stop());
  return { root, stateDir };
}

/** The real `ahub` entry under an agent identity (codex), as a shell inside an agent session runs it. */
async function ahub(r: { root: string; stateDir: string }, args: string[], person = false) {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "QWEN_CODE", "QWEN_CODE_SESSION_ID", "KIMI_CODE"].includes(key)) delete env[key];
  Object.assign(env, { AGENTHUB_HOME: join(r.root, "home"), COLUMNS: "200", ...(person ? {} : { AGENTHUB_PEER_ID: "codex", AGENTHUB_STATE_DIR: r.stateDir, AGENTHUB_PROJECT_DIR: r.root }) });
  const child = Bun.spawn([process.execPath, MAIN, ...args], { cwd: r.root, env: env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test("ahub board under an agent identity reads every page, in id order, and says how many tasks there are (#1083)", async () => {
  const r = await hub(230); // more than one 200-row page
  const result = await ahub(r, ["board", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  const rows = JSON.parse(result.stdout) as { id: number; title: string; flowRevision: number }[];
  expect(rows).toHaveLength(230);
  expect(rows.map(row => row.id)).toEqual(Array.from({ length: 230 }, (_, i) => i + 1));
  expect(rows[0]).toHaveProperty("flowRevision"); // full rows, not compact ones
  const text = await ahub(r, ["board"]);
  expect(text.code, text.stderr).toBe(0);
  expect(text.stdout).not.toContain("no tasks");
  expect(text.stdout).toContain("230 tasks");
}, 180_000);

test("ahub board --columns under an agent identity renders the columns instead of throwing on the paged reply (#1083)", async () => {
  const r = await hub(230);
  const result = await ahub(r, ["board", "--columns", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  const model = JSON.parse(result.stdout);
  expect(model.tasks).toHaveLength(230);
  expect(Array.isArray(model.columns)).toBe(true);
  const plain = await ahub(r, ["board", "--columns"]);
  expect(plain.code, plain.stderr).toBe(0);
  expect(plain.stdout).not.toContain("tasks.map");
}, 180_000);

test("the person's console still gets the same board as before (#1083)", async () => {
  const r = await hub(30);
  const result = await ahub(r, ["board", "--json"], true);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).map((row: { id: number }) => row.id)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
});

test("readAllTasks reads both reply shapes, follows the cursor to the end and refuses a stuck cursor or a malformed reply with a next step (#1083)", async () => {
  const board = Array.from({ length: 450 }, (_, i) => ({ id: i + 1 }));
  const paged = async (args: Record<string, unknown>) => {
    const after = typeof args.cursor === "string" ? Number(args.cursor) : 0, page = board.slice(after, after + (args.limit as number));
    return JSON.stringify({ tasks: [...page].reverse(), total: board.length, ...(after + page.length < board.length ? { next: String(after + page.length) } : {}) });
  };
  expect((await readAllTasks(paged, {})).map(row => row.id)).toEqual(board.map(row => row.id));
  expect(await readAllTasks(async () => JSON.stringify(board.slice(0, 3)), {})).toEqual(board.slice(0, 3)); // an older hub's bare array
  await expect(readAllTasks(async () => JSON.stringify({ tasks: [{ id: 1 }], total: 9, next: "1" }), {})).rejects.toThrow("did not advance");
  await expect(readAllTasks(async () => JSON.stringify({ unexpected: true }), {})).rejects.toThrow("upgrade or restart the hub");
});
