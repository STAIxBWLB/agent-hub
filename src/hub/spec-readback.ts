import { childEnv } from "./child-process.ts";
import { hubGitSync } from "./git.ts";
import { surveyArray, surveyInputAt, surveyObject, surveyPath, surveyText } from "./advisor-survey.ts";

const TEXT_BYTES = 1024;
const MAX_ITEMS = 16;
const MAX_REFS = 64;

interface ReadbackDetails {
  undefined?: { term: string; where: string }[];
  open_decisions?: { decision: string; where: string }[];
  refs?: string[];
}

export type SpecReadbackReport = ReadbackDetails & (
  | { task: number; proposes: string; existing: string }
  | { task: number; cannot_paraphrase: string }
);

export function parseSpecReadbackReport(input: unknown): SpecReadbackReport {
  const at = surveyInputAt;
  const fields = at("report", "requires a closed object", () => surveyObject(input, [
    "task", "proposes", "existing", "cannot_paraphrase", "undefined", "open_decisions", "refs",
  ]));
  const task = at("task", "requires a positive integer", () => {
    if (typeof fields.task !== "number" || !Number.isSafeInteger(fields.task) || fields.task < 1) {
      throw new Error("invalid read-back task");
    }
    return fields.task;
  });
  const readText = (value: unknown, field: string) =>
    at(field, `requires nonempty text within ${TEXT_BYTES} UTF-8 bytes`, () => surveyText(value, TEXT_BYTES));
  const entries = (name: "undefined" | "open_decisions") =>
    at(name, `allows up to ${MAX_ITEMS} items`, () => surveyArray(fields[name], MAX_ITEMS));
  const details: ReadbackDetails = {};
  if (Object.hasOwn(fields, "undefined")) {
    details.undefined = entries("undefined").map((item, index) => {
      const key = `undefined[${index}]`;
      const entry = at(key, "requires a term and location", () => surveyObject(item, ["term", "where"]));
      return { term: readText(entry.term, `${key}.term`), where: readText(entry.where, `${key}.where`) };
    });
  }
  if (Object.hasOwn(fields, "open_decisions")) {
    details.open_decisions = entries("open_decisions").map((item, index) => {
      const key = `open_decisions[${index}]`;
      const entry = at(key, "requires a decision and location", () => surveyObject(item, ["decision", "where"]));
      return { decision: readText(entry.decision, `${key}.decision`), where: readText(entry.where, `${key}.where`) };
    });
  }
  if (Object.hasOwn(fields, "refs")) {
    details.refs = at("refs", `allows up to ${MAX_REFS} paths`, () => surveyArray(fields.refs, MAX_REFS))
      .map((value, index) => at(`refs[${index}]`, "requires a repository-relative path within 512 UTF-8 bytes", () => surveyPath(value)));
  }
  if (Object.hasOwn(fields, "cannot_paraphrase")) {
    at("cannot_paraphrase", "use a section in place of proposes and existing", () => {
      if (Object.hasOwn(fields, "proposes") || Object.hasOwn(fields, "existing")) throw new Error("mixed read-back report forms");
    });
    return { task, cannot_paraphrase: readText(fields.cannot_paraphrase, "cannot_paraphrase"), ...details };
  }
  return { task, proposes: readText(fields.proposes, "proposes"), existing: readText(fields.existing, "existing"), ...details };
}

/**
 * #1658 T4: where a task's read-back stands against the issue's current body. `current` without lists is a request
 * whose reader has not reported yet; the lists exist only once a report does, and `private` is the stub a task shows
 * once the board holds it private, because a report's terms and decisions are the spec's text.
 */
type ReadbackState = "none" | "current" | "stale" | "unavailable" | "private";
export interface ReadbackView {
  state: ReadbackState;
  undefined?: { term: string; where: string }[];
  open_decisions?: { decision: string; where: string }[];
  missing_refs?: string[];
}

/** The short state text shared by `ahub sdlc status`/`explain` and the line `accept` prints. */
export function readbackSummary(view: ReadbackView): string {
  if (view.state === "none") return "none";
  if (view.state === "private") return "private (the report is withheld with the task's text)";
  if (view.state === "unavailable") return "unavailable (the issue's edit time could not be read)";
  if (view.state === "stale") return "stale (the body changed after the last one)";
  if (view.missing_refs === undefined) return "current (requested; the reader has not reported yet)";
  const terms = view.undefined?.length ?? 0, decisions = view.open_decisions?.length ?? 0, missing = view.missing_refs.length;
  return `current (${terms} undefined term${terms === 1 ? "" : "s"}, ${decisions} open decision${decisions === 1 ? "" : "s"}, ${missing} missing ref${missing === 1 ? "" : "s"})`;
}

/** The one line `ahub sdlc accept` prints before it records the person's acceptance; every state proceeds. */
export function readbackLine(view: ReadbackView | undefined, task: number | string): string {
  if (!view || view.state === "none") return `spec read-back: none (start one with ahub sdlc readback start ${task})`;
  const next = view.state === "stale" ? `; start another with ahub sdlc readback start ${task}` : "";
  return `spec read-back: ${readbackSummary(view)}${next}`;
}

const READBACK_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.pager=cat", "-c", "credential.helper=", "-c", "core.askpass="];
const readbackGit = (cwd: string, args: string[]) => hubGitSync(["-C", cwd, ...READBACK_GIT, ...args], { encoding: "utf8", env: childEnv(process.env), maxBuffer: 8 * 1024 * 1024, timeout: 5000 });

/**
 * #1658 T4: the paths the issue names that are absent from the default branch head. Git only, no worktree read and no
 * fetch, so a hit is a commit a merged change would land on. `undefined` is unknown, never "all present".
 */
export function missingReadbackRefs(cwd: string, paths: readonly string[]): string[] | undefined {
  if (!paths.length) return [];
  try {
    const from = ["origin/HEAD", "origin/main", "origin/master"].find(ref => readbackGit(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).status === 0);
    if (!from) return undefined;
    const tree = readbackGit(cwd, ["ls-tree", "-r", "-z", "--name-only", from]);
    if (tree.status !== 0 || typeof tree.stdout !== "string") return undefined;
    const known = new Set(tree.stdout.split("\0").filter(Boolean));
    return paths.filter(path => !known.has(path));
  } catch { return undefined; }
}
