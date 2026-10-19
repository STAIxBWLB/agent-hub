import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import type { ReviewerPrintPeer } from "../src/adapters/reviewer-print.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}
type Row = { state: string; reviewer: string; refs: string; history: string };
type Capability = { url: string; headers: Record<string, string> };
type Rpc = { refused: boolean; reply?: { error?: unknown; result?: { isError?: boolean; content?: unknown[] } } };
async function call(capability: Capability, name: string, args: Record<string, unknown>): Promise<Rpc> {
  try {
    const response = await fetch(capability.url, { method: "POST", headers: { ...capability.headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(2000) });
    const reply = await response.json() as NonNullable<Rpc["reply"]>;
    return { refused: !response.ok || !!reply.error || reply.result?.isError === true, reply };
  } catch (error) {
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") throw new Error("fixture RPC timed out; refusal not established");
    // Revoking/closing the exact old capability is a refusal, but the pre-mutation positive call must succeed.
    return { refused: true };
  }
}

for (const change of ["head", "revision", "lifecycle"] as const) test(`running reviewer capability refuses stale ${change} after real Tasks changes while reviewer id stays fixed`, async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-binding-")), native = join(root, "native"), bin = join(root, "bin"), project = join(root, "project"), stateDir = join(root, "state"), log = join(root, "held.jsonl");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of [native, bin, project, join(native, "credentials"), join(native, "oauth")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(native, "device_id"), "fixture-device");
  writeFileSync(join(native, "config.toml"), 'default_model="fixture"\n[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="https://api.kimi.ai/coding/v1"\n[providers."managed:kimi-code".oauth]\nstorage="file"\nkey="oauth/kimi-code"\n[models.fixture]\nprovider="managed:kimi-code"\nmodel="kimi-for-coding"\n');
  const fake = resolve(import.meta.dir, "fakes/fake-kimi-held-reviewer.ts"), executable = join(bin, "kimi");
  // Only a short fixture Bun child is executable; no real native CLI/account can be reached.
  writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${fake}' '${log}' "$@"\n`); chmodSync(executable, 0o755);
  const priorPath = process.env.PATH, priorHome = process.env.KIMI_CODE_HOME;
  process.env.PATH = `${bin}:${priorPath ?? "/usr/bin:/bin"}`; process.env.KIMI_CODE_HOME = native;
  cleanup.push(() => { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; if (priorHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = priorHome; });
  const daemon = await startDaemon({ cwd: project, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, watchdog_ms: 10000,
      instances: { "kimi-review": { kind: "kimi", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } },
      roles: { builder: ["implementer"] }, review: { ...DEFAULT_CONFIG.review, pool: ["kimi"] },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  expect(await person.request({ t: "start", peer: "kimi-review" })).toMatchObject({ ok: true });
  const reviewer = daemon.bus.peers.get("kimi-review") as ReviewerPrintPeer;
  const legacy=await ControlClient.connect(stateDir,{role:"tools",peer:"kimi-review"});cleanup.push(()=>legacy.close());
  const builder = await ControlClient.connect(stateDir, { role: "peer", peer: "builder", channel: true }); cleanup.push(() => builder.close());
  await until(() => daemon.bus.stateOf("builder") === "idle");
  const db = new Database(join(stateDir, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const op = (client: ControlClient, operation: string, args: Record<string, unknown>) => client.request({ t: "task", op: operation, args });
  const A = "a".repeat(40), B = "b".repeat(40);
  const proposed = await op(builder, "hub_task_propose", { title: "Synthetic stale binding regression", class: "implement", owner: "builder", refs: change === "lifecycle" ? {} : { commit: A } });
  expect(proposed.ok).toBe(true);
  const id = Number(String(proposed.text).match(/task #(\d+)/)?.[1]); expect(Number.isSafeInteger(id)).toBe(true);
  if(change==="lifecycle")expect(await op(builder,"hub_sdlc_record",{id,receipt:{localHead:A}})).toMatchObject({ok:true});
  // Explicit person assignment survives later done while the same peer remains busy.
  expect(await op(person, "task_assign", { id, peer: "kimi-review", role: "reviewer" })).toMatchObject({ ok: true });
  expect(await op(builder, "hub_task_done", { id, summary: "Fixture head A ready", refs: change === "lifecycle" ? {} : { commit: A } })).toMatchObject({ ok: true });
  await until(() => existsSync(log) && reviewer.reviewing === id);
  const started = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!) as { home: string; task: number; peer: string };
  expect(started.task).toBe(id); expect(started.peer).toBe("kimi-review");
  expect(daemon.bus.peers.get("kimi-review")).toBe(reviewer);
  expect(reviewer.state).toBe("busy"); expect(reviewer.reviewToken(id)).toBeDefined();
  const capability = JSON.parse(readFileSync(join(started.home, "mcp.json"), "utf8")).mcpServers["agent-hub"] as Capability;
  const currentShow = await call(capability, "hub_task_show", { id });
  expect(currentShow.refused).toBe(false); expect(currentShow.reply?.result?.content?.length).toBeGreaterThan(0);
  expect(await op(legacy,"hub_task_show",{id})).toMatchObject({ok:true});
  const row = () => db.query("SELECT state,reviewer,refs,history FROM tasks WHERE id = ?").get(id) as Row;
  const initialHistory = JSON.parse(row().history) as Record<string, unknown>[];
  if (change === "head") {
    expect(await op(person, "hub_review", { id, verdict: "changes_requested", head: A, note: "Fixture requests a new head" })).toMatchObject({ ok: true });
    expect(await op(builder, "hub_task_done", { id, summary: "Fixture head B ready", refs: { commit: B } })).toMatchObject({ ok: true });
    expect(JSON.parse(row().refs).commit).toBe(B);
  } else if(change==="lifecycle"){
    expect(await op(builder,"hub_sdlc_record",{id,receipt:{localHead:B}})).toMatchObject({ok:true});
  } else {
    expect(await op(person, "task_assign", { id, peer: "kimi-review", role: "reviewer" })).toMatchObject({ ok: true });
    const history = JSON.parse(row().history) as Record<string, unknown>[];
    expect(history.length).toBeGreaterThan(initialHistory.length);
    expect(history.at(-1)?.event).toBe("reviewer changed");
    expect(JSON.parse(row().refs).commit).toBe(A);
  }
  expect(row().reviewer).toBe("kimi-review"); expect(row().state).toBe("in_review");
  const historyBeforeStaleCalls = row().history;
  const staleShow = await call(capability, "hub_task_show", { id });
  const staleVerdict = await call(capability, "hub_review", { id, verdict: "approved", head: change !== "revision" ? B : A, note: "Old native child must not approve the replacement review" });
  expect(await op(legacy,"hub_task_show",{id})).toMatchObject({ok:false});
  expect(await op(legacy,"hub_review",{id,verdict:"approved",head:change!=="revision"?B:A,note:"Stale legacy transport"})).toMatchObject({ok:false});
  expect(staleShow.refused).toBe(true);
  expect(staleVerdict.refused).toBe(true);
  expect(row().state).toBe("in_review");
  expect(row().history).toBe(historyBeforeStaleCalls);
}, 15000);
