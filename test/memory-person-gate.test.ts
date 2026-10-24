import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, memoryProjectKey } from "@staix/agent-mem";
import { memoryCommand } from "../src/cli/memory.ts";

// agent-mem 0.7.0 serves --history and --as-of only to a caller that passes `person: true`; the hub forwards its
// console identity through `...opts` (main.ts), so an agent's call, or a caller that omits `person`, is refused.
const dirs: string[] = [], stores: MemoryStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "ahub-person-gate-"))); dirs.push(d); return d; };

test("ahub memory --history reaches agent-mem only for a person caller", async () => {
  const cwd = temp(), project = memoryProjectKey(cwd), s = new MemoryStore({ home: temp() }); stores.push(s);
  const old = s.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "gate needle old", about: [] });
  const current = s.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "gate needle new", about: [] });
  expect(s.supersede(old, current, "person", project)).toBe(true);
  for (const opts of [{ store: s }, { store: s, person: false }]) {
    await expect(memoryCommand(["search", "needle", "--history"], cwd, opts)).rejects.toThrow("authenticated person intent");
  }
  const history = await memoryCommand(["search", "needle", "--history"], cwd, { store: s, person: true });
  expect(history).toContain("gate needle old");
  expect(await memoryCommand(["search", "needle"], cwd, { store: s })).not.toContain("gate needle old");
});
