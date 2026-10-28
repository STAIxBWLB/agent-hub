import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask, citedIds, type AskDeps } from "../src/hub/ask.ts";
import { Board } from "../src/hub/board.ts";
import { DEFAULT_INFERENCE, Inference } from "../src/hub/inference.ts";
import type { MemoryClient } from "../src/memory/client.ts";
import type { OmniRoute } from "../src/omniroute/client.ts";
import { noteCitationId } from "../src/hub/corpus-evidence.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-ask-corpus-"));
  const board = new Board(join(dir, "hub.db"));
  cleanup.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls: { model: string; options: { onCampusOnly?: boolean } }[] = [];
  let selectedModel = "host/local-fixed";
  const omni = {
    base: async () => "http://127.0.0.1:43000",
    chat: async (body: { model: string }, options: { onCampusOnly?: boolean }) => {
      calls.push({ model: body.model, options });
      return { message: { content: "A public note answers this [note:notes/plan.md#launch]." } };
    },
  } as unknown as OmniRoute;
  const inference = new Inference(DEFAULT_INFERENCE, { omni, fixedModel: () => selectedModel, log: () => {} });
  const deps: AskDeps = {
    board,
    isPii: task => task.signals.includes("pii"),
    onCampus: async () => true,
    project: "agent-hub",
    logFile: join(dir, "missing.log"),
    inference,
  };
  return { board, calls, deps, setModel: (model: string) => { selectedModel = model; } };
}

const noteId = noteCitationId("note:notes/研究, [A]#1\\z.md", "계획 검토");

test("ask accepts an exact corpus citation with Unicode and escaped citation delimiters", async () => {
  const { deps } = fixture();
  const id = noteId;
  deps.corpus = () => [{ id, kind: "note", text: "# 계획 검토\nAurora launch window is in spring." }];
  deps.inference = new Inference(DEFAULT_INFERENCE, {
    omni: {
      base: async () => "http://127.0.0.1:43000",
      chat: async () => ({ message: { content: `The launch window is in spring [${id}].` } }),
    } as unknown as OmniRoute,
    fixedModel: () => "host/local-fixed",
    log: () => {},
  });

  const result = await ask("Aurora launch window", deps);
  expect(result.found).toBe(true);
  expect(citedIds(result.answer!)).toEqual([id]);
  expect(result.evidence).toContainEqual({ id, kind: "note", text: "# 계획 검토\nAurora launch window is in spring." });
});

test("ask drops a syntactically valid but invented corpus citation", async () => {
  const { deps } = fixture();
  deps.corpus = () => [{ id: "note:notes/plan.md#launch", kind: "note", text: "launch details" }];
  deps.inference = new Inference(DEFAULT_INFERENCE, {
    omni: {
      base: async () => "http://127.0.0.1:43000",
      chat: async () => ({ message: { content: "A different note says so [note:notes/other.md#launch]." } }),
    } as unknown as OmniRoute,
    fixedModel: () => "host/local-fixed",
    log: () => {},
  });

  const result = await ask("launch details", deps);
  expect(result.found).toBe(false);
  expect(result.note).toContain("note:notes/other.md#launch");
});

test("PII questions, PII tasks, and private context skip corpus, memory, and native retrieval", async () => {
  for (const mode of ["pii-question", "pii-task", "private-context"] as const) {
    const { deps, calls } = fixture();
    let corpusReads = 0, nativeReads = 0, memoryReads = 0;
    const memory = {
      search: async () => { memoryReads++; return ""; },
      timeline: async () => { memoryReads++; return ""; },
    } as unknown as MemoryClient;
    deps.memory = memory;
    deps.native = () => { nativeReads++; return []; };
    deps.corpus = () => { corpusReads++; return [{ id: "note:notes/plan.md#launch", kind: "note", text: "private note" }]; };
    if (mode === "pii-question") {
      deps.isPiiText = text => text.includes("2026-1234567");
      deps.onCampus = async () => false;
      await ask("student 2026-1234567", deps);
    } else if (mode === "pii-task") {
      deps.board.propose("user", { title: "student score record", class: "implement", signals: ["pii"] });
      deps.onCampus = async () => false;
      await ask("student score record", deps);
    } else {
      deps.privateContext = () => true;
      deps.onCampus = async () => false;
      await ask("launch details", deps);
    }
    expect(corpusReads).toBe(0);
    expect(memoryReads).toBe(0);
    expect(nativeReads).toBe(0);
    expect(calls).toHaveLength(0);
  }
});

test("a PII task requires an on-campus call and pins the selected host model before gateway probing", async () => {
  const { board, calls, deps, setModel } = fixture();
  board.propose("user", { title: "student score record", class: "implement", signals: ["pii"] });
  deps.corpus = () => { throw new Error("PII task must not read corpus"); };
  deps.inference = new Inference(DEFAULT_INFERENCE, {
    omni: {
      base: async () => { setModel("provider/changed-after-campus-check"); return "http://127.0.0.1:43000"; },
      chat: async (body: { model: string }, options: { onCampusOnly?: boolean }) => {
        calls.push({ model: body.model, options });
        return { message: { content: "The record is on the board [task #1]." } };
      },
    } as unknown as OmniRoute,
    fixedModel: () => "host/local-fixed",
    log: () => {},
  });

  const result = await ask("student score record", deps);
  expect(result.pii).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({ model: "host/local-fixed", options: expect.objectContaining({ onCampusOnly: true }) });
});

test("false or unknown campus status prevents a PII model call", async () => {
  for (const onCampus of [async () => false, async () => { throw new Error("probe failed"); }] as const) {
    const { board, calls, deps } = fixture();
    board.propose("user", { title: "student score record", class: "implement", signals: ["pii"] });
    deps.onCampus = onCampus;
    const result = await ask("student score record", deps);
    expect(result.answer).toBeUndefined();
    expect(result.note).toContain("no on-campus model");
    expect(calls).toHaveLength(0);
  }
});

test("a caller or policy change during corpus retrieval suppresses the model call", async () => {
  const { deps, calls } = fixture();
  let current = true;
  deps.current = () => current;
  deps.corpus = () => {
    current = false;
    return [{ id: "note:notes/plan.md#launch", kind: "note", text: "launch details" }];
  };

  const result = await ask("launch details", deps);
  expect(result.found).toBe(false);
  expect(result.note).toContain("context changed");
  expect(result.evidence).toEqual([]);
  expect(calls).toHaveLength(0);
});

test("a caller change while the gateway is being probed suppresses transport", async () => {
  const { deps, calls } = fixture();
  let current = true;
  deps.current = () => current;
  deps.corpus = () => [{ id: "note:notes/plan.md#launch", kind: "note", text: "launch details" }];
  deps.inference = new Inference(DEFAULT_INFERENCE, {
    omni: {
      base: async () => { current = false; return "http://127.0.0.1:43000"; },
      chat: async (body: { model: string }, options: { onCampusOnly?: boolean }) => {
        calls.push({ model: body.model, options });
        return { message: { content: "A launch detail [note:notes/plan.md#launch]." } };
      },
    } as unknown as OmniRoute,
    fixedModel: () => "host/local-fixed",
    log: () => {},
  });

  const result = await ask("launch details", deps);
  expect(result.found).toBe(false);
  expect(result.note).toContain("context changed");
  expect(calls).toHaveLength(0);
});
