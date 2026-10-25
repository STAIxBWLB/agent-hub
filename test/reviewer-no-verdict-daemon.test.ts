import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { REVIEWER_FALLBACK_UNCONFIRMED } from "../src/adapters/reviewer-print.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(condition: () => boolean) { for (let index = 0; index < 400 && !condition(); index++) await Bun.sleep(5); expect(condition()).toBe(true); }
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

async function fixture(twoReviewers = false) {
  const home = mkdtempSync(join(tmpdir(), "ahub-no-verdict-daemon-")), cwd = join(home, "project"), stateDir = join(home, "state"), native = join(home, "native"), bin = join(home, "bin");
  for (const directory of [cwd, native, bin]) mkdirSync(directory);
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const oldHome = process.env.HOME, oldCodex = process.env.CODEX_HOME;
  process.env.HOME = native; process.env.CODEX_HOME = native;
  cleanup.push(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex; });
  const modeFile = join(home, "mode.json"), driver = join(home, "driver.ts"), executable = join(bin, "codex");
  writeFileSync(modeFile, JSON.stringify({ mode: "none" }));
  writeFileSync(driver, `import { readFileSync } from "node:fs";
const argv=process.argv.slice(2), mode=JSON.parse(readFileSync(${JSON.stringify(modeFile)},"utf8")).mode;
if(argv[0]!=="exec"||mode==="approve"){await import(${JSON.stringify(resolve(import.meta.dir, "fakes/fake-codex-reviewer.ts"))});}
else {
  const prompt=await new Response(Bun.stdin.stream()).text();
  if(mode==="native-refusal") console.log(JSON.stringify({type:"item.completed",item:{type:"mcp_tool_call",server:"agent-hub",tool:"hub_review",arguments:{note:"PRIVATE_ARGUMENT_CANARY"},error:{message:"approval refused before host"},status:"failed"}}));
  if(mode==="host-refusal") {
    const servers=Bun.TOML.parse(argv.find(v=>v.startsWith("mcp_servers="))).mcp_servers, env=servers["agent-hub"].env;
    const {ControlClient}=await import(${JSON.stringify(resolve(import.meta.dir, "../src/hub/control-client.ts"))});
    const client=await ControlClient.connect(env.AGENTHUB_STATE_DIR,{role:"tools",peer:env.AGENTHUB_PEER_ID});
    const id=Number(/Review task #(\\d+)/.exec(prompt)?.[1]);
    const result=await client.request({t:"task",op:"hub_review",args:{id,verdict:"not-a-verdict",note:"PRIVATE_ARGUMENT_CANARY"}});
    if(result.ok!==false)throw Error("fixture expected real host refusal");client.close();
  }
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"PRIVATE_MODEL_PROSE_CANARY"}}));
  console.log(JSON.stringify({type:"turn.completed"}));
}
`);
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(driver)} "$@"\n`); chmodSync(executable, 0o755);
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, codex_bin: executable, batch_ms: 0, watchdog_ms: 5000,
      instances: { "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" }, ...(twoReviewers ? { "codex-two": { kind: "codex", roles: ["reviewer"] as ["reviewer"], start_mode: "headless" as const, review_mode: "fresh" as const } } : {}) },
      roles: { builder: ["implementer"], inspector: ["reviewer"] }, review: { ...DEFAULT_CONFIG.review, pool: ["codex"] }, tasks: { ...DEFAULT_CONFIG.tasks, wip_limits: { builder: 4 } },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  expect(await person.request({ t: "start", peer: "codex-review" })).toMatchObject({ ok: true });
  if (twoReviewers) expect(await person.request({ t: "start", peer: "codex-two" })).toMatchObject({ ok: true });
  const builder = await ControlClient.connect(stateDir, { role: "peer", peer: "builder", channel: true }); cleanup.push(() => builder.close());
  await until(() => daemon.bus.stateOf("builder") === "idle");
  const db = new Database(join(stateDir, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const row = (id: number) => db.query("SELECT state,reviewer,history FROM tasks WHERE id=?").get(id) as { state: string; reviewer: string; history: string };
  const op = async (client: ControlClient, operation: string, args: Record<string, unknown>) => { const result = await client.request({ t: "task", op: operation, args }); expect(result).toMatchObject({ ok: true }); return result; };
  const ready = async (title: string, manual: boolean | string = false) => {
    const created = await op(builder, "hub_task_propose", { title, class: "implement", owner: "builder" });
    const id = Number(/task #(\d+)/.exec(String(created.text))?.[1]); expect(Number.isSafeInteger(id)).toBe(true);
    await op(builder, "hub_task_accept", { id });
    if (manual) await op(person, "task_assign", { id, peer: typeof manual === "string" ? manual : "codex-review", role: "reviewer" });
    await op(builder, "hub_task_done", { id, summary: "ready" }); return id;
  };
  return { daemon, person, builder, op, modeFile, stateDir, ready, row };
}

test("real daemon retains an explicitly unconfirmed fallback hold through supersession retirement", async () => {
  const f = await fixture(true), publish = f.daemon.bus.publish.bind(f.daemon.bus);
  f.daemon.bus.publish = env => { if (env.kind === "review" && env.to?.includes("codex-two")) throw new Error("fixture fallback publication unavailable"); return publish(env); };
  const id = await f.ready("unconfirmed fallback publication");
  await until(() => f.row(id).reviewer === "codex-two" && f.daemon.bus.stateOf("codex-review") === "idle");
  const held = () => f.daemon.bus.queueList("codex-review", true).find(value => value.originals.some(env => env.kind === "review" && env.refs?.task === String(id)));
  expect(held()?.state).toBe("needs_review"); expect(held()?.reason).toStartWith(REVIEWER_FALLBACK_UNCONFIRMED);
  await f.op(f.builder, "hub_task_propose", { title: "unrelated board mutation", class: "summarize", owner: "builder" });
  f.daemon.bus.publish(newEnvelope("user", "unrelated queue mutation", { to: ["builder"] }));
  expect((await f.person.request({ t: "status" })).status.peers["codex-review"]).toBeDefined();
  expect(held()?.state).toBe("needs_review"); expect(f.daemon.bus.queueSummary("codex-review").heldBy).toBe(held()?.id);
});

test("real daemon still retires an ordinary superseded review hold", async () => {
  const f = await fixture();
  class Holding extends BasePeer {
    async start() { this.setState("idle"); }
    async stop() { this.setState("offline"); }
    async deliver(envs: Envelope[], id?: string) {
      this.setState("busy");
      if (id) { this.delivery({ id, state: "accepted" }); this.delivery(envs.some(env => env.kind === "review") ? { id, state: "needs_review", reason: "ordinary fixture hold" } : { id, state: "completed" }); }
      this.setState("idle");
    }
  }
  const inspector = new Holding("inspector", 5000); f.daemon.bus.add(inspector); await inspector.start(); cleanup.push(() => inspector.stop());
  const id = await f.ready("ordinary superseded review", "inspector");
  const delivery = () => f.daemon.bus.queueList("inspector").find(value => value.originals.some(env => env.kind === "review" && env.refs?.task === String(id)));
  await until(() => delivery()?.state === "needs_review");
  writeFileSync(f.modeFile, JSON.stringify({ mode: "approve" }));
  await f.op(f.person, "task_assign", { id, peer: "codex-review", role: "reviewer" });
  await until(() => delivery()?.state === "completed");
  expect(f.daemon.bus.queueSummary("inspector").heldBy).toBeUndefined();
});

for (const mode of ["none", "native-refusal", "host-refusal"] as const) test(`real daemon ${mode} diagnostics reoffer to the person, unhold the journal and permit the next review`, async () => {
  const f = await fixture(); writeFileSync(f.modeFile, JSON.stringify({ mode }));
  const id = await f.ready("synthetic no-verdict request", mode === "native-refusal");
  await until(() => f.row(id).reviewer === "user" && f.daemon.bus.stateOf("codex-review") === "idle");
  expect(JSON.parse(f.row(id).history).at(-1)).toMatchObject({ reviewerFailure: { peer: "codex-review", cause: "no_verdict" } });
  expect(f.daemon.bus.queueSummary("codex-review").heldBy).toBeUndefined();
  const delivered = f.daemon.bus.queueList("codex-review").find(value => value.originals.some(env => env.kind === "review" && env.refs?.task === String(id)));
  expect(delivered?.state).toBe("completed");
  expect(f.daemon.bus.queueList("codex-review", true).filter(value => value.state === "needs_review")).toHaveLength(0);
  const log = readFileSync(join(f.stateDir, "hub.log"), "utf8"), diagnostic = log.split("\n").filter(line => line.includes(`review of task #${id}: no verdict`));
  expect(diagnostic).toHaveLength(1); expect(diagnostic[0]).toContain("exit=0");
  if (mode === "none") expect(diagnostic[0]).toContain("no hub_review call");
  if (mode === "native-refusal") expect(diagnostic[0]).toContain("approval refused before host");
  if (mode === "host-refusal") { expect(diagnostic[0]).toContain("last hub tool hub_review"); expect(diagnostic[0]).toContain("refusal:"); expect(diagnostic[0]).not.toContain("refusal: withheld"); }
  expect(log).not.toContain("PRIVATE_ARGUMENT_CANARY"); expect(log).not.toContain("PRIVATE_MODEL_PROSE_CANARY");
  writeFileSync(f.modeFile, JSON.stringify({ mode: "approve" }));
  const next = await f.ready("next review is deliverable");
  await until(() => f.row(next).state === "approved" && f.daemon.bus.stateOf("codex-review") === "idle");
  expect((await f.person.request({ t: "status" })).status.peers["codex-review"].reviewerUnavailable).toBeUndefined();
});
