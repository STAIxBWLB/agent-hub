import type { Task } from "./board.ts";

/** Snapshot guidance only; live spec/plan readbacks remain the acceptance gates. */
export function buildEntryDiagnostic(task: Pick<Task, "id" | "sdlc">, planGap = task.sdlc?.planReview ? undefined : "plan not reviewed"): string | undefined {
  const receipt = task.sdlc;
  if (!receipt?.repo || !receipt.issue) return "spec issue not recorded (owner/planner: hub_sdlc_record)";
  const accepted = receipt.acceptance;
  if (!accepted || accepted.repo !== receipt.repo || accepted.issue !== receipt.issue) return `spec not accepted (person: ahub sdlc accept ${task.id} --issue ${receipt.issue})`;
  return planGap ? `plan not reviewed (planner: hub_plan_review)${planGap === "plan not reviewed" ? "" : `; ${planGap}`}` : undefined;
}
