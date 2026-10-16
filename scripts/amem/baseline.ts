/** #412 P0: count-only, read-only snapshot. Never opens the derived native index. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CM_CUTOFF = Date.parse("2026-10-16T00:00:00Z");
const NATIVE_CUTOFF = Date.parse("2026-10-15T21:53:00Z");
const EVENT_CUTOFF = Date.parse("2026-10-15T22:35:35Z");
const DAY_START = Date.parse("2026-10-02T00:00:00Z");
const DAY_MS = 86_400_000;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaults = {
  "claude-mem-db": join(homedir(), ".claude-mem/claude-mem.db"),
  "memory-dir": join(homedir(), ".agenthub/memory"),
  "project-dir": repo,
  "claude-projects": join(homedir(), ".claude/projects"),
  "codex-memories": join(homedir(), ".codex/memories"),
  "research-dir": join(homedir(), ".agenthub/research"),
  cases: join(repo, "docs/plans/amem-cases.json"),
};
type Paths = typeof defaults;
type Counts = Record<string, unknown>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
// JSON objects below contain only fixed public keys and numeric counts; never input labels or error messages.
function attempt(f: () => Counts): Counts {
  try { return { readable: 1, ...f() }; } catch { return { readable: 0, errors: 1 }; }
}
function parseArgs(args: string[]): Paths {
  const paths = { ...defaults };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "") as keyof Paths;
    if (!args[i]?.startsWith("--") || !Object.hasOwn(paths, key) || !args[i + 1]) throw new Error("arguments");
    paths[key] = resolve(args[i + 1]!);
  }
  return paths;
}
function claudeMem(path: string): Counts {
  const db = new Database(path, { readonly: true });
  try {
    db.exec("BEGIN"); // One SQLite read snapshot for all counts; no schema/pragma changes.
    const one = (sql: string, ...values: number[]) => db.query(sql).get(...values) as Record<string, number>;
    const where = "created_at_epoch < ?";
    const daily = Array.from({ length: 14 }, (_, i) => one(
      "SELECT count(*) AS n FROM observations WHERE created_at_epoch >= ? AND created_at_epoch < ?",
      DAY_START + i * DAY_MS, DAY_START + (i + 1) * DAY_MS,
    ).n!);
    const sorted = [...daily].sort((a, b) => a - b);
    const E1 = { ...one(`SELECT count(*) AS observations, coalesce(sum(discovery_tokens),0) AS discovery_tokens FROM observations WHERE ${where}`, CM_CUTOFF),
      daily_utc: Object.fromEntries(daily.map((n, i) => [new Date(DAY_START + i * DAY_MS).toISOString().slice(0, 10), n])),
      days: 14, min: sorted[0], max: sorted[13], median: (sorted[6]! + sorted[7]!) / 2, total: daily.reduce((a, b) => a + b, 0) };
    const E2 = one(`SELECT coalesce(sum(relevance_count > 0),0) AS relevance_positive, coalesce(sum(occurrence_count > 1),0) AS occurrence_repeated FROM observations WHERE ${where}`, CM_CUTOFF);
    const E6 = one(`SELECT count(DISTINCT project) AS project_keys, count(DISTINCT CASE WHEN instr(project,'/') = 0 THEN project END) AS keys_without_slash, coalesce(sum(project = 'agent-hub'),0) AS agent_hub, coalesce(sum(project = 'work/dev/agent-hub'),0) AS work_dev_agent_hub FROM observations WHERE ${where}`, CM_CUTOFF);
    const E8 = one(`SELECT count(*) AS work_state_entries FROM work_state_entries WHERE ${where}`, CM_CUTOFF);
    db.exec("COMMIT");
    return { E1, E2, E6, E8 };
  } finally { db.close(); }
}
const OPS = ["note", "goal", "forget", "supersede", "demote", "settle", "goal_state", "goal_link", "lease", "lease_force", "suggest", "confirm", "reject"] as const;
const KINDS = ["decision", "finding", "contract", "fail"] as const;
const zeros = (keys: readonly string[]) => Object.fromEntries(keys.map(k => [k, 0]));
function native(path: string): Counts {
  const by_op = zeros([...OPS, "unknown"]), by_kind = zeros(KINDS), by_tier = zeros(["short", "long", "other"]);
  const segments = { log: 0, local: 0 };
  const decisions = { approved: 0, changes_requested: 0, other: 0 };
  let rows = 0, malformed = 0, long_decisions = 0, long_auto_outcomes = 0, fail_rows = 0;
  const failHashes = new Set<string>();
  for (const sub of ["log", "local"] as const) {
    for (const file of readdirSync(join(path, sub)).filter(f => f.endsWith(".jsonl")).sort()) {
      for (const line of readFileSync(join(path, sub, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        let e: Record<string, unknown>;
        try { e = JSON.parse(line); if (!e || typeof e !== "object") throw new Error(); } catch { malformed++; continue; }
        const at = typeof e.at === "string" ? Date.parse(e.at) : NaN;
        if (!Number.isFinite(at)) { malformed++; continue; }
        if (at > NATIVE_CUTOFF) continue;
        rows++; segments[sub]++;
        const op = OPS.includes(e.op as typeof OPS[number]) ? String(e.op) : "unknown";
        by_op[op]!++;
        const tier = e.tier === "long" || e.tier === "short" ? e.tier : "other";
        by_tier[tier]!++;
        if (e.op !== "note") continue;
        if (KINDS.includes(e.kind as typeof KINDS[number])) by_kind[String(e.kind)]!++;
        if (typeof e.text !== "string") { malformed++; continue; }
        if (e.kind === "decision") {
          const first = e.text.split("\n")[0]!;
          const category = /^Task #\d+ approved by\b/.test(first) ? "approved"
            : /^Task #\d+ changes requested by\b/.test(first) ? "changes_requested" : "other";
          decisions[category]++;
          if (tier === "long") { long_decisions++; if (category !== "other") long_auto_outcomes++; }
        }
        if (e.kind === "fail") { fail_rows++; failHashes.add(hash(e.text)); }
      }
    }
  }
  return { E3: { rows, malformed, segments, by_op, by_kind, by_tier, decisions, long_decisions, long_auto_outcomes },
    E5: { fail_rows, distinct_fail_text_hashes: failHashes.size } };
}
function events(project: string): Counts {
  const state = join(project, ".agenthub/state");
  let briefs = 0, native_items = 0, claude_mem_items = 0, fails = 0, with_fails = 0, malformed = 0;
  for (const file of readdirSync(state).filter(f => /^events.*\.jsonl$/.test(f)).sort()) {
    for (const line of readFileSync(join(state, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); if (!e || typeof e !== "object") throw new Error(); } catch { malformed++; continue; }
      const at = Date.parse(e.at);
      if (!Number.isFinite(at)) { malformed++; continue; }
      if (at > EVENT_CUTOFF || e.type !== "memory_brief") continue;
      if (![e.native, e.claudeMem, e.fails].every(n => Number.isSafeInteger(n) && n >= 0)) { malformed++; continue; }
      briefs++; native_items += e.native; claude_mem_items += e.claudeMem; fails += e.fails; if (e.fails > 0) with_fails++;
    }
  }
  return { briefs, native_items, claude_mem_items, fails, with_fails, malformed };
}
function recall(project: string): Counts {
  let recalls = 0, chars = 0;
  for (const line of readFileSync(join(project, ".agenthub/state/hub.log"), "utf8").split("\n")) {
    const m = /^(\S+) recall .+: (\d+) chars$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]!);
    if (!Number.isFinite(at) || at > EVENT_CUTOFF) continue;
    recalls++; chars += Number(m[2]);
  }
  return { recalls, chars_total: chars, mean_chars: recalls ? chars / recalls : null };
}
function autoMemory(root: string): Counts {
  let files = 0, project_dirs = 0, projects_with_memory = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    project_dirs++;
    let notes: string[];
    try { notes = readdirSync(join(root, entry.name, "memory")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    const count = notes.filter(f => f.endsWith(".md") && f !== "MEMORY.md" && statSync(join(root, entry.name, "memory", f)).isFile()).length;
    files += count; if (count) projects_with_memory++;
  }
  return { files, project_dirs, projects_with_memory };
}
function fileCount(root: string): number {
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile()) count++;
    else if (entry.isDirectory()) count += fileCount(join(root, entry.name));
  }
  return count;
}
function registry(path: string): Counts {
  const cases = JSON.parse(readFileSync(path, "utf8")) as { mode: string; status: string }[];
  // Only the frozen registry's public taxonomy is emitted, never labels from a memory store.
  const modes = ["Truth/lifecycle", "Duplicate/identity", "Retrieval/capture", "Project isolation", "Privacy", "Index integrity/freshness", "Sync/concurrency", "Scale/cost/measurement"];
  const statuses = ["regression-covered", "open-ceiling", "fixed-source", "historical-fixed", "guard/design", "historical-partial", "open-measurement"];
  const by_mode = zeros([...modes, "other"]), by_status = zeros([...statuses, "other"]);
  for (const c of cases) { by_mode[modes.includes(c.mode) ? c.mode : "other"]!++; by_status[statuses.includes(c.status) ? c.status : "other"]!++; }
  return { cases: cases.length, modes: new Set(cases.map(c => c.mode)).size, by_mode, by_status };
}
function collectBaseline(paths: Paths): Counts {
  const cm = attempt(() => claudeMem(paths["claude-mem-db"]));
  const memory = attempt(() => native(paths["memory-dir"]));
  const brief = attempt(() => events(paths["project-dir"]));
  const log = attempt(() => recall(paths["project-dir"]));
  return {
    E1: cm.E1 ?? cm, E2: cm.E2 ?? cm, E3: memory.E3 ?? memory,
    E4: log, E5: { notes: memory.E5 ?? memory, briefs: brief }, E6: cm.E6 ?? cm,
    E7: { sandbox_receipt: null },
    E8: { claude: attempt(() => autoMemory(paths["claude-projects"])), codex: attempt(() => ({ files: fileCount(paths["codex-memories"]) })), claude_mem: cm.E8 ?? cm, vault: null },
    E9: { benchmark: null }, E10: { static_code_review: null },
    E11: attempt(() => { try { return { research_directory_exists: Number(statSync(paths["research-dir"]).isDirectory()) }; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { research_directory_exists: 0 }; throw e; } }),
    E12: attempt(() => registry(paths.cases)),
  };
}
try { console.log(JSON.stringify(collectBaseline(parseArgs(process.argv.slice(2))))); }
catch { console.log(JSON.stringify({ errors: 1 })); process.exitCode = 1; }
