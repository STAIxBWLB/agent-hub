import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPPORTED_PEERS, definitionOf } from "../../src/adapters/registry.ts";
import { roleEligibility } from "../../src/adapters/role-eligibility.ts";
import { configureJcodeMcp } from "../../src/cli/jcode-mcp.ts";
import { ControlClient } from "../../src/hub/control-client.ts";
import { startDaemon } from "../../src/hub/daemon.ts";
import { type Envelope } from "../../src/hub/envelope.ts";
import { BasePeer } from "../../src/hub/peers.ts";
import { realPath } from "../../src/hub/project.ts";
import { loadConfig } from "../../src/hub/daemon.ts";
import { emulatedBoundedTools } from "../fakes/bounded-capabilities.ts";
import { gitProject } from "../fakes/git-project.ts";

// #1408 T3 (R4, AC6): conductor conformance, one case per `conductorEligible` kind and form, on the existing fakes. A real daemon is started from a project config that names the kind as the
// conductor in one form; the kind's own tools socket then calls the conductor tools, and the conductor feed is read from what the hub published to it. The interactive form is accepted and
// fed, the headless form is refused and fed nothing. No model and no account is involved: this proves the hub's side of the contract, not a native client's behavior.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** A bus peer that records what the hub delivers to it. */
class Recorder extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[], id?: string) { this.got.push(...envs); if (id) this.delivery({ id, state: "completed" }); }
}

/** The calls a conductor makes: its status read, an assignment, and the hold tools. */
const CALLS = ["hub_status", "hub_task_assign", "hub_peer_hold", "hub_peer_release"] as const;
type Call = typeof CALLS[number];
type Outcome = Record<Call, "ok" | string> & { feed: number };

interface Rig { dir: string; state: string; person: ControlClient; tools: ControlClient; fed: Envelope[]; daemon: Awaited<ReturnType<typeof startDaemon>> }

const ROSTER_OFF = { claude: false, codex: false, kimi: false, qwen: false, jcode: false, pi: false, local: false };

/** Starts a daemon whose project config names `kind` the conductor in `mode`, and connects as that kind. Answers `{ refused }` when the hub refuses the kind's own tools socket. */
async function rig(kind: string, mode: "tui" | "headless" | undefined): Promise<Rig | { refused: string }> {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-conductor-conformance-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  gitProject(dir); mkdirSync(join(dir, ".agenthub"));
  const state = join(dir, "state"); mkdirSync(state);
  const config: Record<string, unknown> = {
    roster: { ...ROSTER_OFF, [kind]: true, kimi: true, local: true }, roles: { [kind]: ["conductor"] }, conductor: { feed: "all", approval_wait_s: 0 }, batch_ms: 0,
    memory: { enabled: false }, inference: { enabled: false, triage: false }, mlx: { enabled: false }, snapshots: { enabled: false },
    ...(mode ? { peers: { [kind]: { start_mode: mode } } } : {}), ...(kind === "pi" ? { pi: { enabled: true, auto_start: false } } : {}),
  };
  let launchId: string | undefined;
  if (kind === "jcode") {
    // An owned Jcode proves its tools socket with the launch id of the hub's own launch (#368), so the fake Jcode records it.
    const home = join(dir, "jcode-home"), record = join(dir, "launch.jsonl"); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
    configureJcodeMcp(dir, state, join(import.meta.dir, "../../plugins/agent-hub/server.js"));
    Object.assign(config, { jcode_cmd: [process.execPath, join(import.meta.dir, "../fakes/jcode-instance-agent.ts"), "--record", record], jcode_home: home });
  }
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify(config));
  const daemon = await startDaemon({ boundedTools: emulatedBoundedTools(), cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(state, { role: "console" }); cleanup.push(() => person.close());
  // Everything the hub publishes to the conductor is read from the bus tap, whatever adapter carries it, so the feed is observed the same way for every kind.
  const fed: Envelope[] = [];
  cleanup.push(daemon.bus.tap(event => { if (event.t === "envelope" && event.env.to?.includes(kind)) fed.push(event.env); }));
  for (const peer of [new Recorder("local"), new Recorder("kimi"), ...(kind === "jcode" ? [] : [new Recorder(kind)])]) { daemon.bus.add(peer); await peer.start(); }
  if (kind === "jcode") {
    const started = await person.request({ t: "start", peer: "jcode", args: { mode: "headless" } });
    if (started.ok !== true) throw new Error(`the fake Jcode did not start: ${String(started.error)}`);
    launchId = readFileSync(join(dir, "launch.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.kind === "launch" && row.role === "acp")?.launch;
    if (!launchId) throw new Error("the fake Jcode recorded no launch id");
  }
  let tools: ControlClient;
  try { tools = await ControlClient.connect(state, { role: "tools", peer: kind, ...(launchId ? { launchId } : {}) }); }
  catch (error) { return { refused: (error as Error).message }; }
  cleanup.push(() => tools.close());
  return { dir, state, person, tools, fed, daemon };
}

/** Runs the conductor calls against a rig, with a task for the assignment, and reads how many supervision envelopes the conductor was sent. */
async function exercise(r: Rig): Promise<Outcome> {
  const call = async (op: Call, args: object) => { const reply = await r.tools.request({ t: "task", op, args }); return reply.ok ? "ok" : String(reply.error); };
  const outcome = {} as Outcome;
  outcome.hub_status = await call("hub_status", {});
  expect((await r.person.request({ t: "task", op: "hub_task_propose", args: { title: "conformance task", owner: "local", class: "implement" } })).ok).toBe(true);
  outcome.hub_task_assign = await call("hub_task_assign", { id: 1, peer: "kimi" });
  outcome.hub_peer_hold = await call("hub_peer_hold", { peer: "local" });
  outcome.hub_peer_release = await call("hub_peer_release", { peer: "local" });
  await Bun.sleep(300);
  outcome.feed = r.fed.filter(env => env.refs?.supervision).length;
  return outcome;
}

const REFUSED = "this operation requires the explicit conductor role";

// The kinds the table says may conduct, in the form the table says. Read from the same function, so a kind that becomes eligible is a case here without a second list.
const CONDUCTING: [string, string][] = SUPPORTED_PEERS.flatMap(peer => (definitionOf(peer)?.start.forms ?? []).filter(form => roleEligibility(peer, "conductor", form).eligible).map(form => [peer, form] as [string, string]));

test("the conductor-eligible set the conformance runs over is the registry's: claude, codex, jcode and pi, in their interactive form", () => {
  expect(CONDUCTING).toEqual([["claude", "tui"], ["codex", "tui"], ["pi", "tui"], ["jcode", "tui"]]);
});

for (const [kind] of CONDUCTING) {
  test(`AC6 ${kind} (interactive form): the conductor feed reaches it and hub_status, hub_task_assign and the hold tools are accepted`, async () => {
    const r = await rig(kind, kind === "claude" ? undefined : "tui");
    if ("refused" in r) throw new Error(`${kind}: the hub refused the interactive conductor's tools socket: ${r.refused}`);
    const outcome = await exercise(r);
    expect(outcome.hub_status, "hub_status").toBe("ok");
    expect(outcome.hub_task_assign, "hub_task_assign").toBe("ok");
    expect(outcome.hub_peer_hold, "hub_peer_hold").toBe("ok");
    expect(outcome.hub_peer_release, "hub_peer_release").toBe("ok");
    expect(outcome.feed, "the conductor feed").toBeGreaterThan(0);
    // the hub settled it as the conductor, the same way the loader and doctor read the role
    expect(loadConfig(r.dir).roles[kind]).toContain("conductor");
  }, 60_000);
}

for (const kind of ["codex", "jcode", "pi"]) {
  test(`AC6 ${kind} (headless form): the conductor role is ignored, every conductor call is refused and no feed is sent`, async () => {
    const config = (() => { const dir = mkdtempSync(join(tmpdir(), "ahub-conductor-headless-cfg-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, ".agenthub")); writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ roles: { [kind]: ["conductor"] }, peers: { [kind]: { start_mode: "headless" } } })); return loadConfig(dir); })();
    // the loader keeps the role from nobody: the one source of the refusal below
    expect(Object.values(config.roles).some(list => list.includes("conductor"))).toBe(false);
    expect(config.retired?.join("\n")).toMatch(new RegExp(`roles.${kind}: conductor ignored: ${kind} starts headless`));
    const r = await rig(kind, "headless");
    if ("refused" in r) { expect(r.refused).toMatch(/owned launch|not an owned/); return; } // an owned Jcode may refuse the socket itself; the role was not granted either way
    const outcome = await exercise(r);
    for (const call of CALLS) expect(outcome[call], call).toContain(REFUSED);
    expect(outcome.feed, "the conductor feed").toBe(0);
  }, 60_000);
}

test("AC6 claude has no headless form to refuse: its start mode is not configurable and a headless claude conductor is a config error, never a conductor", () => {
  expect(definitionOf("claude")?.start.forms).toEqual(["tui"]);
  const dir = mkdtempSync(join(tmpdir(), "ahub-conductor-claude-cfg-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ roles: { claude: ["conductor"] }, peers: { claude: { start_mode: "headless" } } }));
  expect(() => loadConfig(dir)).toThrow(/peers\.claude: .*have a start mode/);
  expect(roleEligibility("claude", "conductor", "headless")).toMatchObject({ eligible: false });
});

for (const [kind, why] of [
  ["kimi", "its tui is pull-only: no hub pushes reach it, so the conductor feed cannot"],
  ["qwen", "no case drives its dual-output tui as a conductor yet, so it stays unproven and false until one does (R1)"],
  ["local", "it is the hub-owned headless worker with no interactive session"],
  ["agy", "it is pull-only and has no driven session"],
] as const) {
  test(`AC6 ${kind} is not conductor-eligible, and the hub keeps the role from it: ${why}`, async () => {
    for (const form of definitionOf(kind)?.start.forms ?? []) expect(roleEligibility(kind, "conductor", form), `${kind} ${form}`).toMatchObject({ eligible: false });
    expect(roleEligibility(kind, "conductor").reason).toContain("cannot conduct");
    const dir = mkdtempSync(join(tmpdir(), "ahub-conductor-ineligible-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".agenthub"));
    writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ roles: { [kind]: ["conductor"] } }));
    const config = loadConfig(dir);
    expect(Object.values(config.roles).some(list => list.includes("conductor"))).toBe(false);
    // agy's own adapter ceiling (implementer and verifier only) drops the role with the older ceiling notice; every other kind is dropped by eligibility with the reason.
    expect(config.retired?.join("\n")).toContain(kind === "agy" ? `roles.${kind}: ignored roles outside the adapter ceiling` : `roles.${kind}: conductor ignored`);
  });
}

// ---- the Pi planner decision (R4): decided from this evidence, not flipped without a receipt ----

test("Pi stays implementer-only: the hub holds a planner role on pi back, and nothing here proves Pi can drive the planning flow", () => {
  expect(roleEligibility("pi", "planner")).toMatchObject({ eligible: false, reason: expect.stringContaining("cannot plan") });
  expect(definitionOf("pi")?.projection?.plannerEligible).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), "ahub-pi-planner-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ roles: { pi: ["planner", "implementer"] } }));
  const config = loadConfig(dir);
  expect(config.roles.pi).toEqual(["implementer"]);
  // Pi's tool bridge carries the planner tools, so tool admission is not the gap; the gap is a receipt that a Pi model plans a backlog (a live leg, T5), which a fixture cannot give.
  expect(config.retired?.join("\n")).toContain("roles.pi: ignored roles outside the adapter ceiling");
});
