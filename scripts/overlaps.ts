// Issue #8 T1: how often the claim overlap warning fires, and which tasks it named. Reads hub.log files only.
// usage: bun scripts/overlaps.ts [--since YYYY-MM-DD] <hub.log>...
// every registered project: ahub projects --json | jq -r '.[].stateDir + "/hub.log"' | tr '\n' '\0' | xargs -0 bun scripts/overlaps.ts
import { existsSync, readFileSync } from "node:fs";

export interface Overlap {
  /** The log it came from: task ids are per project. */
  source: string;
  at: string;
  task: number;
  owner: string;
  others: { task: number; owner: string; paths: string[] }[];
}

// The notice Tasks.assignOwner writes, checked against the real one in test/overlaps.test.ts:
// "<iso> task #2 <title> (codex): Overlaps #1 (owner kimi) on a.ts, b.ts; #3 (owner local) on c.ts. codex is told to settle it."
// ponytail: message bodies are logged with their newlines, so a peer could forge such a line, and a path containing
// ", " or "; " or a newline is split or missed; fine for counting, not for acting on.
const LINE = /^(\d{4}-\d\d-\d\dT\S+) task #(\d+) .*\(([\w.-]+)\): Overlaps (.+)\. (?:[\w.-]+|Whoever takes it) is told to settle it\.$/;
const HIT = /^#(\d+) \(owner ([\w.-]+)\) on (.+)$/;

export function parse(text: string, source = ""): Overlap[] {
  return text.split("\n").flatMap((line) => {
    const m = LINE.exec(line);
    if (!m) return [];
    const others = m[4]!.split("; ").flatMap((hit) => {
      const h = HIT.exec(hit);
      return h ? [{ task: Number(h[1]), owner: h[2]!, paths: h[3]!.split(", ") }] : [];
    });
    return others.length ? [{ source, at: m[1]!, task: Number(m[2]), owner: m[3]!, others }] : [];
  });
}

/** Monday of the UTC week the timestamp falls in. */
const weekOf = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

interface Pair { source: string; ids: [number, number]; owners: Map<number, Set<string>>; paths: Set<string>; first: string; count: number }

/**
 * Warnings per week, then each pair of tasks once (per project; a reassigned task keeps its pair), with its owners,
 * shared paths and how often it was warned about. Paths and project directories stay in this output.
 */
export function report(items: Overlap[], since = ""): string[] {
  const weeks = new Map<string, { warnings: number; pairs: Map<string, Pair> }>();
  for (const o of items.filter((i) => i.at >= since).sort((a, b) => a.at.localeCompare(b.at))) {
    const week = weeks.get(weekOf(o.at)) ?? { warnings: 0, pairs: new Map() };
    weeks.set(weekOf(o.at), week);
    week.warnings++;
    for (const other of o.others) {
      const ids: [number, number] = o.task < other.task ? [o.task, other.task] : [other.task, o.task];
      const key = `${o.source}\n${ids.join(" ")}`;
      const pair = week.pairs.get(key) ?? { source: o.source, ids, owners: new Map(ids.map((id) => [id, new Set<string>()])), paths: new Set<string>(), first: o.at, count: 0 };
      week.pairs.set(key, pair);
      pair.count++;
      pair.owners.get(o.task)!.add(o.owner);
      pair.owners.get(other.task)!.add(other.owner);
      for (const p of other.paths) pair.paths.add(p);
    }
  }
  if (!weeks.size) return ["no overlap warnings"];
  const end = (p: Pair, id: number) => `#${id} (${[...p.owners.get(id)!].join(", ")})`;
  return [...weeks].flatMap(([week, w]) => [
    `week of ${week}: ${w.warnings} warning${w.warnings === 1 ? "" : "s"}, ${w.pairs.size} task pair${w.pairs.size === 1 ? "" : "s"}`,
    ...[...w.pairs.values()].map((p) => `  ${p.source ? `${p.source}: ` : ""}${end(p, p.ids[0])} and ${end(p, p.ids[1])} on ${[...p.paths].join(", ")}: first ${p.first}, ${p.count}x`),
  ]);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--since");
  const since = at >= 0 ? args.splice(at, 2)[1] ?? "" : "";
  if (!args.length || (at >= 0 && !/^\d{4}-\d\d-\d\d$/.test(since))) {
    console.error("usage: bun scripts/overlaps.ts [--since YYYY-MM-DD] <hub.log>...");
    process.exit(2);
  }
  const files = args.filter((f) => existsSync(f));
  for (const f of args) if (!files.includes(f)) console.error(`skipped, not found: ${f}`);
  for (const line of report(files.flatMap((f) => parse(readFileSync(f, "utf8"), f)), since)) console.log(line);
}
