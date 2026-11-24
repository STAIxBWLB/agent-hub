// Friction compare (#1644 T4): two reports of the same corpus, class counts side by side. A different corpus version is refused
// (AC5): the counts of two measuring sticks say nothing about each other. The binary version and digest of both sides are printed.
import { readFileSync } from "node:fs";
import type { FrictionClass } from "./classify.ts";
import type { Report } from "./run.ts";

const CLASSES: FrictionClass[] = ["in_band", "out_of_band", "dead_end", "by_design"];

export interface JourneyDelta { id: string; before?: Record<FrictionClass, number>; after?: Record<FrictionClass, number>; delta: Record<FrictionClass, number> }
export interface Comparison { a: Report["binary"]; b: Report["binary"]; totals: Record<FrictionClass, number>; journeys: JourneyDelta[] }

const blank = (): Record<FrictionClass, number> => ({ in_band: 0, out_of_band: 0, dead_end: 0, by_design: 0 });

export function compareReports(a: Report, b: Report): Comparison {
  if (a.corpusVersion !== b.corpusVersion) throw new Error(`refusing to compare corpus version ${a.corpusVersion} with ${b.corpusVersion}: re-run both sides on one corpus`);
  const before = new Map(a.journeys.map(row => [row.id, row.blocks])), after = new Map(b.journeys.map(row => [row.id, row.blocks]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const journeys = ids.map((id): JourneyDelta => {
    const x = before.get(id), y = after.get(id), delta = blank();
    for (const name of CLASSES) delta[name] = (y?.[name] ?? 0) - (x?.[name] ?? 0);
    return { id, ...(x ? { before: x } : {}), ...(y ? { after: y } : {}), delta };
  });
  const totals = blank();
  for (const name of CLASSES) totals[name] = b.totals[name] - a.totals[name];
  return { a: a.binary, b: b.binary, totals, journeys };
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const short = (digest: string) => digest.slice(0, 12);

export function renderComparison(result: Comparison): string {
  const lines = [`a: ${result.a.version} (${short(result.a.digest)})`, `b: ${result.b.version} (${short(result.b.digest)})`, `total: ${CLASSES.map(name => `${name} ${signed(result.totals[name])}`).join(", ")}`];
  for (const row of result.journeys) {
    const note = !row.before ? " (new in b)" : !row.after ? " (gone in b)" : "";
    const moved = CLASSES.filter(name => row.delta[name] !== 0);
    lines.push(`${row.id}${note}: ${moved.length ? moved.map(name => `${name} ${signed(row.delta[name])}`).join(", ") : "no change"}`);
  }
  return lines.join("\n");
}

function load(path: string): Report {
  const value = JSON.parse(readFileSync(path, "utf8")) as Report;
  if (typeof value?.corpusVersion !== "number" || !value.binary || !value.totals || !Array.isArray(value.journeys)) throw new Error(`${path} is not a friction report`);
  return value;
}

if (import.meta.main) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) { console.error("usage: bun scripts/benchmarks/friction/compare.ts <a.json> <b.json>"); process.exit(2); }
  try { console.log(renderComparison(compareReports(load(a), load(b)))); } catch (error) { console.error(`friction: ${(error as Error).message}`); process.exit(1); }
}
