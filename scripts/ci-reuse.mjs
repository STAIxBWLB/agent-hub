import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readFullGateAdmission } from "./ci-gates.mjs";

// Reuse only a successful full check of the identical tree, including its workflow.
// This PR controller (or the separate main group) holds its lock through admission and any gate; other groups may run concurrently.
const required = process.argv.includes("--require");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const deadline = Date.now() + 60_000;
async function api(path) {
  if (!repository || !token) throw new Error("CI admission requires repository and scoped Actions read access");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("CI admission read deadline exceeded");
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(Math.min(15_000, remaining)),
  });
  if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("CI admission response exceeded bound");
  return JSON.parse(text);
}
const decision = await readFullGateAdmission(api, tree, { currentRunId: process.env.GITHUB_RUN_ID, deadline, now: Date.now });
const run = decision.kind === "reuse" ? decision.run : undefined;
// Unknown is not permission to start a duplicate full gate. Publish fail-closed outputs before refusing the job.
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run_gate=${decision.kind === "run" && !required ? "true" : "false"}\nverified_run=${run?.id ?? ""}\nadmission=${decision.kind}\n`);
if (required && !run) throw new Error("No successful full CI gate for this exact tree; release refused");
if (decision.kind === "unknown") throw new Error(`CI admission refused: ${decision.reason}`);
if (decision.kind === "duplicate") throw new Error(`CI admission refused: full gate ${decision.run.id} already admitted for tree ${tree}`);
console.log(run ? `ci: reused full gate ${run.html_url} for tree ${tree}` : `ci: full gate required for tree ${tree}`);
