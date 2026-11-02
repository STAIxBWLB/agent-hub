import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { newToolRequestId, toolWriteOperation, toolWriteUnknownReply } from "../src/hub/tool-request.ts";
import { operationalRequestLabel, operationalRefusal, OPERATIONAL_PERSON_GUIDANCE } from "../src/hub/operational-authority.ts";
import { newEnvelope, USER } from "../src/hub/envelope.ts";

const resultBody = (reply: Record<string, unknown>) => { const { rid: _rid, ...body } = reply; return body; };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(options: { screen?: boolean; piiScreen?: (text: string) => Promise<{ label: "clear" | "pii" | "unknown"; ms: number }>; capabilities?: Record<string, string[]> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-tool-write-daemon-")); roots.push(root);
  const stateDir = join(root, ".agenthub", "state"); mkdirSync(stateDir, { recursive: true });
  if (options.screen) writeFileSync(join(root, ".agenthub", "routing.toml"), '[local]\nfixed_model = "coding"\n[signals]\npii_screen = "local"\n[constraints]\npii = "local_only"\n');
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
      capabilities: { ...DEFAULT_CONFIG.capabilities, ...(options.capabilities ?? {}) } },
    piiScreen: options.piiScreen ?? (async () => ({ label: "clear", ms: 0 })),
  });
  const board = new Board(join(stateDir, "hub.db"));
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
  const codex = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: root });
  return { root, stateDir, daemon, board, person, codex };
}

test("selected task writes replay one result by request ID while unrelated operations retain ordinary behavior", async () => {
  const f = await fixture();
  try {
    expect(f.person.features).toContain("tool_write_idempotency");
    const requestId = newToolRequestId(f.person.instanceId!);
    const args = { title: "synthetic idempotent proposal", class: "implement", refs: { paths: ["src/hub/bus.ts"] } };
    const [first, replay] = await Promise.all([
      f.codex.request({ t: "task", op: "hub_task_propose", args, requestId }),
      f.codex.request({ t: "task", op: "hub_task_propose", args, requestId }),
    ]);
    expect(resultBody(first)).toEqual(resultBody(replay));
    expect(first.rid).not.toBe(replay.rid);
    const rows = f.board.list().filter(task => task.title === args.title);
    expect(rows).toHaveLength(1);
    expect(first).toMatchObject({ ok: true, requestId });

    const changedActor = await f.person.request({ t: "task", op: "hub_task_propose", args, requestId });
    expect(changedActor).toMatchObject({ ok: false, outcome: "unknown", requestId });
    expect(f.board.list().filter(task => task.title === args.title)).toHaveLength(1);

    const proposed = f.board.propose(USER, { title: "synthetic review fixture", class: "implement", refs: { paths: ["src/hub/bus.ts"] } });
    f.board.update(proposed.id, "codex", "accepted", { owner: "codex", reviewer: USER, state: "in_progress" });
    f.board.update(proposed.id, "codex", "done", { state: "in_review" });
    const reviewId = newToolRequestId(f.person.instanceId!);
    const reviewArgs = { id: proposed.id, verdict: "approved" };
    const [review, reviewReplay] = await Promise.all([
      f.person.request({ t: "task", op: "hub_review", args: reviewArgs, requestId: reviewId }),
      f.person.request({ t: "task", op: "hub_review", args: reviewArgs, requestId: reviewId }),
    ]);
    expect(resultBody(review)).toEqual(resultBody(reviewReplay));
    expect(review.rid).not.toBe(reviewReplay.rid);
    expect(review).toMatchObject({ ok: true, requestId: reviewId });
    expect(f.board.get(proposed.id)?.history.filter(entry => entry.event === "approved")).toHaveLength(1);

    const peerReviewed = f.board.propose(USER, { title: "synthetic peer-review fixture", class: "implement", refs: { paths: ["src/hub/bus.ts"] } });
    f.board.update(peerReviewed.id, "claude", "accepted", { owner: "claude", reviewer: "codex", state: "in_progress" });
    f.board.update(peerReviewed.id, "claude", "done", { state: "in_review" });
    const peerReviewId = newToolRequestId(f.codex.instanceId!);
    const peerReviewArgs = { id: peerReviewed.id, verdict: "approved" };
    const [peerReview, peerReviewReplay] = await Promise.all([
      f.codex.request({ t: "task", op: "hub_review", args: peerReviewArgs, requestId: peerReviewId }),
      f.codex.request({ t: "task", op: "hub_review", args: peerReviewArgs, requestId: peerReviewId }),
    ]);
    expect(resultBody(peerReview)).toEqual(resultBody(peerReviewReplay));
    expect(peerReview.rid).not.toBe(peerReviewReplay.rid);
    expect(peerReview).toMatchObject({ ok: true, requestId: peerReviewId });
    expect(f.board.get(peerReviewed.id)?.history.filter(entry => entry.event === "approved")).toHaveLength(1);

    const piiReview = f.board.propose(USER, { title: "synthetic private review fixture", class: "implement", signals: ["pii_path"], refs: { paths: ["private/fixture.md"] } });
    f.board.update(piiReview.id, "codex", "accepted", { owner: "codex", reviewer: USER, state: "in_progress" });
    f.board.update(piiReview.id, "codex", "done", { state: "in_review" });
    const piiReviewId = newToolRequestId(f.person.instanceId!);
    const piiReviewArgs = { id: piiReview.id, verdict: "approved" };
    const [piiVerdict, piiReplay] = await Promise.all([
      f.person.request({ t: "task", op: "hub_review", args: piiReviewArgs, requestId: piiReviewId }),
      f.person.request({ t: "task", op: "hub_review", args: piiReviewArgs, requestId: piiReviewId }),
    ]);
    expect(resultBody(piiVerdict)).toEqual(resultBody(piiReplay));
    expect(piiVerdict.rid).not.toBe(piiReplay.rid);
    expect(piiVerdict).toMatchObject({ ok: true, requestId: piiReviewId });
    expect(f.board.get(piiReview.id)?.history.filter(entry => entry.event === "approved")).toHaveLength(1);

    const invalid = await f.codex.request({ t: "task", op: "hub_task_propose", args: { title: "different payload", class: "implement" }, requestId });
    expect(invalid).toMatchObject({ ok: false, outcome: "unknown", requestId });
    expect(f.board.list().filter(task => task.title === "different payload")).toHaveLength(0);
  } finally { f.person.close(); f.codex.close(); f.board.close(); await f.daemon.stop(); }
});

test("invalid or missing review task ids keep Tasks' known refusal and replay without a board write", async () => {
  const f = await fixture();
  try {
    const revision = f.board.statusRevision();
    for (const id of ["not-a-task-id", 999_999]) {
      const requestId = newToolRequestId(f.person.instanceId!);
      const request = { t: "task", op: "hub_review", requestId, args: { id, verdict: "approved" } };
      const first = await f.person.request(request);
      const replay = await f.person.request(request);
      expect(resultBody(first)).toEqual(resultBody(replay));
      expect(first.rid).not.toBe(replay.rid);
      expect(first).toMatchObject({ ok: false, requestId });
      expect(first.outcome).toBeUndefined();
      expect(String(first.error)).toMatch(/id|task/i);
    }
    expect(f.board.statusRevision()).toBe(revision);
  } finally { f.person.close(); f.codex.close(); f.board.close(); await f.daemon.stop(); }
});

test("self owner normalization and empty owner do not acquire assignment capability", async () => {
  const f = await fixture({ capabilities: { codex: ["propose"] } });
  try {
    const upperOwner = await f.codex.request({ t: "task", op: "hub_task_propose", requestId: newToolRequestId(f.codex.instanceId!), args: {
      title: "synthetic normalized self claim", class: "implement", owner: "Codex", plan: { paths: ["src/hub/bus.ts"] }, refs: { paths: ["src/hub/bus.ts"] },
    } });
    expect(upperOwner.ok).toBe(true);
    expect(f.board.list().find(task => task.title === "synthetic normalized self claim")).toBeDefined();

    const emptyOwner = await f.codex.request({ t: "task", op: "hub_task_propose", requestId: newToolRequestId(f.codex.instanceId!), args: {
      title: "synthetic empty owner", class: "implement", owner: "", refs: { paths: ["src/hub/bus.ts"] },
    } });
    expect(emptyOwner.ok).toBe(true);
    expect(f.board.list().find(task => task.title === "synthetic empty owner")).toBeDefined();
  } finally { f.person.close(); f.codex.close(); f.board.close(); await f.daemon.stop(); }
});

test("a ControlClient timeout remains unknown while an identical retry joins the pending screened proposal", async () => {
  let enterScreen!: () => void, releaseScreen!: (verdict: { label: "clear"; ms: number }) => void, screenCalls = 0;
  const entered = new Promise<void>(resolve => { enterScreen = resolve; });
  const screening = new Promise<{ label: "clear"; ms: number }>(resolve => { releaseScreen = resolve; });
  const f = await fixture({ screen: true, piiScreen: async () => { screenCalls++; enterScreen(); return screening; } });
  try {
    const requestId = newToolRequestId(f.codex.instanceId!);
    const request = { t: "task", op: "hub_task_propose", requestId, args: { title: "synthetic deferred proposal", class: "implement", detail: "synthetic public detail" } };
    const firstPending = f.codex.request(request, 1);
    await entered;
    const timeout = await firstPending;
    expect(timeout).toMatchObject({ ok: false, outcome: "unknown", requestId });

    const replayPending = f.codex.request(request);
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseScreen({ label: "clear", ms: 0 });
    const replay = await replayPending;
    expect(replay).toMatchObject({ ok: true, requestId });
    expect(screenCalls).toBe(1);
    expect(f.board.list().filter(task => task.title === "synthetic deferred proposal")).toHaveLength(1);
  } finally { f.person.close(); f.codex.close(); f.board.close(); await f.daemon.stop(); }
});

test("a cached public proposal is withheld if its task becomes PII before replay", async () => {
  const f = await fixture();
  try {
    const requestId = newToolRequestId(f.codex.instanceId!);
    const args = { title: "synthetic proposal that becomes private", class: "implement", owner: "claude", refs: { paths: ["src/hub/bus.ts"] } };
    const first = await f.codex.request({ t: "task", op: "hub_task_propose", requestId, args });
    expect(first.ok).toBe(true);
    expect(String(first.text)).toContain("was not assigned");
    const taskId = Number(/task #(\d+):/.exec(String(first.text))?.[1]);
    expect(Number.isSafeInteger(taskId)).toBe(true);
    f.board.update(taskId, USER, "mark synthetic task private", { signals: ["pii_path"], refs: { paths: ["private/fixture.md"] } });
    const replay = await f.codex.request({ t: "task", op: "hub_task_propose", requestId, args });
    expect(replay).toMatchObject({ ok: false, outcome: "unknown", requestId });
    expect(String(replay.error)).not.toContain(args.title);
  } finally { f.person.close(); f.codex.close(); f.board.close(); await f.daemon.stop(); }
});

test("a PII proposal still replays the exact fixed public task receipt", async () => {
  const f = await fixture({ screen: true, piiScreen: async () => ({ label: "pii", ms: 0 }) });
  try {
    const requestId = newToolRequestId(f.codex.instanceId!);
    const args = { title: "synthetic private title", class: "implement", refs: { paths: ["private/fixture.md"] } };
    const request = { t: "task", op: "hub_task_propose", requestId, args };
    const [first, replay] = await Promise.all([f.codex.request(request), f.codex.request(request)]);
    expect(resultBody(first)).toEqual(resultBody(replay));
    expect(first.rid).not.toBe(replay.rid);
    expect(first).toMatchObject({ ok: true, requestId });
    expect(first.text).toMatch(/^task #[1-9]\d*: (?:backlog|proposed|in_progress|in_review|approved|changes_requested|cancelled), owner (?:none|[a-z][a-z0-9-]{0,31}), reviewer (?:none|[a-z][a-z0-9-]{0,31})$/);
    expect(String(first.text)).not.toContain(args.title);
    expect(String(first.text)).not.toContain("private/fixture.md");
  } finally { f.person.close(); f.codex.close(); f.board.close(); await f.daemon.stop(); }
});

test("delivery completion replay remains bound to the attached socket and generation", async () => {
  const f = await fixture();
  let claude: ControlClient | undefined;
  try {
    claude = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: true, projectRoot: f.root });
    let pushed: { deliveryId: string; generation: string } | undefined;
    claude.onPush = message => {
      if (message.t === "deliver" && typeof message.deliveryId === "string" && typeof message.generation === "string") pushed = { deliveryId: message.deliveryId, generation: message.generation };
    };
    const envelope = newEnvelope(USER, "synthetic handled delivery", { to: ["claude"], kind: "task" });
    f.daemon.bus.publish(envelope);
    for (let n = 0; n < 200 && !pushed; n++) await Bun.sleep(5);
    expect(pushed).toBeDefined();
    const delivery = pushed!;
    expect(await claude.request({ t: "delivery_receipt", ...delivery, state: "accepted" })).toMatchObject({ ok: true });
    const requestId = newToolRequestId(claude.instanceId!);
    const settlement = { t: "delivery_complete", ...delivery, requestId };
    const [first, replay] = await Promise.all([claude.request(settlement), claude.request(settlement)]);
    expect(resultBody(first)).toEqual(resultBody(replay));
    expect(first.rid).not.toBe(replay.rid);
    expect(first).toMatchObject({ ok: true, requestId });
    expect(f.daemon.bus.queueShow(delivery.deliveryId)?.state).toBe("completed");
    const wrongGeneration = await claude.request({ ...settlement, generation: "wrong-generation" });
    expect(wrongGeneration).toMatchObject({ ok: false, error: "delivery does not belong to this connection generation" });
    expect(wrongGeneration.outcome).toBeUndefined();
  } finally { claude?.close(); f.person.close(); f.codex.close(); f.board.close(); await f.daemon.stop(); }
});


test("the final revoked-owner reply fence preserves uncertainty metadata without returning cached text", () => {
  const source = readFileSync(join(import.meta.dir, "../src/hub/daemon.ts"), "utf8");
  const start = source.indexOf("    const reply = (body: Record<string, unknown>) => {", source.indexOf("  function onMessage("));
  const end = source.indexOf("    const runTaskRequest", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const snippet = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  const makeReply = new Function("c", "msg", "sock", "operationalRequestLabel", "currentExternalTools", "currentImplementerTools", "event", "operationalRefusal", "OPERATIONAL_PERSON_GUIDANCE", "toolWriteOperation", "toolWriteUnknownReply", `let refusalRecorded = false; ${snippet}; return reply;`);
  for (const owner of ["externalOwner", "toolsOwner"]) {
    for (const unknown of [false, true]) {
      const id = newToolRequestId("fixture-instance"), sent: string[] = [];
      const msg = { t: "task", op: "hub_task_propose", rid: 17, requestId: id, args: { title: "synthetic task" } };
      const c = { authed: true, role: "tools", peer: "codex", [owner]: {} };
      // These deny-only ports exercise response classification, never native admission or execution.
      const reply = makeReply(c, msg, { readyState: WebSocket.OPEN, send: (data: string) => sent.push(data) },
        operationalRequestLabel, () => false, () => false, () => true, operationalRefusal, OPERATIONAL_PERSON_GUIDANCE, toolWriteOperation, toolWriteUnknownReply);
      reply(unknown ? { ok: false, outcome: "unknown", requestId: id, error: "original pending receipt" }
        : { ok: true, requestId: id, text: "private/should-not-leak" });
      expect(sent).toHaveLength(1);
      const result = JSON.parse(sent[0]!);
      expect(result).toMatchObject({ rid: 17, ok: false, outcome: "unknown", requestId: id });
      expect(result.error).toContain("hub_task_list"); expect(sent[0]).not.toContain("private/should-not-leak");
    }
  }
});
