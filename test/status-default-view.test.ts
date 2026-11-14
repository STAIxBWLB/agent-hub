import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paint } from "../src/cli/console-state.ts";
import { renderStatus, renderStatusDefault, statusAttention } from "../src/cli/output.ts";
import { HELP } from "../src/cli/help.ts";

// #1484 T3 (AC2): `ahub status` default view. A header, an Attention section (every item that needs action, marked, with its exact next command), then the hub,
// the peers and the tasks with plain keys. `--verbose` and `--full` keep the older full view. `--json` and the exit code are not touched.
const now = 1_000_000;
const text = (lines: ReturnType<typeof renderStatusDefault>, color = false) => lines.map(line => paint(line, color)).join("\n");
const HELD = "abcdef12-3456-4789-8abc-def012345678";
const STANDBY = "11111111-2222-4333-8444-555555555555";
const status = (): any => ({
  version: "0.40.0", pid: 4242, controlPort: 12345, cwd: "/work/project",
  peers: {
    claude: { state: "idle", queued: 0, attached: true, form: "tui", flowRoles: ["planner", "reviewer"], capableRoles: ["planner"], context: { used: 0.21, freshness: "fresh", source: "claude_statusline" } },
    codex: { state: "paused", queued: 3, paused: "budget", form: "headless", heldRows: [{ id: HELD, senders: ["claude"], kinds: ["task"], createdAt: now - 120_000 }] },
    pi: { state: "offline", queued: 0, standbySessions: [{ id: STANDBY, pid: 77, since: now - 60_000 }] },
  },
  tasks: { in_progress: 2, in_review: 1, approved: 40 }, taskWip: { codex: { wip: 1, wipLimit: 2 } },
  agentDrift: [{ id: "codex-review", version: "0.169.0", state: "refused", receipt: "docs/verification/x.md" }],
  deliveryFailures: { codex: 2 }, pendingRestart: [{ key: "pi.enabled", reason: "needs a restart" }],
  planner: { peers: ["claude"], source: "config" }, memoryProfile: { profile: "generation", generation: "abcdef0123456789", state: "ready", agentMemVersion: "0.26.0" },
});

describe("ahub status default view (#1484 AC2)", () => {
  test("the header comes first, then Attention, then Hub, Peers and Tasks, one blank line before each section and none after", () => {
    const lines = text(renderStatusDefault(status(), 80, now)).split("\n");
    expect(lines[0]).toMatch(/^ ahub Status {2}0\.40\.0 {2}pid 4242 {2}127\.0\.0\.1:12345$/);
    const sections = lines.filter(line => line.startsWith("▸ ")).map(line => line.replace(/ \(.*/, ""));
    expect(sections).toEqual(["▸ Attention", "▸ Hub", "▸ Peers", "▸ Tasks"]);
    for (const [index, line] of lines.entries()) if (line.startsWith("▸ ")) { expect(lines[index - 1], line).toBe(""); expect(lines[index + 1], line).not.toBe(""); }
    expect(lines.at(-1)).not.toBe("");
  });
  test("every item that needs action is a marked row with its exact next command, problems before facts", () => {
    const lines = text(renderStatusDefault(status(), 80, now)).split("\n");
    const attention = lines.slice(lines.indexOf(lines.find(l => l.startsWith("▸ Attention"))!), lines.indexOf("▸ Hub") - 1).join("\n");
    for (const [row, next] of [
      ["restart pending: pi.enabled", "ahub restart --dry-run"], ["agent CLI codex-review 0.169.0 is refused", "ahub agents trust codex-review 0.169.0"],
      ["codex has 2 failed deliveries", "ahub queue discard --peer codex --state failed"], ["codex: a delivery is held for review", `ahub queue show ${HELD}`],
      ["codex is paused (budget)", "ahub resume codex"], ["pi has a standby session waiting", `ahub peer takeover pi ${STANDBY}`],
    ] as const) {
      expect(attention, row).toContain(row);
      expect(attention, `${row} -> ${next}`).toContain(`→  ${next}`);
    }
    expect(attention).toMatch(/^ {2}✗ {2}codex: a delivery is held/m); // a hard failure carries the fail marker, the rest the warning marker
    expect(attention).toMatch(/^ {2}⚠ {2}restart pending/m);
    expect(text(renderStatusDefault(status(), 80, now))).toContain("▸ Attention (6 items)");
  });
  test("only a refused agent CLI version is an Attention row; trusted and in-line ones are a count on the Hub row", () => {
    const drift = status();
    drift.agentDrift = [
      { id: "codex-review", version: "0.169.0", state: "refused", receipt: "r" },
      { id: "pi", version: "1.5.2", state: "trusted", receipt: "r" },
      { id: "qwen", version: "0.27.1", state: "in-line", receipt: "r" },
    ];
    const items = statusAttention(drift, now).filter(item => item.text.startsWith("agent CLI"));
    expect(items).toEqual([{ marker: "warn", text: "agent CLI codex-review 0.169.0 is refused", next: "ahub agents trust codex-review 0.169.0" }]);
    const view = text(renderStatusDefault(drift, 120, now));
    expect(view).not.toMatch(/agent CLI pi|agent CLI qwen/);
    expect(view).not.toContain("ahub agents trust pi"); expect(view).not.toContain("ahub agents trust qwen");
    expect(view).toContain("agent CLIs:  2 outside the verified version, already accepted (ahub agents)");
    // the Attention header counts only rows that need action: the shared fixture has 6, and the trusted and in-line rows add none
    expect(view).toContain("▸ Attention (6 items)");
    drift.agentDrift = [{ id: "pi", version: "1.5.2", state: "trusted", receipt: "r" }];
    expect(statusAttention(drift, now).some(item => item.text.startsWith("agent CLI"))).toBe(false);
  });
  test("a healthy hub says so in one row", () => {
    const healthy = text(renderStatusDefault({ version: "0.40.0", pid: 1, controlPort: 2, peers: { claude: { state: "idle", queued: 0, attached: true } }, tasks: { approved: 3 } } as never, 80, now));
    expect(healthy).toContain("▸ Attention\n  ✓  nothing needs attention\n");
    expect(statusAttention({ peers: {} } as never, now)).toEqual([]);
  });
  test("peer detail uses plain keys: the peer is the heading, so a key never repeats its name", () => {
    const view = text(renderStatusDefault(status(), 80, now));
    expect(view).toMatch(/^ {2}claude\n {4}form: +tui\n {4}flow roles: +planner, reviewer\n {4}capable roles: +planner$/m);
    expect(view).not.toMatch(/claude form|claude flow roles|claude capable roles/);
  });
  test("a next step is complete and copyable: no placeholder and no angle brackets", () => {
    for (const item of statusAttention(status(), now)) if (item.next) expect(item.next, item.text).not.toMatch(/[<>]|\.\.\.|\bTODO\b/);
  });
  test("with ASCII markers the report keeps its alignment and has no non-ASCII glyph", () => {
    const ascii = text(renderStatusDefault(status(), 80, now, true));
    expect(ascii).toContain("> Attention (6 items)"); expect(ascii).toContain("  x  codex: a delivery is held"); expect(ascii).toContain("    -> ahub restart --dry-run");
    expect(ascii).not.toMatch(/[✓✗⚠→▸]/);
  });
  test("at 80 columns no line is wider, and a pipe (no width) keeps a long finding on one line", () => {
    const long = status(); long.crash = ["x ".repeat(120).trim()];
    for (const line of text(renderStatusDefault(long, 80, now)).split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(80);
    const piped = text(renderStatusDefault(long, undefined, now)).split("\n");
    expect(piped.filter(line => line.includes("crash recovery") && Bun.stringWidth(line) > 200)).toHaveLength(1);
  });
  test("color names roles: the fail marker is the error role and the next step the accent role", () => {
    const colored = text(renderStatusDefault(status(), 80, now), true);
    expect(colored).toContain("\x1b[1;31m✗ \x1b[0m"); expect(colored).toContain("\x1b[36m→  ahub restart --dry-run\x1b[0m");
    expect(text(renderStatusDefault(status(), 80, now))).not.toContain("\x1b");
  });
  test("the person-run line keeps its documented words", () => {
    expect(text(renderStatusDefault({ peers: {}, tasks: { backlog: 2 }, personRun: [7] } as never, 80, now))).toContain("WAITING ON YOU  #7");
  });
});

describe("ahub status --verbose keeps every detail the older view printed", () => {
  test("renderStatus is unchanged for a status with the same data", () => {
    const old = renderStatus(status(), 120, now).map(line => paint(line, false)).join("\n");
    expect(old).toContain("codex failed deliveries"); expect(old).toContain("pending restart"); expect(old).toContain("claude flow roles");
    expect(old).toMatch(/codex planner WIP\s+1\/2/);
  });
  test("nothing the Attention list names is lost: the verbose view still carries each of those facts", () => {
    const verbose = renderStatus(status(), undefined, now).map(line => paint(line, false)).join("\n"); // no width: a wrapped id would split the needle
    for (const needle of ["codex-review 0.169.0 refused", "pi.enabled", "queue discard --peer codex --state failed", `ahub queue show ${HELD}`]) expect(verbose, needle).toContain(needle);
  });
  test("the help names --verbose and the CLI wires it", () => {
    expect(HELP.find(entry => entry.usage.startsWith("ahub status [--json]"))?.usage).toContain("[--verbose]");
    const main = readFileSync(join(import.meta.dir, "../src/cli/main.ts"), "utf8");
    expect(main).toContain("options.verbose || options.full ? renderStatus(");
    expect(main).toContain("verbose: source.includes(\"--verbose\")");
  });
});

test("the default view carries the planner WIP too, so the seeded `planner-normal-status-wip` fact is not only in the verbose view", () => {
  const view = text(renderStatusDefault({ peers: { codex: { state: "offline" } }, taskWip: { codex: { wip: 1, wipLimit: 2 } } } as never, 120, 0));
  expect(view).toMatch(/planner WIP:\s+codex 1\/2/);
});
