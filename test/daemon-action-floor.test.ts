import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import type { PiPeer } from "../src/adapters/pi.ts";

// #999 T3 through the real daemon: the floor's facts (default branch, the project's own repository, tags, the checked-out branch) are read where the Pi permit
// boundary runs, so an ordinary push and pull request go through and the release-grade ones ask. The default branch comes from the injected remote probe.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function until(check: () => boolean) { for (let n = 0; n < 500 && !check(); n++) await Bun.sleep(10); expect(check()).toBe(true); }
const git = (cwd: string, ...args: string[]) => { const r = hubGitSync(args, { cwd, encoding: "utf8" }); expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0); };

async function rig(policy: unknown, opts: { remote?: string; branch?: string; probe?: (cwd: string) => Promise<string | undefined> } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-floor-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "a@b"); git(cwd, "config", "user.name", "a");
  git(cwd, "commit", "-q", "--allow-empty", "-m", "init");
  if (opts.remote !== "none") git(cwd, "remote", "add", "origin", opts.remote ?? "https://github.com/acme/app.git");
  if (opts.branch) git(cwd, "checkout", "-q", "-b", opts.branch);
  git(cwd, "tag", "v1");
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ action_policy: policy }));
  let probes = 0;
  const daemon = await startDaemon({ cwd, stateDir: cwd, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, permissionTimeoutMs: 500,
    boundedTools: { specAvailable: async () => ({ available: true }), fetchSpec: async () => { throw new Error("unexpected spec read"); } },
    shellDefaultBranchProbe: async (root: string) => { probes++; return opts.probe ? opts.probe(root) : "main"; },
    config: { ...DEFAULT_CONFIG, batch_ms: 0, action_policy: policy as never,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] } } });
  cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(cwd, { role: "console" }); cleanups.push(() => client.close());
  const asks: any[] = []; client.onPush = row => { if (row.t === "permission") asks.push(row); }; client.send({ t: "tail" });
  expect((await client.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  await until(() => daemon.bus.stateOf("pi") === "idle");
  const peer = daemon.bus.peers.get("pi") as PiPeer;
  const bridge = (peer as any).tuiLaunch.env;
  let n = 0;
  const call = async (command: string) => (await fetch(`${bridge.AGENTHUB_PI_BRIDGE_URL}/tool`, {
    method: "POST", headers: { authorization: `Bearer ${bridge.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "bash", args: { command }, toolCallId: `c${++n}`, sessionId: peer.recoveryMetadata().sessionId, generation: (peer as any).budgetGeneration }),
  })).json() as Promise<{ text: string }>;
  /** Runs `command`; when the hub asks, denies, and reports whether it asked (and nothing ran on a denial). */
  const attempt = async (command: string, marker: string) => {
    const before = asks.length;
    const pending = call(`printf ran > ${marker}; ${command}`);
    await until(() => asks.length > before || existsSync(join(cwd, marker)));
    const asked = asks.length > before;
    if (asked) client.send({ t: "permit", id: asks[before].id, option: "deny" });
    await pending;
    return { asked, title: asked ? String(asks[before].title) : "", ran: existsSync(join(cwd, marker)) };
  };
  const mode = async (value: string) => expect((await client.request({ t: "permission", peer: "pi", mode: value, confirmed: true })).permissionMode).toBe(value);
  const status = async () => (await client.request({ t: "status" })).status.actionPolicyInfo.pi;
  return { cwd, daemon, client, asks, call, attempt, mode, status, probes: () => probes };
}

test("floor on: an ordinary branch push and own-repository pull request run without a prompt, and the release-grade ones ask, for the Pi permit path", async () => {
  const r = await rig({ floor: true }, { branch: "feat/x" });
  await r.mode("never-ask");
  await until(() => r.probes() >= 1);
  await Bun.sleep(50);                                              // the default branch read settles into the cache
  expect((await r.status()).floor).toBe(true);
  // allowed: they run (the marker is written) and no prompt opens; the push itself fails in the sandbox (no network), which is not the hub's concern
  for (const [i, command] of ["git push origin feat/x", "git push -u origin HEAD", "gh pr create --title a --body b", "gh pr comment 3 --body x", "gh pr merge 3 --squash --match-head-commit abc"].entries()) {
    const out = await r.attempt(command, `ok-${i}`);
    expect(out, command).toMatchObject({ asked: false, ran: true });
  }
  expect(r.asks).toHaveLength(0);
  // still asked, and nothing ran when denied
  for (const [i, [command, klass]] of ([["git push --force origin feat/x", "publish"], ["git push -f origin feat/x", "publish"], ["git push origin +feat/x", "publish"],
    ["git push --force-with-lease origin feat/x", "publish"], ["git push origin main", "publish"], ["git push origin HEAD:main", "publish"], ["git push origin v1", "publish"],
    ["git push --tags origin feat/x", "publish"], ["git push", "publish"], ["gh release create v9", "publish"], ["npm publish", "publish"], ["bun publish", "publish"], ["cargo publish", "publish"],
    ["gh pr merge 3 --admin", "external-write"], ["gh pr create --repo other/app --title a", "external-write"], ["gh issue create --title a", "external-write"],
    ["rm -rf ../outside", "destroy"], ["mail -s hi a@example.com", "external-write"], ["git push origin $BRANCH", "publish"]] as Array<[string, string]>).entries()) {
    const out = await r.attempt(command, `ask-${i}`);
    expect(out.asked, command).toBe(true);
    expect(out.title, command).toContain(`Action approval (${klass}`);
    expect(out.ran, command).toBe(false);
  }
}, 60_000);

test("floor off, absent or false: the same push and pull request ask exactly as before", async () => {
  for (const policy of [{}, { floor: false }, { budgets: { publish: 1 } }]) {
    const r = await rig(policy, { branch: "feat/x" });
    await r.mode("never-ask");
    expect((await r.status()).floor).toBeUndefined();
    expect(await r.attempt("git push origin feat/x", "a-push")).toMatchObject({ asked: true, ran: false });
    expect(await r.attempt("gh pr create --title a --body b", "a-pr")).toMatchObject({ asked: true, ran: false });
    expect(r.probes(), "no remote read is made for a policy without the floor").toBe(0);
    await r.daemon.stop();
  }
}, 60_000);

test("floor on but a fact is unproven: the remote read fails, the origin is not on GitHub, or the policy is disabled", async () => {
  // the authoritative default-branch read failed: every push asks, even a feature branch
  const failed = await rig({ floor: true }, { branch: "feat/x", probe: async () => undefined });
  await failed.mode("never-ask"); await until(() => failed.probes() >= 1); await Bun.sleep(50);
  expect(await failed.attempt("git push origin feat/x", "f-push")).toMatchObject({ asked: true, ran: false });
  expect(await failed.attempt("gh pr comment 3 --body x", "f-pr")).toMatchObject({ asked: false, ran: true });   // a pull request needs no default branch, only the project's own repository
  await failed.daemon.stop();
  // no GitHub origin: neither the push nor the pull request is provably the project's own
  const foreign = await rig({ floor: true }, { branch: "feat/x", remote: "https://example.com/acme/app.git" });
  await foreign.mode("never-ask"); await Bun.sleep(100);
  expect(await foreign.attempt("git push origin feat/x", "g-push")).toMatchObject({ asked: true, ran: false });
  expect(await foreign.attempt("gh pr comment 3 --body x", "g-pr")).toMatchObject({ asked: true, ran: false });
  await foreign.daemon.stop();
  // a disabled policy still asks nothing, floor or not (unchanged by the floor)
  const off = await rig({ floor: true, enabled: false }, { branch: "feat/x" });
  await off.mode("never-ask");
  expect(await off.attempt("git push --force origin main", "d-push")).toMatchObject({ asked: false, ran: true });
  await off.daemon.stop();
}, 60_000);

test("a tag named like a branch and a nested clone keep asking; a version-shaped branch is a branch", async () => {
  const r = await rig({ floor: true }, { branch: "feat/x" });
  await r.mode("never-ask"); await until(() => r.probes() >= 1); await Bun.sleep(50);
  git(r.cwd, "tag", "feat/tagged");
  expect(await r.attempt("git push origin feat/tagged", "t-push")).toMatchObject({ asked: true, ran: false });   // a local tag of that name: git may push the tag
  // a nested clone has its own origin: the project's floor must not cover it
  mkdirSync(join(r.cwd, "nested")); git(join(r.cwd, "nested"), "init", "-q", "-b", "main"); git(join(r.cwd, "nested"), "remote", "add", "origin", "https://example.com/other/repo.git");
  expect(await r.attempt("git -C nested push origin feat/x", "n-push")).toMatchObject({ asked: true, ran: false });
  expect(await r.attempt("cd nested && git push origin feat/x", "n-cd")).toMatchObject({ asked: true, ran: false });
  git(r.cwd, "checkout", "-q", "-b", "v2.0.0");
  expect(await r.attempt("git push origin HEAD", "v-push")).toMatchObject({ asked: false, ran: true });
}, 60_000);

test("status names the structural guards for a peer the hub cannot see, and says it has not verified them", async () => {
  const r = await rig({ floor: true }, { branch: "feat/x" });
  const row = await r.status();
  expect(row).toMatchObject({ floor: true, enforceable: true });
  expect(row.note).toContain("floor on: ordinary branch pushes and own-repository pull requests do not ask");
  await r.client.request({ t: "peer_stop", peer: "pi" });
  const stopped = await r.status();
  expect(stopped.enforceable).toBe(false);
  expect(stopped.floorGuards.map((g: any) => g.guard)).toEqual(["GitHub branch protection on the default branch", "release only through ahub sdlc authorize-release and the OIDC tag workflow", "the peer's native sandbox"]);
  expect(stopped.note).toContain("rest on structural guards the hub has not verified");
}, 60_000);
