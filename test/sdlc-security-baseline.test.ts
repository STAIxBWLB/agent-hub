import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { readSecurityScan } from "../src/hub/security-baseline.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";

// agent-hub #481 S7 (hub task #442): the scheduled security-scan baseline. The hub reads GitHub's own open-alert counts, records one row per interval and the existing band path judges the series.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const H = 3_600_000;

/** A GitHub whose open-alert counts per source can move between scans; a source set to `null` is not readable (not enabled, not permitted). */
function world(counts: { dependabot: number | null; secret_scanning: number | null; code_scanning: number | null }) {
  const calls: string[][] = [];
  const run: SdlcGh = async args => {
    calls.push(args);
    const match = /repos\/([^/]+\/[^/]+)\/(dependabot|secret-scanning|code-scanning)\/alerts\?state=open&per_page=100&page=(\d+)/.exec(args[1] ?? "");
    if (!match || args[0] !== "api" || args[2] !== "--jq" || args[3] !== "length") return { code: 1, stdout: "" };
    const source = match[2]!.replace("-", "_") as keyof typeof counts, total = counts[source];
    if (total === null) return { code: 1, stdout: "" };
    const page = Number(match[3]);
    return { code: 0, stdout: String(Math.max(0, Math.min(100, total - (page - 1) * 100))) };
  };
  return { counts, calls, run };
}
function rig(security: Record<string, unknown> | null, w: ReturnType<typeof world>, extra: { mode?: string; bands?: Record<string, unknown>; held?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-security-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  let cfg: Record<string, unknown> = { mode: extra.mode ?? "advise", ...(extra.bands ? { bands: extra.bands } : {}), ...(security ? { security_scan: security } : {}) };
  const deps: TasksDeps = { board, bus, cwd: dir, project: "sec", repository: "o/r", routing: () => loadRouting(dir), roles: { claude: ["planner"], codex: ["implementer"] }, notify: line => notices.push(line),
    sweepHeld: extra.held, sdlc: { config: () => sdlcConfig(cfg), gh: w.run } };
  const tasks = new Tasks(deps);
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { board, tasks, notices, setConfig: (next: Record<string, unknown>) => { cfg = next; } };
}
const BAND = { security_open_alerts: { window: 10, min_samples: 4, min_delta: 1, log_sigma: 1, diagnose_sigma: 2, propose_sigma: 3 } };
const SCAN = { sources: ["dependabot", "secret_scanning"], every_h: 1 };

test("config: security_scan is optional, bounded and has no default source; a bad table refuses with a field path", () => {
  expect(sdlcConfig({ mode: "advise" })).not.toHaveProperty("securityScan");
  expect(sdlcConfig({ mode: "advise", security_scan: SCAN }).securityScan).toEqual({ everyH: 1, sources: ["dependabot", "secret_scanning"] });
  expect(sdlcConfig({ mode: "advise", security_scan: { sources: ["code_scanning"], repo: "x/y" } }).securityScan).toEqual({ everyH: 24, sources: ["code_scanning"], repo: "x/y" });
  const bad: [unknown, string][] = [
    [[], "sdlc.security_scan: expected a table"], [{}, "sdlc.security_scan.sources"], [{ sources: [] }, "sdlc.security_scan.sources"], [{ sources: ["osv"] }, "sdlc.security_scan.sources"],
    [{ sources: ["dependabot", "dependabot"] }, "sdlc.security_scan.sources"], [{ sources: ["dependabot"], every_h: 0 }, "sdlc.security_scan.every_h"], [{ sources: ["dependabot"], every_h: 721 }, "sdlc.security_scan.every_h"],
    [{ sources: ["dependabot"], every_h: 1.5 }, "sdlc.security_scan.every_h"], [{ sources: ["dependabot"], repo: "--x/y" }, "sdlc.security_scan.repo"], [{ sources: ["dependabot"], nope: 1 }, "sdlc.security_scan.nope"],
  ];
  for (const [value, message] of bad) expect(() => sdlcConfig({ mode: "advise", security_scan: value }), JSON.stringify(value)).toThrow(message);
  expect(() => sdlcConfig({ mode: "advise", bands: { security_open_alerts: {}, hotfix_rate: {} } })).not.toThrow();
});

test("the reader counts open alerts per source with fixed argv, pages exactly, and keeps no text", async () => {
  const w = world({ dependabot: 250, secret_scanning: 3, code_scanning: 0 });
  const scan = await readSecurityScan("o/r", ["dependabot", "secret_scanning", "code_scanning"], w.run);
  expect(scan).toEqual({ repo: "o/r", sources: ["dependabot", "secret_scanning", "code_scanning"], counts: { dependabot: 250, secret_scanning: 3, code_scanning: 0 }, total: 253 });
  expect(w.calls.every(args => args[0] === "api" && args[2] === "--jq" && args[3] === "length" && /^repos\/o\/r\/(dependabot|secret-scanning|code-scanning)\/alerts\?state=open&per_page=100&page=\d+$/.test(args[1]!))).toBe(true);
  expect(w.calls.filter(args => args[1]!.includes("dependabot"))).toHaveLength(3); // 100 + 100 + 50
});

test("a source GitHub will not read is unknown, never zero alerts; an over-cap source is unknown, not a clipped count", async () => {
  const w = world({ dependabot: 4, secret_scanning: null, code_scanning: 0 });
  const scan = await readSecurityScan("o/r", ["dependabot", "secret_scanning"], w.run);
  expect(scan).toMatchObject({ counts: { dependabot: 4, secret_scanning: null }, total: null });
  const over = await readSecurityScan("o/r", ["dependabot"], world({ dependabot: 5000, secret_scanning: 0, code_scanning: 0 }).run);
  expect(over).toMatchObject({ counts: { dependabot: null }, total: null });
  expect(await readSecurityScan("--o/r", ["dependabot"], w.run)).toBeUndefined();
  expect(await readSecurityScan("o/r", [], w.run)).toBeUndefined();
  expect(await readSecurityScan("o/r", ["osv" as never], w.run)).toBeUndefined();
  expect(await readSecurityScan("o/r", ["dependabot"], async () => { throw new Error("boom"); })).toMatchObject({ total: null });
});

test("a scan is recorded once per interval, and never when nothing is configured, the lifecycle is off or the hub is held", async () => {
  const w = world({ dependabot: 2, secret_scanning: 0, code_scanning: 0 });
  const none = rig(null, w);
  expect(await none.tasks.runSecurityScan(1_000)).toBeUndefined();
  expect(w.calls).toEqual([]); // no table, no read
  const off = rig(SCAN, w, { mode: "off" });
  expect(await off.tasks.runSecurityScan(1_000)).toBeUndefined();
  expect(w.calls).toEqual([]);
  let held = true;
  const guarded = rig(SCAN, w, { held: () => held });
  expect(await guarded.tasks.runSecurityScan(1_000)).toBeUndefined();
  expect(w.calls).toEqual([]);
  held = false;
  const first = await guarded.tasks.runSecurityScan(Date.now());
  expect(first).toBeNumber();
  const reads = w.calls.length;
  expect(await guarded.tasks.runSecurityScan(Date.now() + H / 2)).toBeUndefined(); // not yet due
  expect(w.calls.length).toBe(reads);
  expect(await guarded.tasks.runSecurityScan(Date.now() + 2 * H)).toBeNumber();
  expect(guarded.board.securityScans("o/r", "dependabot,secret_scanning").map(scan => scan.total)).toEqual([2, 2]);
});

test("the schedule is judged again after the read: a configuration changed or a hold set during it writes nothing", async () => {
  const w = world({ dependabot: 2, secret_scanning: 0, code_scanning: 0 });
  const r = rig(SCAN, w);
  const slow: SdlcGh = async args => { r.setConfig({ mode: "advise", security_scan: { sources: ["dependabot"], every_h: 1 } }); return w.run(args); };
  const original = (r.tasks as unknown as { d: { sdlc: { gh: SdlcGh } } }).d.sdlc;
  original.gh = slow;
  expect(await r.tasks.runSecurityScan(Date.now())).toBeUndefined();
  expect(r.board.securityScans("o/r", "dependabot,secret_scanning")).toEqual([]);
});

test("a rise in open alerts is one deduplicated band card naming the scan, never an alert; unknown totals are skipped", async () => {
  const w = world({ dependabot: 2, secret_scanning: 0, code_scanning: 0 });
  const r = rig(SCAN, w, { bands: BAND });
  let now = Date.now();
  for (let i = 0; i < 6; i++) { expect(await r.tasks.runSecurityScan(now)).toBeNumber(); now += 2 * H; }
  expect(r.board.list().filter(task => task.detail?.startsWith("Band breach key: "))).toEqual([]); // a flat baseline fires nothing
  w.counts.dependabot = 9;
  const breach = await r.tasks.runSecurityScan(now);
  const cards = r.board.list().filter(task => task.detail?.startsWith("Band breach key: security_open_alerts"));
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.detail).toContain(`Band breach key: security_open_alerts:#${breach}:`);
  expect(card.detail).toContain(`newest value 9 on security scan #${breach}`);
  expect(card.detail).toContain("over 6 scans");
  expect(card.detail).not.toMatch(/GHSA|CVE|alert #|package|\.ts\b/); // counts and ids only
  expect(card.history[0]!.by).toBe("hub");
  // The same breach again, and a higher value inside the episode, add no second card while this one is open.
  now += 2 * H; w.counts.dependabot = 12;
  await r.tasks.runSecurityScan(now);
  expect(r.board.list().filter(task => task.detail?.startsWith("Band breach key: security_open_alerts"))).toHaveLength(1);
  // A scan with an unreadable source records an unknown total, which is not a point in the series.
  const before = r.board.securityScans("o/r", "dependabot,secret_scanning").length;
  w.counts.secret_scanning = null; now += 2 * H;
  expect(await r.tasks.runSecurityScan(now)).toBeNumber();
  const rows = r.board.securityScans("o/r", "dependabot,secret_scanning");
  expect(rows).toHaveLength(before + 1);
  expect(rows.at(-1)!.total).toBeNull();
  expect(r.tasks.sdlcMetrics("claude").bands).toEqual([expect.objectContaining({ metric: "security_open_alerts", subject: "scan", last: 12 })]);
});

test("a private or unnameable repository identity is never scanned, and the scan table holds counts only", async () => {
  const w = world({ dependabot: 1, secret_scanning: 0, code_scanning: 0 });
  const r = rig({ sources: ["dependabot"], every_h: 1, repo: "patient-900101-1234567/records" }, w);
  expect(await r.tasks.runSecurityScan(Date.now())).toBeUndefined();
  expect(w.calls).toEqual([]);
  const ok = rig({ sources: ["dependabot"], every_h: 1 }, w);
  await ok.tasks.runSecurityScan(Date.now());
  const db = (ok.board as unknown as { db: { query: (sql: string) => { all: () => Record<string, unknown>[] } } }).db;
  const row = db.query("SELECT * FROM security_scans").all()[0]!;
  expect(Object.keys(row).sort()).toEqual(["at", "counts", "id", "repo", "sources", "total"]);
  expect(JSON.parse(row.counts as string)).toEqual({ dependabot: 1 });
});
