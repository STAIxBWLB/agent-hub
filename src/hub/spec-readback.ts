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
