import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@staix/agent-mem";
import { memoryRead } from "../src/hub/read-tools.ts";
import { memoryCommand } from "../src/cli/memory.ts";
import { recallMemoryLines } from "../src/memory/recall.ts";
import { Briefs } from "../src/memory/brief.ts";
import { createStalenessProbe, STALENESS_MAX_PROBES } from "../src/hub/memory-staleness.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const cwd = mkdtempSync(join(tmpdir(), "memory-stale-")); roots.push(cwd); return cwd; }

test("staleness is a read-time hint for missing public paths and symbol files", () => {
  const cwd = fixture(); mkdirSync(join(cwd, "src")); writeFileSync(join(cwd, "src/live.ts"), "export const live = 1;");
  const stale = createStalenessProbe({ cwd });
  expect(stale(["path:src/live.ts"])).toBe(false);
  expect(stale(["path:src/deleted.ts"])).toBe(true);
  expect(stale(["symbol:gone@src/deleted.ts"])).toBe(true);
  expect(stale(["symbol:unresolved@src/live.ts", "issue:owner/repo#1"])).toBe(false);
});

test("private, denied, folded and escaping paths are never probed and never marked", () => {
  const cwd = fixture(), calls: string[] = [];
  const stale = createStalenessProbe({ cwd, privatePaths: ["private/**", "exact.txt"], deny: ["denied"], probe: path => { calls.push(path); throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  for (const node of ["path:private/missing.ts", "symbol:x@PRIVATE/missing.ts", "path:exact.txt", "path:denied/file.ts", "path:.ENV", "path:.agenthub/state/x", "path:prefix//.agenthub//state/x", "path:../outside", "path:/outside"]) expect(stale([node])).toBe(false);
  expect(calls).toEqual([]);
});

test("a symlink to a private tree is unknown without probing its target", () => {
  const cwd = fixture(); mkdirSync(join(cwd, "private")); symlinkSync(join(cwd, "private"), join(cwd, "alias")); const calls: string[] = [];
  const stale = createStalenessProbe({ cwd, privatePaths: ["private"], probe: path => { calls.push(path); return lstatSync(path); } });
  expect(stale(["path:alias/missing.ts"])).toBe(false);
  expect(calls).toEqual([join(cwd, "alias")]);
});

test("staleness has one shared finite metadata budget, caches results and treats errors as unknown", () => {
  const cwd = fixture(); let probes = 0;
  const stale = createStalenessProbe({ cwd, probe: () => { probes++; return { isSymbolicLink: () => false, isDirectory: () => true }; } });
  for (let i = 0; i < 100; i++) expect(stale([`path:file-${i}`])).toBe(false);
  expect(probes).toBe(STALENESS_MAX_PROBES);
  expect(stale(["path:file-0"])).toBe(false); expect(probes).toBe(STALENESS_MAX_PROBES);
  expect(createStalenessProbe({ cwd, probe: () => { throw Object.assign(new Error("refused"), { code: "EACCES" }); } })(["path:unknown"])).toBe(false);
});


test("recall, brief, memory show tool and CLI show decorate read-time output without changing note text", async () => {
  const cwd = fixture(); mkdirSync(join(cwd, ".agenthub")); writeFileSync(join(cwd, ".agenthub/config.json"), "{}");
  const store = new MemoryStore({ home: join(cwd, "state"), deferPromotions: true });
  try {
    const id = store.note({ op: "note", project: "synthetic", tier: "long", scope: "shared", kind: "contract", peer: "codex", source: "person", text: "retained public contract", about: ["path:deleted.ts"] });
    const note = store.get(id)!;
    expect(recallMemoryLines([note], 30, createStalenessProbe({ cwd }))[0]).toContain("(stale?)");
    const brief = new Briefs(undefined, "synthetic", 8, () => [{ id, line: "unchanged native line", kind: "contract", about: note.about }], undefined, items => {
      const stale = createStalenessProbe({ cwd }); return items.map(item => item.line + (stale(item.about ?? []) ? " (stale?)" : ""));
    });
    expect(await brief.forTask("codex", { title: "task", refs: {} })).toContain("(stale?)");
    const shown = memoryRead(store, "synthetic", rows => rows, "hub_memory_show", { ids: [id] }, createStalenessProbe({ cwd }));
    expect(JSON.parse(shown).lines[0]).toContain("(stale?)");
    expect(await memoryCommand(["show", id], cwd, { store })).toContain("(stale?)");
    expect((await memoryCommand(["show", id, "--json"], cwd, { store }))).not.toContain("(stale?)");
    expect(store.get(id)!.text).toBe("retained public contract");
  } finally { store.close(); }
});
