import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, report } from "../scripts/overlaps.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";

class Peer extends BasePeer {
  async deliver() {}
  async start() {
    this.setState("idle");
  }
  async stop() {}
}

test("overlaps: parses the notice Tasks really writes, and not the task envelope that repeats it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-overlaps-"));
  const notices: string[] = [];
  const board = new Board(join(dir, "hub.db"));
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["kimi", "codex"]) {
    const peer = new Peer(id);
    bus.add(peer);
    await peer.start();
  }
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "p", notify: (l) => notices.push(l) });
  await tasks.propose("kimi", { title: "hub (refactor)", class: "implement", owner: "kimi", refs: { paths: ["src/hub/"] } });
  await tasks.propose("codex", { title: "retry (backoff)", class: "implement", owner: "codex", refs: { paths: ["./src/hub/bus.ts", "README.md"] } });
  board.close();
  const log = [
    ...notices.map((l) => `2026-09-28T10:00:00.000Z ${l}`),
    "2026-09-28T10:00:00.100Z msg hub -> codex important hop=0: Task #2 [implement] retry (backoff)",
    "Overlaps #1 (owner kimi) on ./src/hub/bus.ts. Settle it with that owner via hub_send before editing those paths.",
  ].join("\n");
  expect(parse(log, "a")).toEqual([{ source: "a", at: "2026-09-28T10:00:00.000Z", task: 2, owner: "codex", others: [{ task: 1, owner: "kimi", paths: ["./src/hub/bus.ts"] }] }]);
});

test("overlaps: per week, each pair of tasks once per project, a reassigned task keeping its pair", () => {
  const a = [
    "2026-09-28T10:01:00.000Z task #2 retry backoff (codex): Overlaps #1 (owner kimi) on src/a.ts. codex is told to settle it.",
    "2026-09-29T09:00:00.000Z task #2 retry backoff (local): Overlaps #1 (owner kimi) on src/a.ts. local is told to settle it.",
    "2026-10-05T08:00:00.000Z task #4 docs (local): Overlaps #1 (owner kimi) on src/a.ts, src/b.ts; #2 (owner codex) on src/b.ts. local is told to settle it.",
  ].join("\n");
  // Another project: the same task ids are different tasks.
  const b = "2026-09-28T11:00:00.000Z task #2 other (codex): Overlaps #1 (owner kimi) on lib/z.ts. codex is told to settle it.";
  const items = [...parse(a, "a"), ...parse(b, "b")];
  expect(report(items)).toEqual([
    "week of 2026-09-28: 3 warnings, 2 task pairs",
    "  a: #1 (kimi) and #2 (codex, local) on src/a.ts: first 2026-09-28T10:01:00.000Z, 2x",
    "  b: #1 (kimi) and #2 (codex) on lib/z.ts: first 2026-09-28T11:00:00.000Z, 1x",
    "week of 2026-10-05: 1 warning, 2 task pairs",
    "  a: #1 (kimi) and #4 (local) on src/a.ts, src/b.ts: first 2026-10-05T08:00:00.000Z, 1x",
    "  a: #2 (codex) and #4 (local) on src/b.ts: first 2026-10-05T08:00:00.000Z, 1x",
  ]);
  expect(report(items, "2026-10-05")[0]).toBe("week of 2026-10-05: 1 warning, 2 task pairs");
  expect(report(parse("2026-09-28T10:00:00.000Z hub up"))).toEqual(["no overlap warnings"]);
});
