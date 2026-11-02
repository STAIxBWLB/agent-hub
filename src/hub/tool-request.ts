import { createHash, randomUUID } from "node:crypto";
import { canonical } from "./capabilities.ts";

export const TOOL_WRITE_FEATURE = "tool_write_idempotency";
const RETENTION_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 512;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_FUTURE_MS = 30_000;
type Reply = Record<string, unknown>;

/** These three writes have per-call replay semantics; invocation keeps its own admission protocol. */
export function toolWriteOperation(msg: Record<string, unknown>): "hub_task_propose" | "hub_review" | "hub_delivery_done" | undefined {
  if (msg.t === "delivery_complete") return "hub_delivery_done";
  if (msg.t === "task" && (msg.op === "hub_task_propose" || msg.op === "hub_review")) return msg.op;
  return undefined;
}

export function newToolRequestId(instanceId: string, now = Date.now()): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(instanceId) || !Number.isSafeInteger(now) || now < 1) throw new Error("tool request identity is unavailable");
  return `v1/${instanceId}/${now}/${randomUUID()}`;
}

export function toolWriteUnknownReply(msg: Record<string, unknown>, requestId?: string, cause?: string): Reply {
  const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args as Record<string, unknown> : {};
  const id = Number.isSafeInteger(args.id) && (args.id as number) > 0 ? args.id : undefined;
  const delivery = typeof msg.deliveryId === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(msg.deliveryId) ? msg.deliveryId : "<delivery-id>";
  const read = toolWriteOperation(msg) === "hub_delivery_done" ? `ahub queue show ${delivery} (person or conductor)`
    : toolWriteOperation(msg) === "hub_review" && id !== undefined ? `hub_task_show {id: ${id}}` : "hub_task_list (then hub_task_show for the matching task)";
  const token = typeof requestId === "string" && requestId.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(requestId) ? requestId : undefined;
  return { ok: false, outcome: "unknown", ...(token ? { requestId: token } : {}),
    error: `Write outcome unknown${token ? ` (request ${token})` : ""}${cause ? `: ${cause}` : ". The hub may have applied the write"}. Inspect ${read} before another write; do not resubmit with a new request ID.` };
}

interface Entry { scope: string; payload: string; issuedAt: number; settled: boolean; reply: Promise<Reply> }
interface Request { id: unknown; scope: string; payload: unknown; current: (reply?: Reply) => boolean }

/** One daemon epoch. Expired ids are rejected, not forgotten and reapplied. */
export class ToolWriteRegistry {
  private readonly entries = new Map<string, Entry>();
  private watermark = 0;
  private readonly clock: () => number;
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private readonly maxReplyBytes: number;
  constructor(private readonly instanceId: string, options: { now?: () => number; maxEntries?: number; retentionMs?: number; maxReplyBytes?: number } = {}) {
    this.clock = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.retentionMs = options.retentionMs ?? RETENTION_MS;
    this.maxReplyBytes = options.maxReplyBytes ?? MAX_REPLY_BYTES;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(instanceId) || ![this.maxEntries, this.retentionMs, this.maxReplyBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("invalid tool replay registry bounds");
  }

  async run(request: Request, work: () => Promise<Reply>): Promise<Reply> {
    const unavailable = (cause: string) => toolWriteUnknownReply(this.message(request.payload), typeof request.id === "string" ? request.id : undefined, cause);
    const current = (reply?: Reply) => { try { return request.current(reply === undefined ? undefined : structuredClone(reply)) === true; } catch { return false; } };
    if (!current()) return unavailable("current caller authority or privacy is unavailable");
    const observed = this.clock();
    if (!Number.isSafeInteger(observed) || observed < 1) return unavailable("the replay clock is unavailable");
    const now = this.watermark = Math.max(this.watermark, observed);
    const parts = typeof request.id === "string" && request.id.length <= 256 ? request.id.split("/") : [];
    const issuedAt = Number(parts[2]);
    if (parts.length !== 4 || parts[0] !== "v1" || parts[1] !== this.instanceId || !/^[1-9][0-9]{0,15}$/.test(parts[2] ?? "")
      || !Number.isSafeInteger(issuedAt) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parts[3] ?? "")) return unavailable("the request ID is invalid or belongs to another daemon instance; inspect its original outcome");
    let payload: string, scope: string;
    try {
      if (typeof request.scope !== "string" || request.scope.length > 4096) throw new Error("invalid scope");
      scope = createHash("sha256").update(request.scope).digest("hex");
      const encoded = JSON.stringify(request.payload);
      if (!encoded || Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES) throw new Error("request too large");
      const value: unknown = JSON.parse(encoded);
      const stack = [{ value, depth: 0 }]; let nodes = 0;
      while (stack.length) {
        const row = stack.pop()!;
        if (++nodes > 20_000 || row.depth > 32) throw new Error("request too complex");
        if (row.value && typeof row.value === "object") for (const child of Object.values(row.value)) stack.push({ value: child, depth: row.depth + 1 });
      }
      payload = createHash("sha256").update(canonical(value)).digest("hex");
    } catch { return unavailable("the request is too large or malformed for replay protection"); }
    // Pending writes never age out: losing their key could apply an unfinished write twice.
    for (const [id, entry] of this.entries) if (entry.settled && now - entry.issuedAt >= this.retentionMs) this.entries.delete(id);
    const existing = this.entries.get(request.id as string);
    if (existing) {
      if (existing.scope !== scope || existing.payload !== payload) return unavailable("the request ID was already used by another authority or for different arguments");
      const reply = await existing.reply;
      return current(reply) ? structuredClone(reply) : unavailable("caller authority or privacy changed before replay");
    }
    if (now - issuedAt >= this.retentionMs || issuedAt > now + MAX_FUTURE_MS) return unavailable("the request ID is expired or its timestamp is outside the replay window; inspect its original outcome");
    // ponytail: 512 calls/15 min and 64 KiB per reply; a durable outcome ledger is the upgrade path for higher sustained write volume.
    if (this.entries.size >= this.maxEntries) return unavailable("the replay window is full; inspect outstanding writes and wait for the window to drain");
    const entry: Entry = { scope, payload, issuedAt, settled: false, reply: Promise.resolve({}) };
    this.entries.set(request.id as string, entry);
    entry.reply = Promise.resolve().then(async () => {
      if (!current()) return unavailable("caller authority or privacy changed before execution");
      try {
        const result = await work();
        const { rid: _rid, ...body } = result;
        const encoded = JSON.stringify({ ...body, requestId: request.id });
        if (Buffer.byteLength(encoded) > this.maxReplyBytes) return unavailable("the write result exceeds the bounded replay record; inspect the write directly");
        return JSON.parse(encoded) as Reply;
      } catch { return unavailable("the write raised an unexpected failure and may already have applied"); }
    }).finally(() => { entry.settled = true; });
    const reply = await entry.reply;
    return current(reply) ? structuredClone(reply) : unavailable("caller authority or privacy changed before the result");
  }

  private message(payload: unknown): Record<string, unknown> {
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  }
}
