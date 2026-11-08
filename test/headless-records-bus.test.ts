import { expect, test } from "bun:test";
import { Bus, type BusEvent, type BusOptions } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, renderDigest, type Envelope, type EnvelopeOpts } from "../src/hub/envelope.ts";

class Peer extends BasePeer {
  got: Envelope[] = [];
  private handout!: () => void;
  readonly delivered = new Promise<void>(resolve => { this.handout = resolve; });
  async deliver(envs: Envelope[]) { this.got.push(...envs); this.handout(); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  answer(text: string, opts?: EnvelopeOpts, complete = true) { return this.finalAnswer(text, opts, complete); }
}
async function rig(input: Partial<EnvelopeOpts> = {}, options: Partial<BusOptions> = {}) {
  const bus = new Bus({ batchMs: 0, ...options }), worker = new Peer("kimi"), recipient = new Peer("jcode");
  const events: BusEvent[] = []; bus.tap(event => events.push(event));
  bus.add(worker); bus.add(recipient); await worker.start();
  const prompt = newEnvelope("jcode", "work", { to: [worker.id], ...input });
  bus.publish(prompt); await worker.delivered;
  return { bus, worker, recipient, prompt, events };
}
test("completed final text is captured before stripping, while envelopes, queued digests and console taps are clean", async () => {
  const f = await rig(); let captured = "", bytes: { before: number; after: number } | undefined;
  f.bus.onFinalAnswer = (_peer, raw) => { captured = raw; };
  f.bus.onFinalAnswerBytes = (_peer, counts) => { bytes = counts; };
  const raw = "Done.\namem: fix | src/a.ts | race -> held gate\namem: invalid";
  f.worker.answer(raw, { inReplyTo: f.prompt, to: [f.recipient.id] });
  expect(captured).toBe(raw);
  expect(bytes?.before).toBe(Buffer.byteLength(raw)); expect(bytes!.after).toBeLessThan(bytes!.before);
  const answers = f.events.filter((e): e is Extract<BusEvent, { t: "envelope" }> => e.t === "envelope" && e.env.from === "kimi");
  expect(answers).toHaveLength(1); expect(answers[0]!.env.body).toBe("Done.");
  await f.recipient.start(); await f.recipient.delivered;
  expect(renderDigest(f.recipient.got, true)).not.toContain("amem:");
  const beforeDigestBytes = Buffer.byteLength(renderDigest([{ ...answers[0]!.env, body: raw }], true));
  const afterDigestBytes = Buffer.byteLength(renderDigest(f.recipient.got, true));
  expect(afterDigestBytes).toBeLessThan(beforeDigestBytes);
  console.info(`Record forwarding fixture bytes: answer ${bytes!.before} -> ${bytes!.after}; digest ${beforeDigestBytes} -> ${afterDigestBytes}`);
  await f.worker.stop(); await f.recipient.stop(); f.bus.closeJournal();
});
test("observer failures cannot leak Record lines or change the existing reply audience", async () => {
  const f = await rig();
  f.bus.onFinalAnswer = () => { throw new Error("capture unavailable"); };
  f.worker.answer("Answer.\namem: decision | - | use a gate", { inReplyTo: f.prompt, to: [f.recipient.id] });
  const answer = f.events.find(e => e.t === "envelope" && e.env.from === "kimi");
  expect(answer?.t === "envelope" && answer.env.body).toBe("Answer.");
  expect(answer?.t === "envelope" && answer.env.to).toEqual([f.recipient.id]);
  await f.worker.stop(); await f.recipient.stop(); f.bus.closeJournal();
});
test("a priority-prefixed invalid Record is removed without changing the remaining answer priority", async () => {
  const f = await rig({ priority: "important" });
  f.worker.answer("[IMPORTANT] amem: invalid\nRemaining answer.", { inReplyTo: f.prompt, to: [f.recipient.id] });
  const answer = f.events.find(e => e.t === "envelope" && e.env.from === "kimi");
  expect(answer?.t === "envelope" && answer.env.body).toBe("Remaining answer.");
  expect(answer?.t === "envelope" && answer.env.priority).toBe("important");
  await f.worker.stop(); await f.recipient.stop(); f.bus.closeJournal();
});
test("private, review-held, unknown-parent and partial finals never become Record captures", async () => {
  for (const mode of ["private", "review", "unknown", "partial"] as const) {
    const f = await rig(mode === "private" ? { private: true } : {}, mode === "review" ? { reviewObserverInputExcluded: () => true } : {});
    let captured = 0; f.bus.onFinalAnswer = () => { captured++; };
    f.worker.answer("Answer.\namem: contract | - | fixed", { inReplyTo: mode === "unknown" ? newEnvelope("user", "other") : f.prompt, to: [f.recipient.id] }, mode !== "partial");
    expect(captured).toBe(0);
    expect(f.events.filter(e => e.t === "envelope" && e.env.from === "kimi").every(e => e.t === "envelope" && !e.env.body.includes("amem:"))).toBe(true);
    await f.worker.stop(); await f.recipient.stop(); f.bus.closeJournal();
  }
});
test("invocation answer keeps its ownership path and strips records without capture", async () => {
  const f = await rig({ kind: "invocation", refs: { invocation: "fixture" } }); let result = "", captured = 0;
  f.bus.onAnswer = (_peer, text) => { result = text; return true; };
  f.bus.onFinalAnswer = () => { captured++; };
  f.worker.answer("Result.\namem: contract | - | hidden record", { inReplyTo: f.prompt, to: [f.recipient.id] });
  expect(result).toBe("Result.\n"); expect(captured).toBe(0);
  expect(f.events.filter(e => e.t === "envelope" && e.env.from === "kimi")).toHaveLength(0);
  await f.worker.stop(); await f.recipient.stop(); f.bus.closeJournal();
});
