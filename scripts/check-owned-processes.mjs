#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ownedProcesses, parseProcessSnapshot } from "./process-ownership.mjs";

function usage() {
  console.error("usage: node scripts/check-owned-processes.mjs <current-run-temp-root> <ledger.jsonl>");
  process.exit(2);
}

const suppliedRoot = process.argv[2];
const ledgerPath = process.argv[3];
if (!suppliedRoot || !ledgerPath) usage();
const runRoot = resolve(suppliedRoot);
let canonicalRoot;
try { canonicalRoot = realpathSync(runRoot); }
catch (error) {
  console.error(`check: cannot resolve test ownership root ${runRoot}: ${error.message}`);
  process.exit(2);
}

let snapshot;
try {
  snapshot = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,args="], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
  console.error(`check: process inventory failed: ${error.message}`);
  process.exit(2);
}

let births;
try {
  births = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const failure = births.find((item) => item.error);
  if (failure) throw new Error(`process identity capture failed for pid ${failure.pid}: ${failure.error}`);
  if (births.some((item) => typeof item.pid !== "string" || typeof item.root !== "string" || typeof item.started !== "string" || typeof item.pgid !== "string" || !["daemon", "owned_process"].includes(item.kind) || typeof item.command !== "string" || typeof item.runtime !== "string")) throw new Error("invalid process ownership identity");
} catch (error) {
  console.error(`check: ownership ledger unavailable or invalid: ${error.message}`);
  process.exit(2);
}
const leaked = ownedProcesses(parseProcessSnapshot(snapshot), canonicalRoot, births);

if (leaked.length) {
  console.error("check: leaked agent-hub daemon or owned child process(es) from this test invocation:");
  for (const item of leaked) console.error(`  pid=${item.pid} ppid=${item.ppid} pgid=${item.pgid} started=${item.started}\n    ${item.command}`);
  process.exit(1);
}

console.log("check: no current-invocation agent-hub daemon leaks");
