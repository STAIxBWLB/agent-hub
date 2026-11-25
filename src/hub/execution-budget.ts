import { definitionOf, type KindMap } from "../adapters/registry.ts";
import type { Database } from "./db-schema.ts";
import { openHubDatabase } from "./db-schema.ts";

export type ExecutionUnit = "model_calls" | "tool_calls" | "elapsed_ms" | "tokens";
export type ExecutionBudgetLimits = Partial<Record<ExecutionUnit, number>>;
export interface ExecutionBudgetConfig {
  id: string;
  kind: "task" | "run";
  taskId?: number;
  peers: string[];
  limits: ExecutionBudgetLimits;
}
/** #1513 AC3: a person's reason for reconfiguring a budget, kept with who gave it and when. */
export interface ExecutionOverride {
  reason: string;
  by: string;
  at: number;
}
export interface ExecutionBudgetStatus extends ExecutionBudgetConfig {
  used: Partial<Record<ExecutionUnit, number>>;
  units: Partial<Record<ExecutionUnit, { used: number; limit: number; remaining: number; reason?: "exhausted" | "unknown_usage" }>>;
  createdAt: number;
  updatedAt: number;
  /** The last reasoned override. A configure without a reason leaves it as it was. */
  override?: ExecutionOverride;
}
export interface ExecutionBudgetDecision {
  allowed: boolean;
  scope: string;
  unit: ExecutionUnit;
  used: number;
  limit: number | null;
  remaining: number | null;
  reason?: "exhausted" | "unknown_usage" | "not_eligible";
}

const UNITS = new Set<ExecutionUnit>(["model_calls", "tool_calls", "elapsed_ms", "tokens"]);
const validLimits = (raw: ExecutionBudgetLimits): ExecutionBudgetLimits => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("execution budget limits must be an object");
  const out: ExecutionBudgetLimits = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!UNITS.has(key as ExecutionUnit)) throw new Error(`unsupported execution budget unit: ${key}`);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`execution budget ${key} limit must be a nonnegative integer`);
    out[key as ExecutionUnit] = value;
  }
  return out;
};

/** Persistent, cross-turn execution meter. Each admission and increment is one SQLite transaction. */
export class ExecutionBudget {
  private readonly db: Database;
  constructor(path: string, private readonly instances?: KindMap) {
    this.db = openHubDatabase(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS execution_budgets (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, task_id INTEGER, peers TEXT NOT NULL,
      limits TEXT NOT NULL, used TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    // #1513: a table created before the override column exists still opens, and keeps its rows.
    const columns = this.db.query("PRAGMA table_info(execution_budgets)").all() as { name: string }[];
    if (!columns.some(column => column.name === "last_override")) this.db.run("ALTER TABLE execution_budgets ADD COLUMN last_override TEXT");
  }

  /**
   * A configure with a reason records it with the actor and the time, and the caller's `by` is only ever
   * `person`: the console is the one writer of an execution budget.
   */
  configure(input: ExecutionBudgetConfig, meta: { reason?: string; by?: string } = {}): ExecutionBudgetStatus {
    if (!input.id || input.id.length > 200) throw new Error("execution budget id is invalid");
    if (input.kind !== "task" && input.kind !== "run") throw new Error("execution budget kind must be task or run");
    if (input.kind === "task" && (!Number.isSafeInteger(input.taskId) || input.taskId! < 1)) throw new Error("task budget requires a positive task id");
    const peers = [...new Set(input.peers.filter((p) => typeof p === "string" && p.length > 0))].sort();
    if (!peers.length) throw new Error("execution budget requires at least one peer");
    const unsupported = peers.filter((peer) => !definitionOf(peer, this.instances)?.budget?.instrumented);
    if (unsupported.length) throw new Error(`execution budgets require instrumented peers (pi, local); unsupported: ${unsupported.join(", ")}`);
    const limits = validLimits(input.limits ?? {});
    if (!Object.keys(limits).length) throw new Error("execution budget requires at least one supported limit");
    const reason = meta.reason === undefined ? undefined : String(meta.reason).trim();
    if (reason !== undefined && reason.length > 280) throw new Error("execution budget reason is at most 280 characters");
    const now = Date.now();
    const existing = this.db.query("SELECT kind,task_id,last_override FROM execution_budgets WHERE id=?").get(input.id) as { kind: string; task_id: number | null; last_override: string | null } | undefined;
    if (existing && (existing.kind !== input.kind || existing.task_id !== (input.taskId ?? null))) throw new Error("execution budget id is already bound to another scope");
    // A configure without a reason keeps the last one: the row answers "why is this limit what it is", not "what did the last call say".
    const lastOverride = reason ? JSON.stringify({ reason, by: meta.by ?? "person", at: now }) : existing?.last_override ?? null;
    this.db.query(`INSERT INTO execution_budgets (id,kind,task_id,peers,limits,used,created_at,updated_at,last_override)
      VALUES (?,?,?,?,?,'{}',?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,task_id=excluded.task_id,
      peers=excluded.peers,limits=excluded.limits,updated_at=excluded.updated_at,last_override=excluded.last_override`).run(
      input.id, input.kind, input.taskId ?? null, JSON.stringify(peers), JSON.stringify(limits), now, now, lastOverride,
    );
    return this.status(input.id) as ExecutionBudgetStatus;
  }

  disable(id: string): boolean { return this.db.query("DELETE FROM execution_budgets WHERE id=?").run(id).changes > 0; }

  status(id?: string): ExecutionBudgetStatus | ExecutionBudgetStatus[] | undefined {
    const rows = (id
      ? this.db.query("SELECT * FROM execution_budgets WHERE id=?").all(id)
      : this.db.query("SELECT * FROM execution_budgets ORDER BY created_at,id").all()) as BudgetRow[];
    const values = rows.map(fromRow);
    return id ? values[0] : values;
  }

  admitTask(taskId: number | undefined, peer: string, unit: ExecutionUnit, amount = 1): ExecutionBudgetDecision[] {
    return this.admitTasks(taskId === undefined ? [] : [taskId], peer, unit, amount);
  }

  /** Whether any budget meters this peer's work on these tasks. It only reads: nothing is admitted or counted. */
  applies(taskIds: number[], peer: string): boolean {
    return this.scopes(taskIds, peer).length > 0;
  }

  /** Capability comes from the resolved instance definition, never the peer's spelling. */
  instrumented(peer: string): boolean { return definitionOf(peer, this.instances)?.budget?.instrumented === true; }

  /**
   * The named budget must cover this task and owner; another applicable budget proves nothing. #1329 part 2: a `tokens`
   * limit is a covered resource now that a caller can admit the spend it counted itself, so a review run's cap is a budget.
   */
  covers(id: string, taskId: number, peer: string, resources: readonly ExecutionUnit[]): boolean {
    if (!this.instrumented(peer) || !resources.every(unit => UNITS.has(unit))) return false;
    const row = this.scopes([taskId], peer).find(row => row.id === id);
    if (!row) return false;
    const limits = fromRow(row).limits;
    return resources.every(unit => limits[unit] !== undefined && !(unit === "model_calls" && limits.tokens !== undefined));
  }

  private scopes(taskIds: number[], peer: string): BudgetRow[] {
    const ids = [...new Set(taskIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    const taskRows = ids.length
      ? this.db.query(`SELECT * FROM execution_budgets WHERE kind='task' AND task_id IN (${ids.map(() => "?").join(",")}) AND EXISTS (SELECT 1 FROM json_each(peers) WHERE value=?)`).all(...ids, peer) as BudgetRow[]
      : [];
    const runRows = this.db.query("SELECT * FROM execution_budgets WHERE kind='run' AND EXISTS (SELECT 1 FROM json_each(peers) WHERE value=?)").all(peer) as BudgetRow[];
    return [...taskRows, ...runRows];
  }

  admitTasks(taskIds: number[], peer: string, unit: ExecutionUnit, amount = 1): ExecutionBudgetDecision[] {
    if (!UNITS.has(unit) || !Number.isSafeInteger(amount) || amount <= 0) throw new Error("execution budget admission is invalid");
    const transaction = this.db.transaction(() => {
      // Read scopes only after BEGIN IMMEDIATE so a concurrent configure/admission cannot evade a scope or overdraw it.
      const rows = this.scopes(taskIds, peer).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      const pending: { cfg: ExecutionBudgetStatus; updates: Partial<Record<ExecutionUnit, number>>; decisions: ExecutionBudgetDecision[] }[] = rows.map((row) => {
        const cfg = fromRow(row), updates: Partial<Record<ExecutionUnit, number>> = {}, decisions: ExecutionBudgetDecision[] = [];
        const now = Date.now(), elapsedLimit = cfg.limits.elapsed_ms;
        if (elapsedLimit !== undefined) {
          const elapsed = Math.max(cfg.used.elapsed_ms ?? 0, now - cfg.createdAt);
          const decision: ExecutionBudgetDecision = { allowed: elapsed < elapsedLimit, scope: cfg.id, unit: "elapsed_ms", used: elapsed, limit: elapsedLimit, remaining: Math.max(0, elapsedLimit - elapsed), ...(elapsed >= elapsedLimit ? { reason: "exhausted" } : {}) };
          decisions.push(decision); updates.elapsed_ms = elapsed;
        }
        const limit = cfg.limits[unit], current = cfg.used[unit] ?? 0;
        // #1329 part 2: `tokens` is admitted like any counted unit, from the delta the caller counted. A caller that admits
        // model calls against a budget carrying a tokens limit still cannot count them, so that reading stays unknown.
        if (unit === "model_calls" && cfg.limits.tokens !== undefined) {
          decisions.push({ allowed: false, scope: cfg.id, unit: "tokens", used: cfg.used.tokens ?? 0, limit: cfg.limits.tokens ?? null, remaining: cfg.limits.tokens === undefined ? null : Math.max(0, cfg.limits.tokens - (cfg.used.tokens ?? 0)), reason: "unknown_usage" });
        } else if (limit === undefined) decisions.push({ allowed: true, scope: cfg.id, unit, used: current, limit: null, remaining: null });
        else if (current + amount > limit) decisions.push({ allowed: false, scope: cfg.id, unit, used: current, limit, remaining: Math.max(0, limit - current), reason: "exhausted" });
        else {
          updates[unit] = current + amount;
          decisions.push({ allowed: true, scope: cfg.id, unit, used: current + amount, limit, remaining: Math.max(0, limit - current - amount) });
        }
        return { cfg, updates, decisions };
      });
      if (pending.some((item) => item.decisions.some((decision) => !decision.allowed))) return pending.flatMap((item) => item.decisions);
      for (const item of pending) if (Object.keys(item.updates).length) {
        item.cfg.used = { ...item.cfg.used, ...item.updates };
        this.db.query("UPDATE execution_budgets SET used=?,updated_at=? WHERE id=?").run(JSON.stringify(item.cfg.used), Date.now(), item.cfg.id);
      }
      return pending.flatMap((item) => item.decisions);
    });
    return transaction.immediate();
  }
  close(): void { this.db.close(); }
}

interface BudgetRow { id: string; kind: "task"|"run"; task_id: number | null; peers: string; limits: string; used: string; created_at: number; updated_at: number; last_override?: string | null }
function fromRow(row: BudgetRow): ExecutionBudgetStatus {
  const limits = JSON.parse(row.limits) as ExecutionBudgetLimits;
  const used = JSON.parse(row.used) as Partial<Record<ExecutionUnit, number>>;
  if (limits.elapsed_ms !== undefined) used.elapsed_ms = Math.max(used.elapsed_ms ?? 0, Date.now() - row.created_at);
  const units: ExecutionBudgetStatus["units"] = {};
  for (const [unit, limit] of Object.entries(limits) as [ExecutionUnit, number][]) {
    const current = used[unit] ?? 0, remaining = Math.max(0, limit - current);
    // #1329 part 2: a tokens row now carries what a caller admitted, so a remaining allowance is not `unknown_usage`; a
    // caller that admits something it cannot count still gets that reason from `admitTasks`.
    units[unit] = { used: current, limit, remaining, ...(remaining === 0 ? { reason: "exhausted" as const } : {}) };
  }
  const override = row.last_override ? JSON.parse(row.last_override) as ExecutionOverride : undefined;
  return { id: row.id, kind: row.kind, ...(row.task_id === null ? {} : { taskId: row.task_id }), peers: JSON.parse(row.peers), limits, used, units, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(override && typeof override.reason === "string" && typeof override.by === "string" && typeof override.at === "number" ? { override } : {}) };
}
