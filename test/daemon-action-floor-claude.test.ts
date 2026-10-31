import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";

// #999 T3 for the Claude PreToolUse hook, a peer whose shell environment the hub cannot see: with the floor on, an unqualified `gh pr ...` is not proven to mean the project's own
// repository (a GH_REPO exported in that shell would redirect it), so it asks, while an explicit own `-R` or pull request URL, a non-default branch push and the rest of the floor run.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(condition: () => boolean): Promise<void> { for (let n = 0; n < 500 && !condition(); n++) await Bun.sleep(10); expect(condition()).toBe(true); }
const git = (cwd: string, ...args: string[]) => { const r = hubGitSync(args, { cwd, encoding: "utf8" }); expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0); };

async function rig(policy: unknown) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-floor-claude-")); cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q", "-b", "main"); git(cwd, "config", "user.email", "a@b"); git(cwd, "config", "user.name", "a");
  git(cwd, "commit", "-q", "--allow-empty", "-m", "init"); git(cwd, "remote", "add", "origin", "https://github.com/acme/app.git"); git(cwd, "checkout", "-q", "-b", "feat/x");
  const stateDir = join(cwd, "state"); mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ action_policy: policy }));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, permissionTimeoutMs: 400, shellDefaultBranchProbe: async () => "main",
    config: { ...DEFAULT_CONFIG, batch_ms: 0, action_policy: policy as never, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  const claude = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => claude.close());
  await until(() => daemon.bus.peers.get("claude")?.state === "idle");
  const status = (await client.request({ t: "status" })).status;
  const hook = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => hook.close());
  const launcher = { instanceId: status.instanceId, launchId: "floor-launch", permissionHook: true, hookPurpose: "permission", unattended: false };
  writeFileSync(join(stateDir, "claude-launch.json"), JSON.stringify(launcher));
  const input = { t: "facts", phase: "pre", sessionId: "floor-session", nativeInstanceId: status.instanceId, nativeLaunchId: launcher.launchId, hookPurpose: "permission" };
  expect((await hook.request({ ...input, phase: "session" })).ok).toBe(true);
  const classes = async (command: string) => (await hook.request({ ...input, tool: "Bash", input: { command } })).actionClasses as string[] | undefined;
  return { cwd, daemon, client, classes };
}

test("Claude hook with the floor on: an unqualified gh pr call asks, an explicit own selector runs, and the rest of the floor holds", async () => {
  const r = await rig({ floor: true });
  await Bun.sleep(100);                                                               // the default branch read settles into the cache
  // the hub cannot see the environment a Claude shell runs in: nothing proves an unqualified gh pr call means the project's repository
  for (const command of ["gh pr comment 3 --body hi", "gh pr create --title a --body b", "gh pr merge 3 --squash", "gh pr review 3 --approve"])
    expect(await r.classes(command), command).toEqual(["external-write"]);
  // an explicit own repository does not depend on gh's default or on GH_REPO
  for (const command of ["gh pr comment 3 -R acme/app --body hi", "gh pr create --repo acme/app --title a", "gh pr merge https://github.com/acme/app/pull/3 --squash"])
    expect(await r.classes(command), command).toBeUndefined();
  expect(await r.classes("gh pr comment 3 -R other/app --body hi")).toEqual(["external-write"]);
  // the push side of the floor is unchanged for Claude
  expect(await r.classes("git push origin feat/x")).toBeUndefined();
  expect(await r.classes("git push --force origin feat/x")).toEqual(["publish"]);
  expect(await r.classes("git push origin main")).toEqual(["publish"]);
  expect(await r.classes("gh release create v1")).toEqual(["publish"]);
  expect((await r.client.request({ t: "status" })).status.actionPolicyInfo.claude).toMatchObject({ floor: true, enforceable: true });
}, 60_000);

test("Claude hook: a coarse always_ask never hands the floor's classes back, and without the floor the unqualified call asks as it always did", async () => {
  const narrow = await rig({ floor: true, always_ask: ["install"] });
  await Bun.sleep(100);
  expect(await narrow.classes("git push --force origin feat/x")).toEqual(["publish"]);
  expect(await narrow.classes("gh release create v1")).toEqual(["publish"]);
  expect(await narrow.classes("rm -rf ../x")).toEqual(["destroy"]);
  expect(await narrow.classes("git push origin feat/x")).toBeUndefined();
  expect((await narrow.client.request({ t: "status" })).status.actionPolicyInfo.claude.alwaysAsk).toEqual(["publish", "external-write", "destroy", "install"]);
  const off = await rig({});
  expect(await off.classes("gh pr comment 3 --body hi")).toEqual(["external-write"]);
  expect(await off.classes("git push origin feat/x")).toEqual(["publish"]);
}, 60_000);
