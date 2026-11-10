import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import type { Lifecycle, ProjectRecord } from "../src/hub/manager.ts";
import { createProvider } from "../src/ui/plugin.ts";

// #1221 T2 AC5: an advisory supervision proposal reaches the console's existing inbox, and its two verbs reach the
// hub's own `supervision` action as the person. The hub is scripted: the snapshot carries the field the daemon sends only
// in advisory mode, and the `ui_action` it receives is what this file asserts. Nothing here runs a real hub or a worker.

const dirs: string[] = [], servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PROPOSAL = {
  id: "sup-0123456789ab", task: 42, rule: "repeated_failure", version: 1, revision: "1:none", trigger: "failures:check:implement",
  refs: ["history:4", "history:6"], limits: { records: 5, truncated: false }, action: "escalate", reason: "repeated_failure",
  state: "pending", created: 1_790_000_000_000,
};

function fixture(options: { supervision?: unknown; answer?: Record<string, unknown> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ahub-supervision-inbox-")); dirs.push(home);
  const project: ProjectRecord = { id: "a", root: "/tmp/a-project", stateDir: join(home, "a"), basePort: 4700, instanceId: "i-a", pid: 42 };
  const actions: Record<string, unknown>[] = [];
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, data) {
      const m = JSON.parse(String(data));
      if (m.t === "hello") return void ws.send(JSON.stringify({ rid: m.rid, t: "welcome", cwd: project.root, projectId: project.id, instanceId: project.instanceId }));
      if (m.t === "ui_snapshot") {
        return void ws.send(JSON.stringify({ rid: m.rid, ok: true, cursor: 1, peers: {}, permissions: [], tasks: [], questions: [], status: { peers: {} }, events: [],
          ...(options.supervision === undefined ? {} : { supervision: options.supervision }) }));
      }
      if (m.t === "ui_action") { actions.push(m.action as Record<string, unknown>); return void ws.send(JSON.stringify({ rid: m.rid, ok: true, ...(options.answer ?? {}) })); }
    },
  } });
  servers.push(hub);
  mkdirSync(project.stateDir, { recursive: true });
  writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: project.id, instanceId: project.instanceId }));
  writeFileSync(join(project.stateDir, "control-token"), "scripted-token");
  const projects = [project];
  const registry = { get: (id: string) => projects.find((candidate) => candidate.id === id), list: () => projects, close() {} } as never;
  const lifecycle: Lifecycle = {
    inspectProject: async (row) => ({ state: "running", status: { instanceId: (row as ProjectRecord).instanceId, peers: {} } }) as never,
    startProject: async () => ({}), stopProject: async () => {},
  };
  const provider = createProvider({ home, registry: registry as never, lifecycle, inboxFreshMs: 60_000, inboxStaleMs: 60_000 });
  const inbox = async () => await provider.snapshot({ after: 0, panel: "inbox" }) as { items: { id: string; group: string; kind: string; title: string; detail?: string; project?: string; at: string; chip?: { text: string; tone: string }; verbs: { id: string; label: string; primary?: boolean }[]; link: { panel: string; params?: Record<string, string> } }[]; more: number };
  return { provider, inbox, actions };
}

const advisory = (proposals: unknown[] = [PROPOSAL]) => ({ mode: "advisory", proposals });

test("AC5: an advisory snapshot becomes one inbox row offering the hub's two verbs and no other", async () => {
  const f = fixture({ supervision: advisory() });
  const reply = await f.inbox();
  const item = reply.items.find((row) => row.kind === "supervision");
  expect(item).toEqual({
    id: "supervision:a:sup-0123456789ab", group: "candidate", kind: "supervision", title: "#42: escalate",
    detail: "repeated_failure (repeated_failure)", project: "a-project", at: "2026-09-21T14:13:20.000Z",
    chip: { text: "supervision", tone: "neutral" }, verbs: [{ id: "supervision_accept", label: "Accept", primary: true }, { id: "supervision_dismiss", label: "Dismiss" }],
    link: { panel: "board", params: { project: "a" } },
  });
  expect(f.actions).toEqual([]); // a poll decides nothing
});

test("off and shadow add no row, and a row that is not a supervision proposal is dropped, never rendered", async () => {
  expect((await fixture().inbox()).items.filter((row) => row.kind === "supervision")).toEqual([]);
  expect((await fixture({ supervision: { mode: "shadow", proposals: [PROPOSAL] } }).inbox()).items.filter((row) => row.kind === "supervision")).toEqual([]);
  const malformed = fixture({ supervision: advisory([{ ...PROPOSAL, id: "sup-nope" }, { ...PROPOSAL, id: "sup-ffffffffffff", task: "42" }, null]) });
  expect((await malformed.inbox()).items.filter((row) => row.kind === "supervision")).toEqual([]);
});

test("a dismissal reaches the hub as the person's own decision and runs nothing", async () => {
  const f = fixture({ supervision: advisory(), answer: { proposal: { ...PROPOSAL, state: "dismissed" } } });
  await f.inbox();
  const result = await f.provider.action({ action: "supervision_dismiss", id: "supervision:a:sup-0123456789ab", projectId: "a" });
  expect(result).toEqual({ ok: true, message: "Dismissed" });
  expect(f.actions).toEqual([{ action: "supervision", projectId: "a", instanceId: "i-a", id: "sup-0123456789ab", verb: "dismiss" }]);
});

test("an acceptance is confirmed first, then reaches the hub with the accept verb and reports the receipt it got", async () => {
  const f = fixture({ supervision: advisory(), answer: { receipt: { outcome: "ran", detail: "escalate", at: 1_790_000_000_000 } } });
  await f.inbox();
  const input = { action: "supervision_accept", id: "supervision:a:sup-0123456789ab", projectId: "a" };
  const asked = await f.provider.action(input);
  expect(asked).toMatchObject({ ok: false, needsConfirm: true, verb: "supervision_accept" });
  if (asked.ok !== false || !("needsConfirm" in asked)) return;
  expect(asked.preview).toEqual(["Accept a supervision proposal in a-project and run the action it names once."]);
  expect(f.actions).toEqual([]);
  const accepted = await f.provider.action({ ...input, confirmed: true, fingerprint: asked.fingerprint });
  expect(accepted).toEqual({ ok: true, message: "Accepted and run" });
  expect(f.actions).toEqual([{ action: "supervision", projectId: "a", instanceId: "i-a", id: "sup-0123456789ab", verb: "accept" }]);
});

test("an acceptance the hub could not observe says so, and a refusal is passed through", async () => {
  const unknown = fixture({ supervision: advisory(), answer: { receipt: { outcome: "unknown", at: 1_790_000_000_000 } } });
  await unknown.inbox();
  const input = { action: "supervision_accept", id: "supervision:a:sup-0123456789ab", projectId: "a" };
  const asked = await unknown.provider.action(input);
  if (asked.ok !== false || !("needsConfirm" in asked)) throw new Error("expected a confirm step");
  expect(await unknown.provider.action({ ...input, confirmed: true, fingerprint: asked.fingerprint })).toEqual({ ok: true, message: "Accepted; the outcome is unconfirmed, check the task" });

  const refused = fixture({ supervision: advisory(), answer: { ok: false, error: "the task moved to another revision; the proposal expired" } });
  await refused.inbox();
  expect(await refused.provider.action({ action: "supervision_dismiss", id: "supervision:a:sup-0123456789ab", projectId: "a" }))
    .toEqual({ ok: false, error: "the task moved to another revision; the proposal expired" });
  // An id that names no supervision proposal of this project is refused before anything is forwarded.
  expect(await refused.provider.action({ action: "supervision_dismiss", id: "supervision:a:perm-1", projectId: "a" })).toEqual({ ok: false, error: "unknown inbox item" });
});
