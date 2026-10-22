import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

// #711 change 4 (task #380): the real `ahub review` process, run as an agent shell and as the person, against a real daemon. The refusal and the authority are unchanged;
// only an agent shell is told why it counts as an agent and where to act as the person.
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION"];
async function cli(root: string, args: string[], markers: Record<string, string> = {}) {
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify(markers)}, { COLUMNS: "200", AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))} });
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function rig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-review-cli-"))), stateDir = join(root, ".agenthub/state");
  mkdirSync(join(root, ".agenthub"), { recursive: true }); mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  const board = new Board(join(stateDir, "hub.db"));
  const task = board.propose("user", { title: "needs the person", class: "implement" });
  board.update(task.id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: "user" });
  board.update(task.id, "codex", "done", { state: "in_review" });
  board.close();
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
  cleanup.push(async () => { await daemon.stop(); rmSync(root, { recursive: true, force: true }); });
  return { root, id: task.id };
}

test("an agent shell is refused the person's review and told why, with the console path; the refusal is unchanged (#711 change 4)", async () => {
  const { root, id } = await rig();
  const out = await cli(root, ["review", String(id), "approved", "looks right"], { AGENTHUB_PEER_ID: "claude", CLAUDECODE: "1" });
  expect(out.code).toBe(1);
  expect(out.stderr).toContain(`only its reviewer (user) or the console user can do that`);       // the hub's own refusal, as before
  expect(out.stderr).toContain('This shell runs as agent "claude" (AGENTHUB_PEER_ID and CLAUDECODE are set), not as you.');
  expect(out.stderr).toContain(`use the ahub console: Tasks, select #${id}, r.`);
  expect(out.stdout).toBe("");
});

test("the person's own terminal approves the same task and gets no cause line; the agent's refusal changed nothing (#711 change 4)", async () => {
  const { root, id } = await rig();
  const refused = await cli(root, ["review", String(id), "approved"], { AGENTHUB_PEER_ID: "codex" });
  expect(refused.code).toBe(1);
  const person = await cli(root, ["review", String(id), "approved", "lgtm"]);                       // no agent markers: the console identity
  expect(person.code, person.stderr).toBe(0);
  expect(person.stderr).not.toContain("This shell runs as agent");
  expect(person.stdout).toMatch(new RegExp(`#${id}`));
  // a person-run refusal (the task is no longer in review) is the hub's text only: no agent cause line for the console identity
  const again = await cli(root, ["review", String(id), "approved"]);
  expect(again.code).toBe(1); expect(again.stderr).not.toContain("This shell runs as agent");
});

test("an agent shell refused something that is not person-only gets no cause line (#711 change 4)", async () => {
  const { root } = await rig();
  const out = await cli(root, ["review", "99999", "approved"], { AGENTHUB_PEER_ID: "claude", CLAUDECODE: "1" });
  expect(out.code).toBe(1);
  expect(out.stderr).not.toContain("This shell runs as agent");
});
