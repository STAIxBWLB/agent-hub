import { SpecsEngine, type SpecsConfig } from "../hub/specs.ts";

export interface SpecsOutput { out(line: string): void; error(line: string): void }
const output: SpecsOutput = { out: line => console.log(line), error: line => console.error(line) };

/** Read-only repository inspection: no daemon connection or stamp mutation. */
export function runSpecs(args: readonly string[], root: string, config: SpecsConfig, io: SpecsOutput = output): number {
  const [command, ...rest] = args;
  const usage = "usage: ahub specs list [--json] | check [--require-fresh] [--base <ref>] [--json] | covers <file...>";
  if (!["list", "check", "covers"].includes(command ?? "")) { io.error(usage); return 1; }
  let json = false, requireFresh = false, base: string | undefined;
  const paths: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === "--json" && command !== "covers" && !json) json = true;
    else if (arg === "--require-fresh" && command === "check" && !requireFresh) requireFresh = true;
    else if (arg === "--base" && command === "check" && base === undefined) {
      base = rest[++index];
      if (!base || base.startsWith("-")) { io.error("specs: --base needs a Git reference; name a commit or branch"); return 1; }
    } else if (command === "covers" && !arg.startsWith("-")) paths.push(arg);
    else { io.error(usage); return 1; }
  }
  if (command === "covers" && !paths.length) { io.error(usage); return 1; }
  try {
    const engine = new SpecsEngine(root, config);
    if (command === "list" || command === "covers") {
      const report = command === "list" ? engine.list() : engine.covers(paths);
      if (json) io.out(JSON.stringify(report));
      else {
        for (const spec of report.specs) io.out(`${spec.id} (${spec.path}): ${spec.title}`);
        if (report.truncated) io.error("specs: scan truncated; narrow specs.roots and run ahub specs check again");
      }
      return report.errors ? 1 : 0;
    }
    const report = engine.check({ ...(base === undefined ? {} : { base }), requireFresh });
    if (json) io.out(JSON.stringify(report));
    else if (report.specCount || report.freshness.length || report.items.length || report.truncated) {
      for (const item of report.items) io.out(`specs: ${item.severity} ${item.code}: ${item.message}; ${item.nextSteps}`);
      for (const row of report.freshness) if (row.state === "stale") {
        io.out(`specs: ${row.path}: stale (${row.commitsSince ?? "unknown"} source commits${row.dirty ? "; uncommitted source changes" : ""})`);
      }
      if (report.truncated) io.out("specs: scan truncated; narrow specs.roots and run ahub specs check again");
      io.out(`specs: ${report.specCount} specs, ${report.errors} errors, ${report.warnings} warnings, ${report.stale} stale`);
    }
    return report.errors || requireFresh && report.stale ? 1 : 0;
  } catch (error) {
    io.error(`specs: ${error instanceof Error ? error.message : "inspection unavailable"}; check the repository and specs configuration, then run ahub specs check again`);
    return 1;
  }
}
