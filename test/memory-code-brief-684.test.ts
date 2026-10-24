import { expect, test } from "bun:test";
import { Briefs, type NativeItem } from "../src/memory/brief.ts";
import { MemoryClient } from "../src/memory/client.ts";
const task = { id: 1, title: "public task", refs: { paths: ["src/a.ts"] } };
const item = (id: string, kind = "decision"): NativeItem => ({ id: `mem:${id}`, line: `${kind} ${id}`, kind });
const lines = (text: string | undefined) => text?.split("\n").slice(1);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const A = "a".repeat(32), B = "b".repeat(32);
class Curated extends MemoryClient {
  calls = 0;
  started = deferred();
  gate?: Promise<void>;
  override async search(): Promise<string> { this.calls++; this.started.resolve(); await this.gate; return `| #mem:${A} | now | finding | curated A |\n| #mem:${B} | now | decision | curated B |`; }
  override async timeline(): Promise<undefined> { return undefined; }
}
test("#367 async direct and neighbour notes retain host fails-first order after task-specific plan priority", async () => {
  const plan = item("plan", "fail"), direct = item("direct", "fail"), neighbour = item("neighbour", "fail"), decision = item("direct-decision"), extra = item("neighbour-decision");
  const counts: unknown[] = [], client = new Curated();
  const briefs = new Briefs(client, "fixture", 4, async () => { await Promise.resolve(); return [direct, neighbour, decision, extra]; }, (_peer, _task, count) => counts.push(count));
  expect(lines(await briefs.forTask("codex", task, [plan, plan]))).toEqual([plan.line, direct.line, neighbour.line, decision.line]);
  expect(client.calls).toBe(0); expect(counts).toEqual([{ native: 4, fails: 3, claudeMem: 0 }]);
});
test("#367 awaited native notes dedupe within the brief and across peer deliveries without consuming omitted notes", async () => {
  const a = item("direct", "fail"), b = item("neighbour"), c = item("omitted");
  const briefs = new Briefs(undefined, "fixture", 2, async () => [a, a, b, c]);
  expect(lines(await briefs.forTask("codex", task))).toEqual([a.line, b.line]);
  expect(lines(await briefs.forTask("codex", { ...task, id: 2 }))).toEqual([c.line]);
  expect(await briefs.forTask("codex", { ...task, id: 3 })).toBeUndefined();
  expect(lines(await briefs.forTask("claude", task))).toEqual([a.line, b.line]);
  expect(lines(await briefs.forTask("codex", { ...task, id: 4 }, [a]))).toEqual([a.line]);
});
test("#367 item budget is snapshotted before code-neighbour selection and shared with curated memory", async () => {
  const gate = deferred(), client = new Curated(); let budget = 4;
  const a = item("direct", "fail"), b = item("neighbour");
  const briefs = new Briefs(client, "fixture", () => budget, async () => { await gate.promise; return [a, b]; });
  const pending = briefs.forTask("codex", task); budget = 1; gate.resolve();
  expect(lines(await pending)).toEqual([a.line, b.line, `mem:${A} now finding curated A`, `mem:${B} now decision curated B`]); expect(client.calls).toBe(1);
  budget = 2;
  expect(await briefs.forTask("codex", { ...task, id: 2 })).toBeUndefined();
});
test("#367 a budget change during curated lookup applies to the next brief, with zero respected", async () => {
  const gate = deferred(), client = new Curated(); client.gate = gate.promise; let budget = 3;
  const a = item("direct", "fail"), briefs = new Briefs(client, "fixture", () => budget, async () => [a]);
  const pending = briefs.forTask("codex", task); await client.started.promise; budget = 1; gate.resolve();
  expect(lines(await pending)).toEqual([a.line, `mem:${A} now finding curated A`, `mem:${B} now decision curated B`]);
  budget = 0;
  const zero = new Briefs(undefined, "fixture", () => budget, async () => [a]);
  expect(await zero.forTask("codex", task)).toBeUndefined();
});
test("#367 rejected async native context fails open to plan priority and curated notes", async () => {
  for (const native of [async (): Promise<NativeItem[]> => { throw Error("private raw query failure"); }, (): NativeItem[] => { throw Error("private sync failure"); }]) {
    const client = new Curated(), plan = item("plan", "fail"), briefs = new Briefs(client, "fixture", 2, native);
    const text = await briefs.forTask("codex", task, [plan]);
    expect(lines(text)).toEqual([plan.line, `mem:${A} now finding curated A`]); expect(text).not.toContain("private");
  }
});
test("#367 simultaneous async briefs recheck peer seen entries before final delivery", async () => {
  const gate = deferred(), a = item("shared", "fail"); let call = 0;
  const briefs = new Briefs(undefined, "fixture", 2, async () => { if (++call === 1) await gate.promise; return [a]; });
  const first = briefs.forTask("codex", task), second = briefs.forTask("codex", { ...task, id: 2 });
  expect(lines(await second)).toEqual([a.line]); gate.resolve(); expect(await first).toBeUndefined();
});
test("#367 async native and curated rows share their memory-id dedupe and one item budget", async () => {
  const client = new Curated(), native = { id: `mem:${A}`, line: "native A", kind: "fail" };
  const briefs = new Briefs(client, "fixture", 3, async () => [native]);
  expect(lines(await briefs.forTask("codex", task))).toEqual([native.line, `mem:${B} now decision curated B`]);
});
