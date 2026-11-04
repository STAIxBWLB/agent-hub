import { isReviewObserverExcluded } from "../src/hub/memory-policy.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { definitionOf } from "../src/adapters/registry.ts";
import { isWsPeer } from "../src/adapters/channel-peer.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { HUB, newEnvelope, remoteEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { Board, isClosedTaskState } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { SESSION_TITLE_HINT, DOING_STUB, sessionTitleBindings, unnamedSessionLabel } from "../src/hub/peer-doing.ts";

class NativeTitlePeer extends BasePeer {
  constructor() { super("pi"); }
  get titleSession() { return "native-session"; }
  get sessionTitle() { return ""; }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}

test("a failing optional title journal read cannot skip invocation, pending task or supervision ACK bookkeeping", async () => {
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("  bus.onDelivered ="), end = source.indexOf("  bus.onPulled =", start);
  const sessionStart = source.indexOf("  const contextSession ="), sessionEnd = source.indexOf("  const activityRings", sessionStart);
  const reviewHeldStart = source.indexOf("  const reviewObserverHeld ="), reviewHeldEnd = source.indexOf("  const invocations =", reviewHeldStart);
  const presenceStart = source.indexOf("  const presenceOnlyDelivery ="), presenceEnd = source.indexOf("\n", presenceStart);
  const deliveryKeyStart = source.indexOf("  const reviewObserverDeliveryKey ="), deliveryKeyEnd = source.indexOf("\n", deliveryKeyStart);
  const inputScopeStart = source.indexOf("  const reviewInputHeld ="), inputScopeEnd = source.indexOf("  const notePulledReviewInput =", inputScopeStart);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); expect(sessionEnd).toBeGreaterThan(sessionStart);
  expect(reviewHeldStart).toBeGreaterThan(0); expect(reviewHeldEnd).toBeGreaterThan(reviewHeldStart);
  expect(presenceStart).toBeGreaterThan(0); expect(deliveryKeyStart).toBeGreaterThan(0); expect(inputScopeStart).toBeGreaterThan(0); expect(inputScopeEnd).toBeGreaterThan(inputScopeStart);
  const peer = new NativeTitlePeer(), bus = new Bus({}), stateRoot = mkdtempSync(join(tmpdir(), "session-title-observer-")), board = new Board(join(stateRoot, "hub.db"));
  bus.add(peer); await peer.start();
  const currentReviewObserverInputs = new Map<string, { held: boolean }>(), pendingReviewObserverInputs = new Map<string, { held: boolean }>();
  const readReviewObserverScope = (id: string) => pendingReviewObserverInputs.get(id)?.held === true || currentReviewObserverInputs.get(id)?.held === true ? "open-review-comments" : undefined;
  const pendingDeliveryTask = new Map([["pi", 7]]), supervisionTurns = new Map(), delivered: string[] = [];
  let reads = 0;
  let journalThrows = true, journalRow: unknown;
  const unexpected = () => { throw new Error("unrelated policy/effect path reached"); };
  const context = {
    Buffer, HUB, randomUUID, definitionOf, isWsPeer, remoteEnvelope, sessionTitleBindings, isReviewObserverExcluded, progress:{clearPeer(){}},
    bus, board, currentReviewObserverInputs, pendingReviewObserverInputs, readReviewObserverScope,
    firstTitleMessages: new Map(), titleBindings: { pi: { session: "native-session", delivery: "old-delivery", envelope: "old-envelope" } },
    journal: { get: () => { reads++; if (journalThrows) throw new Error("journal unavailable"); return journalRow; } },
    titleBindingFile: "unused", atomicPrivateJSON: unexpected, claudeSession: unexpected,
    invocations: { markDelivered: (id: string) => delivered.push(id) }, pendingDeliveryTask, supervisionTurns,
    turns: new Map([["pi", { id: "active-turn", start: 123, tokens: 7 }]]),
  };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `${source.slice(presenceStart, presenceEnd)}\n${source.slice(deliveryKeyStart, deliveryKeyEnd)}\n${source.slice(inputScopeStart, inputScopeEnd)}\n`
    + source.slice(sessionStart, sessionEnd) + source.slice(reviewHeldStart, reviewHeldEnd) + source.slice(start, end));
  try {
    runInNewContext(script, context);
    const invoke = newEnvelope(HUB, "invocation", { kind: "invocation" }); invoke.refs = { invocation: invoke.id };
    const supervision = newEnvelope(HUB, "supervision", { kind: "task", refs: { supervision: true } });
    (context.bus.onDelivered as (peer: string, envs: unknown[], id: string) => void)("pi", [invoke, supervision], "new-delivery");
    expect(reads).toBe(1); expect(delivered).toEqual([invoke.id]); expect(pendingDeliveryTask.has("pi")).toBe(false);
    expect(supervisionTurns.get("pi")).toMatchObject({ id: "active-turn", at: 123, tokens: 7 });

    // Restart title recovery must reject a persisted ordinary member of a mixed quote-bearing delivery row.
    const oldReview = newEnvelope(HUB, "old review quote", { to: ["pi"], kind: "review", priority: "important", refs: { task: "7", reviewPackage: "review:title-restore" } });
    const oldOrdinary = newEnvelope("user", "OLD_RESTORED_TITLE_CANARY", { to: ["pi"] });
    context.firstTitleMessages.clear();
    context.titleBindings = { pi: { session: "native-session", delivery: "old-delivery", envelope: oldOrdinary.id } };
    journalRow = { peer: "pi", originals: [oldReview, oldOrdinary] }; journalThrows = false;
    const fresh = newEnvelope("user", "FRESH_TITLE_CANARY", { to: ["pi"] });
    (context.bus.onDelivered as (peer: string, envs: Envelope[], id: string) => void)("pi", [fresh], "fresh-delivery");
    expect((context.firstTitleMessages as Map<string, { env: Envelope }>).get("pi")?.env.id).toBe(fresh.id);
    expect(reads).toBe(2);
  } finally { board.close(); bus.closeJournal(); rmSync(stateRoot, { recursive: true, force: true }); }
});

test("unknown optional journal evidence does not fail live DOING projection", async () => {
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const doingRows ="), end = source.indexOf("  // A Claude session's title", start);
  const privacy = source.split("\n").find(line => line.startsWith("  const contextPii ="))!;
  const titleStart = source.indexOf("  const titlePrivate ="), titleEnd = source.indexOf("  type TitleResult", titleStart);
  const scopeStart = source.indexOf("  const reviewObserverHeld ="), scopeEnd = source.indexOf("  const invocations =", scopeStart);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  expect(scopeStart).toBeGreaterThan(0); expect(scopeEnd).toBeGreaterThan(scopeStart);
  const peer = new NativeTitlePeer(); await peer.start();
  const unexpected = () => { throw new Error("unexpected privacy port call"); };
  const currentReviewObserverInputs = new Map<string, { held: boolean }>(), pendingReviewObserverInputs = new Map<string, { held: boolean }>();
  const readReviewObserverScope = (id: string) => pendingReviewObserverInputs.get(id)?.held === true || currentReviewObserverInputs.get(id)?.held === true ? "open-review-comments" : undefined;
  const review = newEnvelope(HUB, "RESTORED_REVIEW_QUOTE_CANARY", { to: ["pi"], kind: "review", priority: "important", refs: { task: "1", reviewPackage: "review:restored-title" } });
  const clean = { ...newEnvelope("user", "CLEAN_TITLE_CANARY", { to: ["pi"] }), id: "e1" };
  let journalMode: "mixed" | "ordinary" | "throw" = "mixed";
  const context = { definitionOf, remoteEnvelope, isReviewObserverExcluded, isClosedTaskState, DOING_STUB, SESSION_TITLE_HINT, unnamedSessionLabel,
    bus: { peers: new Map([["pi", peer]]), stateOf: () => peer.state, lastDeliveredTo:()=>[] }, board: { list: () => [], peerTaskSignals: () => [] },
    tasks: { isPii: unexpected, publicMetadataText: (text: string) => text === "CLEAN_TITLE_CANARY" }, turns: new Map(), doings: new Map(), privateTitleWrites: new Map(),
    firstTitleMessages: new Map(), titleBindings: { pi: { session: "native-session", delivery: "d1", envelope: "e1" } },
    currentReviewObserverInputs, pendingReviewObserverInputs, readReviewObserverScope,
    journal: { get: () => { if (journalMode === "throw") throw new Error("journal unavailable"); return { peer: "pi", originals: journalMode === "mixed" ? [review, clean] : [clean] }; } }, extracted: undefined as unknown,
  };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`${privacy}\n${source.slice(scopeStart, scopeEnd)}\n${source.slice(titleStart, titleEnd)}\n${source.slice(start, end)}\nglobalThis.extracted=doingRows;`);
  runInNewContext(script, context);
  const doingRows = context.extracted as (ids: string[], includeIncomingLabels?: boolean) => Record<string, { text: string; source: string }>;
  expect(doingRows(["pi"], true)).toEqual({});
  journalMode = "ordinary";
  expect(doingRows(["pi"], true).pi).toMatchObject({ text: "CLEAN_TITLE_CANARY", source: "label" });
  journalMode = "throw"; context.firstTitleMessages.clear();
  expect(doingRows(["pi"], true)).toEqual({});
});
