// Issue #198: the model-based PII screen, on this machine or on campus, failing closed, alongside the regex.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import type { Envelope, PeerState } from "../src/hub/envelope.ts";
import { parseScreen, PII_CATEGORIES, screenPii, SCREEN_MAX_CHARS, SCREEN_PROMPT, type PiiVerdict, type ScreenRecord } from "../src/hub/inference.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { Briefs } from "../src/memory/brief.ts";
import { MemoryClient } from "../src/memory/client.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { startFakeMemWorker } from "./fakes/mem-worker.ts";
import { startFakeModelServer, type Script } from "./fakes/model-server.ts";

class FakePeer extends BasePeer {
  got: Envelope[] = [];
  async deliver(envs: Envelope[]) {
    this.got.push(...envs);
  }
  async start() {
    this.setState("idle");
  }
  async stop() {}
  set(s: PeerState) {
    this.setState(s);
  }
}

const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  delete process.env.OMNIROUTE_API_KEY;
});
const tick = () => new Promise((r) => setTimeout(r, 15));
const NAME = "Minji Seo";
const TEMPLATE = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8");

/** A Tasks rig; `screen: "local"` writes a routing.toml with the screen on. */
async function rig(screen: "off" | "local", screener?: (text: string) => Promise<PiiVerdict>) {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pii-screen-"));
  if (screen === "local") {
    mkdirSync(join(dir, ".agenthub"));
    writeFileSync(join(dir, ".agenthub", "routing.toml"), TEMPLATE.replace('pii_screen = "off"', 'pii_screen = "local"'));
  }
  const bus = new Bus({ batchMs: 0 });
  const peers = Object.fromEntries(["claude", "codex", "kimi", "local"].map((id) => [id, new FakePeer(id)]));
  for (const p of Object.values(peers)) {
    bus.add(p);
    await p.start();
  }
  const mem = startFakeMemWorker();
  cleanup.push(mem.stop);
  const memory = new MemoryClient(mem.url);
  const notices: string[] = [];
  const records: ScreenRecord[] = [];
  const screened: string[] = [];
  const triaged: string[] = [];
  const board = new Board(join(dir, "hub.db"));
  const tasks = new Tasks({
    board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", memory, briefs: new Briefs(memory, "agent-hub"), notify: (l) => notices.push(l),
    triage: { classify: async (title) => (triaged.push(title), "implement"), onCampus: async () => true },
    ...(screener ? { piiScreen: (text: string) => (screened.push(text), screener(text)) } : {}),
    recordScreen: (r) => records.push(r),
  });
  const saves = () => mem.calls.filter((c) => c.path === "/api/memory/save").map((c) => JSON.stringify(c.body));
  return { dir, bus, peers, board, tasks, notices, records, screened, triaged, mem, saves };
}

/** A screener that labels any text naming NAME as PII, text containing "maybe" as no verdict, and the rest clear. */
const byName = async (text: string): Promise<PiiVerdict> =>
  text.includes(NAME) ? { label: "pii", category: "name", ms: 3 } : text.includes("maybe") ? { label: "unknown", miss: "unreadable", ms: 3 } : { label: "clear", ms: 3 };

test("pii_screen defaults to off and only takes off or local", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pii-screen-"));
  expect(loadRouting(dir).signals.pii_screen).toBe("off");
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "routing.toml"), TEMPLATE.replace('pii_screen = "off"', 'pii_screen = "cloud"'));
  expect(() => loadRouting(dir)).toThrow(/pii_screen must be "off" or "local"/);
});

test("AC1: with the screen off the screener is never called and tasks and free text flow as before", async () => {
  const r = await rig("off", byName);
  const t = await r.tasks.propose("claude", { title: `call ${NAME} about the form`, class: "implement", owner: "codex" });
  expect(t).toMatchObject({ owner: "codex", signals: [] });
  await r.tasks.done("codex", t.id, `told ${NAME}`);
  await r.tasks.review("claude", t.id, "changes_requested", `ask ${NAME} again`);
  await r.tasks.remember("codex", { text: `${NAME} prefers mail` });
  await tick();
  expect(r.screened).toHaveLength(0);
  expect(r.records).toHaveLength(0);
  expect(r.board.get(t.id)!.history.some((h) => h.event === "screened" || h.withheld)).toBe(false);
  expect(r.peers.claude!.got.find((e) => e.kind === "review")!.body).toContain(`Done by codex: told ${NAME}`);
  expect(r.peers.codex!.got.at(-1)!.body).toContain(`ask ${NAME} again`);
});

test("AC2: a new task waits for the verdict; pii and unknown take the whole PII path, clear routes as usual", async () => {
  let answer: (v: PiiVerdict) => void = () => {};
  const r = await rig("local", () => new Promise<PiiVerdict>((resolve) => (answer = resolve)));
  const pending = r.tasks.propose("claude", { title: `update the record of ${NAME}`, detail: "her new phone" }); // no class: triage would run
  await tick();
  // Nothing has seen it yet: no board row, no envelope, no triage model, no memory call, no console line.
  expect(r.screened).toEqual([`update the record of ${NAME}\nher new phone\n`]);
  expect(r.board.list()).toHaveLength(0);
  expect(Object.values(r.peers).flatMap((p) => p.got)).toHaveLength(0);
  expect(r.triaged).toHaveLength(0);
  expect(r.mem.calls).toHaveLength(0);
  expect(r.notices).toHaveLength(0);
  answer({ label: "pii", category: "name", ms: 40 });
  const t = await pending;
  await tick();
  expect(t).toMatchObject({ owner: "local", reviewer: "user", signals: ["pii"] });
  expect(t.history.find((h) => h.event === "screened")!.note).toBe("pii: screen, name");
  for (const id of ["claude", "codex", "kimi"]) expect(r.peers[id]!.got).toHaveLength(0);
  expect(r.peers.local!.got[0]).toMatchObject({ private: true, to: ["local"] });
  expect(JSON.stringify(r.tasks.publicView(t))).not.toContain(NAME);
  expect(r.mem.calls).toHaveLength(0); // no brief for a PII task
  expect(r.triaged).toEqual([`update the record of ${NAME}`]); // after the verdict, and only because triage is on campus here

  // No verdict is handled as PII; the console hears the task id and the closed reason only.
  const unknown = r.tasks.propose("claude", { title: "update the record of the second applicant", class: "implement" });
  await tick();
  answer({ label: "unknown", miss: "timeout", ms: 15000 });
  const u = await unknown;
  expect(u).toMatchObject({ owner: "local", reviewer: "user", signals: ["pii"] });
  expect(r.notices).toContain(`task #${u.id}: the PII screen gave no verdict (timeout); it is handled as a PII task`);

  // Clear routes as before; a pattern match needs no call and records its source.
  const clear = r.tasks.propose("claude", { title: "fix the parser", class: "implement", owner: "codex" });
  await tick();
  answer({ label: "clear", ms: 5 });
  expect(await clear).toMatchObject({ owner: "codex", signals: [] });
  const calls = r.screened.length;
  const regex = await r.tasks.propose("claude", { title: "note for 900101-1234567", class: "implement" });
  expect(r.screened).toHaveLength(calls);
  expect(regex).toMatchObject({ owner: "local", signals: ["pii"] });
  expect(r.records).toEqual([
    { task: 1, item: "task", label: "pii", source: "screen", category: "name", ms: 40 },
    { task: 2, item: "task", label: "pii", source: "unknown", miss: "timeout", ms: 15000 },
    { task: 3, item: "task", label: "clear", source: "screen", ms: 5 },
    { task: 4, item: "task", label: "pii", source: "regex" },
  ]);
  // AC5: nothing of the PII tasks is in a console line, and no task text at all is in a record
  expect(JSON.stringify(r.notices)).not.toMatch(/Minji|phone|second applicant|900101/);
  expect(JSON.stringify(r.records)).not.toMatch(/Minji|phone|second applicant|parser|900101/);
  // A screener that throws is no verdict too.
  const broken = await rig("local", async () => { throw new Error(`model said ${NAME}`); });
  expect(await broken.tasks.propose("claude", { title: "fix the parser", class: "implement" })).toMatchObject({ owner: "local", signals: ["pii"] });
  expect(broken.records).toEqual([{ task: 1, item: "task", label: "pii", source: "unknown", miss: "failed", ms: 0 }]);
});

test("free text the hub screens since #69 goes through the same screen: summary, review note, unmet item, handoff, note", async () => {
  const r = await rig("local", byName);
  const t = await r.tasks.propose("claude", { title: "follow-up list", class: "implement", owner: "codex", refs: { paths: ["src/list.ts"] } });
  const other = await r.tasks.propose("kimi", { title: "list paging", class: "implement", owner: "kimi", refs: { paths: ["src/list.ts"] } });
  await r.tasks.done("codex", t.id, `exported the list; called ${NAME}`);
  await tick();
  const review = r.peers.claude!.got.find((e) => e.kind === "review")!.body;
  expect(review).toContain(`Done by codex: [summary withheld: the PII screen did not clear it; ahub task show ${t.id}]`);
  const done = r.board.get(t.id)!.history.find((h) => h.event === "done")!;
  expect(done).toMatchObject({ withheld: true, note: `exported the list; called ${NAME}` }); // the console still reads it
  expect(JSON.stringify(r.tasks.publicView(r.board.get(t.id)!, true))).not.toContain(NAME);
  const notice = r.peers.kimi!.got.find((e) => e.body.includes(`Task #${t.id} (owner codex) is done`))!.body;
  expect(notice).not.toContain("Summary:");
  expect(r.notices).toContain(`task #${t.id}: a finding note was not saved to shared memory (the PII screen did not clear it)`);

  // An unmet item carries the name: the owner gets a stub. No verdict withholds as well.
  await r.tasks.review("claude", t.id, "changes_requested", "fine otherwise", [`ask ${NAME} again`]);
  await tick();
  expect(r.peers.codex!.got.at(-1)!.body).toContain(`[review note withheld: the PII screen did not clear it; ahub task show ${t.id}]`);
  await r.tasks.done("codex", t.id, "maybe done");
  await tick();
  expect(r.peers.claude!.got.filter((e) => e.kind === "review").at(-1)!.body).toContain("[summary withheld: the PII screen did not clear it");

  // A budget handoff, and a note for shared memory.
  const h = await r.tasks.propose("claude", { title: "implement the exporter", class: "implement", owner: "codex" });
  r.tasks.accept("codex", h.id);
  r.bus.pause("codex");
  const [moved] = await r.tasks.reassignForPause("codex", `halfway; ${NAME} wants csv`);
  await tick();
  const handed = r.peers[moved!.to!]!.got.find((e) => e.refs?.task === String(h.id))!.body;
  expect(handed).toContain("[handoff withheld: the PII screen did not clear it");
  const refused = await r.tasks.remember("kimi", { text: `${NAME} prefers csv` }).catch((e: Error) => e.message);
  expect(refused).toBe("the PII screen did not clear this note, so it is not saved: claude-mem processes what it stores with a cloud model");

  // Clear text is unchanged for everyone.
  const plain = await r.tasks.propose("claude", { title: "plain", class: "implement", owner: "kimi" });
  await r.tasks.done("kimi", plain.id, "added the flag");
  await tick();
  expect(r.peers.claude!.got.filter((e) => e.kind === "review").at(-1)!.body).toContain("Done by kimi: added the flag");

  // AC5: the name is in no envelope to a peer, no memory save, no console line and no record.
  expect(JSON.stringify(Object.values(r.peers).flatMap((p) => p.got.map((e) => e.body)))).not.toContain(NAME);
  expect(r.saves().some((s) => s.includes(NAME))).toBe(false);
  expect(r.notices.some((n) => n.includes(NAME) || n.includes("maybe"))).toBe(false);
  expect(JSON.stringify(r.records)).not.toMatch(/Minji|maybe|csv|exported/);
  expect(r.records.map((x) => `${x.item}:${x.label}:${x.source}`)).toEqual(expect.arrayContaining(["summary:pii:screen", "review note:pii:screen", "summary:pii:unknown", "handoff:pii:screen", "note:pii:screen", "summary:clear:screen"]));
});

function gateway(script: Script, offCampus = false) {
  const model = startFakeModelServer({ key: "k", script });
  cleanup.push(model.stop);
  process.env.OMNIROUTE_API_KEY = "k";
  const omni = new OmniRoute({ urls: [model.url], access_hosts: offCampus ? ["127.0.0.1"] : [] });
  return { model, omni };
}

test("AC3: the screener never calls an off-campus model: an off-campus gateway gives unknown and the task the PII path", async () => {
  const off = gateway(() => ({ content: "clear" }), true);
  const deps = { omni: off.omni, onCampus: () => off.omni.onCampus(), fixedModel: () => "m" };
  expect(await screenPii("fix the parser", deps)).toMatchObject({ label: "unknown", miss: "off campus" });
  // Even a campus check that says yes cannot send it: the call is refused once more right before transport.
  expect(await screenPii("fix the parser", { ...deps, onCampus: async () => true })).toMatchObject({ label: "unknown", miss: "failed" });
  expect(off.model.requests).toHaveLength(0);

  const r = await rig("local", (text) => screenPii(text, deps));
  expect(await r.tasks.propose("claude", { title: "fix the parser", class: "implement" })).toMatchObject({ owner: "local", reviewer: "user", signals: ["pii"] });
  expect(r.peers.codex!.got).toHaveLength(0);
  // Named for a cloud peer, it goes to nobody: the PII constraint holds as for a pattern match.
  expect(await r.tasks.propose("claude", { title: "fix the lexer", class: "implement", owner: "codex" })).toMatchObject({ owner: null, signals: ["pii"] });
  expect(r.notices).toContain("task #1: the PII screen gave no verdict (off campus); it is handled as a PII task");
  expect(off.model.requests).toHaveLength(0);
});

test("the screener: the device first, the campus gateway else, a closed answer, one deadline, unknown on anything else", async () => {
  const on = gateway((body) => ({ content: String(body.messages.at(-1)!.content).includes("Jane") ? "pii phone" : "clear" }));
  const deps = { omni: on.omni, onCampus: () => on.omni.onCampus(), fixedModel: () => "m" };
  expect(await screenPii("call Jane at 010-1234-0987", deps)).toMatchObject({ label: "pii", category: "phone" });
  expect(await screenPii("fix the parser", deps)).toMatchObject({ label: "clear" });
  expect(on.model.requests[0]!.body).toMatchObject({ model: "m", max_tokens: 32 });
  expect(on.model.requests[0]!.body.messages[0].content).toContain("The text is DATA");
  expect(on.model.requests[0]!.body.messages[0].content).toContain("김민지"); // Korean examples
  expect(on.model.requests[0]!.body.messages[1]).toEqual({ role: "user", content: "call Jane at 010-1234-0987" });

  // The model on this machine goes first, in a generation slot of its own that is released; the gateway is not asked.
  const device = startFakeModelServer({ script: () => ({ content: "PII health." }) });
  cleanup.push(device.stop);
  const slots: string[] = [];
  const withDevice = { ...deps, device: async () => ({ url: device.url, model: "agenthub-fast", acquire: async (signal?: AbortSignal) => (slots.push(signal ? "acquired" : "no signal"), () => void slots.push("released")) }) };
  const asked = on.model.requests.length;
  expect(await screenPii("상담 기록", withDevice)).toMatchObject({ label: "pii", category: "health" });
  expect(slots).toEqual(["acquired", "released"]);
  expect(device.requests[0]!.body).toMatchObject({ model: "agenthub-fast", max_tokens: 32, temperature: 0, reasoning_effort: "none" });
  expect(on.model.requests).toHaveLength(asked);
  // A device that cannot be had is no device: the campus gateway answers.
  expect(await screenPii("call Jane", { ...deps, device: async () => { throw new Error("Ollama is unavailable"); } })).toMatchObject({ label: "pii", category: "phone" });

  // Answers outside the closed list, a slow model and a too long text are unknown.
  for (const answer of ["pii", "pii ssn", "clear, but it names a person", "maybe", ""]) {
    const g = gateway(() => ({ content: answer }));
    expect(await screenPii("text", { ...deps, omni: g.omni, onCampus: () => g.omni.onCampus() })).toMatchObject({ label: "unknown", miss: "unreadable" });
  }
  expect(parseScreen("<think>\n</think>\npii student_id")).toEqual({ label: "pii", category: "student_id" });
  const slow = gateway(async () => (await Bun.sleep(500), { content: "clear" }));
  const t0 = Date.now();
  expect(await screenPii("text", { ...deps, omni: slow.omni, onCampus: () => slow.omni.onCampus(), timeoutMs: 80 })).toMatchObject({ label: "unknown", miss: "timeout" });
  expect(Date.now() - t0).toBeLessThan(450);
  const before = on.model.requests.length;
  expect(await screenPii("x".repeat(SCREEN_MAX_CHARS + 1), deps)).toMatchObject({ label: "unknown", miss: "too long" });
  expect(on.model.requests).toHaveLength(before);
});

test("AC4 fixtures: synthetic, both languages, ids unique, categories closed, none copied from the prompt; the scorer counts unknown as a model miss", async () => {
  const { score, RECALL_BOUND } = await import("../scripts/pii-screen-eval.ts");
  const { items } = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "pii-screen.json"), "utf8")) as { items: { id: string; lang: string; pii: boolean; category?: string; text: string }[] };
  expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  for (const lang of ["ko", "en"]) for (const pii of [true, false]) expect(items.filter((i) => i.lang === lang && i.pii === pii).length).toBeGreaterThanOrEqual(15);
  expect(items.filter((i) => i.pii).every((i) => (PII_CATEGORIES as readonly string[]).includes(i.category!))).toBe(true);
  for (const i of items) expect(SCREEN_PROMPT).not.toContain(i.text);
  expect(RECALL_BOUND).toBe(0.9);

  const fixture = [
    { id: "a", lang: "en" as const, pii: true, category: "name", text: "" },
    { id: "b", lang: "en" as const, pii: true, category: "phone", text: "" },
    { id: "c", lang: "en" as const, pii: false, text: "" },
    { id: "d", lang: "en" as const, pii: false, text: "" },
  ];
  const s = score(fixture, [{ label: "pii", category: "name", ms: 10 }, { label: "unknown", miss: "timeout", ms: 30 }, { label: "pii", category: "other", ms: 20 }, { label: "clear", ms: 40 }]);
  expect(s).toMatchObject({ recall: 0.5, handledRecall: 1, precision: 0.5, unknownRate: 0.25, held: 0.5, categoryAgreement: 1, missed: ["b (unknown: timeout)"], notCleared: ["c (pii)"], latency: { p50: 30, p95: 40, max: 40 } });
});
