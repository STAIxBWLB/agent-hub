import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { createProvider } from "../src/ui/plugin.ts";
import type { Lifecycle, ProjectRecord } from "../src/hub/manager.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { canAnswerInInbox, personEvidence, questionItem } from "../src/ui/plugin-questions.ts";

// #1053 T5: the acon inbox item for a question, its plain fallback, a forwarded answer with the console's person meta, and a refusal without it.
const dirs: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ROW = { set: "qs-0123456789ab", peer: "codex", created: 1_790_000_000_000, private: false, questions: [
  { id: "db", prompt: "Which database should the store use?", options: [{ id: "pg", label: "Postgres", description: "the default" }, { id: "sqlite", label: "SQLite" }] },
  { id: "extras", prompt: "Which extras?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], multi: true, allowOther: true },
] };
const META = { identity: "local", node: "node-1", via: "console" as const };
const FEATURES = ["inbox.form", "action.meta"];

function fixture(o: { features?: readonly string[]; rows?: unknown[]; answerReply?: Record<string, unknown> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ahub-q-plugin-")); dirs.push(home);
  const project: ProjectRecord = { id: "p1", root: "/tmp/q-project", stateDir: join(home, "state"), basePort: 4700, instanceId: "i1", pid: 42 };
  const registry = { get: (id: string) => id === project.id ? project : undefined, list: () => [project], close() {} } as any;
  const lifecycle: Lifecycle = { inspectProject: async () => ({ state: "running", status: { instanceId: "i1", peers: {} } }), startProject: async () => ({}), stopProject: async () => {} };
  const received: Record<string, unknown>[] = [];
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, data) {
      const m = JSON.parse(String(data));
      if (m.t === "hello") return void ws.send(JSON.stringify({ rid: m.rid, t: "welcome", cwd: project.root, projectId: project.id, instanceId: "i1" }));
      received.push(m);
      if (m.t === "ui_snapshot") return void ws.send(JSON.stringify({ rid: m.rid, ok: true, cursor: 1, peers: {}, permissions: [], tasks: [], questions: o.rows ?? [ROW], status: { peers: {} }, events: [] }));
      if (m.t === "answer") return void ws.send(JSON.stringify({ rid: m.rid, t: "answer", ...(o.answerReply ?? { ok: true, questionSet: m.questionSet, state: "answered" }) }));
      if (m.t === "ui_action") return void ws.send(JSON.stringify({ rid: m.rid, ok: true }));
    },
  } });
  servers.push(hub);
  mkdirSync(project.stateDir, { recursive: true });
  writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: project.id, instanceId: "i1" }));
  writeFileSync(join(project.stateDir, "control-token"), "scripted-token");
  const provider = createProvider({ home, registry, lifecycle, ...(o.features ? { features: o.features } : {}) });
  return { provider, received };
}
const ANSWERS = { db: { selected: ["pg"] }, extras: { selected: ["a", "b"], other: "later" } };
const inboxOf = async (provider: ReturnType<typeof fixture>["provider"]) => ((await provider.snapshot({ after: 0, panel: "inbox" })) as { items: any[] }).items;

test("with inbox.form and action.meta an open question is an inbox item whose answer verb carries a form built from the stored row", async () => {
  const { provider } = fixture({ features: FEATURES });
  const [item, ...rest] = await inboxOf(provider);
  expect(rest).toEqual([]);
  expect(item).toMatchObject({ id: "question:p1:qs-0123456789ab", group: "decision", kind: "question", actor: "codex", project: "q-project", chip: { text: "question", tone: "warn" }, link: { panel: "agents", params: { project: "p1" } } });
  expect(item.title).toBe("codex asks: Which database should the store use?");
  expect(item.at).toBe(new Date(ROW.created).toISOString());
  const answer = item.verbs.find((verb: any) => verb.id === "answer");
  expect(answer).toMatchObject({ primary: true });
  expect(answer.form.questions).toEqual([
    { id: "db", prompt: "Which database should the store use?", options: [{ id: "pg", label: "Postgres", description: "the default" }, { id: "sqlite", label: "SQLite" }] },
    { id: "extras", prompt: "Which extras?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], multiple: true, other: { maxLength: 500 } },
  ]);
  expect(item.verbs.map((verb: any) => verb.id)).toEqual(["answer", "open"]);
  expect(() => JSON.stringify(item)).not.toThrow();
});

test("without the console features the question is a plain decision item with an open verb and no form", async () => {
  for (const features of [undefined, [], ["inbox.form"], ["action.meta"], ["inbox.result"]]) {
    const { provider } = fixture(features ? { features } : {});
    const [item] = await inboxOf(provider);
    expect(item, JSON.stringify(features)).toMatchObject({ group: "decision", kind: "decision", title: "codex asks: Which database should the store use?", verbs: [{ id: "open", primary: true }] });
    expect(JSON.stringify(item)).not.toContain("\"form\"");
    expect(canAnswerInInbox(features)).toBe(false);
  }
  expect(canAnswerInInbox(FEATURES)).toBe(true);
});

test("a private question's inbox title is a stub: the text is only in the form, the person's own answer surface", async () => {
  const secret = { ...ROW, private: true, questions: [{ id: "q", prompt: "SECRET-PROMPT about patient 900101-1234567?", options: [{ id: "o1", label: "SECRET-LABEL" }, { id: "o2", label: "two" }] }] };
  for (const features of [FEATURES, undefined]) {
    const { provider } = fixture({ rows: [secret], ...(features ? { features } : {}) });
    const [item] = await inboxOf(provider);
    expect(item.title).toBe("codex asks a question");
    const outside = JSON.stringify({ ...item, verbs: item.verbs.map((verb: any) => ({ ...verb, form: undefined })) });
    expect(outside).not.toContain("SECRET");
    expect(outside).not.toContain("900101");
  }
});

test("an answer with the console's person meta is forwarded to the hub as a console-role answer for that item's set, surface acon", async () => {
  const { provider, received } = fixture({ features: FEATURES });
  await inboxOf(provider);
  const result = await provider.action({ action: "answer", id: "question:p1:qs-0123456789ab", answers: ANSWERS }, META);
  expect(result).toEqual({ ok: true, message: "Answered" });
  const sent = received.find(m => m.t === "answer")!;
  expect(sent).toMatchObject({ t: "answer", surface: "acon", questionSet: "qs-0123456789ab", answers: ANSWERS });
  expect(received.some(m => m.t === "ui_action")).toBe(false); // never through the dashboard whitelist
  expect(plugin.manifest.capabilities?.actions).toContain("answer");
});

test("an answer without the person meta is refused before it reaches the hub, however the page dresses it", async () => {
  const { provider, received } = fixture({ features: FEATURES });
  await inboxOf(provider);
  const before = received.length;
  const base = { action: "answer", id: "question:p1:qs-0123456789ab", answers: ANSWERS };
  for (const meta of [undefined, {}, { identity: "local", node: "n", via: "page" }, { identity: "", node: "n", via: "console" }, { identity: "local", via: "console" }, "console"] as unknown[])
    expect(await provider.action(base, meta as never), JSON.stringify(meta)).toMatchObject({ ok: false, error: expect.stringContaining("verified person identity") });
  // fields that would stand in for the console's evidence or retarget the answer are refused even with a real meta
  for (const extra of [{ identity: "attacker" }, { personMeta: META }, { meta: META }, { surface: "console" }, { questionSet: "qs-ffffffffffff" }, { projectId: "p2" }, { instanceId: "i2" }])
    expect(await provider.action({ ...base, ...extra }, META), JSON.stringify(extra)).toMatchObject({ ok: false, error: expect.stringContaining("come from the console") });
  expect(received.length).toBe(before);
  // a console that does not advertise action.meta never gets an answer through, meta or not
  const bare = fixture({ features: ["inbox.form"] });
  expect(await bare.provider.action(base, META)).toMatchObject({ ok: false, error: expect.stringContaining("verified person identity") });
  expect(bare.received.some(m => m.t === "answer")).toBe(false);
});

test("an answer cannot name another item's kind or project, and the hub's refusal for a stale or superseded set is returned with its state", async () => {
  const { provider, received } = fixture({ features: FEATURES, answerReply: { ok: false, error: "question is already superseded", state: "superseded" } });
  await inboxOf(provider);
  for (const id of ["perm:p1:perm-1", "question:p1:not-a-set", "question:p9:qs-0123456789ab", "worktrees:p1", undefined])
    expect(await provider.action({ action: "answer", id, answers: ANSWERS }, META), String(id)).toMatchObject({ ok: false });
  expect(received.some(m => m.t === "answer")).toBe(false);
  const stale = await provider.action({ action: "answer", id: "question:p1:qs-0123456789ab", answers: ANSWERS }, META);
  expect(stale).toEqual({ ok: false, error: "question is already superseded" });
});

test("question items are built only from the rows the hub reports: a malformed row is skipped and the seen time stays stable", async () => {
  const { provider } = fixture({ features: FEATURES, rows: [ROW, { set: 3 }, { set: "qs-aaaaaaaaaaaa", questions: [] }, null] });
  const items = await inboxOf(provider);
  expect(items.map(item => item.id)).toEqual(["question:p1:qs-0123456789ab"]);
  const long = questionItem({ ...ROW, questions: [{ ...ROW.questions[0]!, prompt: `${"x".repeat(900)}\n\u0007bell` }] }, { id: "p1", name: "q-project" }, FEATURES);
  expect(long.title.length).toBeLessThanOrEqual(200);
  expect(long.title).not.toMatch(/[\u0000-\u001f]/);
  expect(personEvidence(FEATURES, META, {})).toEqual({ ok: true, identity: "local" });
});
