import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Turns } from "../src/hub/snapshots.ts";

test("instance turn workspace evidence is explicit and does not change legacy turn records", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-instance-turn-")), db = join(root, "hub.db"), turns = new Turns(db);
  try {
    turns.begin("legacy", "external", undefined);
    turns.begin("extra", "codex-worker", "extra-start-tree", root);
    expect(typeof turns.workspace).toBe("function");
    expect(turns.workspace("legacy")).toBeUndefined();
    expect(turns.workspace("extra")).toBe(root);
    expect(Object.keys(turns.get("extra")!).sort()).toEqual(Object.keys(turns.get("legacy")!).sort());
    turns.end("extra", "extra-end-tree", ["own.txt"], 1);
    const oldReader = new Database(db, { readonly: true });
    try { expect(oldReader.query("SELECT start_tree, end_tree, changed FROM turns WHERE id = ?").get("extra")).toEqual({ start_tree: null, end_tree: null, changed: "[]" }); } finally { oldReader.close(); }
    expect(turns.get("extra")).toMatchObject({ start_tree: "extra-start-tree", end_tree: "extra-end-tree", changed: ["own.txt"] });
    expect(turns.workspace("extra")).toBe(root);
    turns.begin("next", "codex-worker", undefined, join(root, "next"));
    turns.end("next", undefined, [], 1);
    expect(turns.get("extra")).toBeUndefined();
    expect(turns.workspace("extra")).toBeUndefined();
    expect(turns.workspace("next")).toBe(join(root, "next"));
  } finally { turns.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a readonly legacy turn store without workspace table remains readable", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-legacy-turn-")), db = join(root, "hub.db");
  const legacy = new Database(db); legacy.run("CREATE TABLE turns (id TEXT PRIMARY KEY, peer TEXT, started INTEGER, ended INTEGER, start_tree TEXT, end_tree TEXT, changed TEXT, native TEXT)"); legacy.close();
  const turns = new Turns(db, true);
  try { expect(typeof turns.workspace).toBe("function"); expect(turns.workspace("old")).toBeUndefined(); }
  finally { turns.close(); rmSync(root, { recursive: true, force: true }); }
});
