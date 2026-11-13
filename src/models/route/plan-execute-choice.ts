import { diagnoseStageResult } from "./stage-diagnostics.ts";
import type { RouteConversationView } from "./conversation-view.ts";
import { ScopeStore, type ScopeStoreOptions } from "./turn-state.ts";

export interface PlanPhaseSnapshot {
  phase: "planning" | "executing";
  fallbackTier: "efficient" | "capable";
  addPlanningInstruction: boolean;
}

/** Deterministic host phase fallback; optional model/effort proposals do not apply here. */
export class PlanPhase {
  private readonly executing: ScopeStore<boolean>;
  constructor(options: ScopeStoreOptions = {}) { this.executing = new ScopeStore(options); }

  observe(view: RouteConversationView | undefined, scope: string): PlanPhaseSnapshot {
    let executing = this.executing.get(scope) === true;
    if (!executing && view?.results.some(({ input, sourceTextComplete }) => sourceTextComplete
      && input.associated && input.family === "mutation" && !input.error
      && diagnoseStageResult(input).fault === "none"
      && !/\b(?:denied|refused|cancell?ed|not permitted)\b/i.test(input.text))) {
      executing = true;
      this.executing.set(scope, true);
    }
    return { phase: executing ? "executing" : "planning", fallbackTier: executing ? "efficient" : "capable", addPlanningInstruction: !executing };
  }
}
