import { decodeBase64url } from "../rooms/crypto.ts";
import { roomReceiptReasonText, type RoomReceiptReason } from "../rooms/application.ts";
import { frame, type Envelope } from "../hub/envelope.ts";
import { terminalText } from "./console-state.ts";
import type { RoomPersonInboxMeta, RoomPersonInboxItem } from "../rooms/store.ts";
/** Membership mutations and inbox forms are person-only; main.ts refuses agent/live-test calls before importing this module. */
export const ROOM_USAGE = "usage: ahub room create <name> --broker <url> [--label <id>] | invite <name> [--accept <request>] | join <token> [--name <name>] [--label <id>] | join <name> --roster <signed-roster> | leave <name> | revoke <name> <fingerprint> | expose <name> [<peer>...] | resolve <name> --frame <digest> --action accept|discard (membership mutations and resolve require TTY y/N or --confirm <member-fingerprint-prefix>, 16..64 lowercase hex) | list [--json] | status [<name>] [--json] | inbox [<name>] [--json] | inbox show|done|discard <id>";

type RoomAction = "create" | "invite" | "join" | "leave" | "revoke" | "expose" | "resolve";
export type RoomCliCommand =
  | { op: "list" | "status"; input: Record<string, unknown>; json: boolean }
  | { op: "inbox"; action: "list"; input: { name?: string }; json: boolean }
  | { op: "inbox"; action: "show" | "done" | "discard"; input: { id: string } }
  | { op: "mutation"; action: RoomAction; input: Record<string, unknown>; confirm?: string };
export type RoomRequest = (message: Record<string, unknown>) => Promise<any>;
/** Fixed host/test I/O only, never a callback selected by project configuration. */
export interface RoomConfirmationIO { isTTY(): boolean; answer(prompt: string): Promise<string> }

export class RoomCliError extends Error {
  constructor(readonly code: "usage" | "refused" | "invalid_reply" | "inbox_list_limit" | "confirmation_required" | "not_confirmed" | "confirmation_mismatch") {
    const message = { refused: "operation refused", invalid_reply: "invalid control reply", inbox_list_limit: "inbox list exceeds the limit; choose a room name", confirmation_required: "confirmation required; use a TTY or --confirm with the member fingerprint prefix", not_confirmed: "not confirmed; nothing executed", confirmation_mismatch: "confirmation does not match the member fingerprint; nothing executed" };
    super(code === "usage" ? ROOM_USAGE : `room: ${message[code]}`);
    this.name = "RoomCliError";
  }
}
function fail(code: ConstructorParameters<typeof RoomCliError>[0] = "usage"): never { throw new RoomCliError(code); }
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const FP = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
function id(value: string | undefined): string { if (!value || !ID.test(value)) fail(); return value; }
function artifact(value: string | undefined): string {
  if (!value || value.length > 699_051 || !B64.test(value) || value.length % 4 === 1) fail();
  return value;
}
function flags(args: readonly string[], allowed: readonly string[], dashValues: readonly string[] = []): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !allowed.includes(key) || !value || value.startsWith("--") && !dashValues.includes(key) || result.has(key)) fail();
    result.set(key, value);
  }
  return result;
}

/** The parser carries no authorization, filesystem or network effects. The daemon validates every value again. */
function parseRoomInput(args: readonly string[]): RoomCliCommand {
  const [action, operand, ...rest] = args;
  if (action === "list" || action === "status") {
    const json = args.includes("--json"), values = args.slice(1).filter(value => value !== "--json");
    if (args.filter(value => value === "--json").length > 1 || values.length > (action === "status" ? 1 : 0)) fail();
    return { op: action, input: values.length ? { name: id(values[0]) } : {}, json };
  }
  if (args.includes("--json")) fail(); // Invitation secrets are never a JSON data format.
  if (action === "resolve") {
    const name = id(operand), options = flags(rest, ["--frame", "--action"], ["--frame"]), frame = options.get("--frame"), choice = options.get("--action");
    if (!frame || frame.length !== 43 || (choice !== "accept" && choice !== "discard")) fail();
    try { decodeBase64url(frame, 32); } catch { fail(); }
    return { op: "mutation", action, input: { name, frame, action: choice } };
  }
  if (action === "create") {
    const name = id(operand), options = flags(rest, ["--broker", "--label"]), broker = options.get("--broker");
    if (!broker || broker.length > 2048) fail();
    return { op: "mutation", action, input: { name, broker, ...(options.has("--label") ? { label: id(options.get("--label")) } : {}) } };
  }
  if (action === "invite") {
    const name = id(operand), options = flags(rest, ["--accept"]);
    return { op: "mutation", action, input: { name, ...(options.has("--accept") ? { request: artifact(options.get("--accept")) } : {}) } };
  }
  if (action === "join") {
    const options = flags(rest, ["--roster", "--name", "--label"]);
    if (options.has("--roster")) {
      if (options.size !== 1) fail();
      return { op: "mutation", action, input: { name: id(operand), roster: artifact(options.get("--roster")) } };
    }
    return { op: "mutation", action, input: { token: artifact(operand), ...(options.has("--name") ? { name: id(options.get("--name")) } : {}), ...(options.has("--label") ? { label: id(options.get("--label")) } : {}) } };
  }
  if (action === "leave") {
    if (rest.length) fail();
    return { op: "mutation", action, input: { name: id(operand) } };
  }
  if (action === "revoke") {
    if (rest.length !== 1 || !FP.test(rest[0]!)) fail();
    return { op: "mutation", action, input: { name: id(operand), member: rest[0] } };
  }
  if (action === "expose") {
    const peers = rest.map(value => id(value));
    if (peers.length > 64 || new Set(peers).size !== peers.length) fail();
    return { op: "mutation", action, input: { name: id(operand), peers } };
  }
  return fail();
}

export function parseRoomCommand(args: readonly string[]): RoomCliCommand {
  if (args[0] === "inbox") {
    const values = args.slice(1).filter(value => value !== "--json"), json = args.includes("--json");
    if (args.filter(value => value === "--json").length > 1) fail();
    if (values.length === 2) {
      const [action, value] = values;
      if (json || (action !== "show" && action !== "done" && action !== "discard") || !value || value.length !== 36 || !UUID.test(value)) fail();
      return { op: "inbox", action, input: { id: value } };
    }
    if (values.length > 1) fail();
    return { op: "inbox", action: "list", input: values.length ? { name: id(values[0]) } : {}, json };
  }
  if (args[0] === "list" || args[0] === "status") return parseRoomInput(args);
  let confirm: string | undefined;
  const input: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--confirm") { input.push(args[i]!); continue; }
    const value = args[++i];
    if (confirm !== undefined || !value || !/^[0-9a-f]{16,64}$/.test(value)) fail();
    confirm = value;
  }
  const command = parseRoomInput(input);
  if (command.op !== "mutation") return fail();
  return { ...command, ...(confirm !== undefined ? { confirm } : {}) };
}

const confirmationIO: RoomConfirmationIO = {
  isTTY: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  answer: async prompt => {
    const { createInterface } = await import("node:readline/promises");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController(), abort = () => controller.abort();
    terminal.once("close", abort); terminal.once("SIGINT", abort);
    try { return await terminal.question(prompt, { signal: controller.signal }); }
    finally { terminal.off("close", abort); terminal.off("SIGINT", abort); terminal.close(); }
  },
};
async function confirmMember(member: string, explicit: string | undefined, io: RoomConfirmationIO): Promise<string> {
  if (explicit !== undefined) {
    if (!member.startsWith(explicit)) fail("confirmation_mismatch");
    return explicit;
  }
  if (!io.isTTY()) fail("confirmation_required");
  let answer: string;
  try { answer = await io.answer("Compare both fingerprints out of band. Proceed with this member? [y/N] "); }
  catch { return fail("not_confirmed"); }
  if (answer.trim().toLowerCase() !== "y") fail("not_confirmed");
  return member;
}

type DeliveryState = "pending" | "dispatching" | "accepted" | "completed" | "completed (admitted)" | "completed (inbox)" | "failed_safe" | "needs_review" | "disposed" | "disposed (accept, by person)" | "disposed (discard, by person)";
interface DeliveryRow { direction: "inbound" | "outbound"; id: string; application: string; peer: string; state: DeliveryState; disposition?: "accept" | "completed" | "retry" | "discard"; lateReceipt?: "completed (admitted)" | "completed (inbox)" | "failed_safe"; refusalReason?: RoomReceiptReason }
interface DeliverySummary { direction: "inbound"; pending: number; needsReview: number; truncated: boolean }
interface RemotePeerRow { id: string; state: "idle" | "busy" | "paused" | "offline" }
interface RoomRow { name: string; room: string; owner: string; member: string; epoch: string; state: string; deliveries?: (DeliveryRow | DeliverySummary)[]; remotePeers?: RemotePeerRow[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REMOTE_ID = /^[a-z][a-z0-9-]{0,31}@[a-z][a-z0-9-]{0,31}$/;
const REFUSAL_REASONS: readonly RoomReceiptReason[] = ["admitted", "not_exposed", "boundary_refused", "invalid_message", "rate_limited", "hop", "person_inbox_unsupported", "inbox_admitted", "inbox_full", "inbox_oversize", "inbox_expired", "inbox_age_unavailable"];
const DELIVERY_STATES: readonly string[] = ["pending", "dispatching", "accepted", "completed", "completed (admitted)", "completed (inbox)", "failed_safe", "needs_review", "disposed", "disposed (accept, by person)", "disposed (discard, by person)"];
function digestId(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43) return false;
  try { decodeBase64url(value, 32); return true; } catch { return false; }
}
function deliveryRows(value: unknown): (DeliveryRow | DeliverySummary)[] {
  if (!Array.isArray(value) || value.length > 401) return fail("invalid_reply");
  return value.map<DeliveryRow | DeliverySummary>(item => {
    const row = record(item);
    if (row.direction !== "inbound" && row.direction !== "outbound") return fail("invalid_reply");
    if (row.id === undefined) {
      if (row.direction !== "inbound" || typeof row.pending !== "number" || !Number.isSafeInteger(row.pending) || row.pending < 0 || row.pending > 10000
        || typeof row.needsReview !== "number" || !Number.isSafeInteger(row.needsReview) || row.needsReview < 0 || row.needsReview > 10000
        || typeof row.truncated !== "boolean") return fail("invalid_reply");
      return { direction: "inbound", pending: row.pending, needsReview: row.needsReview, truncated: row.truncated };
    }
    if (typeof row.id !== "string" || !(UUID.test(row.id) || digestId(row.id)) || typeof row.application !== "string" || !UUID.test(row.application)
      || typeof row.peer !== "string" || !(ID.test(row.peer) || REMOTE_ID.test(row.peer))
      || typeof row.state !== "string" || !DELIVERY_STATES.includes(row.state)) return fail("invalid_reply");
    if (row.disposition !== undefined && (typeof row.disposition !== "string" || (row.direction === "inbound" ? !["accept", "discard"].includes(row.disposition) : !["completed", "retry", "discard"].includes(row.disposition)))) return fail("invalid_reply");
    if (row.lateReceipt !== undefined && row.lateReceipt !== "completed (admitted)" && row.lateReceipt !== "completed (inbox)" && row.lateReceipt !== "failed_safe") return fail("invalid_reply");
    if (row.refusalReason !== undefined && (typeof row.refusalReason !== "string" || !REFUSAL_REASONS.includes(row.refusalReason as RoomReceiptReason))) return fail("invalid_reply");
    if (row.direction === "outbound" && row.state.startsWith("disposed")) return fail("invalid_reply");
    const state = row.state === "completed" ? row.refusalReason === "inbox_admitted" ? "completed (inbox)" : "completed (admitted)" : row.state === "disposed" && row.disposition !== undefined ? `disposed (${row.disposition}, by person)` as DeliveryState : row.state as DeliveryState;
    return { direction: row.direction, id: row.id, application: row.application, peer: row.peer, state,
      ...(row.disposition !== undefined ? { disposition: row.disposition as DeliveryRow["disposition"] } : {}), ...(row.lateReceipt !== undefined ? { lateReceipt: row.lateReceipt as DeliveryRow["lateReceipt"] } : {}), ...(row.refusalReason !== undefined ? { refusalReason: row.refusalReason as RoomReceiptReason } : {}) };
  });
}
function remotePeerRows(value: unknown): RemotePeerRow[] {
  if (!Array.isArray(value) || value.length > 4096) return fail("invalid_reply");
  return value.map<RemotePeerRow>(item => {
    const row = record(item);
    if (typeof row.id !== "string" || !REMOTE_ID.test(row.id) || typeof row.state !== "string" || !["idle", "busy", "paused", "offline"].includes(row.state)) return fail("invalid_reply");
    return { id: row.id, state: row.state as RemotePeerRow["state"] };
  });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_reply");
  return value as Record<string, unknown>;
}
function success(value: unknown): Record<string, unknown> {
  const row = record(value);
  if (row.ok !== true) fail("refused");
  return row;
}
function roomRows(value: unknown): RoomRow[] {
  if (!Array.isArray(value) || value.length > 64) return fail("invalid_reply");
  return value.map(item => {
    const row = record(item);
    if (typeof row.name !== "string" || !ID.test(row.name) || typeof row.room !== "string" || row.room.length !== 43 || !B64.test(row.room)
      || typeof row.owner !== "string" || !FP.test(row.owner) || typeof row.member !== "string" || !FP.test(row.member)
      || typeof row.epoch !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(row.epoch)
      || typeof row.state !== "string" || !/^[a-z][a-z_-]{0,31}$/.test(row.state)) return fail("invalid_reply");
    // Ignore all other fields, even from a newer daemon: read output never grows into room bodies or secrets.
    return { name: row.name, room: row.room, owner: row.owner, member: row.member, epoch: row.epoch, state: row.state,
      ...(row.deliveries !== undefined ? { deliveries: deliveryRows(row.deliveries) } : {}), ...(row.remotePeers !== undefined ? { remotePeers: remotePeerRows(row.remotePeers) } : {}) };
  });
}

const INBOX_LIST_LIMIT = 1100, INBOX_BODY_BYTES = 65536;
function inboxMeta(value: unknown): RoomPersonInboxMeta {
  const row = record(value);
  if (typeof row.id !== "string" || row.id.length !== 36 || !UUID.test(row.id)
    || typeof row.name !== "string" || row.name.length > 32 || ID.exec(row.name)?.[0] !== row.name
    || !digestId(row.room) || typeof row.sender !== "string" || row.sender.length !== 64 || !FP.test(row.sender)
    || typeof row.from !== "string" || row.from.length > 65 || REMOTE_ID.exec(row.from)?.[0] !== row.from
    || typeof row.receivedAt !== "number" || !Number.isSafeInteger(row.receivedAt) || row.receivedAt < 0
    || typeof row.expiresAt !== "number" || !Number.isSafeInteger(row.expiresAt) || row.expiresAt < row.receivedAt
    || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > INBOX_BODY_BYTES
    || (row.state !== "unread" && row.state !== "done" && row.state !== "discarded" && row.state !== "expired")) fail("invalid_reply");
  // Deliberately never read body, title, debug or other fields on metadata paths.
  return { id: row.id, name: row.name, room: row.room, sender: row.sender, from: row.from, receivedAt: row.receivedAt,
    expiresAt: row.expiresAt, bytes: row.bytes, state: row.state };
}
function inboxItem(value: unknown, expectedId: string): RoomPersonInboxItem {
  const meta = inboxMeta(value);
  if (meta.id !== expectedId) fail("invalid_reply");
  if (meta.state !== "unread") return meta; // Purged stubs never render an injected body.
  const body = record(value).body;
  if (typeof body !== "string" || body.length > INBOX_BODY_BYTES) fail("invalid_reply");
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > INBOX_BODY_BYTES || bytes !== meta.bytes) fail("invalid_reply");
  return { ...meta, body };
}

async function runInboxCommand(options: Extract<RoomCliCommand, { op: "inbox" }>, request: RoomRequest): Promise<void> {
  if (options.action === "list") {
    const reply = record(await request({ t: "room", op: "inbox_list", input: options.input }));
    if (reply.ok !== true && reply.code === "inbox_list_limit") fail("inbox_list_limit");
    const value = success(reply).inbox;
    if (!Array.isArray(value)) fail("invalid_reply");
    if (value.length > INBOX_LIST_LIMIT) fail("inbox_list_limit");
    const rows = value.map(inboxMeta);
    if (new Set(rows.map(row => row.id)).size !== rows.length || options.input.name !== undefined && rows.some(row => row.name !== options.input.name)) fail("invalid_reply");
    if (options.json) return console.log(JSON.stringify(rows));
    console.log(`Room inbox (${rows.length})`);
    for (const row of rows) console.log(`${row.id} ${row.name} ${row.from} ${row.state}; received ${row.receivedAt}; expires ${row.expiresAt}; ${row.bytes} bytes\n  sender ${row.sender}`);
    return;
  }
  const reply = success(await request({ t: "room", op: `inbox_${options.action}`, input: options.input }));
  if (options.action !== "show") {
    const item = inboxMeta(reply.item);
    if (item.id !== options.input.id || item.state === "unread") fail("invalid_reply");
    console.log(`Room inbox ${item.id}: ${item.state}`);
    return;
  }
  const item = inboxItem(reply.item, options.input.id);
  if (item.body === undefined) { console.log(`Room inbox ${item.id}: ${item.state} (body unavailable)`); return; }
  const env: Envelope = { id: item.id, trace: item.id, hop: 0, from: item.from, to: ["user"], kind: "chat", priority: "status", ts: item.receivedAt, body: terminalText(item.body) };
  console.log(frame(env));
}

/** Uses one already authenticated control connection so an ephemeral preview ticket cannot cross callers. */
export async function runRoomCommand(args: readonly string[], request: RoomRequest, io: RoomConfirmationIO = confirmationIO): Promise<void> {
  const command = parseRoomCommand(args);
  if (command.op === "inbox") return runInboxCommand(command, request);
  if (command.op !== "mutation") {
    const result = success(await request({ t: "room", op: command.op, input: command.input })), rows = roomRows(result.rooms);
    if (args.includes("--json")) return console.log(JSON.stringify(rows));
    console.log(`Rooms (${rows.length})`);
    for (const row of rows) {
      console.log(`${row.name} ${row.room} epoch ${row.epoch} ${row.state}\n  owner ${row.owner}\n  member ${row.member}`);
      for (const peer of row.remotePeers ?? []) console.log(`  peer ${peer.id}: ${peer.state}`);
      for (const delivery of row.deliveries ?? []) {
        if (!("id" in delivery)) console.log(`  inbound: pending ${delivery.pending}, needs_review ${delivery.needsReview}${delivery.truncated ? "; truncated" : ""}`);
        else console.log(`  ${delivery.direction} ${delivery.id}: ${delivery.state}; application ${delivery.application}; peer ${delivery.peer}${delivery.disposition ? `; person disposition ${delivery.disposition}` : ""}${delivery.lateReceipt ? `; late receipt evidence ${delivery.lateReceipt}` : ""}${delivery.refusalReason ? `; refusal ${roomReceiptReasonText(delivery.refusalReason)}` : ""}`);
      }
    }
    return;
  }
  const preview = success(await request({ t: "room", op: "preview", action: command.action, input: command.input }));
  if (typeof preview.owner !== "string" || !FP.test(preview.owner) || typeof preview.member !== "string" || !FP.test(preview.member)
    || typeof preview.ticket !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(preview.ticket)) fail("invalid_reply");
  console.log(`Owner fingerprint: ${preview.owner}`);
  console.log(`Member fingerprint: ${preview.member}`);
  const confirm = await confirmMember(preview.member, command.confirm, io);
  const result = success(await request({ t: "room", op: "execute", ticket: preview.ticket, confirm }));
  if (result.name !== undefined) {
    if (typeof result.name !== "string" || !ID.test(result.name)) fail("invalid_reply");
    console.log(`Room: ${result.name}`);
  }
  if (result.artifact !== undefined) {
    if (typeof result.artifact !== "string") fail("invalid_reply");
    let encoded: string;
    try { encoded = artifact(result.artifact); } catch { return fail("invalid_reply"); }
    console.log("Room artifact (share out of band):");
    console.log(encoded);
  } else console.log(command.action === "resolve" && result.kind === "disposed" ? "room resolve: disposed" : `room ${command.action}: complete`);
}

/** Never echo tokens, broker URLs, daemon payloads or native diagnostics on refusal. */
export function roomCommandError(error: unknown): string {
  return error instanceof RoomCliError ? error.message : "room: operation failed";
}
