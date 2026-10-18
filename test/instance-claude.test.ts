import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { validateInstances } from "../src/hub/instances.ts";
import { claudePeer, claudeStateFile } from "../src/hub/claude-state.ts";
import { planReset } from "../src/cli/reset.ts";

// #450 I3: a second Claude runs as a declared channel instance from the person's terminal, reviewing or planning.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const instances = { "claude-review": { kind: "claude", roles: ["reviewer"] } };

test("a Claude instance declares reviewer or planner roles and no headless start or worktree", () => {
  expect(validateInstances(instances)["claude-review"]).toEqual({ kind: "claude", roles: ["reviewer"] });
  expect(validateInstances({ "claude-plan": { kind: "claude", roles: ["planner", "reviewer"] } })["claude-plan"]!.roles).toEqual(["planner", "reviewer"]);
  for (const entry of [{ kind: "claude" }, { kind: "claude", roles: [] }, { kind: "claude", roles: ["implementer"] }, { kind: "claude", roles: ["reviewer", "verifier"] }]) expect(() => validateInstances({ "claude-x": entry })).toThrow("must declare its roles");
  expect(() => validateInstances({ "claude-x": { kind: "claude", roles: ["reviewer"], start_mode: "headless" } })).toThrow("person's terminal");
  expect(() => validateInstances({ "claude-x": { kind: "claude", roles: ["reviewer"], worktree: "../wt" } })).toThrow("person's terminal");
});

test("each Claude instance keeps its own launch, session and context files; the builtin keeps the old names", () => {
  expect(claudeStateFile("claude-session", "claude")).toBe("claude-session.json");
  expect(claudeStateFile("claude-context", "claude-review")).toBe("claude-context.claude-review.json");
  expect(claudeStateFile("claude-launch", "claude-review")).toBe("claude-launch.claude-review.json");
  for (const value of [undefined, "", "Claude", "../x", "a/b", "x".repeat(40)]) expect(claudePeer(value)).toBe("claude");
  expect(claudePeer("claude-review")).toBe("claude-review");
});

test("ahub reset removes each Claude instance's session pointers with the builtin ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-claude-reset-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["claude-session.json", "claude-session.claude-review.json", "claude-context.claude-review.json", "claude-launch.claude-review.json"]) writeFileSync(join(dir, name), "{}");
  expect(planReset(dir, "fixture").sessionPointers.sort()).toEqual(["claude-context.claude-review.json", "claude-session.claude-review.json", "claude-session.json"]);
});

test("the daemon admits a declared Claude instance as a channel peer, with its declared roles, and never starts it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-claude-instance-")), stateDir = join(root, "state");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0,
    config: { ...DEFAULT_CONFIG, instances, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const connect = async (hello: Parameters<typeof ControlClient.connect>[1]) => { const c = await ControlClient.connect(stateDir, { ...hello, projectRoot: root }); cleanup.push(() => c.close()); return c; };
  const console_ = await connect({ role: "console" });
  expect((await console_.request({ t: "start", peer: "claude-review" })).ok).toBe(false);
  const peer = await connect({ role: "peer", peer: "claude-review", channel: true });
  const frames: any[] = []; peer.onPush = m => frames.push(m);
  for (let n = 0; n < 300 && daemon.bus.stateOf("claude-review") !== "idle"; n++) await Bun.sleep(10);
  expect(daemon.bus.stateOf("claude-review")).toBe("idle");
  const status = (await console_.request({ t: "status" })).status;
  expect(status.roleInfo?.["claude-review"]?.flowRoles).toEqual(["reviewer"]);
  expect(await console_.request({ t: "send", to: ["claude-review"], body: "review this" })).toMatchObject({ ok: true });
  for (let n = 0; n < 300 && !frames.some(f => f.t === "deliver"); n++) await Bun.sleep(10);
  expect(frames.some(f => f.t === "deliver" && f.envs?.some((e: { body: string }) => e.body.includes("review this")))).toBe(true);
  expect(existsSync(join(stateDir, "claude-session.claude-review.json"))).toBe(false);
});
