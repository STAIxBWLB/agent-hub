#!/usr/bin/env bun
// Read-only source check for the #412 P0 annex. This never executes cited tests.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";

type Case = { id: string; mode: string; status: string };
type Row = { id: string; mode: string; status: string; owner: string; phase: string; evidence: string };
const root = resolve(import.meta.dir, "../..");
const errors: string[] = [];

function read(path: string): string | undefined {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    errors.push(`${path}: reference must stay in the repository`);
    return undefined;
  }
  try { return readFileSync(full, "utf8"); }
  catch { errors.push(`${path}: unreadable`); return undefined; }
}

function parseCases(text: string): Case[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error("expected an array");
    const cases: Case[] = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null || typeof item.id !== "string" || typeof item.mode !== "string" || typeof item.status !== "string") {
        errors.push("amem-cases.json: invalid case");
      } else cases.push(item as Case);
    }
    if (value.length !== 60) errors.push(`amem-cases.json: expected 60 cases, got ${value.length}`);
    return cases;
  } catch (error) {
    errors.push(`amem-cases.json: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) { errors.push(`registry: missing ${heading} section`); return ""; }
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function parseTableA(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of section(text, "Table A").split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (cells[0] === "id" || cells.every(cell => /^[- :]+$/.test(cell))) continue;
    if (cells.length !== 6) { errors.push(`Table A: expected 6 cells: ${line}`); continue; }
    const [id, mode, status, owner, phase, evidence] = cells as [string, string, string, string, string, string];
    rows.push({ id, mode, status, owner, phase, evidence });
  }
  return rows;
}

const namesByFile = new Map<string, Set<string>>();
function testNames(path: string): Set<string> {
  const cached = namesByFile.get(path);
  if (cached) return cached;
  const names = new Set<string>();
  namesByFile.set(path, names);
  const text = read(path);
  if (text === undefined) return names;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["test", "it"].includes(node.expression.text)) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg))) {
        // Preserve exactly what was written between the source delimiters, including template substitutions.
        names.add(arg.getText(source).slice(1, -1));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names;
}

function assertRow(row: Row, cases: Map<string, Case>, gaps: Set<string>): void {
  const entry = cases.get(row.id);
  if (!entry) errors.push(`${row.id}: unknown case id`);
  else {
    if (row.mode !== entry.mode) errors.push(`${row.id}: mode differs from inventory`);
    if (row.status !== entry.status) errors.push(`${row.id}: status differs from inventory`);
  }
  if (!/^(agent-mem|agent-hub|external): .+/.test(row.owner)) errors.push(`${row.id}: missing owner module`);
  if (!/^(P(?:[1-9]|10)|external|none \(declared ceiling\))$/.test(row.phase)) errors.push(`${row.id}: missing or invalid phase`);
  if (row.evidence === "gap") {
    if (!gaps.has(row.id)) errors.push(`${row.id}: gap is absent from Gaps`);
    return;
  }
  if (gaps.has(row.id)) errors.push(`${row.id}: Gaps lists a row with retained evidence`);
  const citations = row.evidence.split(/; (?=(?:ceiling )?`)/).filter(Boolean);
  if (!citations.length) errors.push(`${row.id}: missing retained regression or declared ceiling`);
  for (const citation of citations) {
    const match = /^(ceiling )?`([^`]+)` :: `([^`]+)`$/.exec(citation);
    if (!match) { errors.push(`${row.id}: invalid citation ${citation}`); continue; }
    const [, ceiling, path, name] = match as unknown as [string, string | undefined, string, string];
    if (ceiling) {
      const source = read(path);
      if (!name.startsWith("ponytail:") || (source !== undefined && !source.includes(name))) errors.push(`${row.id}: missing ponytail marker in ${path}: ${name}`);
    } else {
      if (!path.startsWith("test/") || !testNames(path).has(name)) errors.push(`${row.id}: no literal test declaration in ${path}: ${name}`);
    }
  }
}

const caseText = read("docs/plans/amem-cases.json");
const registry = read("docs/plans/2026-10-16-amem-failure-registry.md");
const cases = parseCases(caseText ?? "[]");
const caseMap = new Map<string, Case>();
for (const item of cases) {
  if (caseMap.has(item.id)) errors.push(`${item.id}: duplicate inventory id`);
  caseMap.set(item.id, item);
}
const rows = parseTableA(registry ?? "");
const gapsSection = section(registry ?? "", "Gaps");
const gapIds = [...gapsSection.matchAll(/^- ([A-Z]\d{2}) \(/gm)].map(match => match[1]!);
const gaps = new Set(gapIds);
for (const id of gapIds) {
  if (!caseMap.has(id)) errors.push(`${id}: unknown Gaps id`);
  if (gapIds.filter(value => value === id).length !== 1) errors.push(`${id}: duplicate Gaps id`);
}
for (const id of caseMap.keys()) {
  const count = rows.filter(row => row.id === id).length;
  if (count !== 1) errors.push(`${id}: expected exactly one Table A row, got ${count}`);
}
if (rows.length !== 60) errors.push(`Table A: expected 60 rows, got ${rows.length}`);
for (const row of rows) assertRow(row, caseMap, gaps);
if (errors.length) {
  for (const error of errors) console.error(`check-registry: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`check-registry: OK (${rows.length} cases, ${new Set(cases.map(item => item.mode)).size} modes; gaps: ${gapIds.join(", ") || "none"})`);
}
