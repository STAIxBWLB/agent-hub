// #286 Part 3 / AC9: the hub-driven Qwen TUI over dual output. A fake Qwen (test/fakes/qwen-dual.ts) speaks the dual-output files; no live model and no real home.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QwenDualPeer, QWEN_STALLED_NOTE, isQwenTaskNotification, qwenDualNamesStateDir, type QwenDualOptions } from "../src/adapters/qwen-dual.ts";
import { COMPAT, assessVersion } from "../src/adapters/compat.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";
import type { ProcRow } from "../src/hub/child-process.ts";
import type { PermissionRequest } from "../src/adapters/acp.ts";
import type { NativeCliEntryContext } from "../src/adapters/definitions/native-cli-entry-types.ts";

const FAKE = join(import.meta.dir, "fakes/qwen-dual.ts");
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (condition: () => boolean, diagnostic?: () => string, ms = 6000) => { for (let i = 0; i < ms / 10 && !condition(); i++) await Bun.sleep(10); expect(condition(), diagnostic?.()).toBe(true); };

interface Rig {
  root: string; dir: string; peer: QwenDualPeer; answers: { body: string; opts?: any }[]; receipts: DeliveryReceipt[]; notices: string[]; stalled: boolean[]; logs: string[]; requests: PermissionRequest[];
  settle: Map<string, (id: string | undefined) => void>; child?: ReturnType<typeof Bun.spawn>; fakeArgs: string[]; launch: () => void; kill: () => void;
}
function rig(extra: Partial<QwenDualOptions> = {}, options: { fakeArgs?: string[]; pollMs?: number; watchdogMs?: number; autoApprove?: (name: string) => boolean; sessionId?: string; root?: string } = {}): Rig {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "qwen-dual-")), stateDir = join(root, "state");
  if (!options.root) cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const dir = join(stateDir, "qwen-dual");
  const answers: Rig["answers"] = [], receipts: DeliveryReceipt[] = [], notices: string[] = [], stalled: boolean[] = [], logs: string[] = [], requests: PermissionRequest[] = [];
  const settle = new Map<string, (id: string | undefined) => void>();
  let table: ProcRow[] = [];
  const peer = new QwenDualPeer("qwen", { cwd: root, stateDir, guardDir: stateDir, cmd: ["qwen"], mcpServers: [{ name: "agent-hub", command: "bun", args: ["run", "server.js"], env: {} }],
    watchdogMs: options.watchdogMs ?? 60_000, pollMs: options.pollMs ?? 20, ownerMs: 50, preamble: "PREAMBLE",
    autoApprove: options.autoApprove ?? (name => name === "mcp__agent-hub__hub_send"),
    onPermission: (req, signal) => new Promise(resolve => {
      requests.push(req);
      const key = `${requests.length}`;
      settle.set(key, resolve);
      signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
    onStalled: value => stalled.push(value), onNotice: text => notices.push(text), log: line => logs.push(line),
    table: () => table, ...extra });
  peer.onMessage = (body, opts) => { answers.push({ body, opts }); return undefined; };
  peer.onDelivery = receipt => receipts.push(receipt);
  const state: Rig = { root, dir, peer, answers, receipts, notices, stalled, logs, requests, settle, fakeArgs: options.fakeArgs ?? [], launch: () => {}, kill: () => {} };
  state.launch = () => {
    const launch = peer.launch!;
    const args = launch.args.filter((word, index, all) => !(word === "--mcp-config" || all[index - 1] === "--mcp-config" || word === "--approval-mode" || all[index - 1] === "--approval-mode" || word === "--model" || all[index - 1] === "--model"));
    const child = Bun.spawn([process.execPath, FAKE, ...args, ...state.fakeArgs], { cwd: root, env: { PATH: process.env.PATH! }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    state.child = child; cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
    table = [{ pid: child.pid, ppid: process.pid, pgid: child.pid, started: "x", command: `bun qwen ${launch.args.join(" ")}` }];
  };
  state.kill = () => { state.child?.kill("SIGKILL"); };
  cleanups.push(() => peer.stop());
  return state;
}
const env = (body: string): Envelope[] => [newEnvelope("user", body, { to: ["qwen"] })];
async function attached(options: Parameters<typeof rig>[1] = {}, extra: Partial<QwenDualOptions> = {}): Promise<Rig> {
  const r = rig(extra, options);
  await r.peer.start(); r.launch();
  await until(() => r.peer.state === "idle", () => `peer is ${r.peer.state}: ${r.logs.join(" | ")}`);
  return r;
}
const events = (r: Rig) => readFileSync(join(r.dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const inputLines = (r: Rig) => readFileSync(join(r.dir, "input.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const answered = (r: Rig, n: number, id = "allow") => { r.settle.get(String(n))!(id); };

test("the compat entry for the dual-output contract verifies 0.26.1 only, and does not widen the headless qwen entry", () => {
  expect(COMPAT["qwen-dual"].verified).toEqual(["0.26.1"]);
  expect("line" in COMPAT["qwen-dual"]).toBe(false);
  // The entries are separate contracts, so a widening of one never changes the other: #843 AC5 verified 0.26.1 for the
  // ACP receipt on the headless qwen entry; this dual-output entry stays verified on 0.26.1 only, at its own gate.
  expect(assessVersion("qwen-dual", "0.26.1", []).ok).toBe(true);
  expect(assessVersion("qwen-dual", "0.25.0", []).ok).toBe(false);
  expect(assessVersion("qwen", "0.26.0", []).ok).toBe(true);
  expect(assessVersion("qwen", "0.27.0", []).ok).toBe(false);
});

test("start prepares private input and event files and the launch carries the dual-output flags", async () => {
  const r = rig(); await r.peer.start();
  for (const name of ["input.jsonl", "events.jsonl"]) expect(statSync(join(r.dir, name)).mode & 0o777).toBe(0o600);
  expect(statSync(r.dir).mode & 0o077).toBe(0);
  const launch = r.peer.launch!;
  expect(launch.cmd).toBe("qwen");
  expect(launch.args[launch.args.indexOf("--input-file") + 1]).toBe(join(r.dir, "input.jsonl"));
  expect(launch.args[launch.args.indexOf("--json-file") + 1]).toBe(join(r.dir, "events.jsonl"));
  expect(launch.args[launch.args.indexOf("--approval-mode") + 1]).toBe("default");
  expect(JSON.parse(readFileSync(launch.args[launch.args.indexOf("--mcp-config") + 1]!, "utf8")).mcpServers["agent-hub"].command).toBe("bun");
  expect(launch.args).not.toContain("--acp");
  expect(r.peer.state).toBe("offline");   // not attached until the TUI announces itself
});

test("delivery becomes one submit line, the last message is shared, and busy/idle follow the events", async () => {
  const r = await attached();
  const states: string[] = []; r.peer.onState = state => states.push(state);
  const delivery = r.peer.deliver(env("hello qwen"), "d1");
  expect(r.peer.state).toBe("busy");   // synchronously, before the file is even read
  await delivery;
  await until(() => r.answers.length === 1);
  expect(r.answers[0]!.body).toContain("echo:"); expect(r.answers[0]!.body).toContain("hello qwen");
  expect(r.answers[0]!.opts.to).toEqual(["user"]);
  await until(() => r.peer.state === "idle");
  expect(states).toEqual(["busy", "idle"]);
  expect(r.receipts.map(receipt => receipt.state)).toEqual(["accepted", "completed"]);
  const submits = inputLines(r).filter(line => line.type === "submit");
  expect(submits).toHaveLength(1); expect(submits[0].text).toContain("hello qwen"); expect(submits[0].text).toContain("PREAMBLE");
});

test("a second delivery is a second submit and carries no preamble again", async () => {
  const r = await attached();
  await r.peer.deliver(env("one"), "d1"); await until(() => r.peer.state === "idle" && r.answers.length === 1);
  await r.peer.deliver(env("two"), "d2"); await until(() => r.answers.length === 2);
  const submits = inputLines(r).filter(line => line.type === "submit");
  expect(submits).toHaveLength(2); expect(submits[1].text).not.toContain("PREAMBLE");
});

test("a tool-use assistant message does not end the turn; the final assistant and its message_stop do", async () => {
  const r = await attached();
  await r.peer.deliver(env('TOOL:mcp__agent-hub__hub_send:{"text":"x"}'), "d1");
  await until(() => r.answers.length === 1);
  expect(r.answers[0]!.body).toBe("ran mcp__agent-hub__hub_send");   // not the empty tool_use message
  expect(r.receipts.at(-1)!.state).toBe("completed");
});

test("hub tools are approved by exact mcp__<server>__<tool> name only: a prefix-similar name asks the console", async () => {
  const r = await attached();
  await r.peer.deliver(env('TOOL:mcp__agent-hub__hub_send:{"text":"x"}'), "d1");
  await until(() => r.answers.length === 1);
  expect(r.requests).toHaveLength(0);                       // exact name: approved without asking
  expect(inputLines(r).filter(line => line.type === "confirmation_response")).toHaveLength(1);
  expect(inputLines(r).find(line => line.type === "confirmation_response").allowed).toBe(true);
  await until(() => r.peer.state === "idle");
  await r.peer.deliver(env('TOOL:mcp__agent-hub__hub_send_evil:{"text":"x"}'), "d2");
  await until(() => r.requests.length === 1);               // a name that merely starts with a hub tool's name is not one
  expect(r.requests[0]!.tool).toBe("mcp__agent-hub__hub_send_evil");
  answered(r, 1, "deny");
  await until(() => r.peer.state === "idle");
  await r.peer.deliver(env('TOOL:mcp__other__hub_send:{"text":"x"}'), "d3");   // another server's tool of the same short name
  await until(() => r.requests.length === 2);
  expect(r.requests[1]!.tool).toBe("mcp__other__hub_send");
  answered(r, 2, "deny");
  await until(() => r.peer.state === "idle");
});

test("an approval round-trips through the console: allow answers confirmation_response and the tool runs", async () => {
  const r = await attached();
  await r.peer.deliver(env('TOOL:run_shell_command:{"command":"echo hi"}'), "d1");
  await until(() => r.requests.length === 1);
  expect(r.requests[0]!.title).toContain("echo hi"); expect(r.requests[0]!.tool).toBe("run_shell_command");
  expect(r.requests[0]!.options.map(option => option.optionId)).toEqual(["allow", "deny"]);
  expect(r.peer.state).toBe("busy");
  answered(r, 1, "allow");
  await until(() => r.answers.length === 1);
  expect(r.answers[0]!.body).toBe("ran run_shell_command");
  const response = inputLines(r).find(line => line.type === "confirmation_response");
  expect(response.allowed).toBe(true); expect(typeof response.request_id).toBe("string");
  expect(events(r).some(event => event.type === "control_response" && event.response.subtype === "success" && event.response.request_id === response.request_id)).toBe(true);
});

test("a deny ends the turn itself: Qwen emits nothing, so the adapter goes idle with no shared answer and a notice", async () => {
  const r = await attached();
  await r.peer.deliver(env('TOOL:run_shell_command:{"command":"touch x"}'), "d1");
  await until(() => r.requests.length === 1);
  const before = events(r).length;   // session_start, user, control_request
  answered(r, 1, "deny");
  await until(() => r.peer.state === "idle");
  expect(inputLines(r).find(line => line.type === "confirmation_response").allowed).toBe(false);
  await Bun.sleep(150);
  expect(events(r).length).toBe(before);   // the fake (like Qwen) wrote nothing for the deny: no control_response, no tool_result, no assistant
  expect(events(r).map(event => event.type)).toEqual(["system", "user", "control_request"]);
  expect(r.answers).toHaveLength(0);
  // A deny is a known outcome: it completes, so the hub does not hold the peer's queue behind a needs_review (measured against the real Qwen: it wedged every later message).
  expect(r.receipts.at(-1)!).toMatchObject({ id: "d1", state: "completed" });
  expect(r.receipts.some(receipt => receipt.state === "needs_review")).toBe(false);
  expect(r.notices.some(text => text.includes("deny cancelled the Qwen turn"))).toBe(true);
  // and the peer takes the next delivery
  await r.peer.deliver(env("after the deny"), "d2"); await until(() => r.answers.length === 1);
  expect(r.answers[0]!.body).toContain("after the deny");
});

test("a TUI-side answer withdraws the pending hub approval, and a late hub answer finds nothing to grant", async () => {
  const t = await attached({ fakeArgs: ["--tui-answer", "150"] });   // this fake answers the first approval itself, as the person pressing Enter in the TUI
  let withdrawn = false;
  t.peer.onDelivery = receipt => t.receipts.push(receipt);
  await t.peer.deliver(env('TOOL:run_shell_command:{"command":"echo hi"}'), "d1");
  await until(() => t.requests.length === 1);
  await until(() => t.answers.length === 1);   // the TUI answered (allowed) and the turn finished
  expect(t.logs.some(line => line.includes("answered in the Qwen terminal"))).toBe(true);
  expect(inputLines(t).filter(line => line.type === "confirmation_response")).toHaveLength(0);   // the hub sent nothing: its approval was withdrawn
  t.settle.get("1")!("allow");   // a late console answer
  withdrawn = true;
  await Bun.sleep(100);
  expect(withdrawn).toBe(true);
  expect(inputLines(t).filter(line => line.type === "confirmation_response")).toHaveLength(0);
});

test("a write or command that names the hub state dir is refused without asking anyone", async () => {
  const r = await attached();
  const stateDir = join(r.root, "state");
  await r.peer.deliver(env(`TOOL:run_shell_command:{"command":"echo '{\\"type\\":\\"submit\\"}' >> ${stateDir}/qwen-dual/input.jsonl"}`), "d1");
  await until(() => r.peer.state === "idle");
  expect(r.requests).toHaveLength(0);
  expect(inputLines(r).find(line => line.type === "confirmation_response").allowed).toBe(false);
  expect(r.receipts.at(-1)!.state).toBe("completed");   // a refusal is a known outcome too
  expect(r.notices.some(text => text.includes("input file is a prompt channel"))).toBe(true);
  expect(qwenDualNamesStateDir({ file_path: `${stateDir}/qwen-dual/input.jsonl` }, stateDir)).toBe(true);
  expect(qwenDualNamesStateDir({ command: "cat ./.agenthub/state/hub.log" }, stateDir)).toBe(true);
  expect(qwenDualNamesStateDir({ command: "ls src" }, stateDir)).toBe(false);
});

test("a stalled turn is reported, never cancelled: the peer stays busy, says to press Esc, and recovers when Qwen moves", async () => {
  const t = await attached({ watchdogMs: 120 });
  await t.peer.deliver(env("STALL please"), "d1");
  await until(() => t.stalled.includes(true));
  expect(t.peer.state).toBe("busy");   // the watchdog never goes idle on its own
  expect(t.peer.stalled).toBe(true); expect(t.peer.statusNotice!.message).toBe(QWEN_STALLED_NOTE); expect(QWEN_STALLED_NOTE).toContain("Esc");
  expect(t.notices.some(text => text.includes("press Esc in the Qwen terminal"))).toBe(true);
  expect(inputLines(t).filter(line => line.type !== "submit")).toHaveLength(0);   // nothing was typed or sent to stop it
  expect(t.child!.killed).toBe(false); expect(t.child!.exitCode).toBeNull();      // and the process was not signalled
  writeFileSync(join(t.dir, "input.jsonl.esc"), "");   // the person presses Esc: Qwen simply goes quiet
  await Bun.sleep(300);
  expect(t.peer.state).toBe("busy");   // still no event: the hub does not guess an end
  appendFileSync(join(t.dir, "events.jsonl"), `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "typed by the person" }] } })}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } })}\n${JSON.stringify({ type: "stream_event", event: { type: "message_stop" } })}\n`);
  await until(() => t.peer.state === "idle");
  expect(t.stalled.at(-1)).toBe(false);
  expect(t.receipts.at(-1)!.state).toBe("needs_review");   // the hub's turn was cut by the person's own prompt: uncertain, not completed
});

test("an unread event file reads as detached, not idle, and the peer reattaches when it is readable again", async () => {
  const r = await attached();
  const file = join(r.dir, "events.jsonl");
  renameSync(file, `${file}.moved`); mkdirSync(file);   // a directory where the file was: unreadable as a regular file
  await until(() => r.peer.state === "offline");
  expect(r.peer.isDetached).toBe(true); expect(r.peer.state).not.toBe("idle");
  expect(r.peer.statusNotice!.code).toBe("qwen-detached");
  await expect(r.peer.deliver(env("nobody can read this"), "dX")).rejects.toThrow();
  expect(r.receipts.at(-1)!.state).toBe("failed_safe");
  rmSync(file, { recursive: true }); renameSync(`${file}.moved`, file);
  await until(() => r.peer.state === "idle"); expect(r.peer.isDetached).toBe(false);
});

test("an event file the hub cannot open (mode 000) detaches the peer and never reads as idle", async () => {
  const r = await attached();
  chmodSync(join(r.dir, "events.jsonl"), 0o000);
  cleanups.push(() => { try { chmodSync(join(r.dir, "events.jsonl"), 0o600); } catch { /* removed */ } });
  if (process.getuid?.() === 0) return;   // root reads anything
  await until(() => r.peer.isDetached);
  expect(r.peer.state).toBe("offline");
});

test("a restart resumes the recorded session from the saved offset: no event processed twice, no submit replayed", async () => {
  const r = await attached();
  await r.peer.deliver(env("before the restart"), "d1"); await until(() => r.answers.length === 1);
  const session = r.peer.sessionId!, offset = r.peer.offset, eventsBefore = events(r).length, submitsBefore = inputLines(r).filter(line => line.type === "submit").length;
  expect(offset).toBeGreaterThan(0); expect(session).toMatch(/^[0-9a-f-]{36}$/);
  await r.peer.stop(); r.kill(); await r.child!.exited;
  // The hub restarts; the person's Qwen is gone too, so the launch resumes the same session with qwen -r.
  const root = r.root, again = rig({}, { root, fakeArgs: [] });
  await again.peer.start();
  expect(again.peer.sessionId).toBe(session);
  const launch = again.peer.launch!;
  expect(launch.args[launch.args.indexOf("-r") + 1]).toBe(session);
  expect(launch.args[launch.args.indexOf("--input-file") + 1]).toBe(join(r.dir, "input.jsonl"));   // the same two files
  again.launch(); await until(() => again.peer.state === "idle");
  await Bun.sleep(200);
  expect(again.answers).toHaveLength(0);   // the earlier answer was not shared again
  expect(inputLines(again).filter(line => line.type === "submit")).toHaveLength(0);   // and no submit was replayed (the input file starts empty for the new TUI)
  expect(submitsBefore).toBe(1); expect(eventsBefore).toBeGreaterThan(3);
  await again.peer.deliver(env("after the restart"), "d2"); await until(() => again.answers.length === 1);
  expect(again.answers[0]!.body).toContain("after the restart"); expect(again.answers).toHaveLength(1);
});

test("a hub restart while the person's Qwen keeps running adopts it from the saved offset: nothing is launched or processed twice", async () => {
  const r = await attached();
  await r.peer.deliver(env("first"), "d1"); await until(() => r.answers.length === 1);
  const offset = r.peer.offset;
  await r.peer.stop();   // the hub goes away; Qwen is still running
  expect(r.child!.exitCode).toBeNull();
  const table: ProcRow[] = [{ pid: r.child!.pid, ppid: 1, pgid: r.child!.pid, started: "x", command: `bun qwen --input-file ${join(r.dir, "input.jsonl")}` }];
  const adopted = rig({ table: () => table }, { root: r.root });
  await adopted.peer.start();
  expect(adopted.peer.adopted).toBe(true); expect(adopted.peer.launch).toBeUndefined();
  expect(adopted.peer.offset).toBe(offset);
  await until(() => adopted.peer.state === "idle", () => adopted.logs.join("|"));
  await Bun.sleep(150);
  expect(adopted.answers).toHaveLength(0);   // the processed turn was not processed again
  await adopted.peer.deliver(env("second"), "d2"); await until(() => adopted.answers.length === 1);
  expect(adopted.answers[0]!.body).toContain("second");
});

test("the Qwen process ending marks the peer offline and settles an open turn as uncertain", async () => {
  const exits: number[] = [];
  const r = await attached({}, { onExit: () => exits.push(1) });
  await until(() => (r.peer as any).state_.ownerPid !== undefined, () => "the owner was never bound from the process table");
  await r.peer.deliver(env("STALL forever"), "d1");
  await until(() => r.receipts.some(receipt => receipt.state === "accepted"));
  r.kill();
  await until(() => r.peer.state === "offline", () => r.logs.join("|"), 8000);
  expect(r.receipts.at(-1)!).toMatchObject({ id: "d1", state: "needs_review" });
  expect(exits).toEqual([1]);
  expect(r.notices.some(text => text.includes("terminal ended"))).toBe(true);
});

test("the hub never signals or types into Qwen: stop leaves the process running and the input file free of keystrokes", async () => {
  const r = await attached();
  await r.peer.stop("requested stop");
  expect(r.child!.exitCode).toBeNull(); expect(r.child!.killed).toBe(false);
  expect(inputLines(r).filter(line => !["submit", "confirmation_response"].includes(line.type))).toHaveLength(0);
});

test("a TUI that states an unverified version or contract is not attached", async () => {
  const r = rig({}, { fakeArgs: ["--fake-version", "0.27.0"] });
  await r.peer.start(); r.launch();
  await until(() => r.notices.some(text => text.includes("not verified")));
  expect(r.peer.state).toBe("offline");
  expect(existsSync(join(r.dir, "input.jsonl"))).toBe(true);
});

test("a person's own prompt in the TUI is not the hub's: it keeps the peer busy without a hub answer", async () => {
  const r = await attached();
  appendFileSync(join(r.dir, "events.jsonl"), `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "typed by the person" }] } })}\n`);
  await until(() => r.peer.state === "busy");
  appendFileSync(join(r.dir, "events.jsonl"), `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "private answer" }], stop_reason: "end_turn" } })}\n${JSON.stringify({ type: "stream_event", event: { type: "message_stop" } })}\n`);
  await until(() => r.peer.state === "idle");
  expect(r.answers).toHaveLength(0);   // the person's conversation is never shared
});

// #517: Qwen tells the model that a background shell finished with a `user` event of its own. It is not the person typing, and it arrives in the middle of a running hub
// turn (13 of the 25 in the live event files), so reading it as the person ended the turn as uncertain and held the peer's whole queue (7 of 7 recorded holds).
const NOTIFICATION = (id = "bg_0a1b2c3d", status = "completed") => `<task-notification>\n<task-id>${id}</task-id>\n<kind>shell</kind>\n<status>${status}</status>\n<summary>Shell command "make" ${status}.</summary>\n<command>make</command>\n<cwd>/tmp</cwd>\n<pid>7</pid>\n<exit-code>0</exit-code>\n<output-file>/tmp/out</output-file>\n</task-notification>`;
const userEvent = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const appendEvents = (r: Rig, ...lines: unknown[]) => appendFileSync(join(r.dir, "events.jsonl"), lines.map(line => `${JSON.stringify(line)}\n`).join(""));
const finalAnswer = (text: string) => [{ type: "assistant", message: { content: [{ type: "text", text }], stop_reason: "end_turn" } }, { type: "stream_event", event: { type: "message_stop" } }];

test("a background-task notification inside a running hub turn does not end it: the delivery completes and nothing is held (#517)", async () => {
  const r = await attached();
  await r.peer.deliver(env("NOTIFY please"), "d1");   // the fake: a tool_use message, then Qwen's own notice, then the answer, all in one turn
  await until(() => r.answers.length === 1, () => `receipts ${JSON.stringify(r.receipts)} notices ${r.notices.join(" | ")}`);
  await until(() => r.peer.state === "idle");
  expect(events(r).filter(event => event.type === "user" && JSON.stringify(event).includes("<task-notification>"))).toHaveLength(1);   // the notice really was in the stream
  expect(r.receipts.map(receipt => receipt.state)).toEqual(["accepted", "completed"]);   // never needs_review
  expect(r.notices).toEqual([]);
  expect(r.answers[0]!.body).toContain("echo:"); expect(r.answers[0]!.body).not.toContain("task-notification");
  // And the next delivery goes through: the queue was never held.
  await r.peer.deliver(env("after"), "d2");
  await until(() => r.receipts.at(-1)?.id === "d2" && r.receipts.at(-1)!.state === "completed");
});

test("a notification after the turn has ended, with nothing following it, leaves the peer idle and the queue open (#517)", async () => {
  const r = await attached();
  await r.peer.deliver(env("NOTIFYAFTER please"), "d1");
  await until(() => r.receipts.at(-1)?.state === "completed");
  await until(() => events(r).some(event => event.type === "user" && JSON.stringify(event).includes("<task-notification>")));
  await Bun.sleep(150);
  expect(r.peer.state).toBe("idle"); expect(r.notices).toEqual([]);
  await r.peer.deliver(env("after the trailing notice"), "d2");
  await until(() => r.receipts.at(-1)?.id === "d2" && r.receipts.at(-1)!.state === "completed", () => JSON.stringify(r.receipts));
});

test("several notifications in one hub turn leave it running until its own end, and the answer is the last assistant message (#517)", async () => {
  const r = await attached({}, { watchdogMs: 60_000 });
  await r.peer.deliver(env("STALL then answer"), "d1");
  await until(() => r.receipts.some(receipt => receipt.state === "accepted"));
  appendEvents(r, userEvent(NOTIFICATION("bg_aaaa1111")), userEvent(NOTIFICATION("bg_bbbb2222", "cancelled")));
  await Bun.sleep(200);
  expect(r.peer.state).toBe("busy");
  expect(r.receipts.map(receipt => receipt.state)).toEqual(["accepted"]);   // still running, not held
  appendEvents(r, ...finalAnswer("the real answer"));
  await until(() => r.receipts.at(-1)!.state === "completed");
  expect(r.answers.map(answer => answer.body)).toEqual(["the real answer"]);
  expect(r.notices).toEqual([]);
});

test("Qwen folds several finished shells into one event: one or more whole envelopes separated by a blank line are still its own notice (#517)", async () => {
  expect(isQwenTaskNotification(NOTIFICATION())).toBe(true);
  expect(isQwenTaskNotification(`${NOTIFICATION("bg_aaaa1111")}\n\n${NOTIFICATION("bg_bbbb2222", "cancelled")}`)).toBe(true);
  const r = await attached();
  await r.peer.deliver(env("STALL then answer"), "d1");
  await until(() => r.receipts.some(receipt => receipt.state === "accepted"));
  appendEvents(r, userEvent(`${NOTIFICATION("bg_aaaa1111")}\n\n${NOTIFICATION("bg_bbbb2222")}`), ...finalAnswer("done"));
  await until(() => r.receipts.at(-1)!.state === "completed");
  expect(r.receipts.map(receipt => receipt.state)).toEqual(["accepted", "completed"]); expect(r.notices).toEqual([]);
});

test("a notification that arrives while Qwen is idle changes nothing: the peer stays idle, and a notice with no follow-up never blocks the queue (#517)", async () => {
  const r = await attached();
  appendEvents(r, userEvent(NOTIFICATION()));
  await Bun.sleep(200);
  expect(r.peer.state).toBe("idle");   // not busy: Qwen may never answer it
  expect(r.answers).toHaveLength(0); expect(r.receipts).toHaveLength(0); expect(r.notices).toEqual([]);
  // No assistant message ever follows, and the next delivery still goes through.
  await r.peer.deliver(env("after the lone notice"), "d1");
  await until(() => r.receipts.at(-1)?.state === "completed", () => JSON.stringify(r.receipts));
  expect(r.answers).toHaveLength(1); expect(r.notices).toEqual([]);
  // And Qwen answering a notice on its own, when idle, shares nothing and leaves the peer idle.
  appendEvents(r, userEvent(NOTIFICATION("bg_cccc3333")), ...finalAnswer("noted the shell finished"));
  await Bun.sleep(200);
  expect(r.peer.state).toBe("idle"); expect(r.answers).toHaveLength(1);
});

test("the exemption is judged on the raw event: a notice split across blocks, or beside any other block, is the person's prompt (#517)", async () => {
  const mixed: [string, unknown[]][] = [
    ["two text blocks that join into a valid envelope", [{ type: "text", text: "<task-notification>\n<task-id>bg_0a1b2c3d</task-id>\n<kind>shell</kind>\n" }, { type: "text", text: "<status>completed</status>\n</task-notification>" }]],
    ["a valid envelope plus a second text block", [{ type: "text", text: NOTIFICATION() }, { type: "text", text: "and I also typed this" }]],
    ["a valid envelope plus an image block", [{ type: "text", text: NOTIFICATION() }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]],
    ["an image block before a valid envelope", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: NOTIFICATION() }]],
    ["an empty text block beside a valid envelope", [{ type: "text", text: "" }, { type: "text", text: NOTIFICATION() }]],
  ];
  for (const [label, content] of mixed) {
    const r = await attached();
    await r.peer.deliver(env("STALL a turn"), "d1");
    await until(() => r.receipts.some(receipt => receipt.state === "accepted"));
    appendEvents(r, { type: "user", message: { role: "user", content } });
    await until(() => r.receipts.at(-1)!.state === "needs_review", () => `not held for ${label}: ${JSON.stringify(r.receipts)}`);
    // The personal answer that follows is never shared as the hub delivery's result.
    appendEvents(r, ...finalAnswer("a private answer"));
    await Bun.sleep(100);
    expect(r.answers, label).toHaveLength(0);
    await r.peer.stop();
  }
  // A single text block that is wholly the envelope is the one accepted shape, and a content string never is (Qwen writes lists).
  const r = await attached();
  await r.peer.deliver(env("STALL a turn"), "d1");
  await until(() => r.receipts.some(receipt => receipt.state === "accepted"));
  appendEvents(r, { type: "user", message: { role: "user", content: NOTIFICATION() } });
  await until(() => r.receipts.at(-1)!.state === "needs_review");
});

test("only the exact notification shape is exempt: a person's prompt that looks like one still ends a hub turn as uncertain (#517)", async () => {
  for (const typed of ["<task-notification>just typed by the person</task-notification>", `${NOTIFICATION()}\nand more typed after it`, `${NOTIFICATION()}\n\ntyped between two`, `${NOTIFICATION()}\n\n${NOTIFICATION()}\n\nand then more`, `please read: ${NOTIFICATION()}`, ` ${NOTIFICATION()}`, NOTIFICATION("bg_not a valid id"), `<task-notification>\n<task-id>bg_0a1b2c3d</task-id>\n<kind>shell</kind>\n<status>completed</status>\n<task-notification>nested</task-notification></task-notification>`]) {
    const r = await attached();
    await r.peer.deliver(env("STALL a turn"), "d1");
    await until(() => r.receipts.some(receipt => receipt.state === "accepted"));
    appendEvents(r, userEvent(typed));
    await until(() => r.receipts.at(-1)!.state === "needs_review", () => `not held for ${JSON.stringify(typed.slice(0, 40))}: ${JSON.stringify(r.receipts)}`);
    expect(r.notices.join("\n")).toContain("without a result");
    await r.peer.stop();
  }
});

test("an approval request during the person's own turn is theirs: the console is not asked", async () => {
  const r = await attached();
  appendFileSync(join(r.dir, "events.jsonl"), `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "typed by the person" }] } })}\n${JSON.stringify({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "run_shell_command", input: { command: "ls" } } })}\n`);
  await Bun.sleep(150);
  expect(r.requests).toHaveLength(0);
  expect(inputLines(r).filter(line => line.type === "confirmation_response")).toHaveLength(0);
});

test("a stale approval answer is logged, never retried", async () => {
  const r = await attached();
  appendFileSync(join(r.dir, "events.jsonl"), `${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "gone", error: "unknown request_id (already resolved, cancelled, or never issued)" } })}\n`);
  await until(() => r.logs.some(line => line.includes("stale or unknown request")));
  expect(inputLines(r).filter(line => line.type === "confirmation_response")).toHaveLength(0);
});

test("input that Qwen would read as a command is fenced: a digest that starts with a slash, bang or at sign is prefixed", async () => {
  const r = await attached({}, { preamble: undefined });
  (r.peer as any).primed = true;   // a primed session sends the bare digest: the frame, not the standing instruction, leads
  await r.peer.deliver(env("/clear everything"), "d1");
  await until(() => r.answers.length === 1);
  const submit = inputLines(r).find(line => line.type === "submit");
  expect(/^\s*[\/!@?]/.test(submit.text)).toBe(false);
  expect(submit.text).toContain("/clear everything");
});

test("the Qwen TUI is explicit only: Qwen stays a headless-form peer and recovery never restores its terminal as a headless worker", async () => {
  const { definitionOf } = await import("../src/adapters/registry.ts");
  const { QWEN_RECOVERY_SESSION } = await import("../src/adapters/definitions/native-recovery.ts");
  const qwen = definitionOf("qwen")!;
  expect(qwen.start.forms).toEqual(["headless"]); expect(qwen.start.defaultForm).toBe("headless");
  const { START_MODE_PEERS } = await import("../src/adapters/registry.ts");
  expect(START_MODE_PEERS).not.toContain("qwen");
  expect(QWEN_RECOVERY_SESSION.recoveryRefusal!({ id: "qwen", args: { mode: "tui" } } as any, "restore")).toContain("cannot be restored as a headless worker");
  expect(QWEN_RECOVERY_SESSION.recoveryRefusal!({ id: "qwen", args: { mode: "headless" } } as any)).toBeUndefined();
});

test("an event line over the read cap is dropped through its newline and the position persists: later events are still read (review finding)", async () => {
  const r = await attached();
  const file = join(r.dir, "events.jsonl");
  // 1.5 MiB with no newline yet, the way a big tool result arrives in pieces, then its newline, then a normal turn's events.
  appendFileSync(file, `{"type":"user","message":{"content":"${"x".repeat(1_500_000)}`);
  await until(() => r.logs.some(line => line.includes("dropped an event line over")));
  const offsetInside = r.peer.offset;
  expect(offsetInside).toBeGreaterThan(1_000_000);   // persisted: the next poll does not reread the first megabyte
  await Bun.sleep(120);
  expect(r.peer.offset).toBe(offsetInside);
  appendFileSync(file, `y"}}\n`);   // the oversized line ends
  await r.peer.deliver(env("after the oversized line"), "d1");
  await until(() => r.answers.length === 1, () => r.logs.join("|"));
  expect(r.answers[0]!.body).toContain("after the oversized line");
  expect(r.receipts.at(-1)!.state).toBe("completed");
  expect(JSON.parse(readFileSync(join(r.dir, "state.json"), "utf8")).offset).toBe(r.peer.offset);   // and a restart would not reread it either
});

test("a detached TUI whose Qwen is still running is not replaced by a headless start; an exited one is (review finding)", async () => {
  const r = await attached();
  await until(() => (r.peer as any).state_.ownerPid !== undefined, () => "owner never bound");
  const file = join(r.dir, "events.jsonl");
  renameSync(file, `${file}.moved`); mkdirSync(file);
  await until(() => r.peer.isDetached);
  expect(r.peer.state).toBe("offline");        // detached reads offline, which is exactly why state is no proof of a free terminal
  expect(r.peer.holdsTerminal()).toBe(true);   // the person's Qwen is still alive and bound
  r.kill(); await r.child!.exited;
  await until(() => !r.peer.holdsTerminal(), () => r.logs.join("|"), 8000);   // once it exited, the terminal is free
  expect(r.peer.holdsTerminal()).toBe(false);
});

test("an approval answer that could not be written does not settle the turn: the peer stays busy and the person is told to answer in the Qwen terminal (review finding)", async () => {
  const r = await attached();
  await r.peer.deliver(env('TOOL:run_shell_command:{"command":"touch x"}'), "d1");
  await until(() => r.requests.length === 1);
  chmodSync(join(r.dir, "input.jsonl"), 0o400);   // the input file becomes unwritable
  cleanups.push(() => { try { chmodSync(join(r.dir, "input.jsonl"), 0o600); } catch { /* removed */ } });
  if (process.getuid?.() === 0) return;
  answered(r, 1, "deny");
  await until(() => r.notices.some(text => text.includes("could not write its approval answer")));
  expect(r.peer.state).toBe("busy");   // Qwen is still blocked on the approval: not idle, not cancelled
  expect(r.receipts.some(receipt => receipt.state === "needs_review")).toBe(false);
  expect(r.notices.some(text => text.includes("deny cancelled the Qwen turn"))).toBe(false);
  expect(r.peer.holdsTerminal()).toBe(true);
});

test("the owner is the root of the process tree that names the input file: the real Qwen is a script wrapper, a node launcher and a cli.js child, all three naming it (measured on 0.26.1)", async () => {
  const sig = (pid: number) => `sig-${pid}`;   // the pids below are not real processes
  const r = rig({ signature: sig }, {}); await r.peer.start();
  const input = join(r.dir, "input.jsonl"), named = (pid: number, ppid: number, head: string): ProcRow => ({ pid, ppid, pgid: pid, started: "x", command: `${head} --input-file ${input} --json-file ${join(r.dir, "events.jsonl")}` });
  const own = (r.peer as any).opts as QwenDualOptions & { table?: () => ProcRow[] | undefined };
  const real: ProcRow[] = [named(300, 299, "script -q /dev/null qwen"), named(301, 300, "node /bin/qwen"), named(302, 301, "node --expose-gc cli.js"), { pid: 5, ppid: 1, pgid: 5, started: "x", command: "unrelated" }];
  own.table = () => real;
  (r.peer as any).sessionSeen = true; (r.peer as any).discoverOwner();
  expect((r.peer as any).state_.ownerPid).toBe(300);   // the root, so the person's terminal is what the hub watches
  // Two separate trees naming the same file is ambiguous: no owner is bound, and nothing is guessed.
  const second = rig({ signature: sig }, {}); await second.peer.start();
  const file = join(second.dir, "input.jsonl"), both: ProcRow[] = [{ pid: 400, ppid: 1, pgid: 400, started: "x", command: `qwen --input-file ${file}` }, { pid: 500, ppid: 1, pgid: 500, started: "x", command: `qwen --input-file ${file}` }];
  (second.peer as any).opts.table = () => both; (second.peer as any).sessionSeen = true; (second.peer as any).discoverOwner();
  expect((second.peer as any).state_.ownerPid).toBeUndefined();
});

test("the CLI entry runs the daemon's launch in the person's own environment, with the hub's marker over it and no recovery or unattended authority", async () => {
  const { runQwenEntry } = await import("../src/adapters/definitions/native-cli-entry-qwen.ts");
  const { definitionOf } = await import("../src/adapters/registry.ts");
  const requests: Record<string, unknown>[] = [], launched: { bin?: string; argv?: string[]; env?: NodeJS.ProcessEnv } = {};
  const saved = { PATH: process.env.PATH, FAKE_PROVIDER_KEY: process.env.FAKE_PROVIDER_KEY, AGENTHUB_RECOVERY_OPERATION: process.env.AGENTHUB_RECOVERY_OPERATION, AGENTHUB_HOME: process.env.AGENTHUB_HOME,
    AGENTHUB_CHANNEL: process.env.AGENTHUB_CHANNEL, AGENTHUB_LAUNCH_ID: process.env.AGENTHUB_LAUNCH_ID, AGENTHUB_MODE: process.env.AGENTHUB_MODE, CLAUDECODE: process.env.CLAUDECODE };
  process.env.FAKE_PROVIDER_KEY = "person-key"; process.env.AGENTHUB_RECOVERY_OPERATION = "op-1"; process.env.AGENTHUB_HOME = "/person-hub";
  // the person ran it from a shell inside an `ahub claude` session
  process.env.AGENTHUB_CHANNEL = "1"; process.env.AGENTHUB_LAUNCH_ID = "claude-launch"; process.env.AGENTHUB_MODE = "tools"; process.env.CLAUDECODE = "1";
  const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const args = ["--mode", "tui"];
  const context = { args, cwd: "/project", stateDir: "/state", cliDir: "/pkg", unattendedEnv: false, definition: definitionOf("qwen"),
    fail: (message: string): never => { throw new Error(message); }, projectConfig: () => ({}),
    connect: async () => ({ close() {}, request: async (message: Record<string, unknown>) => { requests.push(message); return message.t === "status" ? { status: { peers: { qwen: { state: "offline" } } } }
      : { ok: true, mode: "tui", launch: { cmd: "qwen", args: ["--input-file", "/state/qwen/qwen-dual/input.jsonl"], env: { AGENTHUB_PEER_ID: "qwen", AGENTHUB_RECOVERY_OPERATION: "daemon-op", AGENTHUB_UNATTENDED: "1" } } }; } }),
    takeFlags: () => ({ one: { "--mode": "tui" }, rest: [], many: {} }),
    execWithEnv: (bin: string, argv: string[], env: NodeJS.ProcessEnv): never => { Object.assign(launched, { bin, argv, env }); throw new Error("exec boundary"); },
    helpers: {} } as unknown as NativeCliEntryContext;
  try { await expect(runQwenEntry(context)).rejects.toThrow("exec boundary"); }
  finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    Object.defineProperty(process.stdin, "isTTY", { value: tty.in, configurable: true }); Object.defineProperty(process.stdout, "isTTY", { value: tty.out, configurable: true });
  }
  expect(requests.find(request => request.t === "start")).toMatchObject({ peer: "qwen", args: { mode: "tui" } });
  expect(launched.bin).toBe("qwen");
  expect(launched.env!.PATH).toBe(saved.PATH);                       // without the person's PATH the exec finds no qwen (measured against the real CLI)
  expect(launched.env!.FAKE_PROVIDER_KEY).toBe("person-key");        // and their provider key reaches Qwen without passing through the daemon
  expect(launched.env!.AGENTHUB_PEER_ID).toBe("qwen");               // the hub's marker is over it
  expect(launched.env!.AGENTHUB_RECOVERY_OPERATION).toBeUndefined(); // recovery and unattended authority never reach the native child
  expect(launched.env!.AGENTHUB_UNATTENDED).toBeUndefined();
  expect(launched.env!.AGENTHUB_HOME).toBe("/person-hub");           // the person's hub home is theirs to keep
  for (const name of ["AGENTHUB_CHANNEL", "AGENTHUB_LAUNCH_ID", "AGENTHUB_MODE", "CLAUDECODE"]) expect(launched.env![name]).toBeUndefined(); // another agent's identity never reaches Qwen
});

// ---- through the daemon: the start, the launch the person's terminal runs, the status surface and the stop refusal ----
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

async function daemonRig(version = "0.26.1", watchdogMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "qwen-dual-daemon-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(join(root, ".agenthub"), { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false } }));
  // The configured `qwen_cmd`: the fake, which prints its version for the pre-start gate and speaks dual output when launched.
  const cmd = [process.execPath, FAKE, "--fake-version", version];
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, qwen_cmd: cmd, batch_ms: 0, ...(watchdogMs ? { watchdog_ms: watchdogMs } : {}), memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
  expect((await client.request({ t: "settings_set", key: "roster.qwen", value: true })).ok).toBe(true);
  return { root, stateDir, daemon, client };
}

test("through the daemon: a TUI start returns the launch, the fake attaches, a delivery round-trips, and the hub never stops the person's Qwen", async () => {
  const { stateDir, daemon, client } = await daemonRig();
  const reply = await client.request({ t: "start", peer: "qwen", args: { mode: "tui" } });
  expect(reply.ok).toBe(true); expect(reply.mode).toBe("tui");
  const launch = reply.launch as { cmd: string; args: string[]; env: Record<string, string> };
  expect(launch.args).toContain("--input-file"); expect(launch.args).toContain("--json-file"); expect(launch.args[launch.args.indexOf("--approval-mode") + 1]).toBe("default");
  expect(launch.env.AGENTHUB_PEER_ID).toBe("qwen"); expect(launch.env.AGENTHUB_RECOVERY_OPERATION).toBeUndefined();
  for (const flag of ["--input-file", "--json-file", "--mcp-config"]) expect(launch.args[launch.args.indexOf(flag) + 1]!.startsWith(join(stateDir, "qwen", "qwen-dual"))).toBe(true);
  expect(statSync(launch.args[launch.args.indexOf("--input-file") + 1]!).mode & 0o777).toBe(0o600);
  expect(daemon.bus.peers.get("qwen")!.state).toBe("offline");   // not attached until the TUI says session_start
  // The person's terminal runs exactly this launch (the fake stands in for qwen, minus the MCP config and approval flags it ignores).
  const argv = launch.args.filter((word, index, all) => !(["--mcp-config", "--approval-mode"].includes(word) || ["--mcp-config", "--approval-mode"].includes(all[index - 1] ?? "")));
  const child = Bun.spawn([launch.cmd, ...argv], { env: { PATH: process.env.PATH! }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  await until(() => daemon.bus.peers.get("qwen")!.state === "idle", () => `qwen is ${daemon.bus.peers.get("qwen")!.state}`);
  const replies: string[] = []; daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "qwen") replies.push(event.env.body); });
  daemon.bus.publish(newEnvelope("user", "qwen tui ping", { to: ["qwen"] }));
  await until(() => replies.length === 1);
  const submit = readFileSync(launch.args[launch.args.indexOf("--input-file") + 1]!, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).find(line => line.type === "submit");
  expect(submit.text).toContain("qwen tui ping"); expect(submit.text).toContain("[agent-hub message from"); expect(replies[0]).toContain("echo:");
  // A second start is `already`, and a stop refuses with the right instruction: the hub never signals the person's Qwen.
  expect((await client.request({ t: "start", peer: "qwen", args: { mode: "tui" } })).already).toBe(true);
  const stop = await client.request({ t: "peer_stop", peer: "qwen" });
  expect(stop.ok).toBe(false); expect(String(stop.error)).toContain("its own terminal");
  expect(child.exitCode).toBeNull();
  const headless = await client.request({ t: "start", peer: "qwen", args: { mode: "headless" } });
  expect(headless.ok).toBe(false); expect(String(headless.error)).toContain("end it there");
});

test("through the daemon: a Qwen version outside the dual-output entry is refused before any file is prepared", async () => {
  const { stateDir, client } = await daemonRig("0.26.0");   // verified for headless ACP, not for dual output
  const reply = await client.request({ t: "start", peer: "qwen", args: { mode: "tui" } });
  expect(reply.ok).toBe(false); expect(String(reply.error)).toContain("Version not verified"); expect(String(reply.error)).toContain("0.26.0");
  expect(existsSync(join(stateDir, "qwen"))).toBe(false);
});

test("through the daemon: a stalled turn shows in status with the Esc instruction, and the peer stays busy", async () => {
  const { daemon, client } = await daemonRig("0.26.1", 200);
  const reply = await client.request({ t: "start", peer: "qwen", args: { mode: "tui" } });
  const launch = reply.launch as { cmd: string; args: string[] };
  const argv = launch.args.filter((word, index, all) => !(["--mcp-config", "--approval-mode"].includes(word) || ["--mcp-config", "--approval-mode"].includes(all[index - 1] ?? "")));
  const child = Bun.spawn([launch.cmd, ...argv], { env: { PATH: process.env.PATH! }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  await until(() => daemon.bus.peers.get("qwen")!.state === "idle");
  daemon.bus.publish(newEnvelope("user", "STALL now", { to: ["qwen"] }));
  await until(() => daemon.bus.peers.get("qwen")!.state === "busy");
  let status: any;
  for (let i = 0; i < 300 && !status?.statusNotice; i++) { await Bun.sleep(20); status = (await client.request({ t: "status" })).status.peers.qwen; }
  expect(status.statusNotice.message).toContain("press Esc in the Qwen terminal");
  expect(status.state).toBe("busy");   // reported, not cancelled
  expect(child.exitCode).toBeNull();
});

test("through the daemon: a headless start over a detached but still-running Qwen TUI is refused, and the adapter is not stopped (review finding)", async () => {
  const { daemon, client } = await daemonRig();
  const reply = await client.request({ t: "start", peer: "qwen", args: { mode: "tui" } });
  const launch = reply.launch as { cmd: string; args: string[] };
  const argv = launch.args.filter((word, index, all) => !(["--mcp-config", "--approval-mode"].includes(word) || ["--mcp-config", "--approval-mode"].includes(all[index - 1] ?? "")));
  const child = Bun.spawn([launch.cmd, ...argv], { env: { PATH: process.env.PATH! }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  const peer = daemon.bus.peers.get("qwen") as unknown as QwenDualPeer;
  await until(() => peer.state === "idle" && peer.holdsTerminal());
  const file = argv[argv.indexOf("--json-file") + 1]!;
  renameSync(file, `${file}.moved`); mkdirSync(file);   // the event file becomes unreadable: the peer detaches and reads offline
  await until(() => peer.isDetached);
  expect(peer.state).toBe("offline");
  const headless = await client.request({ t: "start", peer: "qwen", args: { mode: "headless" } });
  expect(headless.ok).toBe(false); expect(String(headless.error)).toContain("end it there");
  expect(daemon.bus.peers.get("qwen")).toBe(peer as any);   // the same adapter: nothing replaced it
  expect(child.exitCode).toBeNull();                        // and the person's Qwen was not touched
  expect((await client.request({ t: "start", peer: "qwen", args: { mode: "tui" } })).already).toBe(true);
});
