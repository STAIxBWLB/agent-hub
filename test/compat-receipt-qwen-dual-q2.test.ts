import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQwenDualBusQ2, type Q2NativePorts, type Q2Request } from "../scripts/compat-receipts/proofs/qwen-dual-bus-q2.ts";

// These controls write synthetic event files. No Qwen executable, account, model, PTY or real HOME is used.
function fixture(mode: "ordinary" | "tool-stop" | "merged") {
  const root = mkdtempSync(join(tmpdir(), "qwen-dual-q2-control-"));
  let input = "", output = "", offset = 0, released = false, closed = false;
  let watcher: FSWatcher | undefined, fault: unknown;
  let held!: () => void;
  const firstHeld = new Promise<void>(resolve => { held = resolve; });
  const requests: Q2Request[] = [], submitsAtRelease: number[] = [];
  const write = (...rows: object[]) => appendFileSync(output, rows.map(row => JSON.stringify(row) + "\n").join(""));
  const user = (text: string) => ({ type: "user", message: { content: [{ type: "text", text }] } });
  const assistant = (text: string) => ({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text }] } });
  const stop = { type: "stream_event", event: { type: "message_stop" } };
  const records = () => readFileSync(input, "utf8").split("\n").filter(Boolean).map(row => JSON.parse(row));
  const consume = () => {
    if (closed) return;
    try {
      const rows = records();
      for (; offset < rows.length; offset++) {
        const row = rows[offset];
        if (row.type !== "submit") throw Error("unexpected synthetic input");
        if (offset === 0) {
          requests.push({ marker: "first", responseFormat: "absent", schemaHasTitle: false, messageCount: 2, userMessages: 1 });
          write(user(row.text), { type: "stream_event", event: { type: "content_block_delta", delta: { text: "Q2_FIRST_BEGIN" } } });
          if (mode === "tool-stop") write({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "fixture-tool", name: "fixture" }] } }, stop);
          held();
        } else if (offset === 1) {
          if (!released) throw Error("second input escaped while first was held");
          requests.push({ marker: "second", responseFormat: "absent", schemaHasTitle: false, messageCount: 4, userMessages: 2 });
          write(user(row.text), assistant("Q2_SECOND_DONE"), stop);
        } else throw Error("too many synthetic submits");
      }
    } catch (error) { fault = error; held(); }
  };
  const ports: Q2NativePorts = {
    kind: "synthetic-control",
    async start(launch) {
      input = launch.args[launch.args.indexOf("--input-file") + 1]!;
      output = launch.args[launch.args.indexOf("--json-file") + 1]!;
      watcher = watch(input, consume);
      write({ type: "system", subtype: "session_start", session_id: "fixture-q2-session", data: {
        version: "0.26.1", protocol_version: 2, supported_events: ["user", "assistant", "stream_event", "control_request", "control_response"],
      } });
    },
    async firstHeld() { await firstHeld; if (fault) throw fault; },
    releaseFirst() {
      const count = records().filter(row => row.type === "submit").length;
      submitsAtRelease.push(count); released = true;
      write(assistant(mode === "merged" ? "Q2_FIRST_DONE Q2_SECOND_DONE" : "Q2_FIRST_DONE"), stop);
    },
    requests: () => requests,
    async stop() { closed = true; watcher?.close(); return { ownedStopConfirmed: true }; },
  };
  return { root, ports, submitsAtRelease, fault: () => fault, close: () => { closed = true; watcher?.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const mode of ["ordinary", "tool-stop"] as const) test(`manual Q2 actual Bus/driver keeps a held turn's second envelope queued: ${mode}`, async () => {
  const f = fixture(mode);
  try {
    const result = await runQwenDualBusQ2({ cwd: f.root, stateDir: join(f.root, "state"), command: ["synthetic-not-executed"], version: "0.26.1",
      bounds: { bytes: 1024 * 1024, records: 256, timeoutMs: 4000 }, host: { table: () => [], pollMs: 5 } }, f.ports);
    expect(f.fault()).toBeUndefined();
    expect(result.passed).toBe(true); expect(result.checkpoint).toBe("passed");
    expect(result.heldSubmitCount).toBe(1); expect(result.heldQueued).toBe(true);
    expect(f.submitsAtRelease).toEqual([1]);
    expect(result.userCount).toBe(2); expect(result.firstStop).toBeLessThan(result.secondUser); expect(result.secondUser).toBeLessThan(result.secondStop);
    expect(result.providerRequests.map(row => row.marker)).toEqual(["first", "second"]);
    expect(result.evidenceKind).toBe("synthetic-control"); expect(result.autoAdmit).toBe(false); expect(result.ownedStopConfirmed).toBe(true);
  } finally { f.close(); }
});

test("manual Q2 refuses the old one-assistant/both-markers false-positive shape", async () => {
  const f = fixture("merged");
  try {
    const result = await runQwenDualBusQ2({ cwd: f.root, stateDir: join(f.root, "state"), command: ["synthetic-not-executed"], version: "0.26.1",
      bounds: { bytes: 1024 * 1024, records: 256, timeoutMs: 4000 }, host: { table: () => [], pollMs: 5 } }, f.ports);
    expect(result.passed).toBe(false); expect(result.checkpoint).toBe("merged-final-assistant");
    expect(result.autoAdmit).toBe(false); expect(result.ownedStopConfirmed).toBe(true);
  } finally { f.close(); }
});
