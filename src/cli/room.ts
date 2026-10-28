/** Room mutations are person-only; main.ts refuses agent and live-test calls before importing this module. */
export const ROOM_USAGE = "usage: ahub room create <name> --broker <url> [--label <id>] | invite <name> [--accept <request>] | join <token> [--name <name>] [--label <id>] | join <name> --roster <signed-roster> | leave <name> | revoke <name> <fingerprint> | expose <name> [<peer>...] | list [--json] | status [<name>] [--json]";

type RoomAction = "create" | "invite" | "join" | "leave" | "revoke" | "expose";
export type RoomCliCommand =
  | { op: "list" | "status"; input: Record<string, unknown>; json: boolean }
  | { op: "mutation"; action: RoomAction; input: Record<string, unknown> };
export type RoomRequest = (message: Record<string, unknown>) => Promise<any>;

export class RoomCliError extends Error {
  constructor(readonly code: "usage" | "refused" | "invalid_reply") {
    super(code === "usage" ? ROOM_USAGE : `room: ${code === "refused" ? "operation refused" : "invalid control reply"}`);
    this.name = "RoomCliError";
  }
}
const fail = (code: "usage" | "refused" | "invalid_reply" = "usage"): never => { throw new RoomCliError(code); };
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const FP = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
function id(value: string | undefined): string { if (!value || !ID.test(value)) fail(); return value; }
function artifact(value: string | undefined): string {
  if (!value || value.length > 699_051 || !B64.test(value) || value.length % 4 === 1) fail();
  return value;
}
function flags(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !allowed.includes(key) || !value || value.startsWith("--") || result.has(key)) fail();
    result.set(key, value);
  }
  return result;
}

/** The parser carries no authorization, filesystem or network effects. The daemon validates every value again. */
export function parseRoomCommand(args: readonly string[]): RoomCliCommand {
  const [action, operand, ...rest] = args;
  if (action === "list" || action === "status") {
    const json = args.includes("--json"), values = args.slice(1).filter(value => value !== "--json");
    if (args.filter(value => value === "--json").length > 1 || values.length > (action === "status" ? 1 : 0)) fail();
    return { op: action, input: values.length ? { name: id(values[0]) } : {}, json };
  }
  if (args.includes("--json")) fail(); // Invitation secrets are never a JSON data format.
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

interface RoomRow { name: string; room: string; owner: string; member: string; epoch: string; state: string }
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
    return { name: row.name, room: row.room, owner: row.owner, member: row.member, epoch: row.epoch, state: row.state };
  });
}

/** Uses one already authenticated control connection so an ephemeral preview ticket cannot cross callers. */
export async function runRoomCommand(args: readonly string[], request: RoomRequest): Promise<void> {
  const command = parseRoomCommand(args);
  if (command.op !== "mutation") {
    const result = success(await request({ t: "room", op: command.op, input: command.input })), rows = roomRows(result.rooms);
    if (command.json) return console.log(JSON.stringify(rows));
    console.log(`Rooms (${rows.length})`);
    for (const row of rows) console.log(`${row.name} ${row.room} epoch ${row.epoch} ${row.state}\n  owner ${row.owner}\n  member ${row.member}`);
    return;
  }
  const preview = success(await request({ t: "room", op: "preview", action: command.action, input: command.input }));
  if (typeof preview.owner !== "string" || !FP.test(preview.owner) || typeof preview.member !== "string" || !FP.test(preview.member)
    || typeof preview.ticket !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(preview.ticket)) fail("invalid_reply");
  console.log(`Owner fingerprint: ${preview.owner}`);
  console.log(`Member fingerprint: ${preview.member}`);
  const result = success(await request({ t: "room", op: "execute", ticket: preview.ticket }));
  if (result.artifact !== undefined) {
    if (typeof result.artifact !== "string") fail("invalid_reply");
    let encoded: string;
    try { encoded = artifact(result.artifact); } catch { return fail("invalid_reply"); }
    console.log("Room artifact (share out of band):");
    console.log(encoded);
  } else console.log(`room ${command.action}: complete`);
}

/** Never echo tokens, broker URLs, daemon payloads or native diagnostics on refusal. */
export function roomCommandError(error: unknown): string {
  return error instanceof RoomCliError ? error.message : "room: operation failed";
}
