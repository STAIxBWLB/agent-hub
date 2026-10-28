import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { dogfoodScorecard, source } from "../src/hub/dogfood.ts";
import { dogfoodTasks } from "../src/hub/dogfood-read.ts";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";
import { personEnv } from "../src/hub/child-process.ts";
import { realPath } from "../src/hub/project.ts";

// agent-hub#901 through the real daemon and the real `ahub task claim`: the daemon's own check lookup supplies the key, and only the console may record a verdict.
const ENTRY = join(import.meta.dir, "../src/cli/main.js");
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (condition: () => boolean, what: string) => { for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(10); expect(condition(), what).toBe(true); };

async function fixture(check: string) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-claims-daemon-"))), stateDir = join(root, ".agenthub/state");   // where the CLI looks for the hub
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(stateDir, { recursive: true });
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, profile: "research", batch_ms: 0, checks: { ...DEFAULT_CONFIG.checks, fact_check: check }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { enabled: false, keep: 1 } } });
  cleanups.push(() => daemon.stop());
  const board = new Board(join(stateDir, "hub.db")); cleanups.push(() => board.close());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
  const op = async (name: string, args: unknown) => await client.request({ t: "task", op: name, args }) as { ok: boolean; text?: string; error?: string };
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, ENTRY, "--project", root, ...args], { cwd: root, env: { ...personEnv(process.env), COLUMNS: "100" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  return { root, stateDir, daemon, board, client, op, cli };
}

test("the daemon's own check lookup supplies the key: a fact_check task's check entries carry fact_check, and an unrelated class's carry its own key or none", async () => {
  const f = await fixture(`echo "citations: 4 declared keys, 1 missing"; exit 1`);
  const proposed = await f.op("hub_task_propose", { title: "Check claims", class: "fact_check", owner: "claude", plan: { paths: ["r.md"], claims: ["a", "b"] } });
  expect(proposed.ok, proposed.error).toBe(true);
  const id = Number(/task #(\d+)/.exec(proposed.text!)![1]);
  expect((await f.op("hub_task_accept", { id })).ok).toBe(true);
  const done = await f.op("hub_task_done", { id, summary: "checked" });
  expect(done.ok, done.error).toBe(true);
  await until(() => f.board.get(id)!.history.some(h => h.event === "check failed"), "the check result");
  expect(f.board.get(id)!.history.findLast(h => h.event === "check failed")).toMatchObject({ by: "hub", checkKey: "fact_check", missingKeys: 1 });
});

test("ahub task claim records a verdict through the daemon, prints the slot and the verdict and never a claim, and the scorecard reads it", async () => {
  const f = await fixture("true");
  const proposed = await f.op("hub_task_propose", { title: "Check claims", class: "fact_check", owner: "claude", plan: { paths: ["r.md"], claims: ["PRIVATE_CLAIM_TEXT", "second"] } });
  const id = Number(/task #(\d+)/.exec(proposed.text!)![1]);
  const claimed = await f.cli("task", "claim", String(id), "2", "unsupported", "--model", "m-1", "--model-said", "supported");
  expect(claimed.code, claimed.err).toBe(0);
  expect(claimed.out.trim()).toBe(`task #${id}: claim 2 recorded as unsupported (model m-1, model said supported)`);
  expect(claimed.out + claimed.err).not.toContain("PRIVATE_CLAIM_TEXT");
  expect(f.board.get(id)!.history.at(-1)).toMatchObject({ by: "user", event: "claim verdict", claim: { slot: 2, verdict: "unsupported", model: "m-1", modelVerdict: "supported" } });
  const card = dogfoodScorecard({ since: 0, until: Date.now() + 60_000, projectProfile: source("research"), tasks: dogfoodTasks(join(f.stateDir, "hub.db")), events: source([]), prs: source([]), log: source([]), features: source([]) });
  const row = card.profile!.rows.find(r => r.profile === "research" && r.alias === null)!;
  expect(row.research!.claims.perTask[0]!.claims![1]).toEqual({ slot: 2, modelLabel: "m-1", personVerdict: "unsupported", agreement: false });
  // A plain verdict without optional flags.
  const plain = await f.cli("task", "claim", String(id), "1", "supported");
  expect(plain.code, plain.err).toBe(0); expect(plain.out.trim()).toBe(`task #${id}: claim 1 recorded as supported`);
});

test("ahub task claim refuses a bad slot, a bad word, a stray operand and a missing argument before any write, with its usage line", async () => {
  const f = await fixture("true");
  const proposed = await f.op("hub_task_propose", { title: "Check claims", class: "fact_check", owner: "claude", plan: { paths: ["r.md"], claims: ["a"] } });
  const id = Number(/task #(\d+)/.exec(proposed.text!)![1]);
  for (const args of [[String(id), "1"], [String(id), "1", "true"], ["x", "1", "supported"], [String(id), "0", "supported"], [String(id), "1", "supported", "extra"]]) {
    const r = await f.cli("task", "claim", ...args);
    expect(r.code, args.join(" ")).toBe(1); expect(r.err, args.join(" ")).toContain("usage: ahub task claim");
  }
  const refused = await f.cli("task", "claim", String(id), "5", "supported");        // slot 5 of 1 declared claim: the daemon refuses
  expect(refused.code).toBe(1); expect(refused.err).toContain("declared claim");
  expect(f.board.get(id)!.history.some(h => h.event === "claim verdict")).toBe(false);
});

test("only the console may record a verdict: a peer's task op is refused, and the CLI is a person command an agent shell and a live test never run", async () => {
  const f = await fixture("true");
  const proposed = await f.op("hub_task_propose", { title: "Check claims", class: "fact_check", owner: "claude", plan: { paths: ["r.md"], claims: ["a"] } });
  const id = Number(/task #(\d+)/.exec(proposed.text!)![1]);
  const peer = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: false }); cleanups.push(() => peer.close());
  const refused = await peer.request({ t: "task", op: "claim_verdict", args: { id, slot: 1, verdict: "supported" } }) as { ok: boolean; error?: string };
  expect(refused.ok).toBe(false); expect(refused.error).toContain("console command");
  expect(f.board.get(id)!.history.some(h => h.event === "claim verdict")).toBe(false);
  expect(classifyPeerCommand("task", ["claim", String(id), "1", "supported"])).toBe("console");
  expect(liveTestRefusal("task", ["claim", String(id), "1", "supported"])).toBe(true);
});
