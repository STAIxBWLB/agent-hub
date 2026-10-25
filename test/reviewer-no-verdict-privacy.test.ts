import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { looksSecret } from "@staix/agent-mem";
import { Board, isClosedTaskState } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { ASK_NOTE_TITLE } from "../src/hub/ask.ts";
import { withoutPii, mentionsPrivatePath } from "../src/hub/memory-policy.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { ReviewerPrintPeer, reviewerNoVerdictLine, type ReviewerNoVerdict, type ReviewerPrintOptions } from "../src/adapters/reviewer-print.ts";
import { codexReviewerBackend } from "../src/adapters/codex-review-isolation.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(nativeTrace?: { hostRefusals: string[]; nativeRefusal: string }) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-review-diagnostic-privacy-")), board = new Board(join(cwd, "board.db")), bus = new Bus({ batchMs: 0 }), routing = loadRouting(cwd);
  const ready = join(cwd, "trace-ready"), release = join(cwd, "trace-release");
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", routing: () => routing, notify: () => {} });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const peer = "codex-review";
  const options: ReviewerPrintOptions = { cwd, mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000, verdictSince: () => false,
    bindingCurrent: (task, binding) => tasks.reviewBindingCurrent(peer, task, binding),
    backend: { id: "fixture", prepare: async () => {
      if (!nativeTrace) throw new Error("this policy fixture never launches a process");
      const frame = { type: "item.completed", item: { type: "mcp_tool_call", server: "agent-hub", tool: "hub_review", error: { message: nativeTrace.nativeRefusal } } };
      return { command: [process.execPath, "-e", `await new Response(Bun.stdin.stream()).text(); await Bun.write(${JSON.stringify(ready)}, "ready"); for(let n=0;n<200 && !await Bun.file(${JSON.stringify(release)}).exists();n++)await Bun.sleep(5); if(!await Bun.file(${JSON.stringify(release)}).exists())process.exit(1); console.log(JSON.stringify(${JSON.stringify(frame)}));`], args: [],
        isolation: { backend: "fixture", binary: process.execPath, version: "fixture", profile: "fixture", readOnly: true, strictMcp: true, ephemeral: true, evidence: ["fixture only"] } };
    }, toolTrace: event => codexReviewerBackend.toolTrace?.(event) } };
  const reviewer = new ReviewerPrintPeer(peer, options);
  bus.add(reviewer);
  const proposed = board.propose("user", { title: "synthetic review", class: "summarize" });
  board.update(proposed.id, "builder", "accepted", { state: "in_progress", owner: "builder" });
  const task = board.update(proposed.id, "builder", "done", { state: "in_review", reviewer: peer, refs: { commit: "a".repeat(40) } });
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const declaration = (name: string) => { const start = source.indexOf(`  const ${name} =`), end = source.indexOf(";\n", start); expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); return source.slice(start, end + 1); };
  const start = source.indexOf("        onNoVerdict:"), end = source.indexOf("        onUnavailable:", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const logs: string[] = [], turns = new Map<string, { private: boolean }>();
  const code = declaration("screenMemory") + "\n" + declaration("boundedSafe") + "\n" + declaration("contextPii")
    + "\nconst options = {" + source.slice(start, end) + "}; globalThis.diagnostic = options.onNoVerdict;";
  const diagnostic = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(code) + "\ndiagnostic", {
    board, tasks, bus, peer, reviewer, turns, looksSecret, ASK_NOTE_TITLE, withoutPii, mentionsPrivatePath, isClosedTaskState,
    activeRouting: () => routing, opts: { cwd }, config: { pii: { paths: ["private/"] }, local: { deny: ["denied/"] } },
    reviewerNoVerdictLine, log: (line: string) => logs.push(line),
  }) as (value: ReviewerNoVerdict, current: () => boolean) => void;
  if (nativeTrace) { options.onNoVerdict = diagnostic; cleanup.push(() => reviewer.stop()); }
  return { board, bus, peer, reviewer, task, turns, logs, diagnostic, ready, release };
}

test("a full host refusal survives its truncated native echo and differing later host refusals stay uncertain", async () => {
  for (const mode of ["secret-tail", "differing-hosts"] as const) {
    const prefix = "SAFE_REFUSAL_PREFIX ".repeat(300), full = prefix + "token: abcdefgh12345678";
    const hostRefusals = mode === "secret-tail" ? [full] : ["first safe host refusal", "different safe host refusal"];
    const f = fixture({ hostRefusals, nativeRefusal: prefix.slice(0, 4000) });
    await f.reviewer.start();
    await f.reviewer.deliver([newEnvelope(HUB, "synthetic review", { kind: "review", to: [f.peer], refs: { task: String(f.task.id), commit: "a".repeat(40), reviewRevision: String(f.task.history.length) } })]);
    for (let count = 0; count < 200 && !existsSync(f.ready); count++) await Bun.sleep(5);
    expect(existsSync(f.ready)).toBe(true); expect(f.reviewer.reviewing).toBe(f.task.id);
    for (const refusal of hostRefusals) f.reviewer.recordToolTrace(f.task.id, { tool: "hub_review", refusal });
    writeFileSync(f.release, "release");
    for (let count = 0; count < 200 && f.reviewer.state !== "idle"; count++) await Bun.sleep(5);
    expect(f.reviewer.state).toBe("idle"); expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain("refusal: withheld"); expect(f.logs[0]).not.toContain("SAFE_REFUSAL_PREFIX");
    await f.reviewer.stop();
  }
});

test("production no-verdict diagnostics screen the full refusal before bounding and withhold stale/private metadata", () => {
  for (const mode of ["safe", "secret-tail", "private-tail", "denied-tail", "task-private", "turn-private", "head-changed", "detached", "generation"] as const) {
    const f = fixture(); let currentGeneration = true;
    const prefix = "SAFE_REFUSAL_PREFIX ".repeat(100);
    const refusal = prefix + (mode === "secret-tail" ? "token: abcdefgh12345678" : mode === "private-tail" ? "private/records.ts" : mode === "denied-tail" ? "denied/records.ts" : "expected verdict refusal");
    if (mode === "task-private") f.board.update(f.task.id, "user", "fixture private", { signals: ["pii"] });
    if (mode === "turn-private") f.turns.set(f.peer, { private: true });
    if (mode === "head-changed") f.board.update(f.task.id, "user", "fixture head", { refs: { commit: "b".repeat(40) } });
    if (mode === "detached") f.bus.peers.delete(f.peer);
    if (mode === "generation") currentGeneration = false;
    f.diagnostic({ task: f.task.id, head: "a".repeat(40), flowRevision: f.task.history.length, exitCode: 0, reviewCalled: true, lastTool: "hub_review", refusal }, () => currentGeneration);
    expect(f.logs).toHaveLength(1); const line = f.logs[0]!;
    expect(line).not.toContain("\n"); expect(Array.from(line).length).toBeLessThan(500);
    if (mode === "safe") expect(line).toContain("SAFE_REFUSAL_PREFIX");
    else { expect(line).not.toContain("SAFE_REFUSAL_PREFIX"); expect(line).toContain("withheld"); }
    if (["task-private", "turn-private", "head-changed", "detached", "generation"].includes(mode)) expect(line).not.toContain("last hub tool");
  }
});
