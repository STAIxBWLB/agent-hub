// AC4 of issue #198: the PII screen against the synthetic fixture set (test/fixtures/pii-screen.json). A live check:
// it calls the project's on-device model, or its gateway only while on campus, exactly as the hub would, so it is
// never part of the hermetic suite. Exit 1 when recall is under the bound fixed in the spec before measuring.
//   bun scripts/pii-screen-eval.ts [--project <dir>] [--out docs/verification/<date>-pii-screen.md]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";
import { screenPii, type PiiVerdict } from "../src/hub/inference.ts";
import { currentRouting } from "../src/hub/routing.ts";
import { ensureMlx } from "../src/models/mlx.ts";
import { OmniRoute } from "../src/omniroute/client.ts";

/** Fixed in the spec before any measurement: the model itself labels at least this share of the positives `pii`. */
export const RECALL_BOUND = 0.9;

export interface Item {
  id: string;
  lang: "ko" | "en";
  pii: boolean;
  category?: string;
  text: string;
}

const share = (n: number, d: number) => (d ? n / d : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Recall counts only `pii` labels (an unknown verdict is a miss for the model); `handledRecall` is what the hub does,
 * unknown being handled as PII. Precision is over `pii` labels; `held` is the share of negatives the hub would keep
 * on the local worker (pii or unknown).
 */
export function score(items: Item[], verdicts: PiiVerdict[]) {
  const pairs = items.map((item, i) => ({ item, v: verdicts[i]! }));
  const pos = pairs.filter((p) => p.item.pii);
  const neg = pairs.filter((p) => !p.item.pii);
  const tp = pos.filter((p) => p.v.label === "pii");
  const fp = neg.filter((p) => p.v.label === "pii");
  const ms = verdicts.map((v) => v.ms).sort((a, b) => a - b);
  const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0;
  return {
    recall: share(tp.length, pos.length),
    handledRecall: share(pos.filter((p) => p.v.label !== "clear").length, pos.length),
    precision: share(tp.length, tp.length + fp.length),
    unknownRate: share(pairs.filter((p) => p.v.label === "unknown").length, pairs.length),
    held: share(neg.filter((p) => p.v.label !== "clear").length, neg.length),
    categoryAgreement: share(tp.filter((p) => p.v.category === p.item.category).length, tp.length),
    missed: pos.filter((p) => p.v.label !== "pii").map((p) => `${p.item.id} (${p.v.label}${p.v.miss ? `: ${p.v.miss}` : ""})`),
    notCleared: neg.filter((p) => p.v.label !== "clear").map((p) => `${p.item.id} (${p.v.label}${p.v.miss ? `: ${p.v.miss}` : ""})`),
    latency: { p50: at(0.5), p95: at(0.95), max: ms.at(-1) ?? 0 },
    counts: { items: pairs.length, positives: pos.length, negatives: neg.length },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const project = arg("--project") ?? process.cwd();
  const config = loadConfig(project);
  const omni = new OmniRoute(config.omniroute);
  const fixedModel = currentRouting(project).local.fixed_model;
  const device = config.mlx.enabled === false ? undefined : () => ensureMlx(config.mlx);
  const deps = { ...(device ? { device } : {}), omni, onCampus: () => omni.onCampus(), fixedModel: () => fixedModel };
  const { items } = JSON.parse(readFileSync(join(import.meta.dir, "..", "test", "fixtures", "pii-screen.json"), "utf8")) as { items: Item[] };
  const onDevice = device ? await device().then((h) => h.model, () => undefined) : undefined;
  const campus = await omni.onCampus();
  const path = onDevice
    ? `on-device model ${onDevice}${campus ? `; items that find the slot taken, or the device failing or still loading, are answered by the campus gateway, model ${fixedModel}` : ""}`
    : campus ? `campus gateway, model ${fixedModel}` : "none: off campus and no on-device model, so every verdict is unknown";
  const verdicts: PiiVerdict[] = [];
  for (const item of items) verdicts.push(await screenPii(item.text, deps)); // one at a time, like the hub's slot
  const s = score(items, verdicts);
  const report = [
    `# PII screen calibration (issue #198), ${new Date().toISOString().slice(0, 10)}`,
    "",
    `- Screen: ${path}`,
    `- Fixtures: ${s.counts.items} synthetic items (${s.counts.positives} positives, ${s.counts.negatives} hard negatives), test/fixtures/pii-screen.json`,
    `- Recall (pii labels only): ${pct(s.recall)}; bound ${pct(RECALL_BOUND)}, fixed before measuring: ${s.recall >= RECALL_BOUND ? "met" : "NOT met"}`,
    `- Recall as handled (pii or unknown): ${pct(s.handledRecall)}`,
    `- Precision (pii labels): ${pct(s.precision)}`,
    `- Unknown rate: ${pct(s.unknownRate)}`,
    `- Hard negatives held as PII (pii or unknown): ${pct(s.held)}`,
    `- Category agreement on true positives: ${pct(s.categoryAgreement)}`,
    `- Latency: p50 ${s.latency.p50} ms, p95 ${s.latency.p95} ms, max ${s.latency.max} ms`,
    `- Missed positives: ${s.missed.join(", ") || "none"}`,
    `- Negatives not cleared: ${s.notCleared.join(", ") || "none"}`,
    "",
  ].join("\n");
  process.stdout.write(report);
  const out = arg("--out");
  if (out) writeFileSync(out, report);
  process.exit(s.recall >= RECALL_BOUND ? 0 : 1);
}
