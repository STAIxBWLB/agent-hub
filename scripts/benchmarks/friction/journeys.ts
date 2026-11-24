// The seed corpus (#1644). Each closed refusal defect becomes one journey so it cannot return. T1 ships the first two;
// the other ten of the issue's list follow in T3 once the owner confirms the seed list.
import type { Journey } from "./run.ts";

export const JOURNEYS: Journey[] = [
  {
    id: "project-not-initialised",
    guards: "agent-hub#1644 seed: a command in a project without .agenthub names the step that fixes it",
    steps: [{ argv: ["up"], expectBlock: true }],
  },
  {
    id: "daemon-not-running",
    guards: "agent-hub#1644 seed: a command that needs a hub names the command that starts it",
    setup: [["init"]],
    steps: [{ argv: ["status"], expectBlock: true }],
  },
];
