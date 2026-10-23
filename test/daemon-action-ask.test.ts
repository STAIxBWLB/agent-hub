import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, USER } from "../src/hub/envelope.ts";
import { readEvents } from "../src/hub/events.ts";

// #636 slice 2 end to end: Claude's PreToolUse `facts` reply and the ACP request_permission path, under every permission mode.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(condition: () => boolean, what = "condition"): Promise<void> {
  for (let n = 0; n < 500 && !condition(); n++) await Bun.sleep(10);
  expect(condition(), what).toBe(true);
}

async function rig(options: { unattended?: boolean; policy?: unknown; extraKimi?: string[] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-action-ask-")); cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const stateDir = join(cwd, "state");
  mkdirSync(join(cwd, ".agenthub"));
  if (options.policy !== undefined) writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ action_policy: options.policy }));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, unattended: options.unattended, permissionTimeoutMs: 400,
    config: { ...DEFAULT_CONFIG, peers: { kimi: { start_mode: "headless" } }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts"), ...(options.extraKimi ?? [])], ...(options.policy !== undefined ? { action_policy: options.policy as never } : {}) } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  const pushes: any[] = []; client.onPush = m => pushes.push(m); client.send({ t: "tail" });
  return { cwd, stateDir, daemon, client, pushes };
}

test("Claude: the PreToolUse reply names the classes for a classed call in every permission mode, and not for an unclassed one (#636)", async () => {
  const r = await rig();
  const claude = await ControlClient.connect(r.stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => claude.close());
  await until(() => r.daemon.bus.peers.get("claude")?.state === "idle");
  const status = (await r.client.request({ t: "status" })).status;
  const hook = await ControlClient.connect(r.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => hook.close());
  const launcher = { instanceId: status.instanceId, launchId: "action-launch", permissionHook: true, hookPurpose: "permission", unattended: false };
  writeFileSync(join(r.stateDir, "claude-launch.json"), JSON.stringify(launcher));
  const input = { t: "facts", phase: "pre", sessionId: "action-session", nativeInstanceId: status.instanceId, nativeLaunchId: launcher.launchId, hookPurpose: "permission" };
  expect((await hook.request({ ...input, phase: "session" })).ok).toBe(true); // the first verified hook call: only then may the hub change this Claude's mode
  expect((await r.client.request({ t: "status" })).status.actionPolicyInfo.claude).toMatchObject({ enforceable: true, note: "always-ask active" });
  for (const mode of ["ask", "ask-when-needed", "never-ask"]) {
    expect((await r.client.request({ t: "permission", peer: "claude", mode, confirmed: true })).permissionMode).toBe(mode);
    const classed = await hook.request({ ...input, tool: "Bash", input: { command: "git push origin main" } });
    expect(classed).toMatchObject({ ok: true, permission: mode, actionClasses: ["publish"] });
    expect((await hook.request({ ...input, tool: "Bash", input: { command: "git push origin main" } })).actionClasses).toEqual(["publish"]); // repeated: still asks, no budget relaxes Claude
    expect((await hook.request({ ...input, tool: "Bash", input: { command: "rm -rf /etc/x && make" } })).actionClasses).toEqual(["destroy"]);
    const plain = await hook.request({ ...input, tool: "Bash", input: { command: "make test" } });
    expect(plain.permission).toBe(mode); expect(plain.actionClasses).toBeUndefined();
    expect((await hook.request({ ...input, tool: "Read", input: { file_path: "a.ts" } })).actionClasses).toBeUndefined();
  }
});

test("Claude: a narrowed or disabled machine-local policy classes less, and an unattended launch is listed as not enforceable (#636)", async () => {
  const narrow = await rig({ policy: { always_ask: ["destroy"] } });
  await ControlClient.connect(narrow.stateDir, { role: "peer", peer: "claude" }).then(c => cleanup.push(() => c.close()));
  await until(() => narrow.daemon.bus.peers.get("claude")?.state === "idle");
  const status = (await narrow.client.request({ t: "status" })).status;
  const hook = await ControlClient.connect(narrow.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => hook.close());
  const launcher = { instanceId: status.instanceId, launchId: "n-launch", permissionHook: true, hookPurpose: "permission", unattended: false };
  writeFileSync(join(narrow.stateDir, "claude-launch.json"), JSON.stringify(launcher));
  const input = { t: "facts", phase: "pre", sessionId: "n-session", nativeInstanceId: status.instanceId, nativeLaunchId: launcher.launchId, hookPurpose: "permission" };
  expect((await hook.request({ ...input, tool: "Bash", input: { command: "git push" } })).actionClasses).toBeUndefined();
  expect((await hook.request({ ...input, tool: "Bash", input: { command: "rm -rf /etc/x" } })).actionClasses).toEqual(["destroy"]);
  writeFileSync(join(narrow.stateDir, "claude-launch.json"), JSON.stringify({ ...launcher, unattended: true }));
  const row = (await narrow.client.request({ t: "status" })).status.actionPolicyInfo.claude;
  expect(row.enforceable).toBe(false); expect(row.note).toContain("--unattended");
});

test("Kimi ACP: a classed call under never-ask goes to the console even for an unattended hub, a person's allow runs it, silence denies (#636)", async () => {
  for (const unattended of [false, true]) {
    const r = await rig({ unattended });
    expect((await r.client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
    await until(() => r.daemon.bus.stateOf("kimi") === "idle");
    expect((await r.client.request({ t: "permission", peer: "kimi", mode: "never-ask", confirmed: true })).permissionMode).toBe("never-ask");
    const row = (await r.client.request({ t: "status" })).status.actionPolicyInfo.kimi;
    expect(row.enforceable).toBe(false); expect(row.note).toContain("native mode never-ask sends no request");
    expect((await r.client.request({ t: "permission", peer: "kimi", mode: "ask", confirmed: true })).permissionMode).toBe("ask");
    expect((await r.client.request({ t: "status" })).status.actionPolicyInfo.kimi).toMatchObject({ enforceable: true, note: "always-ask active" });
    const replies = () => r.pushes.filter(p => p.t === "event" && p.e?.t === "envelope" && p.e.env.from === "kimi").map(p => p.e.env.body as string);
    await r.client.request({ t: "send", body: "PERMISSION ANNOUNCED ACTIONCMD[git push origin main]", to: ["kimi"] });
    await until(() => r.pushes.some(p => p.t === "permission"), "the classed call reaches the console");
    const ask = r.pushes.find(p => p.t === "permission");
    expect(ask.title).toBe("Action approval (publish): git push origin main");
    expect(ask.options.map((o: any) => o.kind)).toEqual(["allow_once", "reject_once"]);
    r.client.send({ t: "permit", id: ask.id, option: "yes" });
    await until(() => replies().length === 1, "reply after the person's allow");
    expect(replies()[0]).toEndWith("permission=yes");
    // an unclassed call: an unattended hub still allows it as before, an attended one asks as before
    const pending = r.pushes.filter(p => p.t === "permission").length;
    await r.client.request({ t: "send", body: "PERMISSION ANNOUNCED ACTIONCMD[make test]", to: ["kimi"] });
    if (unattended) { await until(() => replies().length === 2, "unattended allows an unclassed call"); expect(replies()[1]).toEndWith("permission=yes"); expect(r.pushes.filter(p => p.t === "permission").length).toBe(pending); }
    else { await until(() => r.pushes.filter(p => p.t === "permission").length === pending + 1, "an attended hub still asks"); }
    // silence on a classed call expires as a denial, unattended or not
    await r.client.request({ t: "send", body: "PERMISSION ANNOUNCED ACTIONCMD[npm publish]", to: ["kimi"] });
    await until(() => replies().length >= (unattended ? 3 : 2), "the timed-out classed call");
    expect(replies().at(-1)).toEndWith("permission=cancelled");
    expect(readEvents(join(r.stateDir, "events.jsonl")).filter(e => e.type === "permission" && (e as any).event === "requested").length).toBeGreaterThanOrEqual(2);
    await r.daemon.stop();
  }
}, 30_000);

test("Kimi ACP: a class budget grants more calls until it is spent, and the approval text stays out of the event log (#636)", async () => {
  const r = await rig({ policy: { budgets: { destroy: 2 } } });
  expect((await r.client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => r.daemon.bus.stateOf("kimi") === "idle");
  const replies = () => r.pushes.filter(p => p.t === "event" && p.e?.t === "envelope" && p.e.env.from === "kimi").map(p => p.e.env.body as string);
  const permissions = () => r.pushes.filter(p => p.t === "permission");
  await r.client.request({ t: "send", body: "PERMISSION ANNOUNCED ACTIONCMD[rm -rf /tmp/one]", to: ["kimi"] });
  await until(() => permissions().length === 1);
  const first = permissions()[0];
  const budget = first.options.find((o: any) => o.optionId === "agent-hub:action-budget");
  expect(budget).toMatchObject({ kind: "allow_once", name: "Allow destroy x2 for this session" });
  r.client.send({ t: "permit", id: first.id, option: budget.optionId });
  await until(() => replies().length === 1);
  expect(replies()[0]).toEndWith("permission=yes");
  // the second call is inside the approved budget: it follows the permission mode (ask here: the console still sees the ordinary Kimi request)
  await r.client.request({ t: "send", body: "PERMISSION ANNOUNCED ACTIONCMD[rm -rf /tmp/two]", to: ["kimi"] });
  await until(() => permissions().length === 2);
  expect(permissions()[1].title).not.toContain("Action approval");
  r.client.send({ t: "permit", id: permissions()[1].id, option: "yes" }); await until(() => replies().length === 2);
  // the third is over the budget: classed again, its own ask
  await r.client.request({ t: "send", body: "PERMISSION ANNOUNCED ACTIONCMD[rm -rf /tmp/three]", to: ["kimi"] });
  await until(() => permissions().length === 3);
  expect(permissions()[2].title).toBe("Action approval (destroy): rm -rf /tmp/three");
  // the approval text is for the console: it is in the permission push, and never in the event log or the hub's own envelopes
  expect(readFileSync(join(r.stateDir, "events.jsonl"), "utf8")).not.toContain("Action approval");
  expect(readFileSync(join(r.stateDir, "events.jsonl"), "utf8")).not.toContain("rm -rf /tmp/three");
});
