import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectChain } from "@staix/agent-mem";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { USER } from "../src/hub/envelope.ts";
import { campaignHash, parseResearchCampaign } from "../src/hub/research-campaign.ts";
import { SourceRegistry } from "../src/hub/sources.ts";
import { realPath } from "../src/hub/project.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

// #601 through the real daemon and its control socket: the person's `study_*` ops, the agents' `hub_study_*` tools and the refusals between them. Nothing here calls Tasks directly.
class FixturePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envelopes: Envelope[]) { /* receives task context without running a native account */ }
}
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const SECRET_QUESTION = "SECRET_QUESTION_CANARY which compound binds", SECRET_PATH = "/private/SECRET_PATH_CANARY/notes.txt";

async function rig(options: { privateSource?: boolean; stateUnderProject?: boolean } = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-study-cli-"))), stateDir = options.stateUnderProject ? join(root, ".agenthub/state") : join(root, "state");
  mkdirSync(stateDir, { recursive: true }); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const envKeys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME", "KIMI_CODE_HOME"] as const;
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) { const dir = join(root, key.toLowerCase()); mkdirSync(dir); process.env[key] = dir; }
  cleanup.push(() => { for (const key of envKeys) { const previous = saved[key]; if (previous === undefined) delete process.env[key]; else process.env[key] = previous; } });
  // Three sources, one private: the id of a private source is itself a reference a public view must not carry.
  const registry = new SourceRegistry(stateDir);
  const sources = [0, 1, 2].map(n => registry.add({ bytes: Buffer.from(`fixture source ${n}`), kind: "file", origin: `fixture-${n}.txt`, private: options.privateSource === true && n === 2, text: `fixture source ${n}` }).id);
  const board = new Board(join(stateDir, "hub.db"));
  const parent = board.propose(USER, { title: "Research parent", class: "plan", backlog: true });
  board.close();
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: root, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, notifier: () => {},
    config: { ...DEFAULT_CONFIG, roles: { claude: ["planner"], codex: ["implementer"], kimi: ["implementer"] }, roster: { ...DEFAULT_CONFIG.roster, kimi: true }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const connect = async (role: "console" | "tools", peer?: string) => { const client = await ControlClient.connect(stateDir, role === "console" ? { role, projectRoot: root } : { role, peer }); cleanup.push(() => client.close()); return client; };
  return { root, stateDir, sources, parent, daemon, person: await connect("console"), planner: await connect("tools", "claude"), agent: await connect("tools", "codex"), connect, project: projectChain(root).at(-1)! };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const contractFor = (r: Rig, over: Record<string, unknown> = {}) => ({ question: SECRET_QUESTION, scope: `Fixture scope near ${SECRET_PATH}`, exclusions: [], sourceIds: r.sources,
  units: [
    { id: "alpha", round: 0, question: "Read the first source", perspective: "measurement", requiredOutput: "Handoff", sourceIds: [r.sources[0]!, r.sources[1]!], dependsOn: [], purpose: "discovery" },
    { id: "beta", round: 0, question: "Read the third source independently", perspective: "independent", requiredOutput: "Handoff", sourceIds: [r.sources[2]!], dependsOn: [], purpose: "discovery" },
  ], deliverableSections: [], stopPolicy: { maxUnits: 3, maxFollowUpRounds: 1, deadline: new Date(Date.now() + 30 * 86_400_000).toISOString() }, ...over });
const task = (client: ControlClient, op: string, args: Record<string, unknown>) => client.request({ t: "task", op, args });
const json = (reply: any) => { expect(reply.ok, JSON.stringify(reply)).toBe(true); return JSON.parse(reply.text); };
const sentence = (reply: any) => { expect(reply.ok, JSON.stringify(reply)).toBe(true); return String(reply.text); };   // pull, assign and accept answer in a sentence

test("the person drafts and approves through the control socket, and every unit becomes a bound task", async () => {
  const r = await rig();
  const draft = json(await task(r.person, "study_draft", { parentTaskId: r.parent.id, contract: contractFor(r) }));
  expect(draft).toMatchObject({ revision: 1, status: "draft", unitCount: 0 });
  const approved = json(await task(r.person, "study_approve", { id: draft.id, revision: 1 }));
  expect(approved).toMatchObject({ status: "approved", unitCount: 2 });
  expect(approved.units.map((unit: any) => unit.unitId).sort()).toEqual(["alpha", "beta"]);
  const shown = json(await task(r.person, "hub_study_show", { id: draft.id }));
  expect(shown.units.map((unit: any) => unit.unitId).sort()).toEqual(["alpha", "beta"]);
  expect(json(await task(r.person, "hub_study_show", {}))).toEqual({ campaigns: [expect.objectContaining({ id: draft.id, status: "approved", unitCount: 2 })] });   // one page, no cursor: nothing follows
  const closed = json(await task(r.person, "study_close", { id: draft.id, revision: 1, reason: "fixture done" }));
  expect(closed.status).toBe("closed");
}, 30_000);

test("no agent connection can approve, close, draft as the person or reach a study_* op, whatever its role", async () => {
  const r = await rig();
  const draft = json(await task(r.person, "study_draft", { parentTaskId: r.parent.id, contract: contractFor(r) }));
  for (const client of [r.agent, r.planner]) {
    for (const [op, args] of [["study_approve", { id: draft.id, revision: 1 }], ["study_close", { id: draft.id, revision: 1, reason: "x" }],
      ["study_draft", { parentTaskId: r.parent.id, contract: contractFor(r) }], ["study_revise", { id: draft.id, revision: 1, contract: contractFor(r) }]] as const) {
      const reply = await task(client, op, args);
      expect(reply.ok, `${op} as a tools connection`).toBe(false);
      expect(reply.error).toContain("console commands");
    }
  }
  const board = new Board(join(r.stateDir, "hub.db"));
  try { expect(board.researchCampaign(draft.id)!.status).toBe("draft"); expect(board.researchCampaignBindings(draft.id, 1)).toHaveLength(0); } finally { board.close(); }
}, 30_000);

test("the configured planner drafts and revises through hub_study_* and cannot approve; a non-planner is refused", async () => {
  const r = await rig();
  expect((await task(r.agent, "hub_study_draft", { parentTaskId: r.parent.id, contract: contractFor(r) })).ok).toBe(false);   // codex holds implementer only
  const draft = json(await task(r.planner, "hub_study_draft", { parentTaskId: r.parent.id, contract: contractFor(r) }));
  expect(draft).toMatchObject({ revision: 1, status: "draft" });
  const revised = json(await task(r.planner, "hub_study_revise", { id: draft.id, revision: 1, contract: contractFor(r, { scope: "Narrower scope" }) }));
  expect(revised.revision).toBe(2);
  expect((await task(r.planner, "hub_study_revise", { id: draft.id, revision: 1, contract: contractFor(r) })).ok).toBe(false);   // stale revision
  const approve = await task(r.planner, "study_approve", { id: draft.id, revision: 2 });
  expect(approve.ok).toBe(false);
  const board = new Board(join(r.stateDir, "hub.db"));
  try { expect(board.researchCampaign(draft.id)!.status).toBe("draft"); } finally { board.close(); }
}, 30_000);

test("hub_study_show is read-only for every connection and a public campaign shows its units, never its question text", async () => {
  const r = await rig();
  const draft = json(await task(r.person, "study_draft", { parentTaskId: r.parent.id, contract: contractFor(r) }));
  json(await task(r.person, "study_approve", { id: draft.id, revision: 1 }));
  for (const client of [r.person, r.planner, r.agent]) {
    const text = (await task(client, "hub_study_show", { id: draft.id })).text;
    expect(JSON.parse(text).units.map((unit: any) => unit.unitId).sort()).toEqual(["alpha", "beta"]);
    expect(text).not.toContain("SECRET_QUESTION_CANARY");
    expect(text).not.toContain("SECRET_PATH_CANARY");
  }
  expect((await task(r.agent, "hub_study_show", { id: "not-a-campaign" })).ok).toBe(false);
  expect((await task(r.agent, "hub_study_show", { id: draft.id, extra: 1 })).ok).toBe(false);
  // The list is paged through the real tool: an unknown field and a malformed cursor are refused, a valid cursor past the end is an empty page.
  expect((await task(r.agent, "hub_study_show", { extra: 1 })).ok).toBe(false);
  expect((await task(r.agent, "hub_study_show", { after: "not-a-campaign" })).ok).toBe(false);
  expect(json(await task(r.agent, "hub_study_show", { after: "rc-ffffffffffff" }))).toEqual({ campaigns: [] });
}, 30_000);

test("a campaign with a private source shows ids, counts and states only: no source id, question, scope or path, to anyone", async () => {
  const r = await rig({ privateSource: true });
  const draft = json(await task(r.person, "study_draft", { parentTaskId: r.parent.id, contract: contractFor(r) }));
  json(await task(r.person, "study_approve", { id: draft.id, revision: 1 }));
  for (const client of [r.person, r.planner, r.agent]) {
    const reply = await task(client, "hub_study_show", { id: draft.id }), text = reply.text as string;
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    for (const forbidden of [SECRET_QUESTION, "SECRET_QUESTION_CANARY", "SECRET_PATH_CANARY", ...r.sources, "fixture-2.txt", "fixture source"]) expect(text, `leaked ${forbidden}`).not.toContain(forbidden);
    const view = JSON.parse(text);
    expect(view.units.every((unit: any) => unit.sourceIds.length === 0 && unit.duplicateSourceIds.length === 0 && unit.handoff.coveredSourceIds.length === 0)).toBe(true);
    expect(view.units.map((unit: any) => unit.unitId).sort()).toEqual(["alpha", "beta"]);   // ids, counts and states are still there
  }
  const list = (await task(r.agent, "hub_study_show", {})).text as string;
  for (const forbidden of [SECRET_QUESTION, "SECRET_PATH_CANARY", ...r.sources]) expect(list).not.toContain(forbidden);
}, 30_000);

test("hub_study_handoff accepts only the bound in-progress owner, and every missing required field is named", async () => {
  const r = await rig();
  const draft = json(await task(r.person, "study_draft", { parentTaskId: r.parent.id, contract: contractFor(r) }));
  const approved = json(await task(r.person, "study_approve", { id: draft.id, revision: 1 }));
  const alpha = approved.units.find((unit: any) => unit.unitId === "alpha").taskId as number;
  const handoff = { campaignId: draft.id, revision: 1, unitId: "alpha", taskId: alpha, evidence: [{ sourceId: r.sources[0], locator: "section 1" }], unresolved: [], contradictions: [], limitations: [] };
  const notOwner = await task(r.agent, "hub_study_handoff", { handoff });
  expect(notOwner.ok).toBe(false);
  expect(notOwner.error).toContain("owner");
  const missing = await task(r.agent, "hub_study_handoff", { handoff: { campaignId: draft.id } });
  expect(missing.ok).toBe(false);
  expect(missing.error).toContain("revision, unitId, taskId, evidence, unresolved, contradictions, limitations");   // all of them at once, not the first
  const board = new Board(join(r.stateDir, "hub.db"));
  try { expect(board.researchHandoffs(draft.id)).toEqual([]); } finally { board.close(); }
}, 30_000);

test("the person's contract and ids are validated by the hub before any write", async () => {
  const r = await rig();
  expect((await task(r.person, "study_draft", { parentTaskId: r.parent.id, contract: { question: "x" } })).ok).toBe(false);
  expect((await task(r.person, "study_approve", { id: "rc-000000000000", revision: 1 })).ok).toBe(false);
  expect((await task(r.person, "study_close", { id: "rc-000000000000", revision: 1, reason: "" })).ok).toBe(false);
  expect((await task(r.person, "study_draft", { parentTaskId: r.parent.id, contract: contractFor(r), extra: true })).ok).toBe(false);   // an unknown field is refused, not dropped
  const board = new Board(join(r.stateDir, "hub.db"));
  try { expect(board.researchCampaignIds(r.project)).toEqual([]); } finally { board.close(); }
}, 30_000);

// The three-source, two-peer example, end to end through the socket: codex reads two sources (alpha), kimi reads the third independently (beta).
// A complete handoff, an incomplete one and a missing one are three different things the readback must keep apart.
test("three-source, two-peer example: coverage moves from none to incomplete to complete through hub_study_handoff and hub_study_show", async () => {
  const r = await rig();
  const codex = new FixturePeer("codex"), kimi = new FixturePeer("kimi");
  for (const peer of [codex, kimi]) { r.daemon.bus.add(peer); await peer.start(); }
  const draft = json(await task(r.person, "study_draft", { parentTaskId: r.parent.id, contract: contractFor(r) }));
  const approved = json(await task(r.person, "study_approve", { id: draft.id, revision: 1 }));
  const taskOf = (unit: string) => approved.units.find((row: any) => row.unitId === unit).taskId as number;
  const kimiTools = await r.connect("tools", "kimi");
  for (const [unit, peer, client] of [["alpha", "codex", r.agent], ["beta", "kimi", kimiTools]] as const) {
    sentence(await task(r.person, "backlog_pull", { id: taskOf(unit) }));
    sentence(await task(r.person, "task_assign", { id: taskOf(unit), peer }));
    sentence(await task(client, "hub_task_accept", { id: taskOf(unit), plan: { paths: [`notes/${unit}.md`] } }));
  }
  const coverage = async () => Object.fromEntries(json(await task(r.person, "hub_study_show", { id: draft.id })).units.map((unit: any) => [unit.unitId, unit.handoff]));
  expect(await coverage()).toMatchObject({ alpha: { present: false, complete: false }, beta: { present: false, complete: false } });
  const handoff = (unit: string, sources: string[]) => ({ campaignId: draft.id, revision: 1, unitId: unit, taskId: taskOf(unit), evidence: sources.map(sourceId => ({ sourceId, locator: "section 1" })), unresolved: [], contradictions: [], limitations: [] });
  json(await task(r.agent, "hub_study_handoff", { handoff: handoff("alpha", [r.sources[0]!]) }));                  // covers one of alpha's two sources
  expect(await coverage()).toMatchObject({ alpha: { present: true, complete: false, coveredSourceIds: [r.sources[0]] }, beta: { present: false } });
  expect((await task(kimiTools, "hub_study_handoff", { handoff: handoff("alpha", [r.sources[0]!]) })).ok).toBe(false);    // kimi does not own alpha
  json(await task(r.agent, "hub_study_handoff", { handoff: handoff("alpha", r.sources.slice(0, 2)) }));              // now both
  json(await task(kimiTools, "hub_study_handoff", { handoff: handoff("beta", [r.sources[2]!]) }));
  expect(await coverage()).toMatchObject({ alpha: { present: true, complete: true }, beta: { present: true, complete: true } });
  expect(json(await task(r.person, "hub_study_show", { id: draft.id })).discoveryRounds).toEqual([{ round: 0, complete: true }]);
}, 30_000);

// The real `ahub` process against the real daemon: argv parsing, the contract file, the control socket, the daemon's console-only ops and the renderer, with no fake in between.
test("the real ahub CLI drafts, shows, approves and closes a campaign against the real daemon", async () => {
  const r = await rig({ stateUnderProject: true });
  writeFileSync(join(r.root, ".agenthub/config.json"), "{}");
  writeFileSync(join(r.root, "contract.json"), JSON.stringify(contractFor(r)));
  const ahub = async (...args: string[]) => {
    const env = { ...process.env, NO_COLOR: "1", COLUMNS: "100" } as Record<string, string>;
    for (const marker of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR"]) delete env[marker];
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", r.root, ...args], { cwd: r.root, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
  };
  const drafted = await ahub("study", "draft", String(r.parent.id), "contract.json");
  expect(drafted.code, drafted.stderr).toBe(0);
  const id = drafted.stdout.match(/rc-[a-f0-9]{12}/)![0];
  expect(drafted.stdout).toContain("drafted"); expect(drafted.stdout).toContain(`ahub study approve ${id} 1`);
  expect((await ahub("study", "show")).stdout).toContain(`${id}  r1   draft`);
  const approved = await ahub("study", "approve", id, "1");
  expect(approved.code, approved.stderr).toBe(0); expect(approved.stdout).toContain("approved"); expect(approved.stdout).toMatch(/alpha\s+#\d+/); expect(approved.stdout).toMatch(/beta\s+#\d+/);
  const shown = await ahub("study", "show", id);
  expect(shown.stdout).toContain("0/2 covered"); expect(shown.stdout).toContain("0/1 covered"); expect(shown.stdout).not.toContain("SECRET_QUESTION_CANARY");
  expect(JSON.parse((await ahub("study", "show", id, "--json")).stdout).units).toHaveLength(2);
  const refused = await ahub("study", "approve", "rc-000000000000", "1"); expect(refused.code).toBe(1);
  const closed = await ahub("study", "close", id, "1", "--reason", "example finished");
  expect(closed.code, closed.stderr).toBe(0); expect(closed.stdout).toContain("closed");
  expect((await ahub("study", "show")).stdout).toContain(`${id}  r1   closed`);
}, 60_000);

// What the earlier real-CLI test left out, on the real path: `study revise`, an agent's shell (the real classifier, the real daemon), and a restart between approve and show.
function realCli(r: Rig, markers: Record<string, string> = {}) {
  return async (...args: string[]) => {
    const env = { ...process.env, NO_COLOR: "1", COLUMNS: "100" } as Record<string, string>;
    for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") && key !== "AGENTHUB_HOME" || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "KIMI_CODE"].includes(key)) delete env[key];
    Object.assign(env, markers);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", r.root, ...args], { cwd: r.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
  };
}

test("the real ahub process: an agent shell reads a campaign and is refused every write before the hub changes, and the person revises through the same CLI", async () => {
  const r = await rig({ stateUnderProject: true });
  writeFileSync(join(r.root, ".agenthub/config.json"), "{}");
  writeFileSync(join(r.root, "contract.json"), JSON.stringify(contractFor(r)));
  writeFileSync(join(r.root, "contract2.json"), JSON.stringify(contractFor(r, { scope: "Narrower scope" })));
  const person = realCli(r), agent = realCli(r, { AGENTHUB_PEER_ID: "codex", AGENTHUB_STATE_DIR: r.stateDir, AGENTHUB_PROJECT_DIR: r.root });
  const drafted = await person("study", "draft", String(r.parent.id), "contract.json"); expect(drafted.code, drafted.stderr).toBe(0);
  const id = drafted.stdout.match(/rc-[a-f0-9]{12}/)![0];
  // the person revises a draft: revision 2 exists, a stale revision 1 is refused by the hub
  const revised = await person("study", "revise", id, "1", "contract2.json");
  expect(revised.code, revised.stderr).toBe(0); expect(revised.stdout).toContain("revision 2"); expect(revised.stdout).toContain(`ahub study approve ${id} 2`);
  const stale = await person("study", "revise", id, "1", "contract2.json"); expect(stale.code).toBe(1);
  // an agent shell: read allowed, every write refused as a console command, and nothing changed
  expect((await agent("study", "show")).code).toBe(0);
  expect((await agent("study", "show", id, "--json")).stdout).toContain('"units"');
  for (const argv of [["approve", id, "2"], ["close", id, "2", "--reason", "x"], ["draft", String(r.parent.id), "contract.json"], ["revise", id, "2", "contract2.json"]]) {
    const refused = await agent("study", ...argv);
    expect(refused.code, `agent study ${argv[0]}`).toBe(1);
    expect(refused.stderr, `agent study ${argv[0]}`).toContain(`codex cannot run ahub study ${argv[0]}`);   // the classifier's own refusal, in the agent's process
    expect(refused.stderr).toContain("inherited agent markers");
  }
  const board = new Board(join(r.stateDir, "hub.db"));
  try { expect(board.researchCampaign(id)!.revision).toBe(2); expect(board.researchCampaign(id)!.status).toBe("draft"); expect(board.researchCampaignBindings(id, 2)).toHaveLength(0); } finally { board.close(); }
  // Review thread on #1031: `--live-test` delegates an agent shell to the console role for commands the central list does not refuse, so a missing `study` entry would let it approve as the person.
  for (const argv of [["approve", id, "2"], ["close", id, "2", "--reason", "x"], ["draft", String(r.parent.id), "contract.json"], ["revise", id, "2", "contract2.json"]]) {
    const refused = await agent("--live-test", "study", ...argv);
    expect(refused.code, `agent --live-test study ${argv[0]}`).toBe(1);
    expect(refused.stderr, `agent --live-test study ${argv[0]}`).toContain("live-test cannot write person-attributed content");
  }
  expect((await agent("--live-test", "study", "show")).code).toBe(0);                       // the read stays allowed
  const afterLive = new Board(join(r.stateDir, "hub.db"));
  try { expect(afterLive.researchCampaign(id)!.revision).toBe(2); expect(afterLive.researchCampaign(id)!.status).toBe("draft"); expect(afterLive.researchCampaignBindings(id, 2)).toHaveLength(0); } finally { afterLive.close(); }
  const approved = await person("study", "approve", id, "2"); expect(approved.code, approved.stderr).toBe(0); expect(approved.stdout).toContain("approved");
}, 90_000);

test("a campaign survives a daemon restart: show and close still work, and the units keep their task ids", async () => {
  const r = await rig({ stateUnderProject: true });
  const draft = json(await task(r.person, "study_draft", { parentTaskId: r.parent.id, contract: contractFor(r) }));
  const approved = json(await task(r.person, "study_approve", { id: draft.id, revision: 1 }));
  await r.daemon.stop();
  const again = await startDaemon({ cwd: r.root, stateDir: r.stateDir, projectId: r.root, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, notifier: () => {},
    config: { ...DEFAULT_CONFIG, roles: { claude: ["planner"], codex: ["implementer"] }, roster: {}, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => again.stop());
  const person = await r.connect("console");
  const shown = json(await task(person, "hub_study_show", { id: draft.id }));
  expect(shown.units.map((unit: any) => [unit.unitId, unit.taskId]).sort()).toEqual(approved.units.map((unit: any) => [unit.unitId, unit.taskId]).sort());
  expect(json(await task(person, "hub_study_show", {}))).toEqual({ campaigns: [expect.objectContaining({ id: draft.id, status: "approved", unitCount: 2 })] });
  const replay = json(await task(person, "study_approve", { id: draft.id, revision: 1 }));   // re-running approve returns the stored mapping and creates nothing
  expect(replay.units.map((unit: any) => unit.taskId).sort()).toEqual(approved.units.map((unit: any) => unit.taskId).sort());
  expect(json(await task(person, "study_close", { id: draft.id, revision: 1, reason: "after restart" })).status).toBe("closed");
}, 60_000);
