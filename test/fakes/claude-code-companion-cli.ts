/** C0 specification fixture only. No subprocess, filesystem, shell, persistence or host API. */
export const CLAUDE_COMPANION_LIMITS = { timeoutMs: 5000, maxOutputBytes: 262144, maxRows: 256, maxText: 240 } as const;
export interface ClaudeCompanionCall { executable: string; argv: readonly string[]; cwd: string; timeoutMs: number; maxOutputBytes: number }
export interface ClaudeCompanionResponse { stdout: string; stderr?: string; exitCode: number | null; durationMs?: number }
export class ClaudeCompanionFixtureError extends Error {
  constructor(readonly code: "invalid_request" | "disabled" | "unscripted" | "timeout" | "oversized" | "nonzero" | "malformed" | "binding" | "schema") { super(code); }
}
export class FakeClaudeCompanionCli {
  readonly calls: ClaudeCompanionCall[] = [];
  private readonly responses: ClaudeCompanionResponse[];
  private enabled = true;
  constructor(scripted: readonly ClaudeCompanionResponse[]) { this.responses = structuredClone([...scripted]); }
  setEnabled(value: boolean): void { this.enabled = value; }
  async run(call: ClaudeCompanionCall): Promise<ClaudeCompanionResponse> {
    if (!this.enabled) throw new ClaudeCompanionFixtureError("disabled");
    const { argv } = call;
    if (call.executable !== "ahub" || typeof call.cwd !== "string" || !call.cwd.startsWith("/")
      || !Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--project" || argv[1] !== call.cwd
      || !["status", "board", "projects"].includes(argv[2]!) || argv[3] !== "--json"
      || call.timeoutMs !== CLAUDE_COMPANION_LIMITS.timeoutMs || call.maxOutputBytes !== CLAUDE_COMPANION_LIMITS.maxOutputBytes) throw new ClaudeCompanionFixtureError("invalid_request");
    this.calls.push({ ...call, argv: [...argv] });
    const response = this.responses.shift();
    if (!response) throw new ClaudeCompanionFixtureError("unscripted");
    if (!Number.isFinite(response.durationMs ?? 0) || (response.durationMs ?? 0) < 0) throw new ClaudeCompanionFixtureError("invalid_request");
    if ((response.durationMs ?? 0) > call.timeoutMs) throw new ClaudeCompanionFixtureError("timeout");
    if (new TextEncoder().encode(response.stdout + (response.stderr ?? "")).length > call.maxOutputBytes) throw new ClaudeCompanionFixtureError("oversized");
    if (response.exitCode !== 0) throw new ClaudeCompanionFixtureError("nonzero");
    return structuredClone(response);
  }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= CLAUDE_COMPANION_LIMITS.maxText && !/[\r\n\x00-\x1f]/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function json(raw: string): unknown {
  if (new TextEncoder().encode(raw).length > CLAUDE_COMPANION_LIMITS.maxOutputBytes) throw new ClaudeCompanionFixtureError("oversized");
  try { return JSON.parse(raw); } catch { throw new ClaudeCompanionFixtureError("malformed"); }
}
/** Closed public projection of existing status JSON; unknown source fields are never copied. */
export function fixtureStatus(raw: string, binding: { root: string; projectId: string }) {
  const row = json(raw);
  if (!object(row)) throw new ClaudeCompanionFixtureError("schema");
  if (row.cwd !== binding.root || row.projectId !== binding.projectId) throw new ClaudeCompanionFixtureError("binding");
  if (!text(row.version) || !object(row.peers) || !object(row.tasks)) throw new ClaudeCompanionFixtureError("schema");
  const entries = Object.entries(row.peers);
  if (entries.length > CLAUDE_COMPANION_LIMITS.maxRows) throw new ClaudeCompanionFixtureError("schema");
  const peers = entries.map(([id, peer]) => {
    if (!text(id) || !object(peer) || !["idle", "busy", "paused", "offline"].includes(String(peer.state)) || !count(peer.queued)
      || peer.attached !== undefined && typeof peer.attached !== "boolean" || peer.needsReview !== undefined && !count(peer.needsReview)) throw new ClaudeCompanionFixtureError("schema");
    return { id, state: peer.state as string, queued: peer.queued as number, ...(typeof peer.attached === "boolean" ? { attached: peer.attached } : {}), ...(typeof peer.needsReview === "number" ? { needsReview: peer.needsReview } : {}) };
  });
  const tasks = Object.entries(row.tasks).map(([state, total]) => {
    if (!["proposed", "in_progress", "in_review", "approved", "changes_requested", "cancelled", "backlog"].includes(state) || !count(total)) throw new ClaudeCompanionFixtureError("schema");
    return { state, count: total as number };
  });
  return { root: binding.root, projectId: binding.projectId, version: row.version, peers, tasks };
}
/** The existing board's title is already publicTitle. PII rows retain only their numeric id. */
export function fixtureBoard(raw: string) {
  const rows = json(raw);
  if (!Array.isArray(rows) || rows.length > CLAUDE_COMPANION_LIMITS.maxRows) throw new ClaudeCompanionFixtureError("schema");
  return rows.map(row => {
    if (!object(row) || !Number.isSafeInteger(row.id) || Number(row.id) <= 0 || !text(row.title)) throw new ClaudeCompanionFixtureError("schema");
    if (row.title.includes("[pii]")) return { id: row.id as number };
    if (!["proposed", "in_progress", "in_review", "approved", "changes_requested", "cancelled", "backlog"].includes(String(row.state))) throw new ClaudeCompanionFixtureError("schema");
    return { id: row.id as number, publicTitle: row.title, state: row.state as string };
  });
}
