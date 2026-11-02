import type { BriefFile } from "./review-brief.ts";
import { parseSpecsConfig, SpecsEngine, type SpecsConfig, type SpecsCheckReport, type SpecsCoverReport } from "./specs.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { realPath } from "./project.ts";

export interface SpecAck { id: string; reason: string }
export interface SpecRef { id: string; path: string; title: string; reason?: string }
export interface SpecTaskReport {
  head: string;
  complete: boolean;
  errors: number;
  unchanged: SpecRef[];
  changed: SpecRef[];
  truncated?: boolean;
  reason?: string;
}
export interface SpecsStatus { specCount: number; documents: number; errors: number; stale: number; truncated: boolean }

const UNAVAILABLE = new Set(["discovery-unavailable", "snapshot-unavailable", "coverage-unavailable"]);

/** Host-bound repository inspection only. Tasks owns caller/privacy projection and every board write. */
export class SpecTaskInspector {
  private readonly engines = new Map<string, SpecsEngine>();
  private readonly root: string;
  constructor(root: string, private readonly config: () => SpecsConfig) { this.root = realPath(root); }

  /** A positive absence only; unsafe or incomplete reads must not claim the block is missing. */
  missingBlock(): boolean | undefined {
    const file = join(this.root, "AGENTS.md");
    let fd: number | undefined;
    try {
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 256 * 1024) return undefined;
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) return undefined;
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) { const got = readSync(fd, bytes, count, bytes.length - count, count); if (!got) break; count += got; }
      const text = bytes.subarray(0, count).toString("utf8"), after = lstatSync(file);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return undefined;
      const begin = text.indexOf("<!-- AGENT_HUB_SPECS:BEGIN"), end = text.indexOf("<!-- AGENT_HUB_SPECS:END");
      return begin < 0 || end < begin;
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? true : undefined; }
    finally { if (fd !== undefined) try { closeSync(fd); } catch { /* The optional hint must not break status. */ } }
  }

  private engine(commit?: string): SpecsEngine {
    const config = parseSpecsConfig(this.config());
    const key = JSON.stringify([config.roots, config.stamps_file, commit ?? "live"]);
    const cached = this.engines.get(key);
    if (cached) { this.engines.delete(key); this.engines.set(key, cached); return cached; }
    const engine = new SpecsEngine(this.root, config, commit === undefined ? {} : { commit });
    this.engines.set(key, engine);
    // One live view and a small number of immutable submitted-head views, never an unbounded PR cache.
    if (this.engines.size > 4) this.engines.delete(this.engines.keys().next().value!);
    return engine;
  }

  notice(paths: readonly string[]): SpecsCoverReport | undefined {
    const config = this.config();
    if (!config.enabled || config.review === "off" || !paths.length) return undefined;
    const report = this.engine().covers(paths);
    return report.specs.length ? report : undefined;
  }

  read(action: "check", paths: readonly string[]): SpecsCheckReport;
  read(action: "covers", paths: readonly string[]): SpecsCoverReport;
  read(action: "check" | "covers", paths: readonly string[]): SpecsCheckReport | SpecsCoverReport;
  read(action: "check" | "covers", paths: readonly string[]): SpecsCheckReport | SpecsCoverReport {
    return action === "check" ? this.engine().check() : this.engine().covers(paths);
  }

  status(): SpecsStatus | undefined {
    const config = this.config();
    if (!config.enabled) return undefined;
    const report = this.engine().check();
    if (!report.specCount && !report.freshness.length && !(config.stamps_file && report.errors)) return undefined;
    return { specCount: report.specCount, documents: report.freshness.length, errors: report.errors, stale: report.stale, truncated: report.truncated };
  }

  inspect(head: string, changedFiles: readonly BriefFile[] | undefined, options: { complete: boolean; acks?: readonly SpecAck[] }): SpecTaskReport | undefined {
    const config = this.config();
    if (!config.enabled || config.review === "off") return undefined;
    if (!/^[0-9a-f]{40}$/.test(head)) {
      const live = this.engine().list();
      if (!live.specs.length && !config.stamps_file) return undefined;
      return { head, complete: false, errors: 0, unchanged: [], changed: [], reason: "submitted full head is unavailable" };
    }
    let engine: SpecsEngine, check: SpecsCheckReport;
    try { engine = this.engine(head); check = engine.check(); }
    catch { return { head, complete: false, errors: 0, unchanged: [], changed: [], reason: "submitted spec tree is unavailable" }; }
    if (!check.specCount && !check.freshness.length && !config.stamps_file && !check.truncated && !check.errors) return undefined;
    const coverage = engine.list();
    const unavailable = coverage.items.some(item => UNAVAILABLE.has(item.code));
    if (!options.complete || !changedFiles || coverage.truncated || unavailable) return { head, complete: false, errors: check.errors, unchanged: [], changed: [], truncated: coverage.truncated, reason: "spec coverage or submitted changed-file evidence is incomplete" };
    const changedPaths = new Set(changedFiles.flatMap(file => [file.path, ...(file.oldPath ? [file.oldPath] : [])]));
    const covers = engine.covers([...changedPaths]);
    if (covers.items.some(item => UNAVAILABLE.has(item.code) || item.code === "invalid-cover-path")) return { head, complete: false, errors: check.errors, unchanged: [], changed: [], reason: "changed-file path coverage is unavailable" };
    const acks = new Map((options.acks ?? []).map(ack => [ack.id, ack.reason]));
    const changed: SpecRef[] = [], unchanged: SpecRef[] = [];
    for (const spec of covers.specs) {
      const row: SpecRef = { ...spec, ...(acks.has(spec.id) ? { reason: acks.get(spec.id)! } : {}) };
      (changedPaths.has(spec.path) ? changed : unchanged).push(row);
    }
    if (!changed.length && !unchanged.length && !check.errors && !covers.truncated) return undefined;
    return { head, complete: !covers.truncated, errors: check.errors, changed, unchanged, truncated: covers.truncated };
  }
}
