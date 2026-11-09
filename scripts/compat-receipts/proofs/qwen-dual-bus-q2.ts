import { closeSync, constants, fstatSync, openSync, readSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../../src/hub/bus.ts";
import { newEnvelope } from "../../../src/hub/envelope.ts";
import { QwenDualPeer, type QwenDualOptions } from "../../../src/adapters/qwen-dual.ts";

/** Manual proof only. Importing this module starts no native process or proof. */
export interface Q2Request {
  marker: "first" | "second" | "background" | "unknown";
  responseFormat: "absent" | "text" | "json" | "other";
  schemaHasTitle: boolean;
  messageCount: number;
  userMessages: number;
}
export interface Q2NativePorts {
  kind: "synthetic-control" | "native-pty";
  /** The controller owns the PTY/group, fixed environment, artifact and stop, including aborted starts. */
  start(launch: NonNullable<QwenDualPeer["launch"]>, signal: AbortSignal): Promise<void>;
  /** Resolves only after the provider's first response is held after an observable stream chunk. */
  firstHeld(signal: AbortSignal): Promise<void>;
  releaseFirst(): void;
  requests(): readonly Q2Request[];
  stop(): Promise<{ ownedStopConfirmed: boolean }>;
}
export interface Q2Options {
  cwd: string;
  stateDir: string;
  command: readonly string[];
  version: string;
  bounds: { bytes: number; records: number; timeoutMs: number };
  /** Synthetic controls may bind host process observations; native runs use the actual readers. */
  host?: Pick<QwenDualOptions, "table" | "signature" | "pollMs" | "ownerMs">;
}
type RecordValue = Record<string, any>;
class Checkpoint extends Error { constructor(readonly checkpoint: string) { super(checkpoint); } }
const FIRST = "Q2_FIRST", SECOND = "Q2_SECOND";
const requireProof = (value: unknown, checkpoint: string): void => { if (!value) throw new Checkpoint(checkpoint); };

function records(file: string, bounds: Q2Options["bounds"]): { rows: RecordValue[]; bytes: number } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    requireProof(info.isFile() && info.size <= bounds.bytes, "record-file-bound");
    const buffer = Buffer.alloc(info.size);
    let got = 0;
    while (got < buffer.length) {
      const next = readSync(fd, buffer, got, buffer.length - got, got);
      if (!next) break;
      got += next;
    }
    const complete = buffer.subarray(0, got).lastIndexOf(10) + 1;
    const lines = buffer.subarray(0, complete).toString("utf8").split("\n").filter(Boolean);
    requireProof(lines.length <= bounds.records, "record-count-bound");
    const rows = lines.map(line => { try { return JSON.parse(line); } catch { throw new Checkpoint("record-json"); } });
    requireProof(rows.every(row => row && typeof row === "object" && !Array.isArray(row)), "record-shape");
    return { rows, bytes: complete };
  } finally { closeSync(fd); }
}
function text(event: RecordValue): string {
  const content = event.message?.content;
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(row => row?.type === "text" && typeof row.text === "string").map(row => row.text).join("") : "";
}
function chronology(rows: RecordValue[]) {
  const users: { index: number; text: string }[] = [];
  const firstStops: number[] = [], secondStops: number[] = [];
  let assistant: { first: boolean; second: boolean; tool: boolean } | undefined;
  for (const [index, event] of rows.entries()) {
    if (event.type === "user") users.push({ index, text: text(event) });
    if (event.type === "assistant") {
      const body = text(event), first = body.includes(`${FIRST}_DONE`), second = body.includes(`${SECOND}_DONE`);
      requireProof(!(first && second), "merged-final-assistant");
      assistant = { first, second, tool: event.message?.stop_reason === "tool_use"
        || Array.isArray(event.message?.content) && event.message.content.some((block: RecordValue) => block?.type === "tool_use") };
    }
    if (event.type === "stream_event" && event.event?.type === "message_stop") {
      if (assistant && !assistant.tool) {
        if (assistant.first) firstStops.push(index);
        if (assistant.second) secondStops.push(index);
      }
      assistant = undefined;
    }
  }
  return { users, firstStops, secondStops };
}

/** Exercises the real Bus and driver. Caller-owned native ports supply isolation and physical artifact proof. */
export async function runQwenDualBusQ2(options: Q2Options, ports: Q2NativePorts) {
  for (const value of Object.values(options.bounds)) requireProof(Number.isSafeInteger(value) && value > 0, "input-bound");
  requireProof(ports.kind !== "native-pty" || options.host === undefined, "native-host-override");
  const bus = new Bus({ batchMs: 0 }), controller = new AbortController();
  const deadline = Date.now() + options.bounds.timeoutMs;
  const waiters = new Set<() => void>(), watchers: FSWatcher[] = [];
  let fault: string | undefined, checkpoint = "prepare", ownedStopConfirmed = false;
  const barriers: string[] = [];
  let heldSubmitCount = 0, heldQueued = false, secondBusDelivered = false, outcome = { userCount: 0, firstStop: -1, secondUser: -1, secondStop: -1 };
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const peer = new QwenDualPeer("qwen", { cwd: options.cwd, stateDir: options.stateDir, cmd: options.command,
    mcpServers: [], ...options.host,
    autoApprove: () => false,
    onPermission: async () => { fault = "unexpected-permission"; wake(); return undefined; } });
  const input = join(options.stateDir, "qwen-dual/input.jsonl"), events = join(options.stateDir, "qwen-dual/events.jsonl");
  const untap = bus.tap(wake);
  const bounded = async <T>(work: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Checkpoint(label)); }, Math.max(0, deadline - Date.now()));
    })]); } finally { if (timer) clearTimeout(timer); }
  };
  const observe = (predicate: () => boolean, label: string): Promise<void> => bounded(new Promise<void>((resolve, reject) => {
    const check = () => {
      try {
        if (fault) throw new Checkpoint(fault);
        if (!predicate()) return;
        waiters.delete(check); resolve();
      } catch (error) { waiters.delete(check); reject(error); }
    };
    waiters.add(check); check();
  }), label);
  try {
    await peer.start(); bus.add(peer);
    // The driver's atomic state-file save also wakes offset observers after a poll that leaves it busy.
    const watcher = watch(join(options.stateDir, "qwen-dual"), wake);
    watcher.on("error", () => { fault = "file-watch"; wake(); }); watchers.push(watcher);
    checkpoint = "native-start";
    requireProof(peer.launch, "launch-missing");
    await bounded(ports.start(peer.launch!, controller.signal), checkpoint);
    await observe(() => {
      const session = records(events, options.bounds).rows.find(row => row.type === "system" && row.subtype === "session_start");
      if (!session) return false;
      requireProof(session.data?.version === options.version && session.data?.protocol_version === 2, "session-identity");
      return peer.state === "idle";
    }, "session-ready");
    barriers.push("native-session-ready");
    bus.publish(newEnvelope("user", FIRST, { to: ["qwen"] }));
    checkpoint = "first-held";
    await bounded(ports.firstHeld(controller.signal), checkpoint);
    barriers.push("provider-first-response-held");
    let heldBytes = 0;
    await observe(() => {
      const captured = records(events, options.bounds);
      if (!captured.rows.some(row => row.type === "stream_event" && JSON.stringify(row).includes(`${FIRST}_BEGIN`))) return false;
      heldBytes = captured.bytes;
      return peer.offset >= heldBytes && peer.state === "busy";
    }, "first-stream-consumed");
    barriers.push("first-stream-consumed-by-driver");
    const second = newEnvelope("user", SECOND, { to: ["qwen"] }); bus.publish(second);
    const heldInput = records(input, options.bounds).rows.filter(row => row.type === "submit");
    heldSubmitCount = heldInput.length; heldQueued = bus.queueIds("qwen").includes(second.id);
    requireProof(heldSubmitCount === 1 && heldQueued, "held-input-not-queued");
    requireProof(chronology(records(events, options.bounds).rows).firstStops.length === 0, "first-not-held");
    barriers.push("second-envelope-queued-with-one-submit");
    checkpoint = "second-turn"; ports.releaseFirst();
    barriers.push("first-provider-response-released");
    await observe(() => {
      const observed = chronology(records(events, options.bounds).rows);
      return observed.firstStops.length > 0 && observed.secondStops.length > 0 && peer.state === "idle";
    }, "second-distinct-completion");
    const observed = chronology(records(events, options.bounds).rows);
    requireProof(observed.users.length === 2 && observed.firstStops.length === 1 && observed.secondStops.length === 1, "turn-count");
    requireProof(observed.users[0]!.text.includes(FIRST) && !observed.users[0]!.text.includes(SECOND)
      && observed.users[1]!.text.includes(SECOND), "user-markers");
    requireProof(observed.users[0]!.index < observed.firstStops[0]! && observed.firstStops[0]! < observed.users[1]!.index
      && observed.users[1]!.index < observed.secondStops[0]!, "turn-order");
    requireProof(records(input, options.bounds).rows.filter(row => row.type === "submit").length === 2, "submit-count");
    secondBusDelivered = !bus.queueIds("qwen").includes(second.id) && bus.lastDeliveredTo("qwen").some(row => row.id === second.id);
    requireProof(secondBusDelivered, "second-envelope-not-delivered-by-bus");
    barriers.push("distinct-native-turns-and-second-bus-delivery");
    const requests = ports.requests();
    requireProof(requests.length <= options.bounds.records && requests.every(row => row.marker !== "unknown"), "provider-classification");
    const ordinary = requests.filter(row => row.marker !== "background");
    requireProof(ordinary.length === 2 && ordinary[0]?.marker === "first" && ordinary[1]?.marker === "second"
      && ordinary[0]?.userMessages === 1 && ordinary[1]?.userMessages === 2
      && ordinary.every(row => row.responseFormat === "absent" && !row.schemaHasTitle), "ordinary-provider-turns");
    outcome = { userCount: observed.users.length, firstStop: observed.firstStops[0]!, secondUser: observed.users[1]!.index, secondStop: observed.secondStops[0]! };
    checkpoint = "passed";
  } catch (error) { checkpoint = error instanceof Checkpoint ? error.checkpoint : "host-proof-error"; }
  finally {
    controller.abort(); waiters.clear(); untap(); for (const watcher of watchers) watcher.close();
    bus.closeJournal();
    try { await peer.stop(); } catch { checkpoint = "adapter-stop"; }
    try { ownedStopConfirmed = (await ports.stop()).ownedStopConfirmed; } catch { ownedStopConfirmed = false; }
  }
  return { schemaVersion: 1, manualOnly: true, autoAdmit: false, evidenceKind: ports.kind,
    passed: checkpoint === "passed" && ownedStopConfirmed, checkpoint, heldSubmitCount, heldQueued, secondBusDelivered, barriers, ...outcome,
    providerRequests: ports.requests().slice(0, options.bounds.records).map(row => ({ marker: row.marker,
      responseFormat: row.responseFormat, schemaHasTitle: row.schemaHasTitle, messageCount: row.messageCount,
      userMessages: row.userMessages })), ownedStopConfirmed };
}
