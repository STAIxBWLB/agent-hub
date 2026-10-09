import type { ModelBackend, ModelRelayOptions, RelayRequest } from "../relay.ts";
import { normalizeConversation } from "./normalize.ts";
import { extractToolSignals, turnKind } from "./signals.ts";
import { selectStage, stayOrSwitch, type StageState, type SwitchTrace, type Tier } from "./stage.ts";
import { SessionState } from "./state.ts";

type RelaySelectorOptions = Pick<ModelRelayOptions, "mlx" | "selectBackend" | "routeSessionKey" | "onRoute" | "allowedDGXmodels" | "staySwitch"> & { dgxMaxInputTokens: number };
type RouteSource = "override" | "dimensions" | "hold" | "classifier" | "default";
export type RelayRouteEvent = { route: "hub/auto"; tier: string; source: RouteSource; score: number; ms: number } & Partial<SwitchTrace>;
type EstimateInputTokens = (messages: RelayRequest["messages"], tools?: unknown[]) => number;

/** Stage selection for the relay's virtual `hub/auto` model. */
export class AutoRouteSelector {
  private readonly states = new SessionState<{ stage: StageState; pin?: Tier }>(512, 60 * 60_000);

  constructor(
    private readonly options: RelaySelectorOptions,
    private readonly defaultBackend: ModelBackend,
    private readonly mlxAlias: string,
    private readonly estimateInputTokens: EstimateInputTokens,
  ) {}

  async select(body: RelayRequest): Promise<ModelBackend> {
    const started = performance.now();
    let sessionKey: string | undefined;
    try {
      const key = this.options.routeSessionKey?.(body);
      if (typeof key === "string" && key.length > 0 && key.length <= 512) sessionKey = key;
    } catch { /* host identity lookup is fail-open */ }
    const prior = sessionKey ? this.states.get(sessionKey) : undefined;

    let backend = this.defaultBackend;
    let tier = this.aliasOf(backend);
    let source: RouteSource = "default";
    let score = 0;
    let trace: SwitchTrace | undefined;
    try {
      const conversation = normalizeConversation(body);
      const decision = selectStage(extractToolSignals(conversation), { mode: "efficient_first", confidenceThreshold: 0.5, capableHoldTurns: 2 }, prior?.stage ?? { capableHoldTurnsRemaining: 0 });
      const inputTokens = this.estimateInputTokens(body.messages, body.tools);
      const fits = (candidate: Tier) => { const staged = this.stageBackend(candidate, body); return !!staged && (staged.kind === "mlx" || inputTokens <= this.options.dgxMaxInputTokens); };
      const staged = stayOrSwitch(this.options.staySwitch?.(), prior?.pin, decision, turnKind(conversation), { inputTokens, fits });
      if (sessionKey) this.states.set(sessionKey, { stage: decision.state, ...(staged.pin ? { pin: staged.pin } : {}) });
      trace = staged.trace;
      score = decision.score;
      source = this.sourceOf(decision.source);
      const stagedBackend = this.stageBackend(staged.tier, body);
      if (stagedBackend) {
        backend = stagedBackend;
        tier = this.aliasOf(stagedBackend);
      } else {
        source = "default";
      }
    } catch {
      source = "default";
    }

    if (this.options.selectBackend) {
      try {
        const override = await this.options.selectBackend(body);
        if (this.isAllowed(override)) {
          backend = override;
          tier = this.aliasOf(override);
          source = "override";
        }
      } catch { /* deterministic stage choice is the fail-open route */ }
    }

    this.emit({ route: "hub/auto", tier, source, score, ms: Math.max(0, performance.now() - started), ...trace });
    return backend;
  }

  private stageBackend(tier: "capable" | "efficient", body: RelayRequest): ModelBackend | undefined {
    if (tier === "capable") return "dgx/coding" in this.options.allowedDGXmodels ? { kind: "dgx", alias: "dgx/coding" } : undefined;
    if (this.options.mlx && this.mlxFitsBudget(body)) return { kind: "mlx", alias: this.mlxAlias };
    return "dgx/fast" in this.options.allowedDGXmodels ? { kind: "dgx", alias: "dgx/fast" } : undefined;
  }

  private mlxFitsBudget(body: RelayRequest): boolean {
    const context = Math.min(8192, this.options.mlx?.contextWindow ?? 8192);
    const maxOutput = this.options.mlx?.maxTokens ?? 2048;
    const output = body.max_tokens ?? maxOutput;
    const input = this.estimateInputTokens(body.messages, body.tools);
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

  private emit(event: RelayRouteEvent): void {
    try { this.options.onRoute?.(event); } catch { /* observation cannot fail routing */ }
  }
}
