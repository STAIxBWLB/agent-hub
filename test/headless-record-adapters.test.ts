import { expect, test } from "bun:test";
import { RECORD_INSTRUCTION } from "@staix/agent-mem";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope, type EnvelopeOpts } from "../src/hub/envelope.ts";
import { AcpPeer } from "../src/adapters/acp.ts";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { LocalPeer } from "../src/adapters/local-worker.ts";
import type { ChatMessage, ChatResult, OmniRoute } from "../src/omniroute/client.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

class RecordFixture extends BasePeer {
  constructor() { super("local"); }
  async start(): Promise<void> { this.setState("idle"); }
  async stop(): Promise<void> { this.setState("offline"); }
  async deliver(_envs: Envelope[]): Promise<void> {}
  prompt(base: string): string { return this.turnRecordPrompt(base); }
  answer(text: string, opts?: EnvelopeOpts, complete = true): unknown { return this.finalAnswer(text, opts, complete); }
}

test("the inherited Record boundary uses the imported instruction once and preserves absent/failed getter prompts", () => {
  const peer = new RecordFixture(), base = "fixed standing prompt";
  expect(peer.prompt(base)).toBe(base);
  let reads = 0;
  peer.recordInstruction = () => { reads++; return RECORD_INSTRUCTION; };
  const prompt = peer.prompt(base);
  expect(prompt).toBe(`${base}\n\n${RECORD_INSTRUCTION}`);
  expect(peer.prompt(prompt)).toBe(prompt);
  expect(reads).toBe(2);
  peer.recordInstruction = () => undefined;
  expect(peer.prompt(base)).toBe(base);
  peer.recordInstruction = () => { throw new Error("PRIVATE_POLICY_FAILURE"); };
  expect(peer.prompt(base)).toBe(base);
});

test("final answers retain options, partial status and hook return value while explicit sends remain separate", () => {
  const peer = new RecordFixture(), opts: EnvelopeOpts = { to: ["user"], private: true, priority: "important" };
  const ordinary: string[] = [], finals: { body: string; opts?: EnvelopeOpts; complete?: boolean }[] = [];
  peer.onMessage = body => { ordinary.push(body); return "ordinary-result"; };
  expect(peer.answer("legacy answer", opts)).toBe("ordinary-result");
  peer.onFinalAnswer = (body, options, complete) => { finals.push({ body, opts: options, complete }); return "final-result"; };
  expect(peer.answer("normal answer", opts)).toBe("final-result");
  peer.answer("partial answer", opts, false);
  peer.onMessage("explicit tool send");
  expect(finals).toEqual([{ body: "normal answer", opts, complete: true }, { body: "partial answer", opts, complete: false }]);
  expect(finals[0]!.opts).toBe(opts);
  expect(ordinary).toEqual(["legacy answer", "explicit tool send"]);
});

test("Codex's real renderer decorates delivered turns without decorating native steer prompts", () => {
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, cwd: process.cwd(), preamble: "fixed role" });
  const renderer = peer as unknown as { render(envs: Envelope[], record?: boolean): string; primed: boolean };
  const envs = [newEnvelope("user", "ordinary delivery")];
  const initial = renderer.render(envs);
  let reads = 0;
  peer.recordInstruction = () => { reads++; return RECORD_INSTRUCTION; };
  const first = renderer.render(envs, true);
  expect(first.split(RECORD_INSTRUCTION)).toHaveLength(2);
  expect(first).toContain("fixed role");
  expect(renderer.render(envs)).toBe(initial);
  renderer.primed = true;
  const later = renderer.render(envs, true);
  expect(later.split(RECORD_INSTRUCTION)).toHaveLength(2);
  expect(later).not.toContain("fixed role");
  expect(renderer.render(envs)).not.toContain(RECORD_INSTRUCTION);
  expect(reads).toBe(2);
});

test("ACP's actual delivered turns use one instruction and classify native partial completion separately", async () => {
  const peer = new AcpPeer("kimi", { cmd: [process.execPath, `${import.meta.dir}/fakes/acp-server.ts`], cwd: process.cwd(), preamble: "fixed role" });
  const prompts: string[] = [], answers: { body: string; opts?: EnvelopeOpts; complete?: boolean }[] = [], ordinary: string[] = [];
  // Observe the real request promise unchanged; the committed fake still supplies all protocol replies.
  const port = peer as unknown as { request(method: string, params: { [key: string]: unknown }): Promise<unknown> };
  const request = port.request.bind(peer);
  port.request = (method, params) => {
    if (method === "session/prompt") prompts.push((params.prompt as { text: string }[])[0]!.text);
    return request(method, params);
  };
  let reads = 0;
  peer.recordInstruction = () => { expect(peer.state).toBe("busy"); reads++; return RECORD_INSTRUCTION; };
  peer.onMessage = body => ordinary.push(body);
  peer.onFinalAnswer = (body, opts, complete) => answers.push({ body, opts, complete });
  try {
    await peer.start();
    for (const text of ["ordinary delivery", "PARTIAL_CAPPED"]) {
      const idle = new Promise<void>(resolve => { peer.onState = state => { if (state === "idle") resolve(); }; });
      const env = newEnvelope("user", text);
      await peer.deliver([env]); await idle;
      expect(answers.at(-1)!.opts?.inReplyTo?.id).toBe(env.id);
      expect(answers.at(-1)!.opts?.to).toEqual(["user"]);
    }
    expect(reads).toBe(2); expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(prompt.split(RECORD_INSTRUCTION)).toHaveLength(2);
    expect(prompts[0]).toContain("fixed role"); expect(prompts[1]).not.toContain("fixed role");
    expect(answers.map(answer => [answer.body, answer.complete])).toEqual([["echo: ordinary delivery", true], ["partial work", false]]);
    expect(ordinary).toEqual([]);
  } finally { await peer.stop(); }
});


test("Local keeps one fixed Record prompt through tool rounds and marks a step-capped answer incomplete", async () => {
  for (const maxSteps of [1, 2]) {
    const cwd = mkdtempSync(join(tmpdir(), "ahub-record-local-"));
    writeFileSync(join(cwd, "a.txt"), "fixed local evidence");
    const calls: ChatMessage[][] = [], answers: { text: string; complete?: boolean }[] = [];
    let reads = 0;
    const transport = {
      onCampus: async () => true,
      chat: async (body: { messages: ChatMessage[] }): Promise<ChatResult> => {
        calls.push(body.messages);
        if (body.messages.some(message => message.role === "tool")) return { message: { role: "assistant", content: "finished" } };
        return { message: { role: "assistant", content: "reading", tool_calls: [{ id: "r1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] } };
      },
    };
    let inputBound = false;
    const peer = new LocalPeer("local", { cwd, fixedModel: "fixture", omni: transport as unknown as OmniRoute,
      beforeInput: () => { inputBound = true; }, maxSteps, tools: { deny: [], permit: async () => true } });
    peer.recordInstruction = () => { expect(inputBound).toBe(true); expect(peer.state).toBe("busy"); reads++; return RECORD_INSTRUCTION; };
    peer.onFinalAnswer = (text, _opts, complete) => answers.push({ text, complete });
    try {
      await peer.start();
      const idle = new Promise<void>(resolve => { peer.onState = state => { if (state === "idle") resolve(); }; });
      await peer.deliver([newEnvelope("user", "read a.txt")]); await idle;
      expect(reads).toBe(1); expect(calls).toHaveLength(maxSteps);
      for (const messages of calls) {
        expect(messages[0]!.role).toBe("system");
        expect(messages[0]!.content!.split(RECORD_INSTRUCTION)).toHaveLength(2);
        expect(messages[0]!.content).toBe(calls[0]![0]!.content);
      }
      expect(answers).toHaveLength(1);
      expect(answers[0]!.complete).toBe(maxSteps === 2);
      expect(answers[0]!.text).toBe(maxSteps === 2 ? "finished" : "(stopped after 1 steps) reading");
    } finally { await peer.stop(); rmSync(cwd, { recursive: true, force: true }); }
  }
});


test("Codex samples the Record getter after busy establishes the new host-owned turn", async () => {
  class ReadyCodex extends CodexPeer {
    ready(): void { this.setState("idle"); }
    finish(): void { this.setState("offline"); }
  }
  const peer = new ReadyCodex("codex", { proxyPort: 0, appPort: 0, cwd: process.cwd() });
  const port = peer as unknown as { link: unknown; threadId: string; pending: Map<number, { resolve(result: unknown): void }> };
  const requests: { method: string; id: number; params: { input: { text: string }[] } }[] = [];
  port.link = { up: { readyState: WebSocket.OPEN, send(raw: string) {
    const request = JSON.parse(raw) as typeof requests[number]; requests.push(request);
    port.pending.get(request.id)!.resolve({ turn: { id: "owned-codex-turn" } });
  } } };
  port.threadId = "owned-thread";
  let ownedTurn = false, reads = 0;
  peer.onState = state => { if (state === "busy") ownedTurn = true; };
  peer.recordInstruction = () => { expect(peer.state).toBe("busy"); expect(ownedTurn).toBe(true); reads++; return RECORD_INSTRUCTION; };
  peer.ready();
  try {
    await peer.deliver([newEnvelope("user", "ordinary delivery")]);
    expect(reads).toBe(1); expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("turn/start");
    expect(requests[0]!.params.input[0]!.text.split(RECORD_INSTRUCTION)).toHaveLength(2);
  } finally { peer.finish(); }
});
