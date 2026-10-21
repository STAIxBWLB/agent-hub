import { ACTION_CLASSES, type ActionClass } from "./action-class.ts";
import { sanitize } from "./envelope.ts";

export interface ActionPolicyConfig { enabled: boolean; always_ask: ActionClass[]; budgets: Record<ActionClass, number> }
const DEFAULT_BUDGETS: Record<ActionClass, number> = { publish: 1, destroy: 3, "external-write": 5, install: 2 };
/** Defaults are host policy; overrides belong only in untracked config.local.json. */
export function actionPolicyConfig(value?: unknown): ActionPolicyConfig {
  const fail = (): never => { throw new Error("action_policy: expected enabled, always_ask and class budgets (integers 0..1000)"); };
  if (value === undefined) return { enabled: true, always_ask: [...ACTION_CLASSES], budgets: { ...DEFAULT_BUDGETS } };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["enabled", "always_ask", "budgets"].includes(key))) return fail();
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return fail();
  const classes = raw.always_ask === undefined ? ACTION_CLASSES : raw.always_ask;
  if (!Array.isArray(classes) || classes.length > ACTION_CLASSES.length || new Set(classes).size !== classes.length || classes.some(key => !ACTION_CLASSES.includes(key))) return fail();
  const budgets = { ...DEFAULT_BUDGETS };
  if (raw.budgets !== undefined) {
    if (!raw.budgets || typeof raw.budgets !== "object" || Array.isArray(raw.budgets)) return fail();
    for (const [key, amount] of Object.entries(raw.budgets)) {
      if (!ACTION_CLASSES.includes(key as ActionClass) || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0 || amount > 1000) return fail();
      budgets[key as ActionClass] = amount;
    }
  }
  return { enabled: raw.enabled ?? true, always_ask: [...classes], budgets } as ActionPolicyConfig;
}

export interface ActionSessionBudget { readonly peer: string; readonly session: string }
export interface ActionChallenge { readonly classes: readonly ActionClass[] }
export type ActionDecision = { kind: "native" } | { kind: "ask"; classes: ActionClass[]; challenge?: ActionChallenge } | { kind: "budget"; classes: ActionClass[] };
interface Session { handle: ActionSessionBudget; policy: string; remaining: Record<ActionClass, number> }
const empty = (): Record<ActionClass, number> => ({ publish: 0, destroy: 0, "external-write": 0, install: 0 });
/** Host-only ledger: session ids and policy come from current runtime ports, never a tool argument. */
export class ActionBudgets {
  private sessions = new Map<string, Session>();
  private challenges = new WeakMap<ActionChallenge, { handle: ActionSessionBudget; policy: string; classes: ActionClass[] }>();
  constructor(private readonly config: () => ActionPolicyConfig | undefined, private readonly currentSession: (peer: string) => string | undefined) {}
  bindSession(peer: string, session: string): ActionSessionBudget | undefined {
    if (!session || this.currentSession(peer) !== session) return undefined;
    const previous = this.sessions.get(peer);
    if (previous?.handle.session === session) return previous.handle;
    const handle = Object.freeze({ peer, session });
    this.sessions.set(peer, { handle, policy: "", remaining: empty() });
    return handle;
  }
  revoke(peer: string): void { this.sessions.delete(peer); }
  policyChanged(): void {
    for (const state of this.sessions.values()) { state.policy = ""; state.remaining = empty(); }
    this.challenges = new WeakMap();
  }
  private current(handle: ActionSessionBudget | undefined): Session | undefined {
    if (!handle) return undefined;
    const state = this.sessions.get(handle.peer);
    if (state?.handle !== handle || this.currentSession(handle.peer) !== handle.session) return undefined;
    const policy = JSON.stringify(actionPolicyConfig(this.config()));
    if (state.policy !== policy) { state.policy = policy; state.remaining = empty(); }
    return state;
  }
  private selected(actions: readonly ActionClass[]): ActionClass[] {
    const config = actionPolicyConfig(this.config());
    return config.enabled ? ACTION_CLASSES.filter(key => actions.includes(key) && config.always_ask.includes(key)) : [];
  }
  /** A budget decision consumes every selected class atomically; native never grants permission. */
  request(handle: ActionSessionBudget | undefined, actions: readonly ActionClass[]): ActionDecision {
    const state = this.current(handle), classes = this.selected(actions);
    if (!classes.length) return { kind: "native" };
    if (!state) return { kind: "ask", classes };
    if (classes.some(key => state.remaining[key] <= 0)) {
      const challenge = Object.freeze({ classes: Object.freeze([...classes]) });
      this.challenges.set(challenge, { handle: state.handle, policy: state.policy, classes: [...classes] });
      return { kind: "ask", classes, challenge };
    }
    for (const key of classes) state.remaining[key]--;
    return { kind: "budget", classes };
  }
  /** Explicit class-budget approval only, never an ordinary allow_once; this invocation consumes slot one. */
  approve(challenge: ActionChallenge | undefined): boolean {
    if (!challenge) return false;
    const grant = this.challenges.get(challenge); this.challenges.delete(challenge);
    if (!grant) return false;
    const state = this.current(grant.handle), config = actionPolicyConfig(this.config());
    if (!state || state.policy !== grant.policy) return false;
    for (const key of grant.classes) state.remaining[key] = Math.max(0, config.budgets[key] - 1);
    return true;
  }
  /** Read-only projection: no session is created, rebound or reset by a status poll. */
  status(peer: string, enforced: boolean) {
    const config = actionPolicyConfig(this.config()), state = this.sessions.get(peer);
    const bound = !!state && this.currentSession(peer) === state.handle.session && state.policy === JSON.stringify(config);
    return { enabled: config.enabled, alwaysAsk: [...config.always_ask], limits: { ...config.budgets }, remaining: bound ? { ...state.remaining } : empty(), sessionBound: bound,
      enforceable: enforced, note: !enforced ? `always-ask not enforceable: adapter integration pending${config.enabled ? "" : "; policy disabled"}` : config.enabled ? "always-ask active" : "always-ask disabled" };
  }
}

/** Adapter integrations must pass the host's publicView and current command/private-turn screens. */
export function actionApprovalText<T>(classes: readonly ActionClass[], command: string, task: T | undefined,
  ports: { publicView(task: T): Record<string, unknown>; private: boolean; commandView(command: string): string | undefined }): string {
  const view = task === undefined ? undefined : ports.publicView(task);
  const title = typeof view?.title === "string" ? sanitize(view.title).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 160) : undefined;
  const shown = ports.private ? undefined : ports.commandView(command);
  const line = shown === undefined ? "[private command withheld]" : sanitize(shown).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 512);
  return `Action approval (${ACTION_CLASSES.filter(key => classes.includes(key)).join(", ")})${title ? `; task ${title}` : ""}: ${line}`;
}
