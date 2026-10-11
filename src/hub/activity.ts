/** Person-only transient ACP activity. Never pass this to the bus, events or memory. */
export type ActivityKind = "delivery" | "message" | "thought" | "tool" | "plan" | "ask" | "answered" | "turn_end" | "private";
export interface Activity { kind: ActivityKind; at: number; turn: number; text: string }
const TEXT_CAP = 4096;
export function activityText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, TEXT_CAP) : "";
}
/** Closed projection, not native JSON serialization: omit rawInput and unknown fields. */
export function updateActivity(u: any): { kind: ActivityKind; text: string } | undefined {
  if (u?.sessionUpdate === "agent_message_chunk" || u?.sessionUpdate === "agent_thought_chunk") {
    if (u.content?.type !== "text" || typeof u.content.text !== "string") return;
    return { kind: u.sessionUpdate === "agent_message_chunk" ? "message" : "thought", text: activityText(u.content.text) };
  }
  if (["tool_call", "tool_call_update"].includes(u?.sessionUpdate)) {
    const fields = [u.toolCallId, u.title, u.kind, u.status].filter(v => typeof v === "string").map(activityText);
    for (const location of Array.isArray(u.locations) ? u.locations.slice(0, 12) : []) {
      if (typeof location?.path === "string") fields.push(activityText(location.path));
    }
    for (const c of Array.isArray(u.content) ? u.content.slice(0, 12) : []) {
      if (c?.type === "diff" && typeof c.path === "string") {
        const lines = (v: unknown) => typeof v === "string" && v ? v.split("\n").length : 0;
        fields.push(`+${lines(c.newText)} -${lines(c.oldText)} ${activityText(c.path)}`);
      } else if (c?.type === "content" && c.content?.type === "text") {
        fields.push(activityText(c.content.text).split("\n").slice(-8).join("\n"));
      } else if (c?.type === "terminal") fields.push("terminal output not reported by this update");
    }
    return { kind: "tool", text: fields.join("  ").slice(0, TEXT_CAP) };
  }
  if (u?.sessionUpdate === "plan" && Array.isArray(u.entries)) return { kind: "plan", text: u.entries.slice(0, 32).map((e: any) => [e?.status, e?.priority, e?.content].filter(v => typeof v === "string").map(activityText).join(" ")).join("\n").slice(0, TEXT_CAP) };
}
export class ActivityRing {
  private rows: { item: Activity; bytes: number }[] = [];
  private bytes = 0;
  private listeners = new Set<(item: Activity) => void>();
  // ponytail: 500 items / 256 KiB, memory only; add an explicit retention policy before disk history.
  constructor(private readonly maxItems = 500, private readonly maxBytes = 256 * 1024) {}
  append(item: Activity): void {
    const bounded = { kind: item.kind, at: item.at, turn: item.turn, text: activityText(item.text) };
    const bytes = Buffer.byteLength(JSON.stringify(bounded));
    if (bytes > this.maxBytes) return;
    this.rows.push({ item: bounded, bytes }); this.bytes += bytes;
    while (this.rows.length > this.maxItems || this.bytes > this.maxBytes) this.bytes -= this.rows.shift()!.bytes;
    for (const listener of this.listeners) { try { listener({ ...bounded }); } catch { /* a closed observer never stops the peer */ } }
  }
  snapshot(): Activity[] { return this.rows.map(row => ({ ...row.item })); }
  get byteLength(): number { return this.bytes; }
  subscribe(listener: (item: Activity) => void): () => void {
    // Replay and subscribe synchronously: no event can fall in between.
    for (const { item } of this.rows) listener({ ...item });
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
