import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

// #1635: the real hub's ui_snapshot carries the board's own write counter, a bare number, so acon's revision() can poll it.

const dirs: string[] = [];
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("ui_snapshot carries boardRevision, stable without a write and changed by a task-board write (#1635 AC2)", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ahub-boardrev-"))); dirs.push(home);
  const previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = home;
  cleanup.push(() => { if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; });
  const stateDir = join(home, "state");
  mkdirSync(stateDir);
  const daemon = await startDaemon({ cwd: home, stateDir, projectId: "p-rev", instanceId: "i-rev", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => person.close());
  const first = await person.request({ t: "ui_snapshot", after: 0 });
  expect(Number.isSafeInteger(first.boardRevision)).toBe(true);
  expect((await person.request({ t: "ui_snapshot", after: 0 })).boardRevision).toBe(first.boardRevision);
  const proposed = await person.request({ t: "task", op: "hub_task_propose", args: { title: "revision fixture", class: "implement", owner: "codex" } });
  expect(proposed.ok, String(proposed.error)).toBe(true);
  const after = await person.request({ t: "ui_snapshot", after: 0 });
  expect(after.boardRevision).toBeGreaterThan(first.boardRevision);
  expect(typeof after.boardRevision).toBe("number"); // a bare number: no title or other text is folded into it
});
