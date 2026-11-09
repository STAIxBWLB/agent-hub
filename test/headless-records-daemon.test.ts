import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { matchesPolicy } from "../src/hub/path-policy.ts";
import { runInNewContext } from "node:vm";
import { CaptureStore, configuredPolicy, recordsEnabled, RECORD_INSTRUCTION } from "@staix/agent-mem";
import { preferRecordItems, type RecordBriefSnapshot } from "../src/memory/brief.ts";
import { GeneratedNoteRegistry } from "../src/memory/record-provenance.ts";
import { recallFor } from "../src/memory/recall.ts";
import type { MemoryClient } from "../src/memory/client.ts";
import { RecordCapture } from "../src/memory/records.ts";
import { isInvocationKind, newEnvelope, remoteEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer, type PeerAdapter } from "../src/hub/peers.ts";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class Headless extends BasePeer {
  session = "synthetic-native-session";
  sessionGeneration = 1;
  get nativeSession() { return this.session; }
  begin() { this.setState("busy"); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_input: Envelope[]) {}
}
const record = "amem: fix | src/main.ts#run | synthetic failure -> synthetic repair";

/** Execute the actual daemon binding block with fixed host ports, real RecordCapture and a disposable library store. */
function fixture(policy: "enabled" | "disabled" | "production" | "throw" = "enabled", worktree = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-records-daemon-")), cwd = join(root, "project"), memoryDir = join(root, "memory"); mkdirSync(cwd);
  const executionCwd = worktree ? join(root, "worktree") : cwd; if (worktree) mkdirSync(executionCwd);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const owner = new Headless("codex"); owner.begin(); cleanups.push(() => owner.stop());
  const turn = { id: "synthetic-turn", start: Date.now() }, turns = new Map<string, typeof turn>([[owner.id, turn]]);
  const original = newEnvelope("user", "public fixture", { to: [owner.id] });
  const bus: { peers: Map<string, PeerAdapter>; isRecoveryHeld: boolean; onFinalAnswer?: (peer: string, raw: string, context: { out: Envelope[]; originals: Envelope[] }) => void; onFinalAnswerBytes?: (peer: string, counts: { before: number; after: number }) => void } = { peers: new Map([[owner.id, owner]]), isRecoveryHeld: false };
  let reads = 0, version = "one", privateTurn = false, review = false, recovery = false, attached = false, profile = "profile-one";
  const logs: string[] = [];
  const generatedRecordNotes = new GeneratedNoteRegistry();
  const binding = { home: memoryDir, assertCurrent() {} };
  const state = { config: { memory: { enabled: true }, local: { deny: [] }, pii: { paths: [] as string[] } }, stopping: false, configRevision: 0,
    opts: { cwd, ...(policy === "production" ? {} : { effectiveRecordPolicy: () => { reads++; if (policy === "throw") throw Error("closed fixture policy failure"); return { enabled: policy === "enabled", version }; } }) },
    bus, turns, captureBinding: binding, memoryProblem: undefined, memoryProject: "synthetic-project", memoryProjectFor: () => "synthetic-project",
    memorySyncPolicyVersion: () => profile, recoveryActive: () => recovery, membershipAllowed: () => true, frontendProxyState: () => attached ? { present: true, port: { attached: true } } : { present: false },
    reviewOnlyPeer: () => false, definitionOf: () => ({}), contextPii: () => privateTurn, reviewInputHeld: () => review, reviewObserverInput: () => review,
    isReviewObserverExcluded: () => false, isInvocationKind, remoteEnvelope, boundedSafe: (text: string) => !text.includes("PRIVATE_CANARY"),
    tasks: { publicMetadataText: (text: string) => !text.includes("PRIVATE_CANARY") }, looksSecret: (text: string) => text.includes("SECRET_CANARY"),
    isDenied: (path: string) => path.startsWith("private/"), matchesPolicy: (_cwd: string, _path: string, _paths: string[], _includeParents = false) => false, log: (text: string) => logs.push(text), RecordCapture, CaptureStore, configuredPolicy, recordsEnabled, generatedRecordNotes, preferRecordItems, Buffer, resolve, sanitize: (text: string) => text, corpusBriefAllowed: () => true,
  };
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8"), start = source.indexOf("  const recordOwners ="), end = source.indexOf("  // Hoisted for the Tasks ports above", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end) + "\nglobalThis.records = {bind:bindRecordOwner, inputs:recordInputs, close:closeRecordFrame, read:readRecordSnapshot, steer:noteRecordSteered, project:projectRecordRecall};");
  runInNewContext(script, state);
  const ports = (state as typeof state & { records: { bind(owner: PeerAdapter, cwd: string, session: () => string | undefined): void; inputs: Map<string, { owner: PeerAdapter; originals: Envelope[]; tainted?: true }>; steer(peer: string, originals: Envelope[]): void; close(peer: string): void; read(task?: { owner?: string; title: string; refs: { paths?: string[] } }): RecordBriefSnapshot | undefined; project(peer: string, original: string, tokens: number): { before: string; after: string; records?: number; current?: () => boolean } | undefined } }).records;
  const hookStart = source.indexOf("onGeneratedNote: "), hookEnd = source.indexOf(", onNote:", hookStart);
  expect(hookStart).toBeGreaterThan(0); expect(hookEnd).toBeGreaterThan(hookStart);
  runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync("globalThis.generatedNote = " + source.slice(hookStart + "onGeneratedNote: ".length, hookEnd) + ";"), state);
  const generatedNote = (state as typeof state & { generatedNote: (proof: { id: string; anchors: string[] }) => void }).generatedNote;
  expect(typeof generatedNote).toBe("function");
  ports.bind(owner, executionCwd, () => owner.nativeSession); ports.inputs.set(owner.id, { owner, originals: [original] });
  cleanups.push(() => ports.close(owner.id));
  const rows = () => {
    if (!existsSync(memoryDir)) return [];
    const store = new CaptureStore({ memoryDir, project: "synthetic-project", cwd, readOnly: true });
    try { return store.rows({ limit: 10 }); } finally { store.close(); }
  };
  return { owner, bus, turns, ports, logs, rows, state, cwd, executionCwd, memoryDir, original, generatedNote, generatedRecordNotes, reads: () => reads,
    private: () => { privateTurn = true; }, review: () => { review = true; }, clearReview: () => { review = false; }, recovery: () => { recovery = true; }, attached: () => { attached = true; },
    policyChanged: () => { version = "two"; }, profileChanged: () => { profile = "profile-two"; },
    finish: (raw: string, input = original) => bus.onFinalAnswer!(owner.id, raw, { out: [input], originals: [input] }) };
}

test("daemon host binding captures valid public final Records with immutable host attribution and numeric-only diagnostics", () => {
  const f = fixture(); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION);
  f.finish(`Shared answer\n${record}\namem: invalid fixture\namem: fix | private/run.ts | synthetic denied -> synthetic repair`);
  expect(f.rows()).toHaveLength(1); expect(f.rows()[0]).toMatchObject({ project: "synthetic-project", agent: "codex", event: "Record", excerpt: record, paths: ["src/main.ts#run"] });
  expect(f.logs).toContain(`records capture accepted=1 dropped=2 bytes=${Buffer.byteLength(record)}`);
  f.bus.onFinalAnswerBytes?.(f.owner.id, { before: 200, after: 12 }); expect(f.logs).toContain("records forwarded before=200 after=12");
  expect(f.logs.join("\n")).not.toContain("synthetic-native-session"); expect(f.logs.join("\n")).not.toContain("src/main.ts"); expect(f.logs.join("\n")).not.toContain("synthetic failure");
});

test("daemon false or unreadable host Record policy override remains disabled", () => {
  for (const mode of ["disabled", "throw"] as const) {
    const f = fixture(mode); expect(f.owner.recordInstruction?.()).toBeUndefined(); f.finish(record);
    expect(f.rows()).toEqual([]); expect(f.logs).toEqual([]);
  }
});

test("production Record policy defaults enabled through the active disposable memory binding without a host override", () => {
  const f = fixture("production");
  expect(Object.hasOwn(f.state.opts, "effectiveRecordPolicy")).toBe(false);
  expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION); f.finish(record);
  expect(f.rows()).toHaveLength(1); expect(f.reads()).toBe(0);
});

test("production machine or execution-repository records false narrows an opposing true flag", () => {
  for (const disabled of ["machine", "repository"] as const) {
    const f = fixture("production", true);
    mkdirSync(f.memoryDir); mkdirSync(join(f.executionCwd, ".git")); mkdirSync(join(f.executionCwd, ".amem"));
    writeFileSync(join(f.memoryDir, "amem.config.json"), JSON.stringify({ records: disabled !== "machine" }));
    writeFileSync(join(f.executionCwd, ".amem/config"), JSON.stringify({ records: disabled !== "repository" }));
    expect(Object.hasOwn(f.state.opts, "effectiveRecordPolicy")).toBe(false);
    expect(f.executionCwd).not.toBe(f.cwd);
    expect(f.owner.recordInstruction?.()).toBeUndefined(); f.finish(record);
    expect(existsSync(join(f.memoryDir, "projects"))).toBe(false); expect(f.ports.read({ owner: "codex", title: "Synthetic task", refs: {} })).toBeUndefined();
    expect(f.logs).toEqual([]);
  }
});

test("production malformed machine or execution-repository Record configuration refuses without a host override", () => {
  for (const location of ["machine", "repository"] as const) for (const malformed of ["not JSON", JSON.stringify({ records: "false" })]) {
    const f = fixture("production", true);
    mkdirSync(f.memoryDir); mkdirSync(join(f.executionCwd, ".git")); mkdirSync(join(f.executionCwd, ".amem"));
    writeFileSync(location === "machine" ? join(f.memoryDir, "amem.config.json") : join(f.executionCwd, ".amem/config"), malformed);
    expect(f.owner.recordInstruction?.()).toBeUndefined(); f.finish(record);
    expect(existsSync(join(f.memoryDir, "projects"))).toBe(false); expect(f.ports.read({ owner: "codex", title: "Synthetic task", refs: {} })).toBeUndefined();
    expect(f.logs).toEqual([]);
  }
});

test("production late machine or execution-repository flag drift revokes capture and existing read projections", () => {
  for (const location of ["machine", "repository"] as const) {
    const f = fixture("production", true);
    mkdirSync(f.memoryDir); mkdirSync(join(f.executionCwd, ".git")); mkdirSync(join(f.executionCwd, ".amem"));
    expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION); f.finish(record);
    const snapshot = f.ports.read({ owner: "codex", title: "Synthetic task", refs: { paths: ["src/main.ts"] } });
    const original = `# [amem] recent curated context\n\n### Curated short-term notes\nmem:${"f".repeat(32)} contract: Unrelated public contract.`;
    const projection = f.ports.project("codex", original, 10_000);
    expect(snapshot?.current?.()).toBe(true); expect(projection?.current?.()).toBe(true);
    const logs = [...f.logs];
    writeFileSync(location === "machine" ? join(f.memoryDir, "amem.config.json") : join(f.executionCwd, ".amem/config"), JSON.stringify({ records: false }));
    expect(f.owner.recordInstruction?.()).toBeUndefined(); f.finish(record.replace("synthetic failure", "synthetic late failure"));
    expect(f.rows()).toHaveLength(1); expect(snapshot?.current?.()).toBe(false); expect(projection?.current?.()).toBe(false);
    expect(f.ports.read({ owner: "codex", title: "Synthetic task", refs: {} })).toBeUndefined(); expect(f.logs).toEqual(logs);
  }
});

test("private/review/recovery/TUI/invocation/remote inputs refuse before the effective policy is read", () => {
  for (const exclude of ["private", "review", "recovery", "attached", "invocation", "remote"] as const) {
    const f = fixture();
    if (exclude === "invocation") f.ports.inputs.set(f.owner.id, { owner: f.owner, originals: [newEnvelope("hub", "fixture", { kind: "invocation" })] });
    else if (exclude === "remote") f.ports.inputs.set(f.owner.id, { owner: f.owner, originals: [newEnvelope("user", "fixture", { to: ["qwen@room"] })] });
    else f[exclude]();
    expect(f.owner.recordInstruction?.()).toBeUndefined(); f.finish(record);
    expect(f.reads()).toBe(0); expect(f.rows()).toEqual([]); expect(f.logs).toEqual([]);
  }
});

test("owner/session/turn/profile/policy changes fence a late final frame and private final originals are rechecked", () => {
  for (const change of ["owner", "session", "generation", "turn", "profile", "policy", "private", "final-private"] as const) {
    const f = fixture(); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION);
    if (change === "owner") { const replacement = new Headless("codex"); replacement.begin(); cleanups.push(() => replacement.stop()); f.bus.peers.set("codex", replacement); }
    else if (change === "session") f.owner.session = "replacement-session";
    else if (change === "generation") f.owner.sessionGeneration++;
    else if (change === "turn") f.turns.set("codex", { id: "replacement-turn", start: 1_700_000_000_001 });
    else if (change === "profile") f.profileChanged(); else if (change === "policy") f.policyChanged(); else if (change === "private") f.private();
    f.finish(record, change === "final-private" ? newEnvelope("user", "fixture", { private: true }) : f.original);
    expect(f.rows()).toEqual([]); expect(f.logs).toEqual([]);
  }
});


test("capture denies lexical and resolved private paths under the execution worktree", () => {
  const f = fixture("enabled", true); f.state.config.pii.paths = ["private/"];
  f.state.matchesPolicy = matchesPolicy;
  mkdirSync(join(f.executionCwd, "private")); writeFileSync(join(f.executionCwd, "private/safe.ts"), "public fixture");
  symlinkSync(join(f.executionCwd, "private/safe.ts"), join(f.executionCwd, "public-link.ts"));
  expect(f.executionCwd).not.toBe(f.cwd); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION);
  f.finish("amem: fix | private/safe.ts#run | synthetic failure -> synthetic repair\namem: fix | public-link.ts#run | synthetic failure -> synthetic repair");
  expect(f.rows()).toEqual([]); expect(f.logs).toContain("records capture accepted=0 dropped=2 bytes=0");
});

test("anchorless public decisions and contracts remain project-scoped candidates without authorizing note replacement", () => {
  const f = fixture(); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION);
  const decision = "amem: decision | - | synthetic public decision", contract = "amem: contract | - | synthetic public contract";
  f.finish(`${decision}\n${contract}`);
  expect(f.rows()).toHaveLength(2);
  const snapshot = f.ports.read({ title: "Synthetic task without path selectors", refs: {} });
  expect(snapshot?.partial).toBe(false); expect(snapshot?.rows.map(row => row.excerpt).sort()).toEqual([decision, contract].sort());
  expect(snapshot?.rows.every(row => row.paths.length === 0)).toBe(true); expect(snapshot?.replaceable).toEqual([]);
});


test("Record brief reads reapply current machine PII policy to stored full rows", () => {
  const f = fixture(); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION); f.finish(record);
  const task = { owner: "codex", title: "Synthetic task", refs: { paths: ["src/main.ts"] } };
  expect(f.ports.read(task)?.rows).toHaveLength(1);
  writeFileSync(join(f.memoryDir, "amem.config.json"), JSON.stringify({ piiPatterns: ["synthetic failure"] }));
  expect(f.ports.read(task)?.rows).toEqual([]);
  writeFileSync(join(f.memoryDir, "amem.config.json"), "malformed fixture policy");
  expect(f.ports.read(task)).toBeUndefined();
});

test("Record brief policy follows the task owner's execution repository rather than the canonical project", () => {
  const f = fixture("enabled", true); mkdirSync(join(f.executionCwd, ".git")); mkdirSync(join(f.executionCwd, ".amem"));
  expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION); f.finish(record);
  const task = { owner: "codex", title: "Synthetic task", refs: { paths: ["src/main.ts"] } };
  expect(f.ports.read(task)?.rows).toHaveLength(1);
  writeFileSync(join(f.executionCwd, ".amem/config"), JSON.stringify({ denyPaths: ["src/"] }));
  expect(f.ports.read(task)?.rows).toEqual([]);
  // The canonical cwd has no repository policy: this proves the owner binding selects the narrowing worktree.
  expect(f.ports.read({ ...task, owner: undefined })?.rows).toHaveLength(1);
});


test("excluded steering taints the whole turn monotonically even when final reply context remains public", () => {
  for (const kind of ["remote", "private", "review"] as const) {
    const f = fixture(); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION);
    const reads = f.reads();
    if (kind === "review") f.review();
    const steered = newEnvelope("user", "synthetic steer", { ...(kind === "private" ? { private: true } : {}), ...(kind === "remote" ? { to: ["qwen@room"] } : {}) });
    f.ports.steer(f.owner.id, [steered]);
    expect(f.ports.inputs.get(f.owner.id)?.tainted).toBe(true); expect(f.reads()).toBe(reads);
    if (kind === "review") f.clearReview();
    // A later ordinary steer must not untaint the earlier consumed input.
    f.ports.steer(f.owner.id, [f.original]); f.finish(record);
    expect(f.rows()).toEqual([]); expect(f.logs).toEqual([]); expect(f.reads()).toBe(reads);
  }
});

test("ordinary public steering keeps the captured frame eligible without retaining steered bodies", () => {
  const f = fixture(); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION);
  const reads = f.reads(), steered = newEnvelope("user", "synthetic public continuation");
  f.ports.steer(f.owner.id, [steered]);
  expect(f.reads()).toBe(reads); expect(f.ports.inputs.get(f.owner.id)?.tainted).toBeUndefined();
  expect(f.ports.inputs.get(f.owner.id)?.originals).toEqual([f.original]);
  f.finish(record); expect(f.rows()).toHaveLength(1);
});

test("unknown or replaced steering owners cannot inherit an earlier public capture", () => {
  for (const absent of [false, true]) {
    const f = fixture(); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION);
    if (absent) f.bus.peers.delete(f.owner.id);
    else { const replacement = new Headless("codex"); replacement.begin(); cleanups.push(() => replacement.stop()); f.bus.peers.set("codex", replacement); }
    const reads = f.reads(); f.ports.steer(f.owner.id, [f.original]);
    expect(f.ports.inputs.get(f.owner.id)?.tainted).toBe(true); expect(f.reads()).toBe(reads);
    f.finish(record); expect(f.rows()).toEqual([]);
  }
});


test("a 33-Record partial window preserves unproved notes and compacts only exact registry-proved overlap", () => {
  const f = fixture();
  const store = new CaptureStore({ memoryDir: f.memoryDir, project: "synthetic-project", cwd: f.cwd });
  try {
    for (let index = 0; index < 33; index++) {
      const anchor = index === 32 ? "src/main.ts#run" : `src/other-${index}.ts#run`;
      store.append({ project: "synthetic-project", agent: "codex", event: "Record", paths: [anchor], excerpt: `amem: fix | ${anchor} | synthetic failure ${index} -> synthetic repair`, at: new Date(Date.now() + index).toISOString() });
    }
  } finally { store.close(); }
  const snapshot = f.ports.read();
  if (!snapshot) throw new Error("bounded Record snapshot unavailable");
  expect(snapshot.rows).toHaveLength(32); expect(snapshot.partial).toBe(true); expect(snapshot.replaceable).toEqual([]);
  expect(snapshot.rows.some(row => row.excerpt.includes("synthetic failure 0 ->"))).toBe(false);
  const old = { id: `mem:${"c".repeat(32)}`, kind: "decision", line: "Synthetic existing generated summary ".repeat(20) };
  const preferred = preferRecordItems([old], snapshot, 2);
  expect(preferred.items[0]).toEqual(old); expect(preferred.items).toHaveLength(2);
  expect(preferred.replacedNotes).toBe(0); expect(preferred.records).toBe(1);
  expect(preferred.items[1]?.line).toContain("partial Record window");
  f.generatedNote({ id: old.id, anchors: ["src/main.ts#run"] });
  const proven = f.ports.read();
  if (!proven) throw new Error("registry-proved partial snapshot unavailable");
  expect(proven.partial).toBe(true); expect(proven.replaceable).toEqual([{ id: old.id, anchors: ["src/main.ts#run"] }]);
  const compact = preferRecordItems([old], proven, 2);
  expect(compact.replacedNotes).toBe(1); expect(compact.items.some(item => item.id === old.id)).toBe(false);
  expect(compact.items.some(item => item.line.includes("partial Record window"))).toBe(true);
  expect(Buffer.byteLength(compact.items.map(item => item.line).join("\n"))).toBeLessThan(Buffer.byteLength(old.line));
});


test("proven generated-note overlap reduces actual brief and recall bytes while preserving unproved context", async () => {
  const f = fixture(); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION); f.finish(record);
  // The existing client renders a generated note's title, capped by Tasks.note at 120 characters.
  const id = "a".repeat(32), unrelatedId = "b".repeat(32), old = `mem:${id} decision: ` + "agent-hub task #42: Synthetic generated outcome title ".padEnd(120, "x");
  const unrelated = `mem:${unrelatedId} contract: Keep this unrelated authored contract exactly.`;
  f.generatedNote({ id, anchors: ["src/main.ts#run"] });
  const snapshot = f.ports.read({ owner: "codex", title: "Synthetic task", refs: { paths: ["src/main.ts"] } });
  if (!snapshot) throw new Error("screened Record snapshot unavailable");
  expect(snapshot.replaceable).toEqual([{ id: `mem:${id}`, anchors: ["src/main.ts#run"] }]);
  const originalItems = [{ id: `mem:${id}`, kind: "decision", line: old }, { id: `mem:${unrelatedId}`, kind: "contract", line: unrelated }];
  const brief = preferRecordItems(originalItems, snapshot, 3);
  expect(brief.replacedNotes).toBe(1); expect(brief.records).toBe(1); expect(brief.items.some(item => item.line === unrelated)).toBe(true);
  expect(Buffer.byteLength(brief.items.map(item => item.line).join("\n"))).toBeLessThan(Buffer.byteLength(originalItems.map(item => item.line).join("\n")));
  const context = `# [amem] recent curated context\n\n### Curated short-term notes\nCoverage notice stays exact.\n${old}\n${unrelated}\nTrailing notice stays exact.`;
  let contextCalls = 0;
  const client = { contextInject: async () => { contextCalls++; return context; } } as unknown as MemoryClient;
  const before = await recallFor("codex", client, ["synthetic-project"], 10_000); expect(contextCalls).toBe(1);
  contextCalls = 0;
  const after = await recallFor("codex", client, ["synthetic-project"], 10_000, { allowed: () => true, policyVersion: () => "fixture-one", project: original => f.ports.project("codex", original, 10_000) });
  expect(contextCalls).toBe(1); expect(typeof before).toBe("string"); expect(typeof after).toBe("string");
  expect(Buffer.byteLength(after!)).toBeLessThan(Buffer.byteLength(before!)); expect(after).not.toContain(old);
  console.info(`Record overlap fixture bytes: brief ${Buffer.byteLength(originalItems.map(item => item.line).join("\n"))} -> ${Buffer.byteLength(brief.items.map(item => item.line).join("\n"))}; recall ${Buffer.byteLength(before!)} -> ${Buffer.byteLength(after!)}`);
  expect(after).toContain(unrelated); expect(after).toContain("Coverage notice stays exact."); expect(after).toContain("Trailing notice stays exact.");
  const projected = f.ports.project("codex", context, 10_000); expect(projected?.before).toBe(context); expect(projected?.records).toBeGreaterThan(0);
  expect(projected?.after.startsWith("# [amem] recent curated context\n\n### Curated short-term notes\n")).toBe(true);
  f.generatedRecordNotes.clear();
  const restarted = f.ports.read({ owner: "codex", title: "Synthetic task", refs: { paths: ["src/main.ts"] } });
  expect(restarted?.replaceable).toEqual([]);
  const fallback = f.ports.project("codex", context, Math.floor(Buffer.byteLength(context) / 3));
  expect(fallback).toMatchObject({ before: context, after: context, records: 0 }); expect(fallback?.current?.()).toBe(true);
  expect(f.ports.project("codex", context.replace(`mem:${id}`, "mem:not-a-full-id"), 10_000)).toBeUndefined();
});


test("snapshot and recall current guards rescreen current amem PII policy without a config fingerprint", () => {
  const f = fixture(); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION); f.finish(record);
  const task = { owner: "codex", title: "Synthetic task", refs: { paths: ["src/main.ts"] } }, snapshot = f.ports.read(task);
  const original = `# [amem] recent curated context\n\n### Curated short-term notes\nmem:${"d".repeat(32)} contract: Unrelated public contract.`;
  const projected = f.ports.project("codex", original, 10_000);
  expect(snapshot?.current?.()).toBe(true); expect(projected?.current?.()).toBe(true);
  const logs = [...f.logs];
  writeFileSync(join(f.memoryDir, "amem.config.json"), JSON.stringify({ piiPatterns: ["synthetic failure"] }));
  expect(snapshot?.current?.()).toBe(false); expect(projected?.current?.()).toBe(false);
  expect(f.logs).toEqual(logs); expect(f.logs.join("\n")).not.toContain("synthetic failure");
});

test("snapshot current guard rechecks execution-repository deny policy and capture rechecks fresh PII before append", () => {
  const f = fixture("enabled", true); mkdirSync(join(f.executionCwd, ".git")); mkdirSync(join(f.executionCwd, ".amem"));
  expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION); f.finish(record);
  const snapshot = f.ports.read({ owner: "codex", title: "Synthetic task", refs: { paths: ["src/main.ts"] } });
  expect(snapshot?.current?.()).toBe(true);
  writeFileSync(join(f.executionCwd, ".amem/config"), JSON.stringify({ denyPaths: ["src/"] }));
  expect(snapshot?.current?.()).toBe(false);
  const capture = fixture(); expect(capture.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION);
  mkdirSync(capture.memoryDir); writeFileSync(join(capture.memoryDir, "amem.config.json"), JSON.stringify({ piiPatterns: ["synthetic failure"] }));
  capture.finish(record); expect(existsSync(join(capture.memoryDir, "projects"))).toBe(false);
  expect(capture.logs.join("\n")).not.toContain("synthetic failure");
});


test("fresh policy guards cover legacy-only private text even while all returned Record rows remain public", () => {
  const f = fixture(); expect(f.owner.recordInstruction?.()).toBe(RECORD_INSTRUCTION); f.finish(record);
  const snapshot = f.ports.read({ owner: "codex", title: "Synthetic task", refs: { paths: ["src/main.ts"] } });
  const legacy = "LEGACY_ONLY_CANARY", original = `# [amem] recent curated context\n\n### Curated short-term notes\nmem:${"e".repeat(32)} decision: ${legacy}`;
  const projected = f.ports.project("codex", original, 10_000);
  expect(snapshot?.current?.()).toBe(true); expect(snapshot?.current?.(legacy)).toBe(true); expect(projected?.current?.()).toBe(true);
  const logs = [...f.logs];
  writeFileSync(join(f.memoryDir, "amem.config.json"), JSON.stringify({ piiPatterns: [legacy] }));
  expect(snapshot?.current?.()).toBe(true); // Record row text did not change and remains public.
  expect(snapshot?.current?.(legacy)).toBe(false); expect(projected?.current?.()).toBe(false);
  expect(f.logs).toEqual(logs); expect(f.logs.join("\n")).not.toContain(legacy);
});
