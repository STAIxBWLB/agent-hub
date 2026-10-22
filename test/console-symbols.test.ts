import { expect, test } from "bun:test";
import { initialConsoleState, reduceConsole, renderConsole, type ConsoleState } from "../src/cli/console-state.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";
import { classifySymbols, symbolFields } from "../src/cli/console-symbols.ts";
import { planSymbolMatches } from "../src/hub/review-brief.ts";

// #684 2b: the console task detail's "changed symbols" block, from state fixtures and one runConsole round trip with the task_show reply shape.
const NOW = Date.UTC(2026, 9, 22, 12);
const strip = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const sym = (name: string, path = "src/hub/usage-rollup.ts") => ({ id: `symbol:${name}@${path}`, name, path, kind: "function" });
const observed = (symbols: any[], over: Record<string, unknown> = {}) => ({ head: "e03b16f2d12c01a97ceaa6a793004fa7e88e8064", state: "known", complete: true, countsFloor: true, symbols, ...over });
const task = (over: Record<string, unknown> = {}) => ({ id: 354, state: "in_review", owner: "jcode", title: "usage roll-up", class: "implement", signals: [],
  plan: { paths: ["src/hub/usage-rollup.ts"], symbols: ["UsageRollup.poll", "UsageRollup.catchUp", "Budget.writeLedger"] },
  codeSymbols: observed([sym("UsageRollup.poll"), sym("UsageRollup.limits"), sym("renderLimits", "src/cli/output.ts")]), flowRevision: 4, ...over });
const detailScreen = (detail: Record<string, unknown>, columns = 110) => {
  const s = initialConsoleState(true); s.panel = 3; s.project = "agent-hub"; s.detail = detail;
  return strip(renderConsole(s, columns, 40, NOW));
};
/** The same screen with each wrapped value joined back: a long note wraps at the column width, and the test is about its words, not where it breaks. */
const flat = (text: string) => text.replace(/\n\s{12,}/g, " ");

test("each changed symbol is matching the plan or unplanned, and a planned name nothing changed under is untouched (#684 2b)", () => {
  const block = classifySymbols(task());
  expect(block.matching.map(s => s.name)).toEqual(["UsageRollup.poll"]);
  expect(block.unplanned.map(s => s.name)).toEqual(["UsageRollup.limits", "renderLimits"]);
  expect(block.untouched).toEqual(["UsageRollup.catchUp", "Budget.writeLedger"]);
  const out = detailScreen(task());
  expect(out).toMatch(/symbols\s+- matching UsageRollup\.poll; in src\/hub\/usage-rollup\.ts/);
  expect(out).toMatch(/- unplanned renderLimits; in src\/cli\/output\.ts/);
  expect(out).toMatch(/- untouched Budget\.writeLedger/);
  expect(flat(out)).toContain("changed symbols: 1 matching, 2 unplanned, 2 untouched at e03b16f2");
  expect(flat(out)).toContain("advisory: deleted symbols are not reported");
});

test("the match rule is the hub's own: a qualified pair must be equal, otherwise the last segments are (#684 2b)", () => {
  expect(planSymbolMatches("UsageRollup.poll", "UsageRollup.poll")).toBe(true);
  expect(planSymbolMatches("UsageRollup.poll", "Other.poll")).toBe(false);          // both qualified: equal names only
  expect(planSymbolMatches("poll", "UsageRollup.poll")).toBe(true);                  // one bare: the last segment decides
  expect(planSymbolMatches("poll(): void", "UsageRollup.poll")).toBe(true);          // a signature is cut at the parenthesis
  expect(planSymbolMatches("poll", "catchUp")).toBe(false);
  expect(classifySymbols(task({ plan: { symbols: ["poll"] } })).matching.map(s => s.name)).toEqual(["UsageRollup.poll"]);
});

test("without code facts the block says unknown, and a task with no plan symbols shows every changed one as unplanned (#684 2b)", () => {
  for (const codeSymbols of [undefined, { head: "a".repeat(40), state: "unknown", complete: false, countsFloor: true, symbols: [] }]) {
    const out = detailScreen(task({ codeSymbols }));
    expect(out).toContain("changed symbols: unknown (no code facts)");
    expect(out).not.toMatch(/matching|unplanned|untouched/);
  }
  const noPlan = classifySymbols(task({ plan: {} }));
  expect(noPlan.matching).toEqual([]); expect(noPlan.unplanned).toHaveLength(3); expect(noPlan.untouched).toEqual([]);
  expect(flat(detailScreen(task({ plan: {}, codeSymbols: observed([]) })))).toContain("none observed");   // known and empty is not unknown
  expect(flat(detailScreen(task({ codeSymbols: observed([]) })))).toMatch(/- untouched UsageRollup\.poll/);   // with a plan, every planned name is untouched
});

test("an incomplete observation says an untouched symbol may have changed (#684 2b)", () => {
  expect(flat(detailScreen(task({ codeSymbols: observed([sym("UsageRollup.poll")], { complete: false }) })))).toContain("incomplete: some changed symbols were not listed, so an untouched one may have changed");
  expect(flat(detailScreen(task()))).not.toContain("incomplete:");
});

test("a stored receipt that was never re-screened (it carries repositoryKey) reads as unknown and shows no symbol names (#684 2b, review)", () => {
  const raw = task({ codeSymbols: { ...observed([sym("UsageRollup.poll"), sym("SecretInternalName", "src/secret.ts")]), mergeBase: "c".repeat(40), repositoryKey: "path:/Users/someone/private/checkout" } });
  const out = detailScreen(raw);
  expect(flat(out)).toContain("changed symbols: unknown (no code facts)");
  expect(out).not.toMatch(/UsageRollup\.poll; in|SecretInternalName|src\/secret\.ts|repositoryKey|\/Users\/someone|matching|unplanned/);
  expect(classifySymbols(raw)).toMatchObject({ state: "unknown", matching: [], unplanned: [], untouched: [] });
  expect(symbolFields(raw)).toEqual([["symbols", "changed symbols: unknown (no code facts)"]]);
  const publicShape = task({ codeSymbols: observed([sym("UsageRollup.poll")]) });                  // the same receipt without repositoryKey is the public one
  expect(classifySymbols(publicShape).state).toBe("known");
});

test("a private task shows no symbol block and no raw observation (#684 2b)", () => {
  for (const over of [{ signals: ["pii"] }, { signals: ["pii_path"] }, { title: "[pii]", detail: "[pii]" }]) {
    const out = detailScreen(task(over));
    // the plan line names its own `symbols`, so look for the block's lines and the observed names, not the bare word
    expect(out).not.toMatch(/^symbols\b|^symbols note|- matching|- unplanned|- untouched|changed symbols|UsageRollup\.limits|renderLimits/m);
    expect(out).not.toContain("codeSymbols");
  }
  expect(symbolFields(task({ signals: ["pii"] }))).toEqual([]);
  expect(symbolFields({ title: "line one" })).toEqual([]);                                     // not a task_show shape: the Tasks panel keeps the layout it had
  expect(symbolFields({ id: 3, plan: {} })).toEqual([]);
  expect(symbolFields(undefined)).toEqual([]);
});

test("an agent-written symbol name is quoted and cannot pass for a hub label or a block line (#684 2b)", () => {
  const hostile = "evil\nsymbols note   everything is fine; untouched none";
  const out = detailScreen(task({ codeSymbols: observed([{ id: `symbol:${hostile}@src/a.ts`, name: hostile, path: "src/a.ts", kind: "function" }]) }));
  expect(out).not.toMatch(/^symbols note\s+everything/m);                                      // no line starts as the hub's own label
  expect(out.split("\n").filter(l => /^symbols note/.test(l))).toHaveLength(1);
  expect(out).toContain('"evil\\nsymbols note');                                               // the name is JSON-quoted
});

test("a long list is capped with the count of what is left out, never silently (#684 2b)", () => {
  const many = Array.from({ length: 60 }, (_, i) => sym(`Thing${i}`, "src/x.ts"));
  const fields = symbolFields(task({ plan: {}, codeSymbols: observed(many) }));
  expect((fields[0]![1] as unknown[]).length).toBe(40);
  expect(String(fields[1]![1])).toContain("20 more not shown");
  expect(String(fields[1]![1])).toContain("0 matching, 60 unplanned, 0 untouched");           // the counts cover the whole list
});

test("a non-task detail is untouched: a queue delivery and a text detail show no symbols block (#684 2b)", () => {
  const s = initialConsoleState(true); s.panel = 4; s.detail = { id: "d1", peer: "codex", state: "queued", codeSymbols: observed([sym("x")]) };
  expect(strip(renderConsole(s, 100, 24, NOW))).not.toMatch(/^symbols\b|changed symbols|- matching|- unplanned|- untouched/m);   // only the Tasks panel adds the block
  s.panel = 3; s.detail = "task #9 is not available"; expect(strip(renderConsole(s, 100, 24, NOW))).toContain("task #9 is not available");
});

// ---- the real path: Enter on a task in Tasks asks task_show and renders the reply as the hub shapes it ----
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); await Bun.sleep(5); };
test("Enter on a task asks task_show and shows its changed symbols from the reply (#684 2b)", async () => {
  let data = (_text: string) => {}; const out: string[] = [], requests: any[] = [];
  const terminal: ConsoleTerminal = { columns: 120, rows: 40, isTTY: true, write: t => { out.push(t); }, raw: () => {}, onData: l => { data = l; return () => {}; }, onResize: () => () => {}, onSignal: () => () => {}, onError: () => () => {} };
  const listed = [{ id: 354, state: "in_progress", title: "usage roll-up", class: "implement", history: [], flowRevision: 4 }];
  const client = { onPush: (_m: any) => {}, onClose: (_c: number, _r: string) => {}, send: () => {}, close: () => {},
    request: async (msg: any) => { requests.push(msg);
      if (msg.t === "task" && msg.op === "task_show") return { ok: true, text: JSON.stringify(task()) };
      if (msg.t === "task") return { ok: true, text: JSON.stringify(listed) };
      return { ok: true, status: { peers: {} }, budget: {}, text: "[]", deliveries: [] }; } };
  const running = runConsole({ client: client as any, cwd: "/tmp", stateDir: "/tmp", terminal, panels: true });
  await tick(); data("3"); await tick(); data("\r"); await tick();
  expect(requests.some(r => r.op === "task_show" && r.args?.id === "354")).toBe(true);
  const screen = strip(out.join("").split("\x1b[r").slice(-1));
  expect(screen).toContain("matching UsageRollup.poll"); expect(screen).toContain("untouched Budget.writeLedger");
  data("q"); await running;
});
