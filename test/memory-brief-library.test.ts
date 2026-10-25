import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildIntentBrief, createIntentBriefSource, createStandalonePolicy, MemoryStore } from "@staix/agent-mem";
import { Briefs, type BriefTask, type IntentBriefHost } from "../src/memory/brief.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { withoutPii } from "../src/hub/memory-policy.ts";
import { taskMemoryQueryNodes } from "../src/hub/memory-plan-guard.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-library-brief-")), store = new MemoryStore({ home: join(cwd, "memory") });
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 }), routing = loadRouting(cwd);
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", repository: "o/r", routing: () => routing, notify: () => {} });
  cleanup.push(() => { bus.closeJournal(); board.close(); store.close(); rmSync(cwd, { recursive: true, force: true }); });
  let privateTurn = false;
  const screenMemory = <T extends { title: string | null; text: string }>(rows: T[]) => withoutPii(rows, routing, cwd, ["private/"]);
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async function taskIntentBrief("), end = source.indexOf("  const leaseNoticed", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const ports = { board, tasks, memoryStore: store, memoryProject: "fixture", memoryRepo: "o/r", opts: { cwd },
    config: { local: { deny: [] } }, configRevision: 1, stopping: false,
    turns: new Map(), contextPii: () => privateTurn, checkMemory: () => {}, createIntentBriefSource,
    // Copy only the VM container into this realm; retain the real standalone and host policy checks.
    createStandalonePolicy: (options: Parameters<typeof createStandalonePolicy>[0]) => createStandalonePolicy({ denyPaths: Array.from(options?.denyPaths ?? []), host: { screen: value => options!.host!.screen(value) } }),
    taskNodes: (task: BriefTask) => taskMemoryQueryNodes(task, { cwd, project: "fixture", repo: "o/r" }),
    screenMemory, boundedSafe: (text: string) => screenMemory([{ title: null, text }]).length === 1,
    staleness: () => () => false,
    // Tests below use explicit paths. A code lookup here would be an unintended host effect.
    memoryCode: () => { throw Error("unexpected code lookup"); }, currentMemoryCode: () => { throw Error("unexpected code publication"); },
  };
  const host = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end) + "\nglobalThis.host = taskIntentBrief;") + "\nhost", ports) as IntentBriefHost;
  const task = board.propose(USER, { title: "repair writer", class: "implement", owner: "codex", refs: { paths: ["src/writer.ts"] } });
  const note = (text: string, about = ["path:src/writer.ts"], kind: "fail" | "decision" = "fail") => store.note({ op: "note", project: "fixture", scope: "project", tier: "long", peer: "person", source: "person", kind, text, about });
  return { cwd, store, board, task, host, note, ports, private(value: boolean) { privateTurn = value; } };
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
    const f = fixture(); f.note("ordinary writer advice");
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
    expect(await new Briefs(undefined, "fixture", 8, undefined, undefined, undefined, host).forTask("codex", f.task)).toBeUndefined();
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
