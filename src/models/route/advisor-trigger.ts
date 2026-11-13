import type { JudgeConversation } from "./conversation-view.ts";

const LEDGER_ENTRIES = 1024, STALLED_SCOPES = 1024, FAILED_REVIEWS = 3;
const CONFIG_LIMIT = 200_000, SCOPE_KEY_BYTES = 4096;
interface Budget { charged: number; failures: number }
export interface AdvisorTriggerOptions {
  trigger?: "no_tool_call" | "pattern";
  pattern?: string;
  maxReviews?: number;
  gateMinToolResults?: number;
  gateStallTurns?: number;
}

/** Host review eligibility and reservation ledger, deliberately separate from ScopeStore. */
export class AdvisorTrigger {
  private readonly budgets = new Map<string, Budget>();
  private readonly checkpoints = new Set<string>();
  private readonly reviewLimit: number;
  private readonly minimumResults: number;
  private readonly stallAt: number;
  private readonly pattern: RegExp | undefined;

  constructor(options: AdvisorTriggerOptions = {}) {
    this.reviewLimit = options.maxReviews ?? 1;
    this.minimumResults = options.gateMinToolResults ?? 0;
    this.stallAt = options.gateStallTurns ?? 0;
    for (const [value, minimum] of [[this.reviewLimit, 1], [this.minimumResults, 0], [this.stallAt, 0]] as const) {
      if (!Number.isSafeInteger(value) || value < minimum || value > CONFIG_LIMIT) throw new RangeError("invalid advisor gate bound");
    }
    if (options.trigger !== undefined && options.trigger !== "no_tool_call" && options.trigger !== "pattern") throw new TypeError("invalid advisor trigger");
    if (options.trigger === "pattern") {
      if (!options.pattern) throw new TypeError("advisor pattern is required");
      this.pattern = new RegExp(options.pattern, "u");
    }
  }

  eligible(view: JudgeConversation | undefined, terminal: { hasToolUse: boolean; visibleText: string }, scope = "instance"): boolean {
    this.key(scope);
    if (this.exhausted(this.budgets.get(scope)) || !view) return false;
    const primary = this.pattern ? this.pattern.test(terminal.visibleText)
      : !terminal.hasToolUse && view.resultCount >= this.minimumResults;
    const checkpoint = this.stallAt > 0 && view.assistantTurns >= this.stallAt && !this.checkpoints.has(scope);
    if (!primary && checkpoint) { this.checkpointRoom(scope); this.checkpoints.add(scope); }
    return primary || checkpoint;
  }

  reserve(scope = "instance"): boolean {
    this.key(scope);
    const budget = this.budgets.get(scope) ?? { charged: 0, failures: 0 };
    if (this.exhausted(budget)) { this.checkpoints.delete(scope); return false; }
    this.budgetRoom(scope);
    this.budgets.set(scope, { charged: budget.charged + 1, failures: budget.failures });
    return true;
  }

  settle(scope: string, result: "success" | "failure"): void {
    this.key(scope);
    if (result === "success") return;
    const budget = this.budgets.get(scope) ?? { charged: 0, failures: 0 };
    this.budgetRoom(scope);
    this.budgets.set(scope, { charged: Math.max(0, budget.charged - 1), failures: Math.min(FAILED_REVIEWS, budget.failures + 1) });
    this.checkpoints.delete(scope);
  }

  evict(scope: string): void {
    this.key(scope);
    if (scope !== "instance") this.budgets.delete(scope);
    this.checkpoints.delete(scope);
  }

  private exhausted(budget: Budget | undefined): boolean {
    return !!budget && (budget.charged >= this.reviewLimit || budget.failures >= FAILED_REVIEWS);
  }
  private budgetRoom(scope: string): void {
    if (!this.budgets.has(scope) && this.budgets.size >= LEDGER_ENTRIES) {
      for (const key of this.budgets.keys()) if (key !== "instance") { this.budgets.delete(key); break; }
    }
  }
  private checkpointRoom(scope: string): void {
    if (!this.checkpoints.has(scope) && this.checkpoints.size >= STALLED_SCOPES) {
      const key = this.checkpoints.values().next().value;
      if (key !== undefined) this.checkpoints.delete(key);
    }
  }
  private key(scope: string): void {
    if (typeof scope !== "string" || !scope || scope.length > SCOPE_KEY_BYTES || Buffer.byteLength(scope) > SCOPE_KEY_BYTES) throw new RangeError("invalid advisor scope");
  }
}
