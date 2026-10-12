import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPetConfig } from "../src/cli/pet-config.ts";
import { attentionLine } from "../src/cli/attention.ts";
import { needs } from "../src/ui/needs.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";

test("pet config merges local presentation options and false disables all drawing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-pet-"));
  try {
    mkdirSync(join(cwd, ".agenthub"));
    expect(loadPetConfig(cwd)).toEqual({ enabled: true, blink: true, bell: false });
    writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ pet: { blink: false, bell: true } }));
    writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ pet: { bell: false } }));
    expect(loadPetConfig(cwd)).toEqual({ enabled: true, blink: false, bell: false });
    writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ pet: false }));
    expect(loadPetConfig(cwd).enabled).toBe(false);
    writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ pet: { character: "PRIVATE_MARKER" } }));
    expect(loadPetConfig(cwd).notice).toBeDefined();
    expect(JSON.stringify(loadPetConfig(cwd))).not.toContain("PRIVATE_MARKER");
  } finally { rmSync(cwd, { recursive: true }); }
});

test("only approval deadlines blink, with an explicit static escape", () => {
  const waiting = needs({ approvals: [{ id: "request", expiresAt: 3000 }] }, 0);
  expect(attentionLine(waiting, 0, true)).not.toBe(attentionLine(waiting, 1000, true));
  expect(attentionLine(waiting, 0, false)).toBe(attentionLine(waiting, 1000, false));
  for (const input of [{ storageBlocked: true }, { messages: [{ important: true }] }, { peers: { codex: { state: "busy" } } }, {}]) {
    const value = needs(input, 0);
    expect(attentionLine(value, 0, true)).toBe(attentionLine(value, 1000, true));
  }
});

test("plain attention prints changed act counts and no-pet preserves the stream", async () => {
  for (const noPet of [false, true]) {
    const cwd = mkdtempSync(join(tmpdir(), "ahub-pet-plain-"));
    let output = "";
    let signal = () => {};
    let key = (_text: string) => {};
    const terminal: ConsoleTerminal = { columns: 70, rows: 20, isTTY: true, write: text => { output += text; }, raw: () => {}, onData: fn => { key = fn; return () => {}; }, onSignal: fn => { signal = fn; return () => {}; }, onResize: () => () => {} };
    const client: any = { request: async () => ({}), send: () => {}, close: () => {}, onPush: undefined, onClose: undefined };
    const running = runConsole({ cwd, stateDir: cwd, client, terminal, noPet, color: false });
    try {
      const event = { t: "event", e: { t: "envelope", env: { id: "message-1", from: "codex", to: ["user"], priority: "important", kind: "chat", body: "fixture body", ts: 1000, trace: "trace", hop: 0 } } };
      client.onPush(event);
      const after = output;
      client.onPush({ t: "notice", line: "ordinary notice" });
      expect((output.match(/1 for review/g) ?? []).length).toBe(noPet ? 0 : 1);
      if (!noPet) expect(after).toContain("(O O) ? 1 for review");
      else expect(output).not.toContain("(O O)");
      key("x");
      if (!noPet) expect(output).toContain("(O O) z asleep");
      expect(output).not.toContain("\x07");
    } finally { signal(); await running; rmSync(cwd, { recursive: true }); }
  }
});
