import { expect, test } from "bun:test";
import { follow, operationScreen, planScreen, type ScreenIO, type UpgradeHost } from "../src/cli/upgrade-interactive.ts";
import type { RecoveryOperation, Inspection } from "../src/cli/upgrade.ts";
import { PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";
import { join } from "node:path";
import { terminalText } from "../src/cli/console-state.ts";
import { nextChoices } from "../src/cli/upgrade.ts";
import { restoreTransition, type RestoreReceipt } from "../src/cli/upgrade-restore-state.ts";

const id = "00000000-0000-4000-8000-000000000466", entry = join(PACKAGE_ROOT, "src/cli/main.js");
const project = { id: "alpha", root: "/alpha", stateDir: "/alpha/.agenthub/state", basePort: 4600, instanceId: "old", pid: 1 };
function fixture(): RecoveryOperation {
  return { schema: 1, id, sourceRoot: PACKAGE_ROOT, createdAt: 0, updatedAt: 0, phase: "blocked", step: "prepare:alpha", projects: [{ id: "alpha", phase: "pending", terminals: {} }],
    plan: { schema: 1, kind: "upgrade", version: "0.12.31", sourceRoot: PACKAGE_ROOT, sourceDigest: "fixture", fingerprint: "fixture", blockers: [], projects: [{ project, source: { state: "running", instanceId: "old", version: "0.12.30", peers: [], blockers: [] }, terminals: [], blockers: [] }] } };
}
function screen(answers: string[], now: () => number = () => 1000) {
  const output: string[] = [], asked: string[] = [], ran: string[][] = [];
  const io: ScreenIO = { presentation: { columns: 80, color: true, now },
    ask: async text => { asked.push(text); return answers.shift() ?? null; }, out: text => { output.push(text); },
    run: async args => { ran.push(args); return 0; }, sleep: async () => {}, interrupted: () => false, typed: () => false };
  return { io, output, asked, ran };
}
function host(op: RecoveryOperation, overrides: Partial<UpgradeHost> = {}): UpgradeHost {
  const source: Inspection = { state: "running", instanceId: "old", version: "0.12.30", peers: [], blockers: [] };
  return { plan: async () => op.plan, apply: async () => op, lock: () => id, read: () => op, runner: () => undefined, live: async () => ({ alpha: source }),
    endPeer: async () => "unused", runnerStoppable: () => false, stopRunner: async () => false, entry, version: "0.12.31", ...overrides };
}

test("#466 Enter recommends only the offered reattach action and keeps all restore decisions in io.run", async () => {
  const op = fixture(), launch = { packageEntrypoint: entry, command: "fixture only", argv: [], env: {} };
  const binding = { peer: "pi" as const, handle: "term-pi", incarnationId: "inc-pi", worktreeId: "wt-pi", projectRoot: project.root, sessionId: "saved-pi", launch, launchMetadata: launch };
  op.step = "restore-claude:alpha"; op.projects[0]!.phase = "started"; op.projects[0]!.instanceId = "target";
  op.blockedReattachment = { projectId: "alpha", peer: "pi" }; op.projects[0]!.terminals["restored:pi"] = { state: "failed" };
  op.projects[0]!.reattachments = { pi: { state: "ready", cause: "detached after restore", at: 1, binding } };
  const before = JSON.stringify(op), f = screen(["", "q"]);
  await operationScreen(host(op, { live: async () => ({ alpha: { state: "running", instanceId: "target", version: "0.12.31", peers: [], blockers: [], recovery: { operationId: id, phase: "restored" } } }) }), f.io, id);
  expect(f.ran).toEqual([[entry, "recovery", "reattach", id, "pi"]]);
  expect(f.output.join("\n")).toContain("recommended"); expect(f.output.join("\n")).toContain("Enter");
  expect(JSON.stringify(op)).toBe(before);
  for (const line of [...f.output, ...f.asked]) for (const part of line.split("\n")) expect(Bun.stringWidth(terminalText(part))).toBeLessThanOrEqual(80);
});

test("#466 an unknown runner shows the actual wait disabled and Enter only refreshes", async () => {
  const op = fixture(), f = screen(["w", "", "q"]);
  await operationScreen(host(op, { runner: () => "unknown" }), f.io, id);
  expect(f.ran).toEqual([]);
  expect(f.output.join("\n")).toContain("disabled"); expect(f.output.join("\n")).toContain("unknown");
  expect(f.output.join("\n")).not.toContain("[r]");
  expect(f.output.join("\n")).not.toContain("bun ");
});

test("#466 destructive confirmation names the target version and abandonment before any command", async () => {
  const op = fixture(), f = screen(["e", "n", "q"]);
  await operationScreen(host(op), f.io, id);
  expect(f.ran).toEqual([]);
  expect(f.asked.join("\n") + f.output.join("\n")).toContain("0.12.31");
  expect(f.asked.join("\n") + f.output.join("\n")).toContain("abandoned");
  expect(f.output.join("\n")).toContain("warning");
});

test("#466 resumed follow names checking retained release and only the steps observed on that attempt", async () => {
  const op = fixture(), f = screen([]), states = [
    { phase: "running", step: "stage", updatedAt: 1 }, { phase: "running", step: "prepare:alpha", updatedAt: 2 }, { phase: "completed", step: "completed", updatedAt: 3 },
  ] as const;
  let at = 0;
  expect(await follow(host(op, { runner: () => 123, read: () => ({ ...op, ...states[Math.min(at++, states.length - 1)] }) }), f.io, id, 0)).toBe("completed");
  const text = f.output.join("\n");
  expect(text).toContain("resuming from"); expect(text).toContain("checking retained release");
  expect(text.match(/resuming from/g)?.length).toBe(1);
  expect(text).not.toContain("staging the release"); expect(text).not.toContain("bun "); expect(text).not.toContain("installing the global CLI");
});

test("#466 completed summary uses only read-only final inspection, or says runtime unknown", async () => {
  const op = fixture(); op.phase = "completed";
  const f = screen([]); let reads = 0;
  await operationScreen(host(op, { endInspection: async () => { reads++; return { alpha: { state: "running", version: "0.12.33", peers: [], blockers: [] } }; } }), f.io, id);
  expect(reads).toBe(1); expect(f.ran).toEqual([]); expect(f.output.join("\n")).toContain("running on 0.12.33");
  const unknown = screen([]);
  await operationScreen(host(op, { endInspection: async () => { throw new Error("unreadable"); } }), unknown.io, id);
  expect(unknown.output.join("\n")).toContain("runtime unknown"); expect(unknown.ran).toEqual([]);
});

test("#466 the reviewed plan marks apply as the Enter default and still uses host.apply", async () => {
  const op = fixture(), f = screen([""]); let applied = 0;
  await planScreen(host(op, { lock: () => undefined, apply: async () => { applied++; return op; }, read: () => ({ ...op, phase: "completed" }) }), f.io);
  expect(applied).toBe(1); expect(f.ran).toEqual([]); expect(f.output.join("\n")).toContain("recommended");
});

test("#466 a blocked plan recommends refresh and never offers or runs apply", async () => {
  const op = fixture(), f = screen(["", "q"]); op.plan.blockers = ["review the unavailable source first"]; let applied = 0;
  await planScreen(host(op, { lock: () => undefined, apply: async () => { applied++; return op; } }), f.io);
  expect(applied).toBe(0); expect(f.ran).toEqual([]); expect(f.output.join("\n")).toContain("recommended");
  expect(f.output.join("\n")).not.toContain("[a]");
});

test("#466 an unknown recorded failure recommends reading its receipt before retrying effects", async () => {
  const op = fixture(), f = screen(["", "q"]); op.error = "an older coordinator recorded an unknown native failure";
  await operationScreen(host(op), f.io, id);
  expect(f.ran).toEqual([]);
  const raw = f.output.find(value => value.startsWith("{"));
  expect(raw).toBeDefined(); expect(JSON.parse(raw!).id).toBe(id); expect(raw).not.toContain("\x1b");
});

test("#466 presentation mutation choices equal nextChoices over the unchanged 540-cell restore domain", async () => {
  const launch = { packageEntrypoint: entry, command: "fixture", argv: [], env: {} };
  const binding = { peer: "codex" as const, handle: "terminal", incarnationId: "incarnation", worktreeId: "worktree", projectRoot: project.root, sessionId: "planned", launch, launchMetadata: launch };
  const receipts: RestoreReceipt[] = [{ state: "pending" }, { state: "waiting", origin: "pending", binding }, { state: "waiting", origin: "failed", binding }, { state: "done", binding }, { state: "failed" }];
  let count = 0;
  for (const receipt of receipts) for (const target of ["running", "stopped", "changed"] as const)
    for (const launcher of ["live", "gone", "unknown", "no-record-yet", "replaced", "older-instance"] as const)
      for (const session of ["planned", "other", "none"] as const) for (const allowOther of [false, true]) {
        const result = restoreTransition(receipt, { target, launcher, session, allowOther, binding });
        const op = fixture(); op.step = "restore:alpha"; op.targetRoot = PACKAGE_ROOT;
        op.projects[0]!.phase = "started"; op.projects[0]!.instanceId = "target"; op.projects[0]!.terminals["restored:codex"] = result.next;
        op.plan.projects[0]!.terminals = [binding];
        const live: Record<string, Inspection> = { alpha: { state: target === "stopped" ? "stopped" : "running", version: op.plan.version,
          instanceId: target === "changed" ? "replacement" : "target", snapshot: id, recovery: { operationId: id, phase: "restored" }, blockers: [],
          peers: session === "none" ? [] : [{ id: "codex", state: "idle", threadId: session === "planned" ? "planned" : "other" }] } };
        const before = JSON.stringify(op), expected = new Set<string>();
        for (const choice of nextChoices(op, undefined, live)) {
          if (choice.kind === "resume") expected.add("r");
          else if (choice.kind === "abort") expected.add("c");
          else if (choice.kind === "reattach") expected.add("a");
          else if (choice.kind === "fresh") expected.add("f");
          else if (choice.kind === "stop") { expected.add("e"); expected.add("x"); }
        }
        const f = screen(["q"]); f.io.presentation!.color = false; f.io.presentation!.columns = 120;
        await operationScreen(host(op, { live: async () => live }), f.io, id);
        const shown = new Set([...f.output.join("\n").matchAll(/\[([a-z-]+)\]/g)].map(match => match[1]!).filter(key => ["r", "c", "a", "f", "e", "x"].includes(key)));
        expect([...shown].sort()).toEqual([...expected].sort()); expect(f.ran).toEqual([]); expect(JSON.stringify(op)).toBe(before);
        count++;
      }
  expect(count).toBe(540);
});
