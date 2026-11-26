// Human output for `ahub room` (#1724, from #1654 item 20). Pure: validated rows in, spans out, no I/O. `--json` is the caller's branch and prints the same rows.
import { roomReceiptReasonText } from "../rooms/application.ts";
import { moment } from "./sdlc-output.ts";
import { Report, type MarkerName, type Span } from "./console-state.ts";

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const age = (value: unknown) => typeof value === "number" ? `${value}ms` : "unknown";
const peerMarker = (state: unknown): MarkerName => state === "idle" ? "ok" : state === "busy" ? "active" : state === "paused" ? "pending" : state === "offline" ? "absent" : "unknown";
const deliveryMarker = (state: unknown): MarkerName => /^completed|^disposed/.test(String(state)) ? "ok" : state === "failed_safe" || state === "needs_review" ? "warn" : "pending";

/** `ahub room list` and `ahub room status`: one section per room; status adds the link, the outbox, refusals, remote peers and deliveries. */
export function renderRooms(rows: unknown, status: boolean, columns?: number, ascii = false): Span[][] {
  const rooms = list(rows);
  const out = new Report(columns, ascii).titled("ahub", status ? "Room status" : "Rooms", String(rooms.length));
  if (!rooms.length) out.note("no rooms");
  for (const row of rooms) {
    out.section(String(row.name), String(row.state)).kv([["room", row.room], ["epoch", row.epoch], ["owner", row.owner], ["member", row.member]]);
    if (status) {
      const health = row.health;
      if (row.state === "online" && (row.linkCause === null || row.linkCause === undefined)) out.bullet("ok", "link online");
      else out.bullet("warn", `link cause ${row.linkCause ?? "unknown"}`).note(row.linkNextStep ?? "Check broker availability, then read ahub room status again.");
      out.bullet("unknown", `outbox ${health?.outboxDepth ?? "unknown"}; oldest ${age(health?.oldestOutboxAgeMs)}; last receipt ${age(health?.lastReceiptAgeMs)}`);
      out.bullet(health?.refused ? "warn" : "unknown", `refused: ${health?.refused ? Object.entries(health.refused).map(([reason, count]) => `${reason} ${count}`).join(", ") : "unknown"}`);
    }
    for (const peer of list(row.remotePeers)) {
      out.bullet(peerMarker(peer.presence ?? peer.state), `peer ${peer.id}: ${peer.presence ?? peer.state}${peer.liveness === "untracked" ? "; liveness not tracked (broker without ephemeral); upgrade the broker to track liveness" : ""}`);
    }
    for (const delivery of list(row.deliveries)) {
      if (!("id" in delivery)) out.bullet(delivery.needsReview > 0 ? "warn" : "pending", `inbound: pending ${delivery.pending}, needs_review ${delivery.needsReview}${delivery.truncated ? "; truncated" : ""}`);
      else out.bullet(deliveryMarker(delivery.state), `${delivery.direction} ${delivery.id}: ${delivery.state}; application ${delivery.application}; peer ${delivery.peer}${delivery.disposition ? `; person disposition ${delivery.disposition}` : ""}${delivery.lateReceipt ? `; late receipt evidence ${delivery.lateReceipt}` : ""}${delivery.refusalReason ? `; refusal ${roomReceiptReasonText(delivery.refusalReason)}` : ""}${delivery.holdReason ? "; reason epoch rotated; inspect ahub queue show before resolving" : ""}`);
    }
  }
  return out.lines();
}

/** `ahub room inbox [<name>]`: the person inbox metadata, never a body. */
export function renderRoomInbox(rows: unknown, now = Date.now(), columns?: number, ascii = false): Span[][] {
  const items = list(rows);
  const out = new Report(columns, ascii).titled("ahub", "Room inbox", String(items.length)).section("Messages", String(items.length));
  if (!items.length) out.note("the inbox is empty");
  for (const row of items) {
    out.bullet(row.state === "unread" ? "pending" : "ok", `${row.id} ${row.name} ${row.from} ${row.state}; received ${moment(row.receivedAt, now)}; expires ${moment(row.expiresAt, now)}; ${row.bytes} bytes`);
    out.note(`sender ${row.sender}`);
  }
  return out.lines();
}

/** `ahub room inbox done|discard|show`: the one line that says what the item became. */
export function renderRoomInboxResult(item: { id: string; state: string }, bodyUnavailable: boolean, columns?: number, ascii = false): Span[][] {
  return new Report(columns, ascii).titled("ahub", "Room inbox", item.state).section("Result").bullet(bodyUnavailable ? "warn" : "ok", `Room inbox ${item.id}: ${item.state}${bodyUnavailable ? " (body unavailable)" : ""}`).lines();
}

/** The confirmation preview of a membership change: both fingerprints to compare out of band, then the deliveries an epoch change leaves behind. */
export function renderRoomPreview(action: string, preview: { owner: string; member: string; outstanding?: readonly string[] }, columns?: number, ascii = false): Span[][] {
  const out = new Report(columns, ascii).titled("ahub", `Room ${action}`, "preview");
  out.section("Fingerprints").kv([["Owner fingerprint", preview.owner], ["Member fingerprint", preview.member]]);
  if (preview.outstanding !== undefined) {
    out.section("Outstanding", String(preview.outstanding.length)).note(`Outstanding deliveries on the old epoch (${preview.outstanding.length})`);
    for (const id of preview.outstanding) out.note(id, "value");
  }
  return out.lines();
}

/** What a confirmed membership change did: the room it named and, for an artifact, the line that introduces it (the artifact itself is printed raw so it copies exactly). */
export function renderRoomResult(action: string, result: { name?: string; disposed?: boolean; artifact?: boolean }, columns?: number, ascii = false): Span[][] {
  const out = new Report(columns, ascii).titled("ahub", `Room ${action}`, "done").section("Result");
  if (result.name !== undefined) out.bullet("ok", `Room: ${result.name}`);
  if (result.artifact) out.bullet("ok", "Room artifact (share out of band):");
  else out.bullet("ok", result.disposed ? "room resolve: disposed" : `room ${action}: complete`);
  return out.lines();
}
