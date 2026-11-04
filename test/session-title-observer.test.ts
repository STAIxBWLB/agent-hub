import { isReviewObserverExcluded } from "../src/hub/memory-policy.ts";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { definitionOf } from "../src/adapters/registry.ts";
import { isWsPeer } from "../src/adapters/channel-peer.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { HUB, newEnvelope, remoteEnvelope } from "../src/hub/envelope.ts";
import { isClosedTaskState } from "../src/hub/board.ts";
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
  const start = source.indexOf("  bus.onDelivered ="), end = source.indexOf("  bus.onDeliveryFailed =", start);
  const sessionStart = source.indexOf("  const contextSession ="), sessionEnd = source.indexOf("  const activityRings", sessionStart);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); expect(sessionEnd).toBeGreaterThan(sessionStart);
  const peer = new NativeTitlePeer(); await peer.start();
  const pendingDeliveryTask = new Map([["pi", 7]]), supervisionTurns = new Map(), delivered: string[] = [];
  let reads = 0;
  const unexpected = () => { throw new Error("unrelated policy/effect path reached"); };
  const context = {
    Buffer, HUB, randomUUID, definitionOf, isWsPeer, remoteEnvelope, sessionTitleBindings, isReviewObserverExcluded, progress:{clearPeer(){}},
    bus: { peers: new Map([["pi", peer]]), onDelivered: undefined as unknown },
    firstTitleMessages: new Map(), titleBindings: { pi: { session: "native-session", delivery: "old-delivery", envelope: "old-envelope" } },
    journal: { get: () => { reads++; throw new Error("journal unavailable"); } },
    titleBindingFile: "unused", atomicPrivateJSON: unexpected, claudeSession: unexpected,
    invocations: { markDelivered: (id: string) => delivered.push(id) }, pendingDeliveryTask, supervisionTurns,
    turns: new Map([["pi", { id: "active-turn", start: 123, tokens: 7 }]]),
  };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(sessionStart, sessionEnd) + source.slice(start, end));
  runInNewContext(script, context);
  const invoke = newEnvelope(HUB, "invocation", { kind: "invocation" }); invoke.refs = { invocation: invoke.id };
  const supervision = newEnvelope(HUB, "supervision", { kind: "task", refs: { supervision: true } });
  (context.bus.onDelivered as (peer: string, envs: unknown[], id: string) => void)("pi", [invoke, supervision], "new-delivery");
  expect(reads).toBe(1); expect(delivered).toEqual([invoke.id]); expect(pendingDeliveryTask.has("pi")).toBe(false);
  expect(supervisionTurns.get("pi")).toMatchObject({ id: "active-turn", at: 123, tokens: 7 });
});

test("unknown optional journal evidence does not fail live DOING projection", async () => {
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const doingRows ="), end = source.indexOf("  // A Claude session's title", start);
  const privacy = source.split("\n").find(line => line.startsWith("  const contextPii ="))!;
  const titleStart = source.indexOf("  const titlePrivate ="), titleEnd = source.indexOf("  type TitleResult", titleStart);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const peer = new NativeTitlePeer(); await peer.start();
  const unexpected = () => { throw new Error("unexpected privacy port call"); };
  const context = { definitionOf, remoteEnvelope, isReviewObserverExcluded, isClosedTaskState, DOING_STUB, SESSION_TITLE_HINT, unnamedSessionLabel,
    bus: { peers: new Map([["pi", peer]]), stateOf: () => peer.state, lastDeliveredTo:()=>[] }, board: { list: () => [], peerTaskSignals: () => [] },
    tasks: { isPii: unexpected, publicMetadataText: unexpected }, turns: new Map(), doings: new Map(), privateTitleWrites: new Map(),
    firstTitleMessages: new Map(), titleBindings: { pi: { session: "native-session", delivery: "d1", envelope: "e1" } },
    journal: { get: () => { throw new Error("journal unavailable"); } }, extracted: undefined as unknown,
  };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`${privacy}\n${source.slice(titleStart, titleEnd)}\n${source.slice(start, end)}\nglobalThis.extracted=doingRows;`);
  runInNewContext(script, context);
  expect((context.extracted as (ids: string[]) => unknown)(["pi"])).toEqual({});
});
