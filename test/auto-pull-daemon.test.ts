import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";

// #785 P1c through the real path: a started daemon that loads config from the project's four files, the person turning tasks.auto_pull on with
// `settings_set` over the control socket (the same call `ahub settings set` makes), a planner approving a review with hub_review, and the board read back.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

class Attached extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}

async function fixture(local: unknown = undefined, committed: Record<string, unknown> = {}, attach?: string) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-auto-pull-daemon-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const git = (...args: string[]) => { const result = hubGitSync(["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" }); expect(result.status, result.stderr).toBe(0); };
  const shared = { batch_ms: 0, roster: { claude: true, codex: true, kimi: false, qwen: false, jcode: false, pi: false, local: false }, roles: { claude: ["planner"], codex: ["implementer"] },
    memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, research: { enabled: false }, snapshots: { enabled: false }, approvals: { notify: false },
    pi: { enabled: false, auto_start: false }, coordination: "advisory", tasks: { wip_limits: { codex: 1 }, ...(committed.tasks as object | undefined) }, task_sweep: { enabled: false, interval_s: 30 } };
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify(shared));
  if (local !== undefined) writeFileSync(join(dir, ".agenthub/config.local.json"), JSON.stringify(local));
  writeFileSync(join(dir, ".agenthub/routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"'));
  writeFileSync(join(dir, "example.txt"), "initial\n");
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml", "example.txt"); git("commit", "-qm", "fixture baseline");
  // Two tasks on the board before the hub starts: codex's task in review, and a backlog card reserved for codex.
  mkdirSync(state, { recursive: true });
  const board = new Board(join(state, "hub.db"));
  let busy = board.propose("user", { title: "codex in review", class: "implement", backlog: true, planner: "claude" });
  busy = board.update(busy.id, "user", "backlog pulled", { state: "proposed", owner: "codex", reviewer: "claude" });
  busy = board.update(busy.id, "codex", "accepted", { state: "in_progress" });
  busy = board.update(busy.id, "codex", "done", { state: "in_review" });
  const reserved = board.propose("user", { title: "reserved ready card", class: "implement", backlog: true, planner: "claude", reserved: "codex" });
  board.close();
  const daemon = await startDaemon({ cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, notifier: () => {}, researchGraceMs: 1 });
  cleanup.push(() => daemon.stop());
  // The reserved peer must be attached for the existing planner-pull admission to accept it; an unattached one is refused, which the first test above relies on.
  if (attach) { const peer = new Attached(attach); daemon.bus.add(peer); await peer.start(); }
  const console_ = await ControlClient.connect(state, { role: "console" }); cleanup.push(() => console_.close());
  const planner = await ControlClient.connect(state, { role: "tools", peer: "claude" }); cleanup.push(() => planner.close());
  const row = async (key: string) => (await console_.request({ t: "settings_get" })).rows.find((item: { key: string }) => item.key === key);
  const card = async () => { const board = new Board(join(state, "hub.db")); try { return board.get(reserved.id)!; } finally { board.close(); } };
  const approve = () => planner.request({ t: "task", op: "hub_review", args: { id: busy.id, verdict: "approved", note: "fine" } });
  const log = () => existsSync(join(state, "hub.log")) ? readFileSync(join(state, "hub.log"), "utf8") : "";
  return { dir, state, daemon, console_, planner, row, card, approve, busy, reserved, log };
}

test("a real daemon: auto_pull is off by default (an approval pulls nothing), and a person turns it on live over the control socket into the machine-local file only", async () => {
  const f = await fixture();
  const initial = await f.row("tasks.auto_pull");
  expect(initial).toMatchObject({ key: "tasks.auto_pull", value: false });
  expect(initial.applies).toBe("live");

  // Off: the approval frees codex's slot, and the reserved card stays in the backlog.
  const first = await f.approve();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  expect((await f.card()).state).toBe("backlog");

  // On, live, with no restart: set it through the real settings path.
  const set = await f.console_.request({ t: "settings_set", key: "tasks.auto_pull", value: true, reason: "dogfood" });
  expect(set.ok, JSON.stringify(set)).toBe(true);
  expect((await f.row("tasks.auto_pull")).value).toBe(true);
  expect(JSON.parse(readFileSync(join(f.dir, ".agenthub/config.local.json"), "utf8")).tasks.auto_pull).toBe(true); // machine-local file, never the committed config.json
  expect(JSON.parse(readFileSync(join(f.dir, ".agenthub/config.json"), "utf8")).tasks.auto_pull).toBeUndefined();

});

test("a real daemon started with auto_pull in the untracked config.local.json: approving the review pulls the reserved card, as the hub for the planner, with the reason in history and hub.log", async () => {
  const f = await fixture({ tasks: { auto_pull: true } }, {}, "codex");
  expect(await f.row("tasks.auto_pull")).toMatchObject({ value: true });
  const approved = await f.approve();
  expect(approved.ok, JSON.stringify(approved)).toBe(true);
  let card = await f.card();
  for (let i = 0; i < 100 && card.state === "backlog"; i++) { await new Promise(resolve => setTimeout(resolve, 20)); card = await f.card(); }
  expect(card.state).toBe("proposed");
  const pull = card.history.find(entry => entry.event === "backlog pulled")!;
  expect(pull).toMatchObject({ by: "hub", planner: "claude" });
  expect(pull.note).toContain("auto_pull: capacity released for codex; hub acted for planner claude");
  expect(card.owner).toBe("codex"); // routed to the peer it was reserved for, through the existing planner-pull path
}, 20_000);

test("a real daemon: auto_pull set in the committed config.json is ignored, with a log line, so a cloned repository cannot start work on its own", async () => {
  const f = await fixture(undefined, { tasks: { auto_pull: true } });
  expect(await f.row("tasks.auto_pull")).toMatchObject({ value: false });
  expect((await f.approve()).ok).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 400));
  expect((await f.card()).state).toBe("backlog");
  expect(f.log()).toContain("tasks.auto_pull");
});
