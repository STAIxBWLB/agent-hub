import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type TaskClass } from "../src/hub/board.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A real board on a temporary file: the sample reads board rows exactly as the live leg does. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-decision-eval-"));
  roots.push(root);
  const board = new Board(join(root, "hub.db"));
  return { board, done: () => board.close() };
}

test("AC5 sample: planner-classified non-PII rows only, newest first, bounded, public text", async () => {
  const { snapshot, EVAL_LIMIT } = await import("../scripts/decision-eval.ts");
  const { board, done } = fixture();
  try {
    const kept = board.propose("claude", { title: "fix the  null\tcheck", detail: "in src/hub/bus.ts", class: "implement" });
    const planned = board.propose("claude", { title: "spec the retry", class: "plan" });
    // Every one of these is dropped before any text is taken, its title included.
    const pii = board.propose("claude", { title: "call Jane Park about the refund", class: "implement", signals: ["pii"] });
    const piiPath = board.propose("claude", { title: "private path work", class: "implement", signals: ["pii", "pii_path"] });
    const triaged = board.propose("claude", { title: "hub-named class", class: "review" });
    board.update(triaged.id, "hub", "triaged", {}, "class review named by the hub's model");
    const defaulted = board.propose("claude", { title: "claim without a class", class: "implement" });
    board.update(defaulted.id, "hub", "class defaulted", {}, "class implement for a claim without one");
    const unknown = board.propose("claude", { title: "custom profile class", class: "experiment" as TaskClass });
    const untitled = board.propose("claude", { title: "   ", class: "test" });

    const { samples, excluded } = snapshot(board.list());
    const ids = samples.map((sample) => sample.id);
    expect(ids).toEqual([planned.id, kept.id]); // newest first; the two the planner named
    for (const dropped of [pii.id, piiPath.id, triaged.id, defaulted.id, unknown.id, untitled.id]) expect(ids).not.toContain(dropped);
    expect(excluded).toMatchObject({ pii: 2, "class not named by the planner": 2, "class outside the closed list": 1, "no title": 1 });
    expect(samples[1]).toMatchObject({ id: kept.id, label: "implement", title: "fix the null check", detail: "in src/hub/bus.ts" });
    // No dropped title survives anywhere in the sample the decider would read.
    expect(JSON.stringify(samples)).not.toContain("Jane Park");

    // The limit takes the newest rows; EVAL_LIMIT bounds a default run.
    expect(snapshot(board.list(), 1).samples.map((sample) => sample.id)).toEqual([planned.id]);
    expect(snapshot(board.list(), 0).samples.map((sample) => sample.id)).toEqual([planned.id]);
    expect(EVAL_LIMIT).toBe(50);
  } finally { done(); }
});

test("AC5 scoring: accuracy over labelled rows, coverage, confusions, misses and latency", async () => {
  const { score } = await import("../scripts/decision-eval.ts");
  const labels: TaskClass[] = ["implement", "implement", "review", "plan", "test"];
  const samples = labels.map((label, i) => ({ id: i + 1, label, title: `t${i}`, detail: "" }));
  const s = score(samples, [
    { label: "implement", ms: 10 },
    { label: "implement", ms: 30 },
    { label: "implement", ms: 20 },
    { label: "plan", ms: 40 },
    { miss: "timeout", ms: 50 },
  ]);
  expect(s).toMatchObject({
    rows: 5, decided: 4, correct: 3, accuracy: 0.75, coverage: 0.8,
    wrong: ["#3 review->implement"], misses: ["#5 (timeout)"], confusion: { "review->implement": 1 },
    latency: { p50: 30, p95: 50, max: 50 },
  });
  // No labelled row is not a perfect score.
  expect(score([samples[0]!], [{ miss: "http", ms: 1 }])).toMatchObject({ decided: 0, accuracy: 0, coverage: 0 });
  expect(score([], [])).toMatchObject({ rows: 0, decided: 0, accuracy: 0, coverage: 0, latency: { p50: 0, p95: 0, max: 0 } });
});

test("AC5 columns: a fake decider drives the comparison end to end, one call per row", async () => {
  const { score, agreement, evaluate } = await import("../scripts/decision-eval.ts");
  const samples = [
    { id: 1, label: "implement" as TaskClass, title: "a", detail: "" },
    { id: 2, label: "review" as TaskClass, title: "b", detail: "" },
    { id: 3, label: "plan" as TaskClass, title: "c", detail: "" },
    { id: 4, label: "test" as TaskClass, title: "d", detail: "" },
  ];
  const asked: { column: string; id: number; title: string }[] = [];
  const results = await evaluate(samples, [
    { name: "baseline", decide: async (sample) => {
      asked.push({ column: "baseline", id: sample.id, title: sample.title });
      if (sample.id === 3) return { miss: "inference unavailable" };
      return { label: sample.id === 2 ? "implement" : sample.label };
    } },
    { name: "decider", decide: async (sample) => {
      asked.push({ column: "decider", id: sample.id, title: sample.title });
      if (sample.id === 4) throw new Error("connection refused");
      return { label: sample.label };
    } },
  ]);
  expect(asked).toHaveLength(8); // one call per column per row, in order
  expect(asked.slice(0, 2)).toEqual([{ column: "baseline", id: 1, title: "a" }, { column: "decider", id: 1, title: "a" }]);
  const baseline = score(samples, results[0]!.verdicts);
  expect(baseline).toMatchObject({ decided: 3, accuracy: 2 / 3, coverage: 0.75, wrong: ["#2 review->implement"], misses: ["#3 (inference unavailable)"] });
  expect(baseline.latency.max).toBeGreaterThanOrEqual(0);
  // A throwing column is a miss, never a failed run.
  expect(score(samples, results[1]!.verdicts)).toMatchObject({ decided: 3, correct: 3, accuracy: 1, misses: ["#4 (Error: connection refused)"] });
  // Rows 1 and 2 are the ones both columns labelled: row 3 is the baseline's miss, row 4 the decider's.
  expect(agreement(results[0]!.verdicts, results[1]!.verdicts)).toEqual({ both: 2, same: 1, share: 0.5 });
});

test("AC5 endpoint guard: the decider may only be a literal loopback adec address", async () => {
  const { isSystemOneEndpoint } = await import("../scripts/decision-eval.ts");
  for (const ok of ["http://127.0.0.1:8740/v1/systemone", "http://127.0.0.1/v1/systemone", "http://[::1]:8740/v1/systemone"]) expect(isSystemOneEndpoint(ok)).toBe(true);
  for (const bad of ["https://127.0.0.1:8740/v1/systemone", "http://localhost:8740/v1/systemone", "http://10.0.0.5:8740/v1/systemone",
    "http://127.0.0.1:8740/v1/route", "http://127.0.0.1:8740/v1/systemone?x=1", "http://user:pw@127.0.0.1:8740/v1/systemone",
    "http://127.0.0.1:99999/v1/systemone", "/v1/systemone", 8740, undefined]) expect(isSystemOneEndpoint(bad)).toBe(false);
});
