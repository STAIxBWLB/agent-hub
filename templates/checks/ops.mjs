#!/usr/bin/env node
// Structure only. An empty array does not establish that all required actions were recorded.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

const MAX_BYTES = 1024 * 1024;
function actions(file) {
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
function date(value) {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function valid(value) {
  if (!Array.isArray(value)) return false;
  const seen = new Set(), keys = ["id", "owner", "due", "status"], statuses = new Set(["open", "in_progress", "blocked", "done"]);
  return value.every(action => {
    if (!action || typeof action !== "object" || Array.isArray(action) || Object.keys(action).length !== keys.length || !keys.every(key => Object.hasOwn(action, key))) return false;
    if (typeof action.id !== "string" || !action.id.trim() || seen.has(action.id) || typeof action.owner !== "string" || !action.owner.trim() || !date(action.due) || !statuses.has(action.status)) return false;
    seen.add(action.id); return true;
  });
}
if (process.argv.length !== 3) {
  console.error("usage: ops.mjs <actions.json>"); console.log("ops: FAIL"); process.exitCode = 2;
} else {
  let ok = false;
  try { ok = valid(actions(process.argv[2])); } catch { /* Never echo action content, identifiers or paths. */ }
  console.log(`ops-records: ${ok ? "OK" : "FAIL"}`); console.log(`ops: ${ok ? "OK" : "FAIL"}`); process.exitCode = ok ? 0 : 1;
}
