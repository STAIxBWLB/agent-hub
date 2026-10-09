import type { ModelBackend, ModelRelayOptions, RelayRequest } from "../relay.ts";
import { normalizeConversation } from "./normalize.ts";
import { extractToolSignals, turnKind } from "./signals.ts";
import { selectStage, stayOrSwitch, type StageState, type SwitchTrace, type Tier } from "./stage.ts";
import { SessionState } from "./state.ts";

type RelaySelectorOptions = Pick<ModelRelayOptions, "mlx" | "selectBackend" | "routeSessionKey" | "allowedDGXmodels" | "staySwitch"> & { dgxMaxInputTokens: number };
type RouteSource = "override" | "dimensions" | "hold" | "classifier" | "default" | "load" | "cooldown" | "pin";
/** `stateless`: the request carried no session key, so the planner saw a new session on every call. */
export type RelayRouteEvent = { route: "hub/auto"; tier: string; source: RouteSource; score: number; ms: number; stateless?: boolean } & Partial<SwitchTrace>;
type EstimateInputTokens = (messages: RelayRequest["messages"], tools?: unknown[]) => number;
type AutoState = { stage: StageState; pin?: { tier: Tier; alias: string } };
/**
 * A `hub/auto` decision (#199). `backend` is the stage backend; the relay only reorders it with its fallback, trying
 * `prefer` (an enforced tool loop's pinned backend) first when that is the fallback, and reports a reorder through `moved`.
 */
export interface AutoChoice { backend: ModelBackend; route: RelayRouteEvent; movable: boolean; prefer?: string; moved: (alias: string, source: "load" | "cooldown" | "pin") => void }

/** Stage selection for the relay's virtual `hub/auto` model. */
export class AutoRouteSelector {
  private readonly states = new SessionState<AutoState>(512, 60 * 60_000);

  constructor(
    private readonly options: RelaySelectorOptions,
    private readonly defaultBackend: ModelBackend,
    private readonly mlxAlias: string,
    private readonly estimateInputTokens: EstimateInputTokens,
  ) {}

  async select(body: RelayRequest): Promise<AutoChoice> {
    const started = performance.now();
    let sessionKey: string | undefined;
    try {
      const key = this.options.routeSessionKey?.(body);
      if (typeof key === "string" && key.length > 0 && key.length <= 512) sessionKey = key;
    } catch { /* host identity lookup is fail-open */ }
    const prior = sessionKey ? this.states.get(sessionKey) : undefined;

    let backend = this.defaultBackend;
    let source: RouteSource = "default";
    let score = 0;
    let trace: SwitchTrace | undefined;
    let next: AutoState | undefined;
    let movable = true;
    let prefer: string | undefined;
    try {
      const conversation = normalizeConversation(body);
      const decision = selectStage(extractToolSignals(conversation), { mode: "efficient_first", confidenceThreshold: 0.5, capableHoldTurns: 2 }, prior?.stage ?? { capableHoldTurnsRemaining: 0 });
      const inputTokens = this.estimateInputTokens(body.messages, body.tools);
      const fits = (candidate: Tier) => { const staged = this.stageBackend(candidate, body, inputTokens); return !!staged && (staged.kind === "mlx" || inputTokens <= this.options.dgxMaxInputTokens); };
      const staged = stayOrSwitch(this.options.staySwitch?.(), prior?.pin?.tier, decision, turnKind(conversation), { inputTokens, fits });
      next = { stage: decision.state, ...(staged.pin ? { pin: { tier: staged.pin, alias: "" } } : {}) };
      trace = staged.trace;
      score = decision.score;
      source = this.sourceOf(decision.source);
      // Enforced, a tool loop that keeps its tier keeps its backend too: a move inside the tier costs the same prefill (#199).
      movable = !(trace.staySwitch === "enforce" && trace.turnType === "tool_result" && trace.plan === "stay" && trace.reason !== "new_pin");
      if (!movable) prefer = prior?.pin?.alias;
      const stagedBackend = this.stageBackend(staged.tier, body, inputTokens);
      if (stagedBackend) backend = stagedBackend;
      else source = "default";
    } catch {
      source = "default";
    }

    if (this.options.selectBackend) {
      try {
        const override = await this.options.selectBackend(body);
        if (this.isAllowed(override)) {
          backend = override;
          source = "override";
        }
      } catch { /* deterministic stage choice is the fail-open route */ }
    }

    if (next?.pin) next.pin.alias = this.aliasOf(backend);
    if (sessionKey && next) this.states.set(sessionKey, next);
    const route: RelayRouteEvent = { route: "hub/auto", tier: this.aliasOf(backend), source, score, ms: Math.max(0, performance.now() - started), ...trace, ...(sessionKey ? {} : { stateless: true }) };
    return { backend, route, movable, ...(prefer ? { prefer } : {}), moved: (alias, moveSource) => {
      route.tier = alias;
      route.source = moveSource;
      if (next?.pin) next.pin.alias = alias;
    } };
  }

  private stageBackend(tier: "capable" | "efficient", body: RelayRequest, input: number): ModelBackend | undefined {
    if (tier === "capable") return "dgx/coding" in this.options.allowedDGXmodels ? { kind: "dgx", alias: "dgx/coding" } : undefined;
    if (this.options.mlx && this.mlxFitsBudget(body, input)) return { kind: "mlx", alias: this.mlxAlias };
    return "dgx/fast" in this.options.allowedDGXmodels ? { kind: "dgx", alias: "dgx/fast" } : undefined;
  }

  private mlxFitsBudget(body: RelayRequest, input: number): boolean {
    const context = Math.min(8192, this.options.mlx?.contextWindow ?? 8192);
    const maxOutput = this.options.mlx?.maxTokens ?? 2048;
    const output = body.max_tokens ?? maxOutput;
    const inputLimit = this.options.mlx?.maxInputTokens ?? (this.options.mlx?.provider === "ollama" ? 6000 : 16_000);
    return Number.isInteger(output) && output > 0 && output <= maxOutput && input <= inputLimit && input + output <= context;
  }

  private isAllowed(backend: ModelBackend): boolean {
    return backend.kind === "mlx" ? !!this.options.mlx : backend.kind === "dgx" && backend.alias in this.options.allowedDGXmodels;
  }

  private aliasOf(backend: ModelBackend): string {
    return backend.kind === "mlx" ? backend.alias ?? this.mlxAlias : backend.alias;
  }

  private sourceOf(source: string): RouteSource {
    if (source === "capable_hold") return "hold";
    if (source === "override" || source === "dimensions") return source;
    if (source === "llm-classifier") return "classifier";
    return "default";
  }
}
