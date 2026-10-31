import { ACTION_CLASSES, type ActionClass } from "./action-class.ts";
import { sanitize } from "./envelope.ts";

/** `floor` (#999 T3) lets ordinary branch pushes and own-repository pull requests run without asking. It is kept when present, true or false, so a recovery can tell that the project's file names the key at all. */
export interface ActionPolicyConfig { enabled: boolean; always_ask: ActionClass[]; budgets: Record<ActionClass, number>; floor?: boolean }
const DEFAULT_BUDGETS: Record<ActionClass, number> = { publish: 1, destroy: 3, "external-write": 5, install: 2 };
/** Defaults are host policy; overrides belong only in untracked config.local.json.
 * ponytail: startup adopts that local policy without a retained person confirmation.
 * Status surfaces every weakening as attention; upgrade: retain a person-bound startup confirmation.
 */
export function actionPolicyConfig(value?: unknown): ActionPolicyConfig {
  const fail = (): never => { throw new Error("action_policy: expected enabled, always_ask, floor and class budgets (integers 0..1000)"); };
  if (value === undefined) return { enabled: true, always_ask: [...ACTION_CLASSES], budgets: { ...DEFAULT_BUDGETS } };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["enabled", "always_ask", "budgets", "floor"].includes(key))) return fail();
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return fail();
  if (raw.floor !== undefined && typeof raw.floor !== "boolean") return fail();
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
  return { enabled: raw.enabled ?? true, always_ask: [...classes], budgets, ...(raw.floor !== undefined ? { floor: raw.floor } : {}) } as ActionPolicyConfig;
}

/** The classes the floor never lets always_ask drop: with the floor on, release-grade, destructive and foreign-write calls ask whatever the coarse selector says. */
export const FLOOR_ASKED: readonly ActionClass[] = Object.freeze(["publish", "external-write", "destroy"] as const);
/** The classes that ask under this policy: always_ask, plus every floor class while the floor is on. A disabled policy asks none. */
export function askedClasses(config: ActionPolicyConfig): ActionClass[] {
  if (!config.enabled) return [];
  return ACTION_CLASSES.filter(key => config.always_ask.includes(key) || config.floor === true && FLOOR_ASKED.includes(key));
}

/**
 * The structural guards the floor rests on where the hub cannot see a call first (Codex in never-ask, Kimi in auto, Jcode: #999 T3). The hub names
 * them and cannot verify them from here, so a status row says "not verified", never that they hold. A guard that is missing is the person's to report.
 */
export const FLOOR_GUARDS: readonly { readonly asks: string; readonly guard: string }[] = Object.freeze([
  { asks: "force push, a push to the default branch or of tags", guard: "GitHub branch protection on the default branch" },
  { asks: "gh release and a release tag", guard: "release only through ahub sdlc authorize-release and the OIDC tag workflow" },
  { asks: "deletion outside the project, a write to another repository", guard: "the peer's native sandbox" },
]);
export const floorGuardText = (): string => FLOOR_GUARDS.map(entry => `${entry.asks}: ${entry.guard}`).join("; ");

/**
 * The eight floor classes of #999 (one list with `templates/presets/autonomous.json` `floorClasses`; a test holds them equal): each maps to the action class
 * that asks for it and to the structural guard it rests on where the hub cannot see the call first. `guard` null means none is named: the class is then
 * unprotected there, and status says so.
 */
export const FLOOR_CLASS_TABLE: Readonly<Record<string, { readonly action: ActionClass; readonly asks: string; readonly guard: string | null }>> = Object.freeze({
  "force-push": { action: "publish", asks: "a force or delete push", guard: "GitHub branch protection on the default branch" },
  "default-branch-push": { action: "publish", asks: "a push to the default branch", guard: "GitHub branch protection on the default branch" },
  "tag-push": { action: "publish", asks: "a push of a tag", guard: "release only through ahub sdlc authorize-release and the OIDC tag workflow" },
  "release-publish": { action: "publish", asks: "gh release", guard: "release only through ahub sdlc authorize-release and the OIDC tag workflow" },
  "package-publish": { action: "publish", asks: "npm, bun, pnpm, yarn or cargo publish", guard: null },
  "destroy-outside-root": { action: "destroy", asks: "deletion outside the execution root", guard: "the peer's native sandbox" },
  "foreign-repo-write": { action: "external-write", asks: "a write to another repository", guard: "the peer's native sandbox" },
  "external-send": { action: "external-write", asks: "mail and posting", guard: null },
});
export const FLOOR_CLASSES: readonly string[] = Object.freeze(Object.keys(FLOOR_CLASS_TABLE));
export interface FloorEnforcementRow { readonly status: "hub-enforced" | "not-enforced"; readonly reason: string }
/**
 * What the hub can say about each floor class for one peer, from the running policy and where the hub sees that peer's calls (`enforcement`, as `actionEnforcement`
 * in the daemon reports it). `hub-enforced`: the hub sees the call first and the class asks under this policy, with the floor on or off. `not-enforced`: it does not,
 * or the policy does not ask for the class; the reason names the guard the class rests on and that the hub has not verified it, never that it holds. The hub verifies
 * no structural guard, so no row is `structural-guard` here: that status needs evidence a person or a check supplies (`AutonomyPeer.structuralGuards`).
 */
export function floorEnforcement(policy: ActionPolicyConfig | undefined, enforcement: { readonly enforced: boolean; readonly reason?: string }): Record<string, FloorEnforcementRow> {
  const config = actionPolicyConfig(policy), asked = askedClasses(config), rows: Record<string, FloorEnforcementRow> = {};
  for (const [name, entry] of Object.entries(FLOOR_CLASS_TABLE)) {
    const guard = entry.guard === null ? "no structural guard is named for it" : `it rests on ${entry.guard}, which the hub has not verified`;
    if (!config.enabled) rows[name] = { status: "not-enforced", reason: `action_policy is disabled, so ${entry.asks} does not ask; ${guard}` };
    else if (!asked.includes(entry.action)) rows[name] = { status: "not-enforced", reason: `action_policy always_ask omits ${entry.action}, so ${entry.asks} does not ask; ${guard}` };
    else if (!enforcement.enforced) rows[name] = { status: "not-enforced", reason: `the hub does not see this peer's calls first${enforcement.reason ? ` (${enforcement.reason})` : ""}; ${guard}` };
    else rows[name] = { status: "hub-enforced", reason: `${entry.asks} asks (class ${entry.action}${config.floor === true ? ", floor on" : ""})` };
  }
  return rows;
}

export interface ActionSessionBudget { readonly peer: string; readonly session: string }
export interface ActionChallenge { readonly classes: readonly ActionClass[] }
export type ActionDecision = { kind: "native" } | { kind: "ask"; classes: ActionClass[]; challenge?: ActionChallenge } | { kind: "budget"; classes: ActionClass[] };
/** `grants` counts the class-budget approvals of this session and policy: a challenge remembers it, so a later approval can tell that another one landed first. */
interface Session { handle: ActionSessionBudget; policy: string; remaining: Record<ActionClass, number>; grants: Record<ActionClass, number> }
const empty = (): Record<ActionClass, number> => ({ publish: 0, destroy: 0, "external-write": 0, install: 0 });
/** Host-only ledger: session ids and policy come from current runtime ports, never a tool argument. */
export class ActionBudgets {
  private sessions = new Map<string, Session>();
  private challenges = new WeakMap<ActionChallenge, { handle: ActionSessionBudget; policy: string; classes: ActionClass[]; grants: Record<ActionClass, number> }>();
  constructor(private readonly config: () => ActionPolicyConfig | undefined, private readonly currentSession: (peer: string) => string | undefined) {}
  bindSession(peer: string, session: string): ActionSessionBudget | undefined {
    if (!session || this.currentSession(peer) !== session) return undefined;
    const previous = this.sessions.get(peer);
    if (previous?.handle.session === session) return previous.handle;
    const handle = Object.freeze({ peer, session });
    this.sessions.set(peer, { handle, policy: "", remaining: empty(), grants: empty() });
    return handle;
  }
  revoke(peer: string): void { this.sessions.delete(peer); }
  policyChanged(): void {
    for (const state of this.sessions.values()) { state.policy = ""; state.remaining = empty(); state.grants = empty(); }
    this.challenges = new WeakMap();
  }
  private current(handle: ActionSessionBudget | undefined): Session | undefined {
    if (!handle) return undefined;
    const state = this.sessions.get(handle.peer);
    if (state?.handle !== handle || this.currentSession(handle.peer) !== handle.session) return undefined;
    const policy = JSON.stringify(actionPolicyConfig(this.config()));
    if (state.policy !== policy) { state.policy = policy; state.remaining = empty(); state.grants = empty(); }
    return state;
  }
  /** Whether the floor (#999 T3) is on: the policy is enabled and says `floor`. Callers read floor facts only through this, so facts alone never widen a policy that did not ask for them. */
  floorOn(): boolean {
    const config = actionPolicyConfig(this.config());
    return config.enabled && config.floor === true;
  }
  private selected(actions: readonly ActionClass[]): ActionClass[] {
    const asked = askedClasses(actionPolicyConfig(this.config()));
    return ACTION_CLASSES.filter(key => actions.includes(key) && asked.includes(key));
  }
  /** A budget decision consumes every selected class atomically; native never grants permission. */
  request(handle: ActionSessionBudget | undefined, actions: readonly ActionClass[]): ActionDecision {
    const state = this.current(handle), classes = this.selected(actions);
    if (!classes.length) return { kind: "native" };
    if (!state) return { kind: "ask", classes };
    if (classes.some(key => state.remaining[key] <= 0)) {
      const challenge = Object.freeze({ classes: Object.freeze([...classes]) });
      this.challenges.set(challenge, { handle: state.handle, policy: state.policy, classes: [...classes], grants: { ...state.grants } });
      return { kind: "ask", classes, challenge };
    }
    for (const key of classes) state.remaining[key]--;
    return { kind: "budget", classes };
  }
  /**
   * Explicit class-budget approval only, never an ordinary allow_once; this invocation consumes slot one. Requests run concurrently, so
   * two challenges can be issued while a class is spent: the first approval opens the allowance (budget minus this call), and an approval of
   * a challenge issued before it is a later call inside that allowance, which consumes one slot instead of opening another. With no slot
   * left it is refused (the person asks again and sees a fresh challenge), so N approved calls is the most any budget lets through.
   * Every class is checked before any is spent: a refusal changes nothing.
   */
  approve(challenge: ActionChallenge | undefined): boolean {
    if (!challenge) return false;
    const grant = this.challenges.get(challenge); this.challenges.delete(challenge);
    if (!grant) return false;
    const state = this.current(grant.handle), config = actionPolicyConfig(this.config());
    if (!state || state.policy !== grant.policy) return false;
    const late = (key: ActionClass) => state.grants[key] !== grant.grants[key];
    if (grant.classes.some(key => late(key) && state.remaining[key] <= 0)) return false;
    for (const key of grant.classes) {
      state.remaining[key] = late(key) ? state.remaining[key] - 1 : Math.max(0, config.budgets[key] - 1);
      state.grants[key]++;
    }
    return true;
  }
  /** Read-only projection: no session is created, rebound or reset by a status poll. */
  status(peer: string, enforced: boolean, reason = "adapter integration pending") {
    const config = actionPolicyConfig(this.config()), state = this.sessions.get(peer);
    const bound = !!state && this.currentSession(peer) === state.handle.session && state.policy === JSON.stringify(config);
    const weakened = !config.enabled || config.floor === true || ACTION_CLASSES.some(key => !config.always_ask.includes(key) || config.budgets[key] > DEFAULT_BUDGETS[key]);
    const attention = weakened ? "; attention: machine-local policy weakens defaults; no retained startup confirmation" : "";
    const floor = config.enabled && config.floor === true;
    // Where the hub cannot see a call first, the floor rests on guards outside it: say which, and that the hub has not verified them.
    const rests = floor && !enforced ? `; floor on: ${floorGuardText()} rest on structural guards the hub has not verified` : floor ? "; floor on: ordinary branch pushes and own-repository pull requests do not ask" : "";
    return { enabled: config.enabled, alwaysAsk: askedClasses({ ...config, enabled: true }), limits: { ...config.budgets }, remaining: bound ? { ...state.remaining } : empty(), sessionBound: bound,
      ...(config.floor === true ? { floor: true, ...(floor && !enforced ? { floorGuards: FLOOR_GUARDS.map(entry => ({ ...entry })) } : {}) } : {}),
      enforceable: enforced, note: (!enforced ? `always-ask not enforceable: ${reason}${config.enabled ? "" : "; policy disabled"}` : config.enabled ? "always-ask active" : "always-ask disabled") + rests + attention };
  }
}

type ActionApprovalPorts<T> = { publicView(task: T): Record<string, unknown>; private: boolean; commandView(command: string): string | undefined };

/** Public/native presentation: incomplete command views grant no approval, not even once. */
export function actionApprovalView<T>(classes: readonly ActionClass[], command: string, task: T | undefined,
  ports: ActionApprovalPorts<T>): { title: string; complete: boolean } {
  const view = task === undefined ? undefined : ports.publicView(task);
  const title = typeof view?.title === "string" ? sanitize(view.title).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 160) : undefined;
  const shown = ports.private ? undefined : ports.commandView(command);
  const full = shown === undefined ? undefined : Array.from(sanitize(shown).replace(/[\p{Cc}\p{Cf}]/gu, " "));
  const marker = ` [cut, ${full?.length ?? 0} chars]`;
  const line = full === undefined ? "[private command withheld]" : full.length > 512 ? full.slice(0, 512 - marker.length).join("") + marker : full.join("");
  return { title: `Action approval (${ACTION_CLASSES.filter(key => classes.includes(key)).join(", ")})${title ? `; task ${title}` : ""}: ${line}`,
    complete: shown === command && full !== undefined && full.length <= 512 && full.join("") === command };
}

/** Adapter integrations must pass the host's publicView and current command/private-turn screens. */
export function actionApprovalText<T>(classes: readonly ActionClass[], command: string, task: T | undefined, ports: ActionApprovalPorts<T>): string {
  return actionApprovalView(classes, command, task, ports).title;
}
