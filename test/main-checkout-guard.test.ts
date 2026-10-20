import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { mainCheckoutWarning } from "../src/hub/main-checkout.ts";
import { realPath } from "../src/hub/project.ts";
import { renderStatus } from "../src/cli/output.ts";

const cleanups: (() => unknown)[] = [];
const ok = () => true;
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => { const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env }); expect(r.exitCode).toBe(0); return r.stdout.toString().trim(); };
/** A repository whose default branch is `main` (or what `origin/HEAD` says), with a commit on it. */
function repo(defaultBranch = "main", withOrigin = false) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-checkout-guard-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", defaultBranch); writeFileSync(join(dir, "a"), "a"); git(dir, "add", "a"); git(dir, "commit", "-q", "-m", "init");
  if (withOrigin) {
    git(dir, "update-ref", `refs/remotes/origin/${defaultBranch}`, "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${defaultBranch}`);
  }
  return dir;
}

test("the main checkout warning names a feature branch, and says nothing on the default branch or a detached head (#572 AC3)", () => {
  const dir = repo();
  expect(mainCheckoutWarning(dir, ok)).toBeUndefined();
  git(dir, "switch", "-q", "-c", "fix/feature");
  expect(mainCheckoutWarning(dir, ok)).toBe("the main checkout is on `fix/feature`; move the work to a worktree under .worktrees/");
  git(dir, "switch", "-q", "--detach", "HEAD");
  expect(mainCheckoutWarning(dir, ok)).toBeUndefined();
});

test("the default branch comes from origin/HEAD, falling back to main (#572 AC3)", () => {
  const trunk = repo("trunk", true);
  expect(mainCheckoutWarning(trunk, ok)).toBeUndefined();
  git(trunk, "switch", "-q", "-c", "main");
  expect(mainCheckoutWarning(trunk, ok)).toContain("`main`");
  const plain = repo("develop");
  expect(mainCheckoutWarning(plain, ok)).toContain("`develop`");
  expect(mainCheckoutWarning(join(plain, "no-such-dir"), ok)).toBeUndefined();
  expect(mainCheckoutWarning(realPath(mkdtempSync(join(tmpdir(), "ahub-not-a-repo-"))), ok)).toBeUndefined();
});

async function fixture(branch?: string, piiPattern?: string) {
  const dir = repo(); if (branch) git(dir, "switch", "-q", "-c", branch);
  if (piiPattern) {
    mkdirSync(join(dir, ".agenthub"), { recursive: true });
    const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pii_patterns = .*$/m, `pii_patterns = [${JSON.stringify(piiPattern)}]`);
    writeFileSync(join(dir, ".agenthub", "routing.toml"), routing);
  }
  const stateDir = join(dir, ".agenthub", "state"); mkdirSync(stateDir, { recursive: true });
  const board = new Board(join(stateDir, "hub.db"));
  const task = board.propose("user", { title: "guard fixture", class: "implement" });
  board.update(task.id, "user", "assigned", { owner: "local", reviewer: "codex" });
  board.update(task.id, "local", "accepted", { state: "in_progress" }); board.close();
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, batch_ms: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } } as never);
  cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
  const published: { kind: string; body: string; to?: string[] }[] = [];
  daemon.bus.tap(event => { if (event.t === "envelope" && event.env.kind === "review") published.push(event.env); });
  const status = async () => (await client.request({ t: "status" })).status;
  return { dir, daemon, client, task, status, published };
}

test("hub_task_done warns the owner and the reviewer while the main checkout is on a branch, and ahub status shows it (#572 AC3)", async () => {
  const f = await fixture("fix/left-behind");
  expect((await f.status()).mainCheckout).toContain("`fix/left-behind`");
  const done = await f.client.request({ t: "task", op: "hub_task_done", args: { id: f.task.id, summary: "done" } });
  expect(done.ok).toBe(true);
  expect(done.text).toContain("in_review"); // advisory only: the done itself is recorded
  expect(done.text).toContain("the main checkout is on `fix/left-behind`; move the work to a worktree under .worktrees/");
  const review = f.published.find(env => env.to?.includes("codex"));
  expect(review?.body).toContain("the main checkout is on `fix/left-behind`; move the work to a worktree under .worktrees/");
  const lines = renderStatus({ peers: {}, mainCheckout: (await f.status()).mainCheckout } as never, 100).map(row => row.map(span => span.text).join("")).join("\n");
  expect(lines).toContain("main checkout");
  expect(lines).toContain("fix/left-behind");
});

test("nothing is said while the main checkout is on its default branch, and the warning clears when it returns (#572 AC3)", async () => {
  const f = await fixture("fix/left-behind");
  expect((await f.status()).mainCheckout).toBeDefined();
  git(f.dir, "switch", "-q", "main");
  expect((await f.status()).mainCheckout).toBeUndefined();
  const done = await f.client.request({ t: "task", op: "hub_task_done", args: { id: f.task.id, summary: "done" } });
  expect(done.ok).toBe(true); expect(done.text).not.toContain("main checkout");
  expect(f.published.find(env => env.to?.includes("codex"))?.body).toBeDefined();
  expect(f.published.find(env => env.to?.includes("codex"))?.body).not.toContain("main checkout");
});

test("a branch name that matches the configured sensitive pattern never leaves the hub in the done result, the review request or status (#572 AC3, review I2)", async () => {
  // A synthetic marker, never real personal data: the project's own pii_patterns decide what is sensitive.
  const f = await fixture("fix/SYNTH-SENSITIVE-4471", "SYNTH-SENSITIVE-\\d+");
  const generic = "the main checkout is on a branch other than its default (its name is withheld); move the work to a worktree under .worktrees/";
  const status = await f.status();
  expect(status.mainCheckout).toBe(generic);
  const done = await f.client.request({ t: "task", op: "hub_task_done", args: { id: f.task.id, summary: "done" } });
  expect(done.ok).toBe(true); expect(done.text).toContain(generic); expect(done.text).not.toContain("SYNTH-SENSITIVE");
  const review = f.published.find(env => env.to?.includes("codex"));
  expect(review?.body).toContain("branch other than its default"); expect(review?.body).not.toContain("SYNTH-SENSITIVE");
  const tools = await ControlClient.connect(join(f.dir, ".agenthub", "state"), { role: "tools", peer: "codex" }); cleanups.push(() => tools.close());
  expect(JSON.stringify((await tools.request({ t: "status" })).status ?? {})).not.toContain("SYNTH-SENSITIVE");
  expect(readFileSync(join(f.dir, ".agenthub", "state", "status.json"), "utf8")).not.toContain("SYNTH-SENSITIVE");
  expect(JSON.stringify(status)).not.toContain("SYNTH-SENSITIVE");
});

test("a branch name that is not a plain ref, or that the screen refuses, is replaced by the generic advisory (#572 review I2)", () => {
  const dir = repo(); git(dir, "switch", "-q", "-c", "fix/ok-name");
  expect(mainCheckoutWarning(dir, ok)).toContain("`fix/ok-name`");
  expect(mainCheckoutWarning(dir, () => false)).toBe("the main checkout is on a branch other than its default (its name is withheld); move the work to a worktree under .worktrees/");
  git(dir, "switch", "-q", "-c", "fix/caf\u00e9"); // git allows it; it is not a plain ref name, so it is never echoed
  expect(mainCheckoutWarning(dir, ok)).toContain("its name is withheld"); expect(mainCheckoutWarning(dir, ok)).not.toContain("caf");
});
