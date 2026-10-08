import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { findVerifiedRun } from "./ci-gates.mjs";

// Reuse only a successful full check of the identical tree, including its workflow.
const required = process.argv.includes("--require");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
  return response.json();
}
async function verifiedRun() {
  if (!repository || !token) throw new Error("CI reuse requires repository and scoped Actions read access");
  return findVerifiedRun(api, tree);
}
let run;
try { run = await verifiedRun(); }
catch (error) {
  if (required) throw error;
  console.log(`ci: reuse unavailable; run the full gate (${error.message})`);
}
if (required && !run) throw new Error("No successful full CI gate for this exact tree; release refused");
console.log(run ? `ci: reused full gate ${run.html_url} for tree ${tree}` : `ci: full gate required for tree ${tree}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run_gate=${run ? "false" : "true"}\nverified_run=${run?.id ?? ""}\n`);
