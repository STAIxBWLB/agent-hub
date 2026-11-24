// The seed corpus (#1644). Each closed refusal defect becomes one journey so it cannot return. The list is the one the owner confirmed
// on 2026-11-25 (agent-hub#1644, Design). Every journey names, in `guards`, the issue or contract whose defect it keeps from returning, and
// `expectText` pins the refusal it reaches: a step blocked by something else guards nothing and is a corpus error, not a pass.
// Peers are no-model attachments of the runner and GitHub reads are a fake `gh` outside the project: nothing here needs a model or an account.
import type { Journey, Setup } from "./run.ts";

const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40);

const init: Setup = { argv: ["init"] }, up: Setup = { argv: ["up", "--no-console", "--no-agents"] };
/** A second peer id the hub admits as a plain channel peer (only `claude` and ids it was told about are); it owns the card so `claude` can review it. */
const withWorker: Setup = { patchConfig: config => { config.roles.worker1 = ["implementer"]; } };
const backlogPulled: Setup[] = [{ argv: ["backlog", "add", "implement", "journey card"] }, { argv: ["backlog", "pull", "1"] }];
/** A card owned and accepted by `worker1`, with `claude` attached as its reviewer. */
const owned: Setup[] = [...backlogPulled, { attach: "claude" }, { attach: "worker1" }, { argv: ["task", "assign", "1", "worker1"] }, { tool: "hub_task_accept", peer: "worker1", args: { id: 1, plan: { paths: ["a.ts"] } } }];
const inReview: Setup[] = [...owned, { tool: "hub_task_done", peer: "worker1", args: { id: 1, summary: "done", refs: { commit: SHA_A } } }];

/** A fake `gh` that answers the spec-edit read with the edit time held in `edits.txt` beside it, and fails every other read. */
const ghSpecEdit = `const fs = require("node:fs"), path = require("node:path"), file = path.join(__dirname, "edits.txt");
if (!fs.existsSync(file)) fs.writeFileSync(file, "2026-11-01T00:00:00Z");
if (args.join(" ").includes("lastEditedAt")) process.stdout.write(JSON.stringify({ data: { repository: { issue: { number: 5, lastEditedAt: fs.readFileSync(file, "utf8").trim(), updatedAt: "2026-11-30T00:00:00Z" } } } }));
else process.exit(1);`;

export const JOURNEYS: Journey[] = [
  {
    id: "project-not-initialised",
    guards: "agent-hub#1644 seed: a command in a project without .agenthub names the step that fixes it",
    steps: [{ argv: ["up"], expectBlock: true, expectText: "not initialized" }],
  },
  {
    id: "daemon-not-running",
    guards: "agent-hub#1644 seed: a command that needs a hub names the command that starts it",
    setup: [init],
    steps: [{ argv: ["status"], expectBlock: true, expectText: "no hub running" }],
  },
  {
    id: "refiled-head-after-review",
    guards: "agent-hub#1047 and #1121: an owner that re-files the head the board already holds is refused, and the refusal names the next step",
    setup: [init, withWorker, up, ...inReview],
    steps: [{ tool: "hub_task_done", peer: "worker1", args: { id: 1, summary: "done again", refs: { commit: SHA_A } }, expectBlock: true, expectText: "re-file" }],
  },
  {
    id: "hint-with-missing-arguments",
    guards: "agent-hub#1399: a person-facing command hint carries every required argument",
    setup: [init, up],
    steps: [{ argv: ["queue", "resolve"], expectBlock: true, expectText: "usage: ahub queue" }],
  },
  {
    id: "planner-pull-without-next-step",
    guards: "agent-hub#1430: a planner pull that no peer can take names how to reserve a peer",
    setup: [init, up, { argv: ["backlog", "add", "implement", "journey card"] }],
    steps: [{ tool: "hub_backlog_pull", peer: "console", args: { id: 1, revision: 0, reason: "journey" }, expectBlock: true, expectText: "hub_backlog_plan" }],
  },
  {
    id: "spec-acceptance-missing",
    guards: "agent-hub#481 S1: a task whose spec issue is not recorded names how to record and accept it",
    setup: [init, { write: ".agenthub/sdlc.toml", content: 'mode = "enforce"\nrequired_checks = ["check"]\n' }, withWorker, up, ...backlogPulled, { attach: "worker1" }],
    steps: [{ argv: ["task", "assign", "1", "worker1"], expectBlock: true, expectText: "hub_sdlc_record" }],
  },
  {
    id: "spec-changed-after-acceptance",
    guards: "agent-hub#481 S1: a spec edited after its acceptance is not silently accepted again",
    skip: "the offline surface has no lever that edits the issue after acceptance and then re-reads it through the claim path: the changed state is only reachable once `gh` answers a second edit time, which the assign gate does not re-read",
    steps: [],
  },
  {
    id: "handoff-to-unregistered-project",
    guards: "agent-hub#1644 seed: a handoff to a project this machine never registered names how to register it",
    setup: [init, up, { write: "../sibling/.git/HEAD", content: "ref: refs/heads/main\n" }],
    steps: [{ argv: ["task", "handoff", "--project", "../sibling", "implement", "journey card"], expectBlock: true, expectText: "not in this machine's agent-hub registry" }],
  },
  {
    id: "review-against-moved-head",
    guards: "agent-hub#1121: a review whose head differs from the task's recorded head names both heads and the owner's re-file",
    setup: [init, withWorker, up, ...inReview],
    steps: [{ tool: "hub_review", peer: "claude", args: { id: 1, verdict: "approved", note: "journey", head: SHA_B }, expectBlock: true, expectText: "re-file hub_task_done" }],
  },
  {
    id: "security-pass-lifecycle-off",
    guards: "agent-hub#1403 A2: a security pass offered while the lifecycle is off is refused and says how to enable it",
    setup: [init, withWorker, up, ...inReview],
    steps: [{ tool: "hub_review", peer: "claude", args: { id: 1, verdict: "approved", note: "journey", security_pass: { covered: ["a"], not_covered: [] } }, expectBlock: true, expectText: "sdlc.mode" }],
  },
  {
    id: "merge-refused-unresolved-threads",
    guards: "agent-hub#786 and #1328: a guarded merge refused for its gates names what to settle first",
    skip: "unresolved review threads come from a GitHub pull-request read the fake `gh` would have to serve end to end (graphql threads, checks, reviews); the offline step reaches only the earlier gate that a task must be accepted first, which is a different refusal",
    steps: [],
  },
  {
    id: "queue-full",
    guards: "agent-hub#1644 seed: a recipient queue that is full names how to resolve or discard its work",
    skip: "the queue cap is a startup setting with no CLI lever, and filling a peer's queue needs a delivering peer that does not answer; the offline surface cannot reach `recipient queue is full` without a model-backed or native peer",
    steps: [],
  },
];
