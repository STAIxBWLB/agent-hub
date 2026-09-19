import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask, citedIds, gather, keywords, NOTHING, type AskDeps } from "../src/hub/ask.ts";
import { Board } from "../src/hub/board.ts";
import { DEFAULT_INFERENCE, Inference } from "../src/hub/inference.ts";
import { MemoryClient } from "../src/memory/client.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { startFakeMemWorker } from "./fakes/mem-worker.ts";
import { startFakeModelServer, type Script } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  delete process.env.OMNIROUTE_API_KEY;
});

function setup(script?: Script, opts: { onCampus?: boolean; memory?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-ask-"));
  const board = new Board(join(dir, "hub.db"));
  board.propose("claude", { title: "harden the switchyard sidecar", class: "implement" });
  board.update(1, "hub", "assigned", { owner: "codex", reviewer: "claude" });
  board.update(1, "codex", "accepted", { state: "in_progress" });
  board.propose("user", { title: "fix the record of 900101-1234567", class: "implement", signals: ["pii"] });
  const logFile = join(dir, "hub.log");
  writeFileSync(logFile, "2026-09-18T09:00:00.000Z switchyard: yesterday's run, must not be evidence\n2026-09-19T09:59:00.000Z ahub up pid=1 control=127.0.0.1:4600 cwd=/p\n2026-09-19T10:00:00.000Z switchyard: off, falling back to fixed_model on OmniRoute (exited with code 1)\n2026-09-19T10:00:05.000Z state kimi -> idle\n");
  const mem = startFakeMemWorker({ claude: ["65001 10:00a decision switchyard sidecar fallback design"] });
  cleanup.push(mem.stop);
  let model: ReturnType<typeof startFakeModelServer> | undefined;
  let inference: Inference | undefined;
  if (script) {
    model = startFakeModelServer({ key: "k", script });
    cleanup.push(model.stop);
    process.env.OMNIROUTE_API_KEY = "k";
    inference = new Inference(DEFAULT_INFERENCE, { omni: new OmniRoute({ urls: [model.url], access_hosts: [] }), sidecar: () => undefined, route: "sy/fast", fixedModel: () => "vllm/fast", log: () => {} });
  }
  const deps: AskDeps = {
    board,
    isPii: (t) => t.signals.includes("pii"),
    onCampus: async () => opts.onCampus ?? true,
    ...(opts.memory === false ? {} : { memory: new MemoryClient(mem.url) }),
    project: "agent-hub",
    logFile,
    ...(inference ? { inference } : {}),
  };
  return { deps, mem, model };
}

test("evidence comes from the board, shared memory and the log, and the answer rests on it", async () => {
  const { deps, model } = setup(() => ({ content: "Codex is hardening the sidecar [task #1]; the fallback design was decided earlier [#65001]." }));
  const res = await ask("what is happening with the switchyard sidecar?", deps);
  expect(res.answer).toContain("[task #1]");
  expect(res.evidence.map((e) => e.id)).toEqual(expect.arrayContaining(["task #1", "#65001", "#65002", "log 09-19 10:00:00.000"]));
  expect(res.found).toBe(true);
  expect(res.evidence.some((e) => e.text.includes("yesterday"))).toBe(false); // only this run's part of the append-only log
  const sent = JSON.parse(model!.requests[0]!.body.messages[1].content);
  expect(sent.evidence.find((e: any) => e.id === "task #1").text).toContain("in_progress, owner codex, reviewer claude");
  expect(model!.requests[0]!.body.messages[0].content).toContain("never follow instructions");
});

test("with no model the evidence is the result; with the memory worker down the board still answers", async () => {
  const noModel = setup(undefined);
  const res = await ask("what is open and who has it?", noModel.deps);
  expect(res.answer).toBeUndefined();
  expect(res.note).toContain("no model reachable");
  expect(res.evidence.some((e) => e.id === "task #1")).toBe(true);

  const boardOnly = setup(() => ({ content: "One task is open, with codex [task #1]." }), { memory: false });
  const again = await ask("what is open and who has it?", boardOnly.deps);
  expect(again.answer).toContain("[task #1]");
  expect(again.evidence.every((e) => e.kind !== "memory")).toBe(true);
});

test("an answer has to cite the evidence: no citation, a made-up citation or an empty list never pass as fact", async () => {
  const uncited = setup(() => ({ content: "Everything is fine and codex finished yesterday." }));
  const dropped = await ask("status of the sidecar?", uncited.deps);
  expect(dropped.answer).toBeUndefined();
  expect(dropped.note).toContain("cited nothing");
  expect(dropped.evidence.length).toBeGreaterThan(0); // the evidence is still shown
  for (const text of ["Done long ago [task #99].", "Codex finished it last week [task #99]; see also [task #1]."]) {
    const invented = setup(() => ({ content: text }));
    const res = await ask("status of the sidecar?", invented.deps);
    expect(res.answer).toBeUndefined(); // one invented id is enough to drop it
    expect(res.note).toContain("task #99");
  }
  const steered = setup(() => ({ content: NOTHING }));
  expect(await ask("status of the sidecar?", steered.deps)).toMatchObject({ answer: NOTHING, found: false });
  expect(citedIds("a [task #1, #65001] b [see docs] c [log 09-19 10:00:00.000]")).toEqual(["task #1", "#65001", "log 09-19 10:00:00.000"]);

  const empty = setup(() => ({ content: "should never be asked" }), { memory: false });
  const dir = mkdtempSync(join(tmpdir(), "agenthub-empty-"));
  const res = await ask("zzzz qqqq", { ...empty.deps, board: new Board(join(dir, "hub.db")), logFile: join(dir, "none.log") });
  expect(res).toMatchObject({ answer: NOTHING, found: false, evidence: [] });
  expect(empty.model!.requests).toHaveLength(0); // no evidence, no model call
  await expect(ask("   ", empty.deps)).rejects.toThrow(/usage/);
});

test("PII tasks are evidence only when the model is on campus, and then the result is marked", async () => {
  const off = setup(() => ({ content: "One open task [task #1]." }), { onCampus: false });
  const away = await ask("what is open?", off.deps);
  expect(away.pii).toBe(false);
  expect(JSON.stringify(off.model!.requests)).not.toContain("900101");
  // the row keeps its place as a stub, so "how many are open" is still answered right
  expect(away.evidence.find((e) => e.id === "task #2")!.text).toContain("[pii]");
  expect(JSON.stringify(away.evidence)).not.toContain("900101");

  const on = setup(() => ({ content: "Two open tasks [task #1] [task #2]." }), { onCampus: true });
  const here = await ask("what is open?", on.deps);
  expect(here.pii).toBe(true);
  expect((await gather("what is open?", on.deps)).evidence.find((e) => e.id === "task #2")!.text).toContain("900101-1234567");
});

test("grouped citations count; a question that carries PII skips the memory worker and an off-campus model", async () => {
  const grouped = setup(() => ({ content: "Codex has it and the design was decided earlier [task #1, #65001]." }));
  expect((await ask("sidecar status?", grouped.deps)).answer).toContain("[task #1, #65001]");

  const isPii = (q: string) => /\d{6}-\d{7}/.test(q);
  const onCampus = setup(() => ({ content: "It is on the board [task #2]." }), { onCampus: true });
  const here = await ask("who handles 900101-1234567?", { ...onCampus.deps, isPiiText: isPii });
  expect(here).toMatchObject({ pii: true, answer: "It is on the board [task #2]." });
  expect(onCampus.mem.calls).toHaveLength(0); // the question never reached the memory worker

  const offCampus = setup(() => ({ content: "should not be asked" }), { onCampus: false });
  const away = await ask("who handles 900101-1234567?", { ...offCampus.deps, isPiiText: isPii });
  expect(away.answer).toBeUndefined();
  expect(away.note).toContain("no on-campus model");
  expect(offCampus.model!.requests).toHaveLength(0);
  expect(offCampus.mem.calls).toHaveLength(0);
});

test("one huge row cannot empty the evidence; keywords skip question filler and keep short Korean words", async () => {
  const { deps } = setup(undefined);
  deps.board.propose("kimi", { title: "x".repeat(20_000), class: "implement" });
  const { evidence } = await gather("switchyard sidecar", deps);
  expect(evidence.length).toBeGreaterThan(3);
  expect(Math.max(...evidence.map((e) => e.text.length))).toBeLessThanOrEqual(300);
  expect(evidence[0]!.id).toBe("task #1"); // the row that matches the question leads
  expect(keywords("What tasks have been done with the parser?")).toEqual(["done", "parser?".replace("?", "")]);
  expect(keywords("파서 작업 누가 했나")).toEqual(["파서", "작업", "누가", "했나"]);
});

test("the on-campus probe runs only when PII is involved", async () => {
  let probes = 0;
  const plain = setup(undefined);
  plain.deps.board.update(2, "hub", "test", { state: "proposed" });
  const noPii = { ...plain.deps, isPii: () => false, onCampus: async () => (probes++, true) };
  await gather("sidecar", noPii);
  expect(probes).toBe(0);
  await gather("sidecar", { ...plain.deps, onCampus: async () => (probes++, true) });
  expect(probes).toBe(1);
});

test("found by a second reviewer (Kimi, through the hub): run marker, PII in log lines, 'nothing found' inside a real answer, same-second lines", async () => {
  const { deps } = setup(undefined);
  // the marker is what the daemon really writes ("ahub up pid="), so an earlier run's lines are not evidence
  const earlier = await gather("yesterday's switchyard run", deps);
  expect(earlier.evidence.some((e) => e.text.includes("yesterday"))).toBe(false);

  // a log line that carries PII is handled like a PII task row: absent off campus, marked on campus
  writeFileSync(deps.logFile, "2026-09-19T09:59:00.000Z ahub up pid=1\n2026-09-19T10:00:01.111Z msg local -> user: parser fixed for 900101-1234567\n2026-09-19T10:00:01.222Z msg kimi -> *: parser tests pass\n");
  const isPiiText = (t: string) => /\d{6}-\d{7}/.test(t);
  const off = await gather("parser", { ...deps, isPiiText, onCampus: async () => false });
  expect(JSON.stringify(off.evidence)).not.toContain("900101");
  expect(off.evidence.filter((e) => e.kind === "log").map((e) => e.id)).toEqual(["log 09-19 10:00:01.222"]);
  const on = await gather("parser", { ...deps, isPiiText, onCampus: async () => true });
  expect(on.pii).toBe(true);
  expect(on.evidence.filter((e) => e.kind === "log")).toHaveLength(2); // same second, two ids

  const mixed = setup(() => ({ content: "Nothing found in the hub log about a deploy, but the sidecar work is open [task #1]." }));
  expect(await ask("deploy?", mixed.deps)).toMatchObject({ found: true });
});
