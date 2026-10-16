// Synthetic scale test for the hub memory store: N notes written as log lines, then timed open/rebuild/search/graph.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, entryId, MEMORY_SCHEMA } from "../../src/memory/store.ts";
const N = Number(process.argv[2] ?? 20000);
const home = mkdtempSync(join(tmpdir(), "amem-scale-"));
const dir = join(home, "memory"); mkdirSync(join(dir, "log"), { recursive: true }); mkdirSync(join(dir, "local"));
writeFileSync(join(dir, "machine.json"), JSON.stringify({ id: "0123456789abcdef", label: "bench" }) + "\n");
const kinds = ["decision", "finding", "contract", "fail"] as const;
const words = "store index graph lease sync brief recall preface digest board task review fail decision contract import prune tier".split(" ");
const lines: string[] = [];
for (let i = 0; i < N; i++) {
  const about = [`path:src/m${i % 400}.ts`, `symbol:f${i % 1500}@src/m${i % 400}.ts`, `issue:o/r#${i % 300}`, `task:p#${i % 5000}@1`];
  const text = Array.from({ length: 150 }, (_, j) => words[(i * 7 + j * 13) % words.length]).join(" ");
  const body = { schema: MEMORY_SCHEMA, op: "note", at: new Date(1790000000000 + i * 1000).toISOString(), machine: "0123456789abcdef", project: "p", scope: "project", tier: "long", kind: kinds[i % 4], peer: "bench", title: `t${i}`, text, about, source: "hub" } as const;
  lines.push(JSON.stringify({ ...body, id: entryId(body as never) }));
}
writeFileSync(join(dir, "log", "0123456789abcdef.jsonl"), lines.join("\n") + "\n");
const t = (f: () => unknown) => { const s = performance.now(); const r = f(); return [Math.round(performance.now() - s), r] as const; };
const [open, store] = t(() => new MemoryStore({ home, log: () => {} }));
const [listMs, l] = t(() => (store as MemoryStore).list({ project: "p", q: "lease sync", limit: 50 }).length);
const [graphMs, g] = t(() => (store as MemoryStore).graph("p", "path:src/m7.ts", 2).nodes.length);
const [rebuildMs] = t(() => (store as MemoryStore).rebuild());
console.log(JSON.stringify({ N, logMB: +(statSync(join(dir, "log", "0123456789abcdef.jsonl")).size / 1e6).toFixed(1), indexMB: +(statSync(join(dir, "index.db")).size / 1e6).toFixed(1), openMs: open, searchMs: listMs, hits: l, graph2Ms: graphMs, graphNodes: g, rebuildMs }));
(store as MemoryStore).close(); rmSync(home, { recursive: true, force: true });
