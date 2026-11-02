import { createHash, randomUUID } from "node:crypto";
import { canonical } from "./capabilities.ts";

export const TOOL_WRITE_FEATURE = "tool_write_idempotency";
const RETENTION_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 512;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_FUTURE_MS = 30_000;
type Reply = Record<string, unknown>;

/** Writes with uncertain transport outcomes; delivery completion uses its journal rather than the replay registry. */
export function toolWriteOperation(msg: Record<string, unknown>): "hub_task_propose" | "hub_review" | "hub_delivery_done" | undefined {
  if (msg.t === "delivery_complete") return "hub_delivery_done";
  if (msg.t === "task") {
    // Match the control dispatcher's legacy operation coercion, so accepted writes cannot bypass replay protection.
    let operation: string;
    try { operation = String(msg.op); } catch { return undefined; }
    if (operation === "hub_task_propose" || operation === "hub_review") return operation;
  }
  return undefined;
}

export function newToolRequestId(instanceId: string, now = Date.now()): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(instanceId) || !Number.isSafeInteger(now) || now < 1) throw new Error("tool request identity is unavailable");
  return `v1/${instanceId}/${now}/${randomUUID()}`;
}

function settlingRead(msg: Record<string, unknown>): { read: string; absent: string } {
  const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args as Record<string, unknown> : {};
  const id = typeof args.id === "number" ? args.id : typeof args.id === "string" && /^\s*\d+\s*$/.test(args.id) ? Number(args.id) : undefined;
  const delivery = typeof msg.deliveryId === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(msg.deliveryId) ? msg.deliveryId : "<delivery-id>";
  if (toolWriteOperation(msg) === "hub_delivery_done") return { read: `ahub queue show ${delivery} (person or conductor)`, absent: "completion is absent" };
  if (toolWriteOperation(msg) === "hub_review" && Number.isSafeInteger(id) && id! > 0) return { read: `hub_task_show {id: ${id}}`, absent: "this verdict is absent" };
  return { read: "hub_task_list (then hub_task_show for the matching task)", absent: "the task is absent" };
}
function safeRequestId(requestId: unknown): string | undefined {
  return typeof requestId === "string" && requestId.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(requestId) ? requestId : undefined;
}
export function toolWriteUnknownReply(msg: Record<string, unknown>, requestId?: string, cause?: string): Reply {
  const token = safeRequestId(requestId), settlement = settlingRead(msg);
  const replay = token && toolWriteOperation(msg) !== "hub_delivery_done" ? `, reusing request_id ${JSON.stringify(token)}` : "";
  return { ok: false, outcome: "unknown", ...(token ? { requestId: token } : {}),
    error: `Write outcome unknown${cause ? `: ${cause}` : ". The hub may have applied the write"}. Read ${settlement.read}; call again only if ${settlement.absent}${replay}.` };
}
export function toolWriteRefusedReply(msg: Record<string, unknown>, requestId: unknown, cause: string): Reply {
  const token = safeRequestId(requestId);
  return { ok: false, outcome: "refused", ...(token ? { requestId: token } : {}),
    error: `Write request refused: ${cause}. This attempt did not run. Read ${settlingRead(msg).read} before another write.` };
}

interface Entry { bucket: string; scope: string; payload: string; issuedAt: number; settled: boolean; reply: Promise<Reply> }
interface Request { id: unknown; scope: string; bucket?: string; payload: unknown; current: (reply?: Reply) => boolean }

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
    const refuse = (cause: string) => toolWriteRefusedReply(this.message(request.payload), request.id, cause);
    const unavailable = (cause: string) => toolWriteUnknownReply(this.message(request.payload), typeof request.id === "string" ? request.id : undefined, cause);
    const current = (reply?: Reply) => { try { return request.current(reply === undefined ? undefined : structuredClone(reply)) === true; } catch { return false; } };
    if (!current()) return refuse("current caller authority or privacy is unavailable");
    const observed = this.clock();
    if (!Number.isSafeInteger(observed) || observed < 1) return refuse("the replay clock is unavailable");
    const now = this.watermark = Math.max(this.watermark, observed);
    const parts = typeof request.id === "string" && request.id.length <= 256 ? request.id.split("/") : [];
    const issuedAt = Number(parts[2]);
    if (parts.length !== 4 || parts[0] !== "v1" || parts[1] !== this.instanceId || !/^[1-9][0-9]{0,15}$/.test(parts[2] ?? "")
      || !Number.isSafeInteger(issuedAt) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parts[3] ?? "")) return refuse("the request ID is invalid or belongs to another daemon instance; inspect its original outcome");
    let payload: string, scope: string, bucket: string;
    try {
      if (typeof request.scope !== "string" || request.scope.length > 4096) throw new Error("invalid scope");
      const bucketKey = request.bucket ?? request.scope;
      if (typeof bucketKey !== "string" || bucketKey.length > 4096) throw new Error("invalid bucket");
      scope = createHash("sha256").update(request.scope).digest("hex");
      bucket = createHash("sha256").update(bucketKey).digest("hex");
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
    } catch { return refuse("the request is too large or malformed for replay protection"); }
    // Pending writes never age out: losing their key could apply an unfinished write twice.
    for (const [id, entry] of this.entries) if (entry.settled && now - entry.issuedAt >= this.retentionMs) this.entries.delete(id);
    const existing = this.entries.get(request.id as string);
    if (existing) {
      if (existing.scope !== scope || existing.bucket !== bucket || existing.payload !== payload) return refuse("the request ID was already used by another authority or for different arguments");
      const reply = await existing.reply;
      return current(reply) ? structuredClone(reply) : unavailable("caller authority or privacy changed before replay");
    }
    if (now - issuedAt >= this.retentionMs || issuedAt > now + MAX_FUTURE_MS) return refuse("the request ID is expired or its timestamp is outside the replay window; inspect its original outcome");
    // ponytail: 512 calls per actor/scope per 15 min and 64 KiB per reply; a durable outcome ledger is the upgrade path for higher sustained write volume.
    if ([...this.entries.values()].filter(entry => entry.bucket === bucket).length >= this.maxEntries) return refuse("this actor's replay window is full; inspect its outstanding writes and wait for that window to drain");
    const entry: Entry = { bucket, scope, payload, issuedAt, settled: false, reply: Promise.resolve({}) };
    this.entries.set(request.id as string, entry);
    entry.reply = Promise.resolve().then(async () => {
      if (!current()) return refuse("caller authority or privacy changed before execution");
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
