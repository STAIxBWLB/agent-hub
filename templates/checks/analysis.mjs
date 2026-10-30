#!/usr/bin/env node
// Runs only the explicitly selected program. No shell and no automatic invocation.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const MAX_BYTES = 1024 * 1024, TIMEOUT_MS = 5000;
function boundedFile(file) {
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
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
function run(program, input) {
  return new Promise(resolveRun => {
    const group = process.platform !== "win32";
    const child = spawn(process.execPath, [program, input], { shell: false, detached: group, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = []; let size = 0, refused = false, settled = false;
    const kill = () => { refused = true; try { if (group && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already gone. */ } };
    const timer = setTimeout(kill, TIMEOUT_MS);
    const finish = (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      // A program may have started descendants; release only this invocation's process group.
      if (group && child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
      resolveRun(!refused && code === 0 ? Buffer.concat(chunks, size) : undefined);
    };
    child.on("error", () => { kill(); finish(null); });
    child.stdout.on("data", bytes => {
      if (refused) return;
      if (bytes.length > MAX_BYTES - size) { chunks.length = 0; kill(); return; }
      size += bytes.length; chunks.push(Buffer.from(bytes));
    });
    child.on("close", finish);
  });
}
if (process.argv.length !== 5) {
  console.error("usage: analysis.mjs <program.mjs> <input.json> <expected-output>"); console.log("analysis: FAIL"); process.exitCode = 2;
} else {
  let ok = false;
  try {
    const program = resolve(process.argv[2]), input = resolve(process.argv[3]), expectedFile = resolve(process.argv[4]);
    const programBytes = boundedFile(program), inputBytes = boundedFile(input), expected = boundedFile(expectedFile);
    JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(inputBytes));
    const unchanged = () => boundedFile(program).equals(programBytes) && boundedFile(input).equals(inputBytes) && boundedFile(expectedFile).equals(expected);
    const first = await run(program, input);
    if (first === undefined || !unchanged()) throw new Error("first run refused or declared files changed");
    const second = await run(program, input);
    ok = unchanged() && first !== undefined && second !== undefined && first.equals(expected) && second.equals(expected);
  } catch { /* Refuse without echoing program stderr, private paths, inputs or expected bytes. */ }
  console.log(`analysis-reproduce: ${ok ? "OK" : "FAIL"}`); console.log(`analysis: ${ok ? "OK" : "FAIL"}`); process.exitCode = ok ? 0 : 1;
}
