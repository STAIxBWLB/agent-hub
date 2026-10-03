/** Read-only, manual quarterly check. Fetch/update the upstream checkout separately; never auto-sync ports. */
const PIN = "c8848511a7e2e1d605070c7a68905bdc24c6481a";
const checkout = process.argv[2];
const target = process.argv[3] ?? "HEAD";
if (!checkout || target.startsWith("-")) {
  console.error("usage: bun scripts/check-switchyard-upstream.ts <upstream-checkout> [target-ref]");
  process.exit(2);
}
const paths = [
  "crates/libsy/src/algorithms/stage.rs", "crates/libsy/src/algorithms/plan_execute.rs",
  "crates/libsy/src/algorithms/advisor_gate", "crates/libsy/src/algorithms/advisor_gate.rs",
  "crates/libsy/src/algorithms/escalation.rs", "crates/libsy/src/algorithms/util/stage.rs",
  "crates/libsy/src/algorithms/util/tool_signals.rs", "crates/libsy/src/algorithms/util/escalation.rs",
  "crates/libsy/src/algorithms/util/llm_judge.rs", "crates/libsy/src/algorithms/util/robustness.rs",
  "crates/libsy/src/prompts", "LICENSE", "NOTICE",
];
const result = Bun.spawnSync(["git", "-C", checkout, "diff", "--stat", `${PIN}..${target}`, "--", ...paths], { stdout: "pipe", stderr: "pipe" });
if (result.exitCode !== 0) { console.error(result.stderr.toString()); process.exit(result.exitCode); }
const changed = result.stdout.toString().trim();
console.log(changed || `Switchyard routing sources unchanged from ${PIN}`);
console.log("Review any changes manually against golden tests and provenance before updating the pin.");
