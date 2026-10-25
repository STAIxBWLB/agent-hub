import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildIntentBrief, createIntentBriefSource, createStandalonePolicy, looksSecret, MemoryStore, type View } from "@staix/agent-mem";
import { Briefs, type BriefTask, type IntentBriefHost } from "../src/memory/brief.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { mentionsPrivatePath, withoutPii } from "../src/hub/memory-policy.ts";
import { ASK_NOTE_TITLE } from "../src/hub/ask.ts";
import { taskMemoryQueryNodes } from "../src/hub/memory-plan-guard.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(now?: () => number) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-library-brief-")), store = new MemoryStore({ home: join(cwd, "memory"), ...(now ? { now } : {}) });
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 }), routing = loadRouting(cwd);
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", repository: "o/r", routing: () => routing, notify: () => {} });
  cleanup.push(() => { bus.closeJournal(); board.close(); store.close(); rmSync(cwd, { recursive: true, force: true }); });
  let privateTurn = false;
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async function taskIntentBrief("), end = source.indexOf("  const leaseNoticed", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const declaration = (name: string) => {
    const at = source.indexOf(`  const ${name} =`), until = source.indexOf(";\n", at);
    expect(at).toBeGreaterThan(0); expect(until).toBeGreaterThan(at);
    return source.slice(at, until + 1);
  };
  const ports = { board, tasks, memoryStore: store, memoryProject: "fixture", memoryRepo: "o/r", opts: { cwd },
    config: { local: { deny: ["denied/"] }, pii: { paths: ["private/"] } }, configRevision: 1, stopping: false,
    turns: new Map(), contextPii: () => privateTurn, checkMemory: () => {}, createIntentBriefSource,
    looksSecret, ASK_NOTE_TITLE, mentionsPrivatePath, withoutPii, activeRouting: () => routing,
    // Copy only the VM container into this realm; retain the real standalone and host policy checks.
    createStandalonePolicy: (options: Parameters<typeof createStandalonePolicy>[0]) => createStandalonePolicy({ denyPaths: Array.from(options?.denyPaths ?? []), host: { screen: value => options!.host!.screen(value) } }),
    taskNodes: (task: BriefTask) => taskMemoryQueryNodes(task, { cwd, project: "fixture", repo: "o/r" }),
    staleness: () => () => false,
    // Tests below use explicit paths. A code lookup here would be an unintended host effect.
    memoryCode: () => { throw Error("unexpected code lookup"); }, currentMemoryCode: () => { throw Error("unexpected code publication"); },
  };
  // Extract both production predicates verbatim, binding every host helper they reference.
  const derived = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(
    declaration("screenMemory") + "\n" + declaration("boundedSafe") + "\n" + source.slice(start, end)
    + "\nglobalThis.fixture = { host: taskIntentBrief, boundedSafe, screenMemory };") + "\nfixture", ports) as { host: IntentBriefHost; boundedSafe: (text: string) => boolean; screenMemory: (rows: View[]) => View[] };
  const proposed = board.propose(USER, { title: "repair writer", class: "implement", refs: { paths: ["src/writer.ts"] } });
  const task = board.update(proposed.id, USER, "fixture assignment", { owner: "codex", state: "in_progress" });
  const note = (text: string, about = ["path:src/writer.ts"], kind: "fail" | "decision" = "fail") => store.note({ op: "note", project: "fixture", scope: "project", tier: "long", peer: "person", source: "person", kind, text, about });
  return { cwd, store, board, task, host: derived.host, boundedSafe: derived.boundedSafe, screenMemory: derived.screenMemory, note, ports, private(value: boolean) { privateTurn = value; } };
}

test("AC6 hub production brief port equals the released library for the same source and intent", async () => {
  const f = fixture(), failure = f.note("writer retry loses output"), decision = f.note("write through a temporary file", undefined, "decision");
  f.note("private/records must stay private");
  const context = await f.host(f.task);
  const expected = await buildIntentBrief(context.source, context.options);
  const actual = await new Briefs(undefined, "fixture", 8, undefined, undefined, undefined, f.host).forTask("codex", f.task);
  expect(expected.state).toBe("known"); expect(expected.items.map(row => row.id)).toEqual([failure, decision]);
  expect(actual).toBe(expected.text); expect(actual).not.toContain("private/records");
});

test("the production brief predicates exclude model answers, secrets, private paths and denied queries", async () => {
  const f = fixture(), publicNote = f.note("public writer advice");
  const model = f.store.note({ op: "note", project: "fixture", scope: "project", tier: "long", peer: "hub", source: "person", kind: "fail", title: `${ASK_NOTE_TITLE}: writer`, text: "model writer answer", about: ["path:src/writer.ts"] });
  const secret = f.note("writer token: abcdefgh12345678"), privatePath = f.note("writer private/records advice");
  const denied = f.note("writer advice", ["path:src/writer.ts", "path:denied/records.ts"]);
  expect(looksSecret("writer token: abcdefgh12345678")).toBe(true);
  const context = await f.host(f.task), result = await buildIntentBrief(context.source, context.options);
  expect(result.items.map(item => item.id)).toEqual([publicNote]);
  const text = await new Briefs(undefined, "fixture", 8, undefined, undefined, undefined, f.host).forTask("codex", f.task);
  for (const id of [model, secret, privatePath, denied]) expect(text).not.toContain(`mem:${id}`);
  expect(f.boundedSafe("private/records.ts")).toBe(false);
  expect(f.boundedSafe("denied/records.ts")).toBe(false);
  expect(f.boundedSafe("token: abcdefgh12345678")).toBe(false);
  const deniedContext = await f.host({ ...f.task, refs: { paths: ["denied/records.ts"] } });
  expect((await buildIntentBrief(deniedContext.source, deniedContext.options)).text).toBe("");
});

test("assignment briefs retain an older plan fail at the front when the library byte cap omits it", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const f = fixture(() => now), older = f.note("older plan fail");
  for (let index = 0; index < 3; index++) { now += 1000; f.note(`${index} newer writer fail ` + "x".repeat(700)); }
  const context = await f.host(f.task), ranked = await buildIntentBrief(context.source, context.options);
  expect(ranked.items.map(item => item.id)).not.toContain(older);
  expect(ranked.truncated).toBe(true); expect(ranked.state).toBe("known");
  const priority = [{ id: `mem:${older}`, kind: "fail", line: `mem:${older} fail long: original host-screened older plan fail` }];
  const briefs = new Briefs(undefined, "fixture", 2, undefined, undefined, undefined, f.host);
  const text = await briefs.forTask("codex", f.task, priority);
  expect(text?.split("\n")[1]).toBe(priority[0]!.line);
  expect(text?.split("\n")).toHaveLength(3);
  expect((await briefs.forTask("codex", f.task, priority))?.split("\n")[1]).toBe(priority[0]!.line);
});

test("host-screened plan advice survives a narrower standalone library screen", async () => {
  const f = fixture(), id = f.note("writer public maintainer contact maintainer@example.test");
  const row = f.store.get(id);
  expect(row).toBeDefined();
  expect(f.screenMemory([row!]).map(item => item.id)).toEqual([id]);
  expect(f.ports.tasks.publicMetadataText(JSON.stringify(row))).toBe(true);
  const context = await f.host(f.task), result = await buildIntentBrief(context.source, context.options);
  expect(result.state).toBe("known"); expect(result.items).toHaveLength(0);
  const priority = [{ id: `mem:${id}`, line: `mem:${id} fail long: writer public maintainer contact maintainer@example.test`, kind: "fail" }];
  expect((await new Briefs(undefined, "fixture", 1, undefined, undefined, undefined, f.host).forTask("codex", f.task, priority))?.split("\n")[1]).toBe(priority[0]!.line);
});

test("hub delivery removes library rows without losing a neighbour whose direct bridge was already shown", async () => {
  const f = fixture(), bridge = f.note("writer policy", ["path:src/writer.ts", "path:src/helper.ts"], "decision");
  const briefs = new Briefs(undefined, "fixture", 8, undefined, undefined, undefined, f.host);
  expect(await briefs.forTask("codex", f.task)).toContain(`mem:${bridge}`);
  const neighbour = f.note("helper policy", ["path:src/helper.ts"], "decision");
  const context = await f.host(f.task), expected = await buildIntentBrief(context.source, context.options);
  const actual = await briefs.forTask("codex", f.task);
  expect(actual).toContain(`mem:${neighbour}`); expect(actual).not.toContain(`mem:${bridge}`);
  const row = expected.text.split("\n")[expected.items.findIndex(item => item.id === neighbour) + 1]!;
  expect(actual).toBe([expected.text.split("\n")[0]!, row].join("\n"));
  expect(Buffer.byteLength(actual!)).toBeLessThanOrEqual(expected.bytes);
});

test("hub production brief checks current task privacy and policy revision across library awaits", async () => {
  for (const change of ["task", "turn", "policy"] as const) {
    const f = fixture(), id = f.note("ordinary writer advice");
    const host: IntentBriefHost = async task => {
      const context = await f.host(task), policy = context.options.policy();
      return { ...context, options: { ...context.options, policy: () => ({ ...policy, screen: async value => {
        const allowed = await policy.screen(value);
        if (value && typeof value === "object" && "id" in value) {
          if (change === "task") f.board.update(f.task.id, USER, "private", { signals: ["pii"] });
          if (change === "turn") f.private(true);
          if (change === "policy") f.ports.configRevision++;
        }
        return allowed;
      } }) } };
    };
    const priority = [{ id: `mem:${id}`, line: `mem:${id} fail long: ordinary writer advice`, kind: "fail" }];
    expect(await new Briefs(undefined, "fixture", 8, undefined, undefined, undefined, host).forTask("codex", f.task, priority)).toBeUndefined();
  }
});

test("hub library delivery snapshots its cap and serializes peer dedupe", async () => {
  const f = fixture(); f.note("first fail"); f.note("second fail");
  let cap = 1;
  const briefs = new Briefs(undefined, "fixture", () => cap, undefined, undefined, undefined, f.host);
  const first = briefs.forTask("codex", f.task); cap = 0;
  const second = briefs.forTask("codex", f.task);
  expect((await first)?.split("\n")).toHaveLength(2); expect(await second).toBeUndefined();
  cap = 1;
  const next = await briefs.forTask("codex", f.task); expect(next?.split("\n")).toHaveLength(2);
  expect(await briefs.forTask("codex", f.task)).toBeUndefined();
});

test("hub library delivery preserves library order and repeats a selected plan fail once", async () => {
  const f = fixture(), failure = f.note("repeat this fail"), decision = f.note("writer decision", undefined, "decision");
  const context = await f.host(f.task), expected = await buildIntentBrief(context.source, context.options);
  const briefs = new Briefs(undefined, "fixture", 2, undefined, undefined, undefined, f.host);
  const priority = [{ id: `mem:${failure}`, line: "unused old rendering", kind: "fail" }];
  expect(await briefs.forTask("codex", f.task, priority)).toBe(expected.text);
  const repeated = await briefs.forTask("codex", f.task, priority);
  expect(repeated).toContain(`mem:${failure}`); expect(repeated).not.toContain(`mem:${decision}`);
  expect(repeated?.split("\n")).toHaveLength(2);
});
