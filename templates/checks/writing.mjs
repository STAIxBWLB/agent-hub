#!/usr/bin/env node
// Explicit invocation only: node writing.mjs <document.json> <rules.json>.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

const MAX_BYTES = 1024 * 1024;
function readJSON(file) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw new Error("input refused");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_BYTES) throw new Error("input changed");
    const bytes = Buffer.alloc(opened.size + 1); let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, size); if (!count) break; size += count; }
    const after = fstatSync(fd);
    if (size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error("input changed");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)));
  } finally { closeSync(fd); }
}
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const terms = value => Array.isArray(value) && value.every(nonempty);
function report(results) {
  for (const [id, ok] of results) console.log(`${id}: ${ok ? "OK" : "FAIL"}`);
  const ok = results.every(([, passed]) => passed);
  console.log(`writing: ${ok ? "OK" : "FAIL"}`); process.exitCode = ok ? 0 : 1;
}
if (process.argv.length !== 4) {
  console.error("usage: writing.mjs <document.json> <rules.json>"); console.log("writing: FAIL"); process.exitCode = 2;
} else {
  let document, rules;
  try { document = readJSON(process.argv[2]); } catch { /* Refuse without echoing document bytes or paths. */ }
  try { rules = readJSON(process.argv[3]); } catch { /* Rule values never become diagnostics or regular expressions. */ }
  const metadata = object(document) && [document.title, document.language, document.text].every(nonempty);
  const body = metadata ? `${document.title}\n${document.text}` : "";
  const literals = metadata && object(rules) && terms(rules.requiredTerms) && terms(rules.bannedPhrases)
    && rules.requiredTerms.every(term => document.text.includes(term)) && rules.bannedPhrases.every(term => !body.includes(term));
  const style = metadata && !/\b(?:TODO|TBD)\b/i.test(body) && body.split(/\r\n|\r|\n/).every(line => line === line.trimEnd());
  report([["writing-metadata", metadata], ["writing-terms", literals], ["writing-style", style]]);
}
