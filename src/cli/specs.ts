import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SpecsEngine, stampFrontmatter, type SpecsConfig, type SpecsStampRow } from "../hub/specs.ts";
import { terminalText } from "./console-state.ts";
import { editJsonText } from "./init-settings.ts";

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
        for (const spec of report.specs) io.out(terminalText(`${spec.id} (${spec.path}): ${spec.title}`));
        for (const item of report.items) io.error(terminalText(`specs: ${item.severity} ${item.code}: ${item.message}; ${item.nextSteps}`));
        if (report.truncated) io.error("specs: scan truncated; narrow specs.roots and run ahub specs check again");
      }
      return report.errors ? 1 : 0;
    }
    const report = engine.check({ ...(base === undefined ? {} : { base }), requireFresh });
    if (json) io.out(JSON.stringify(report));
    else if (report.specCount || report.freshness.length || report.items.length || report.truncated) {
      for (const item of report.items) io.out(terminalText(`specs: ${item.severity} ${item.code}: ${item.message}; ${item.nextSteps}`));
      for (const row of report.freshness) if (row.state === "stale") {
        io.out(terminalText(`specs: ${row.path}: stale (${row.commitsSince ?? "unknown"} source commits${row.dirty ? "; uncommitted source changes" : ""})`));
      }
      if (report.truncated) io.out("specs: scan truncated; narrow specs.roots and run ahub specs check again");
      io.out(`specs: ${report.specCount} specs, ${report.errors} errors, ${report.warnings} warnings, ${report.stale} stale`);
    }
    return report.errors || requireFresh && report.stale ? 1 : 0;
  } catch (error) {
    io.error(terminalText(`specs: ${error instanceof Error ? error.message : "inspection unavailable"}; check the repository and specs configuration, then run ahub specs check again`));
    return 1;
  }
}

/** What `ahub specs stamp` needs from its surroundings: whether a person is at a terminal, and a yes/no question to ask them. Tests pass their own. */
export interface SpecsStampTerminal { isTTY: boolean; ask(question: string): Promise<boolean> }

const STAMP_USAGE = "usage: ahub specs stamp <id-or-document>... [--yes]";
const writeAtomic = (path: string, bytes: Buffer, mode: number): void => {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, bytes, { mode, flag: "wx" });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
};

/**
 * #1064 T3: `ahub specs stamp <id-or-document>... [--yes]`, a person's record that they reviewed a spec or stamped document against HEAD.
 * Person only, three ways: main.ts refuses any agent identity before this runs (the command is `console` class, and `--live-test` delegation is refused for it too), this refuses
 * a run without a terminal even with --yes, and nothing here talks to the hub. It shows what it would write (the old and new stamp per document), asks, and then changes only the
 * `verified-against` line of a spec, or the `verifiedAgainst` value of a stamps-file entry, keeping every other byte. It is refused, writing nothing, while a document's covered
 * paths have uncommitted changes. The new stamp is the full HEAD SHA, so it is an ancestor of HEAD.
 */
export async function runSpecsStamp(args: readonly string[], root: string, config: SpecsConfig, terminal: SpecsStampTerminal, io: SpecsOutput = output): Promise<number> {
  const targets: string[] = [];
  let yes = false;
  for (const arg of args) {
    if (arg === "--yes" && !yes) yes = true;
    else if (!arg.startsWith("-")) targets.push(arg);
    else { io.error(STAMP_USAGE); return 1; }
  }
  if (!targets.length) { io.error(STAMP_USAGE); return 1; }
  if (!terminal.isTTY) {
    io.error("specs: stamping records a person's review and needs a terminal, even with --yes; run ahub specs stamp in your own terminal, or in ahub console; nothing was written");
    return 1;
  }
  try {
    const engine = new SpecsEngine(root, config);
    const plan = engine.stampPlan(targets);
    if (plan.refusals.length) {
      for (const refusal of plan.refusals) io.error(terminalText(`specs: ${refusal}`));
      io.error("specs: nothing was written");
      return 1;
    }
    const short = (sha: string | null) => sha === null ? "none" : sha.slice(0, 12);
    io.out(terminalText(`stamp against HEAD ${plan.head.slice(0, 12)}:`));
    for (const row of plan.rows) io.out(terminalText(`  ${row.path}${row.document ? ` (${row.document})` : ""}: ${short(row.from)} -> ${short(row.to)}${row.from === row.to ? " (already this stamp)" : ""}`));
    const changing = plan.rows.filter(row => row.from !== row.to);
    if (!changing.length) { io.out("specs: every named document already holds this stamp; nothing to write"); return 0; }
    if (!yes && !await terminal.ask(`Record that you reviewed ${changing.length === 1 ? "this document" : `these ${changing.length} documents`} against HEAD ${plan.head.slice(0, 12)}?`)) {
      io.out("specs: not stamped; nothing was written");
      return 0;
    }
    // One file at a time, each atomic. Spec files first; a stamps file takes all of its entries in one write.
    const byFile = new Map<string, SpecsStampRow[]>();
    for (const row of changing) byFile.set(row.path, [...(byFile.get(row.path) ?? []), row]);
    for (const [path, rows] of byFile) {
      const absolute = resolve(engine.rootPath, path), original = readFileSync(absolute), mode = statSync(absolute).mode & 0o777; // the file keeps its own permissions
      let next: string;
      if (rows[0]!.kind === "stamps-file") {
        next = original.toString("utf8");
        for (const row of rows) next = editJsonText(next, ["documents", row.document!, "verifiedAgainst"], row.to);
        JSON.parse(next); // the edit must still be the JSON the engine reads
      } else {
        const done = stampFrontmatter(original.toString("latin1"), rows[0]!.to);
        if (!done.ok) { io.error(terminalText(`specs: ${path}: ${done.error}; nothing more was written`)); return 1; }
        next = done.text;
      }
      writeAtomic(absolute, rows[0]!.kind === "stamps-file" ? Buffer.from(next, "utf8") : Buffer.from(next, "latin1"), mode);
    }
    io.out(`specs: stamped ${changing.length} document${changing.length === 1 ? "" : "s"} at ${plan.head.slice(0, 12)}; review the diff and commit it`);
    return 0;
  } catch (error) {
    io.error(terminalText(`specs: ${error instanceof Error ? error.message : "stamping unavailable"}; check the repository and specs configuration, then run ahub specs stamp again`));
    return 1;
  }
}
