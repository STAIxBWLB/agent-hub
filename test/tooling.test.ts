import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StampedEvent } from "../src/hub/events.ts";
import { addonReport, formatAddons, taskRecords, type TaskRecord } from "../src/hub/research.ts";
import { ADDONS, addonState, detectTooling } from "../src/hub/tooling.ts";

// #248: which add-ons each peer works with, carried into the research records, and the on/off comparison.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `ahub-tooling-${name}-`))); dirs.push(d); return d; };
const MARKER = "SECRET-ADDON-CONTENT-7f3a";

/** A home with Claude and Codex inventories whose content carries a marker that must never leave them. */
function inventory(opts: { claude?: Record<string, boolean>; codex?: string } = {}) {
  const home = temp("home"), bin = temp("bin");
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: opts.claude ?? {}, env: { TOKEN: MARKER } }));
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "claude-mem@thedotmack": [{ scope: "user", version: "13.29.0", installPath: `/x/${MARKER}` }],
    "ponytail@ponytail": [{ scope: "user", version: `4.10.0 ${MARKER}` }], // not a version: recorded as unknown
    "codex@openai-codex": [{ scope: "user", version: "1.0.6" }],
    "open-code-review@open-code-review": [{ scope: "project", projectPath: "/elsewhere", version: "2.0.0" }],
    "frontend-design@claude-plugins-official": [{ scope: "user", version: "1.0.0" }],
  } }));
  if (opts.codex !== undefined) { mkdirSync(join(home, ".codex", "plugins", "cache", "claude-mem-local", "claude-mem", "13.29.0"), { recursive: true }); writeFileSync(join(home, ".codex", "config.toml"), opts.codex); }
  return { home, bin };
}
const exe = (dir: string, name: string) => { writeFileSync(join(dir, name), `#!/bin/sh\necho ${MARKER}\n`); chmodSync(join(dir, name), 0o755); };

test("detection reads names and versions from the closed list, per runtime, and nothing else", async () => {
  const { home, bin } = inventory({ claude: { "claude-mem@thedotmack": true, "ponytail@ponytail": true, "codex@openai-codex": false, "open-code-review@open-code-review": true, "frontend-design@claude-plugins-official": true },
    codex: `[plugins."documents@x"]\nenabled = true\n\n[plugins."ponytail@ponytail"]\nenabled = false\n\n[hooks.state."claude-mem@claude-mem-local:hooks/codex-hooks.json:stop:0:0"]\ntrusted_hash = "${MARKER}"\n` });
  exe(bin, "ripwire");
  writeFileSync(join(bin, "dot"), "not executable");
  // Graphviz's `dot` is not resource admission; the dotfiles one reports its version (review of #351).
  const graphviz = temp("graphviz"), admit = temp("admit");
  writeFileSync(join(graphviz, "dot"), "#!/bin/sh\necho 'dot - graphviz version 12.1.0' >&2\nexit 1\n"); chmodSync(join(graphviz, "dot"), 0o755);
  writeFileSync(join(admit, "dot"), "#!/bin/sh\necho 'dot version 2.70.38 (59a6cc7)'\n"); chmodSync(join(admit, "dot"), 0o755);
  expect(await detectTooling("pi", { home, path: graphviz })).toEqual([]);
  expect(await detectTooling("pi", { home, path: [admit, graphviz].join(":") })).toEqual([{ name: "dot-admit", version: "2.70.38" }]);
  expect(await detectTooling("pi", { home, path: [graphviz, admit].join(":") })).toEqual([]); // the first on PATH is the one a shell runs
  // A disabled plugin, a project-scoped install for another project and a plugin outside the list do not count.
  expect(await detectTooling("claude", { home, cwd: "/project", path: bin })).toEqual([{ name: "claude-mem", version: "13.29.0" }, { name: "ponytail", version: null }, { name: "ripwire", version: null }]);
  expect(await detectTooling("codex", { home, path: bin })).toEqual([{ name: "claude-mem", version: "13.29.0" }, { name: "ripwire", version: null }]);
  // Peers without a plugin inventory see only what is on PATH.
  expect(await detectTooling("kimi", { home, path: bin })).toEqual([{ name: "ripwire", version: null }]);
  expect(await detectTooling("pi", { home, path: "" })).toEqual([]);
  // The project's own settings switch a plugin for this project.
  const project = temp("project");
  mkdirSync(join(project, ".claude"));
  writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "claude-mem@thedotmack": false } }));
  expect((await detectTooling("claude", { home, cwd: project, path: "" })).map((a) => a.name)).toEqual(["ponytail"]);
  // No inventory at all is no add-on, never an error.
  expect(await detectTooling("claude", { home: temp("empty"), path: "" })).toEqual([]);
  for (const peer of ["claude", "codex", "kimi"]) expect(JSON.stringify(await detectTooling(peer, { home, cwd: "/project", path: bin }))).not.toContain(MARKER);
  // A `dot` that ignores SIGTERM and never answers is not admission, and the probe ends at its deadline (review of #351).
  const stuck = temp("stuck");
  writeFileSync(join(stuck, "dot"), "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n"); chmodSync(join(stuck, "dot"), 0o755);
  const started = Date.now();
  expect(await detectTooling("pi", { home, path: stuck })).toEqual([]);
  expect(Date.now() - started).toBeLessThan(5000);
}, 15_000);

let clock = Date.parse("2026-10-10T00:00:00Z");
const at = () => new Date(clock += 60_000).toISOString();
const task = (id: number, event: string, state: string, owner: string | null, reviewer: string | null = "claude"): StampedEvent =>
  ({ v: 1, at: at(), type: "task", id, event, by: "hub", state, owner, reviewer, class: "implement", pii: false });
const writer = { version: "test", source: "backfill" as const };

test("research records carry each working peer's latest fingerprint, and a peer without one stays unknown", async () => {
  const { home, bin } = inventory({ claude: { "claude-mem@thedotmack": true } });
  exe(bin, "ripwire");
  const events: StampedEvent[] = [
    { v: 1, at: at(), type: "tooling", peer: "codex", addons: await detectTooling("codex", { home, path: bin }) },
    { v: 1, at: at(), type: "tooling", peer: "claude", addons: [] },
    task(1, "proposed", "proposed", null),
    task(1, "assigned", "in_progress", "codex"),
    // claude re-attaches with claude-mem on before it reviews: its latest fingerprint counts.
    { v: 1, at: at(), type: "tooling", peer: "claude", addons: await detectTooling("claude", { home, cwd: "/p", path: "" }) },
    { v: 1, at: at(), type: "tokens", peer: "kimi", n: 5, task: 1, attribution: "delivery" }, // kimi has no fingerprint
    task(1, "approved", "approved", "codex"),
  ];
  const [r] = taskRecords(events, "proj", writer);
  expect(r!.tooling).toEqual({ codex: [{ name: "ripwire", version: null }], claude: [{ name: "claude-mem", version: "13.29.0" }] });
  expect(r!.tooling!.kimi).toBeUndefined();
  expect(JSON.stringify(r)).not.toContain(MARKER);
  expect(r!.peers).toEqual(["claude", "codex", "kimi"]); // kimi worked on it without a fingerprint
  // The same events give the same record, live or backfill.
  expect(taskRecords(events, "proj", writer)).toEqual(taskRecords(events, "proj", writer));
  // A fingerprint written after the peer's only task event still counts for that task (review of #351).
  const late: StampedEvent[] = [{ v: 1, at: at(), type: "tooling", peer: "codex", addons: [] }, task(5, "proposed", "proposed", null), task(5, "assigned", "in_progress", "codex", null),
    { v: 1, at: at(), type: "turn_end", peer: "pi", turn: "pi#1", ms: 10, task: 5, attribution: "delivery" }, task(5, "done", "approved", "codex", null),
    { v: 1, at: at(), type: "tooling", peer: "pi", addons: [{ name: "ripwire", version: null }] }];
  expect(taskRecords(late, "proj", writer)[0]!.tooling).toEqual({ codex: [], pi: [{ name: "ripwire", version: null }] });
  // A fingerprint binds to the attachment it was detected in: work before a reattachment (or an upgrade that brought
  // the first tooling events) is not credited with it, and work after one never keeps the earlier fingerprint (review of #351).
  const state = (peer: string, s: string): StampedEvent => ({ v: 1, at: at(), type: "state", peer, state: s });
  const turn = (id: number, peer: string): StampedEvent => ({ v: 1, at: at(), type: "turn_end", peer, turn: `${peer}#${id}`, ms: 1, task: id, attribution: "delivery" });
  const windows: StampedEvent[] = [
    state("pi", "idle"), task(6, "proposed", "proposed", null), task(6, "assigned", "in_progress", "codex", null), turn(6, "pi"), task(6, "done", "approved", "codex", null),
    state("pi", "offline"), state("pi", "idle"), { v: 1, at: at(), type: "tooling", peer: "pi", addons: [{ name: "ripwire", version: null }] },
    task(7, "proposed", "proposed", null), task(7, "assigned", "in_progress", "codex", null), turn(7, "pi"),
    state("pi", "offline"), state("pi", "busy"), turn(7, "pi"), { v: 1, at: at(), type: "tooling", peer: "pi", addons: [] }, task(7, "done", "approved", "codex", null),
  ];
  // Work under a new attachment whose fingerprint never arrives is unknown, not the earlier attachment's (review of #351).
  const stale: StampedEvent[] = [state("kimi", "idle"), { v: 1, at: at(), type: "tooling", peer: "kimi", addons: [{ name: "ripwire", version: null }] },
    task(8, "proposed", "proposed", null), task(8, "assigned", "in_progress", "codex", null), turn(8, "kimi"), state("kimi", "offline"), state("kimi", "idle"), turn(8, "kimi"),
    task(8, "done", "approved", "codex", null)];
  expect(taskRecords(stale, "proj", writer)[0]!.tooling?.kimi).toBeUndefined();
  // A crash writes no offline: a new hub run still starts a new attachment (review of #351).
  const crash: StampedEvent[] = [state("qwen", "busy"), task(9, "proposed", "proposed", null), task(9, "assigned", "in_progress", "codex", null), turn(9, "qwen"),
    task(9, "done", "approved", "codex", null), { v: 1, at: at(), type: "hub_start", instance: "run-2" }, state("qwen", "idle"),
    { v: 1, at: at(), type: "tooling", peer: "qwen", addons: [{ name: "ripwire", version: null }] }];
  expect(taskRecords(crash, "proj", writer)[0]!.tooling).toBeUndefined();
  const [six, seven] = taskRecords(windows, "proj", writer);
  expect(six!.tooling).toBeUndefined(); // worked before any fingerprint of its attachment existed
  expect(seven!.tooling).toEqual({ pi: [] }); // its last work was in the later attachment
  // Events from before #248 give records without the field: unknown, never "off".
  expect(taskRecords(events.filter((e) => e.type !== "tooling"), "proj", writer)[0]!.tooling).toBeUndefined();
  expect(addonState("ripwire", [undefined])).toBe("unknown");
  expect(addonState("ripwire", [[], []])).toBe("off");
  expect(addonState("ripwire", [[], undefined, [{ name: "ripwire", version: null }]])).toBe("on");
});

const record = (task: number, tooling: TaskRecord["tooling"], extra: Partial<TaskRecord> = {}): TaskRecord => ({
  schema: "agent-hub.research/v1", kind: "task", project: "p", task, class: "implement", pii: false, outcome: "approved",
  createdAt: `2026-10-0${1 + (task % 9)}T00:00:00.000Z`, startedAt: null, approvedAt: "2026-10-10T00:00:00.000Z", wallMs: 60_000, activeMs: 0,
  owners: ["codex"], reviewer: "claude", reviewRounds: 1, changesRequested: 0, checkPassed: 1, checkFailed: 0, dones: 1, reassignments: 0, reassignedBy: {},
  firstPass: true, stuck: 0, overlaps: 0, conflicts: 0, tests: { pass: 0, fail: 0 }, tokens: { total: 1000, byPeer: { codex: 1000 }, byAttribution: {} }, usage: {}, usageByModel: {},
  turns: 1, filesChanged: 1, models: [], writer, ...(tooling ? { tooling } : {}), ...extra });

test("the add-on report splits tasks on, off and unknown, gives intervals, and marks a thin side inconclusive", () => {
  const on = { codex: [{ name: "ripwire" as const, version: null }], claude: [] };
  const off = { codex: [], claude: [] };
  const records = [
    ...Array.from({ length: 6 }, (_, i) => record(i + 1, on, { tokens: { total: 800, byPeer: { codex: 800 }, byAttribution: {} } })),
    ...Array.from({ length: 6 }, (_, i) => record(i + 11, off, i < 3 ? { changesRequested: 1, firstPass: false, overlaps: 1 } : {})),
    record(30, { codex: [] }), // the reviewer's fingerprint is missing: unknown
    record(31, undefined),
  ];
  const rows = addonReport(records);
  expect(rows.map((r) => r.addon)).toEqual([...ADDONS]);
  const ripwire = rows.find((r) => r.addon === "ripwire")!;
  expect([ripwire.on, ripwire.off, ripwire.unknown]).toEqual([6, 6, 2]);
  const first = ripwire.measures.find((m) => m.measure === "firstPassRate")!;
  expect(first).toMatchObject({ on: 1, off: 0.5, diff: 0.5, inconclusive: false });
  expect(first.low!).toBeLessThanOrEqual(first.diff!); expect(first.high!).toBeGreaterThanOrEqual(first.diff!);
  expect(ripwire.measures.find((m) => m.measure === "tokensMedian")).toMatchObject({ diff: -200 });
  expect(ripwire.measures.find((m) => m.measure === "collisionRate")).toMatchObject({ on: 0, off: 0.5 });
  // Seeded: the same records give the same intervals.
  expect(addonReport(records)).toEqual(rows);
  // Nobody had claude-mem: everything known is off, and no on side means no difference at all.
  const mem = rows.find((r) => r.addon === "claude-mem")!;
  expect([mem.on, mem.off]).toEqual([0, 12]);
  expect(mem.measures.every((m) => m.inconclusive && m.diff === null)).toBe(true);
  // Below five tasks on a side, a difference is inconclusive.
  const thin = addonReport(records.filter((r) => r.task !== 1 && r.task !== 2)).find((r) => r.addon === "ripwire")!;
  expect(thin.on).toBe(4);
  expect(thin.measures.every((m) => m.inconclusive)).toBe(true);
  expect(formatAddons(rows).join("\n")).toContain("ripwire: 6 on, 6 off, 2 unknown");
  // A peer that only had a turn, with or without a fingerprint, still decides the side (review of #351).
  const turnOnly = (tooling: TaskRecord["tooling"]) => addonReport([record(40, tooling, { peers: ["claude", "codex", "pi"] })]).find((r) => r.addon === "ripwire")!;
  expect(turnOnly({ codex: [], claude: [], pi: [{ name: "ripwire", version: null }] }).on).toBe(1);
  expect(turnOnly({ codex: [], claude: [] }).unknown).toBe(1);
  // A peer named like an Object.prototype member is looked up as its own property only.
  const parsed = JSON.parse(JSON.stringify(record(41, { codex: [] }, { owners: ["constructor"], peers: ["codex", "constructor"] }))) as TaskRecord;
  expect(addonReport([parsed]).find((r) => r.addon === "ripwire")!.unknown).toBe(1);
});
