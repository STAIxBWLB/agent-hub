// #719 (#1180): what `bun scripts/inventory-hardcoded-values.ts --check` decides, as pure functions over the generator's entries and the committed baseline. Kept out of the generator because that
// script does all of its work at import time; `test/inventory-hardcoded-values.test.ts` pins every refusal here without a source tree.
//
// The inventory had no check at all after it was committed (#764): nothing ran the generator, so 22 unknown keys at its own head became 1438. The check passes only when every unknown key is in
// the committed baseline of known-unclassified keys (`scripts/inventory-hardcoded-values.baseline.json`), and the baseline only shrinks: a key that is classified now, or that no longer exists,
// must leave it, so classified work cannot be undone silently and new drift cannot hide among the old. The report lists every offending key: a person fixing drift needs all of them, and a list
// that stops early would make the next run find more.

export interface CheckedEntry { key: string; classification: string; file?: string; line?: number; kind?: string; name?: string; value?: string }

export interface InventoryCheck {
  /** An unknown key that is not in the baseline: new drift. */
  fresh: CheckedEntry[];
  /** A baseline key that is classified now: it must leave the baseline. */
  settled: string[];
  /** A baseline key that matches no entry any more (the code moved or changed): it must leave the baseline. */
  gone: string[];
  /** How many baseline keys are still unknown. */
  baselineUnknown: number;
}

export function checkInventory(entries: readonly CheckedEntry[], baseline: ReadonlySet<string>): InventoryCheck {
  const byKey = new Map(entries.map(entry => [entry.key, entry.classification]));
  return {
    fresh: entries.filter(entry => entry.classification === "unknown" && !baseline.has(entry.key)),
    settled: [...baseline].filter(key => byKey.has(key) && byKey.get(key) !== "unknown"),
    gone: [...baseline].filter(key => !byKey.has(key)),
    baselineUnknown: [...baseline].filter(key => byKey.get(key) === "unknown").length,
  };
}

/** The lines a failing check prints, each group with its cause and the next step. Empty when the check passes. */
export function checkReport(result: InventoryCheck): string[] {
  const lines: string[] = [];
  const s = (n: number) => n === 1 ? "" : "s";
  const it = (n: number) => n === 1 ? "it" : "them";
  if (result.fresh.length) {
    lines.push(`${result.fresh.length} inventory key${s(result.fresh.length)} not in scripts/inventory-hardcoded-values.classifications.json and not in the baseline:`,
      ...result.fresh.map(entry => `  ${entry.file ?? "?"}:${entry.line ?? "?"} ${entry.kind ?? "?"} ${entry.name ?? "?"} = ${entry.value ?? "?"}   [${entry.key}]`),
      "Classify each as operational, safety floor, contract or test seam in scripts/inventory-hardcoded-values.classifications.json, by the reasons in docs/verification/2026-10-30-operational-settings-closure.md,",
      "then run bun scripts/inventory-hardcoded-values.ts --check again. Never add a key to the baseline: it only shrinks.");
  }
  if (result.settled.length) {
    lines.push(`${result.settled.length} baseline key${s(result.settled.length)} already classified; remove ${it(result.settled.length)} from scripts/inventory-hardcoded-values.baseline.json (the baseline only shrinks):`,
      ...result.settled.map(key => `  ${key}`));
  }
  if (result.gone.length) {
    lines.push(`${result.gone.length} baseline key${s(result.gone.length)} match no inventory entry any more (the code moved or changed); remove ${it(result.gone.length)} from the baseline, and classify any new key that replaced ${it(result.gone.length)}:`,
      ...result.gone.map(key => `  ${key}`));
  }
  return lines;
}
