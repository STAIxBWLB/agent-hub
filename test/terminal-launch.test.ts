import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalLaunches, type TerminalOwnerProof } from "../src/hub/terminal-launch.ts";
import { publishTerminalLaunch, registerTerminalLaunch, type CommandRunner, type RecordedTerminalLaunch } from "../src/cli/terminal-recovery.ts";
import { processSignature } from "../src/pi/process-signature.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-terminal-owner-"));
  directories.push(stateDir);
  const signature = processSignature(process.pid);
  if (!signature) throw new Error("fixture launcher identity unavailable");
  const row = (launchId: string): RecordedTerminalLaunch => ({ peer: "codex", projectRoot: stateDir, stateDir, instanceId: "instance-current", launcherPid: process.pid, launcherSignature: signature, launchId, handle: `term-${launchId}`, incarnationId: `inc-${launchId}`, worktreeId: "fixture-worktree", env: {} });
  const shown = (candidate: RecordedTerminalLaunch) => ({ result: { terminal: { handle: candidate.handle, incarnationId: candidate.incarnationId, worktreeId: candidate.worktreeId, worktreePath: candidate.projectRoot, connected: true, orphaned: false } } });
  const runnerFor = (candidates: RecordedTerminalLaunch[]): CommandRunner => async argv => {
    expect(argv.slice(0, 2)).toEqual(["terminal", "show"]);
    const candidate = candidates.find(item => item.handle === argv[argv.indexOf("--terminal") + 1]);
    if (!candidate) throw new Error("unknown fixture terminal");
    return shown(candidate);
  };
  const file = join(stateDir, "terminal-recovery.json");
  return { stateDir, row, shown, runnerFor, file };
}

test("#482 an older daemon leaves terminal ownership unrecorded with an upgrade remedy", async () => {
  const f = fixture(), row = f.row("older-daemon");
  writeFileSync(f.file, "[]");
  const authoritative = readFileSync(f.file, "utf8"), warnings: string[] = [];
  let requests = 0;
  const diagnostic = spyOn(console, "error").mockImplementation(message => { warnings.push(String(message)); });
  try {
    await registerTerminalLaunch({ features: [], request: async () => { requests++; throw new Error("older daemon must not receive the unsupported request"); } }, row);
  } finally { diagnostic.mockRestore(); }
  expect(requests).toBe(0);
  expect(warnings.join("\n")).toContain("unrecorded");
  expect(warnings.join("\n")).toContain("upgrade the running hub");
  expect(readFileSync(f.file, "utf8")).toBe(authoritative);
});

test("#482 only the current native owner publishes; refused candidates preserve ledger bytes and unrelated rows", async () => {
  const f = fixture(), a = f.row("owner-a"), b = f.row("refused-b");
  const oldInstance = { ...a, instanceId: "instance-old", launchId: "old-launch" };
  const invalid = { peer: "codex", instanceId: "instance-current", launcherPid: "unreadable", kept: ["opaque"] };
  writeFileSync(f.file, JSON.stringify([oldInstance, invalid]));
  let current = a.launchId;
  const published: string[] = [];
  const launches = new TerminalLaunches({
    owner: candidate => candidate.launchId === current ? { generation: "generation-a", isCurrent: () => current === candidate.launchId } : undefined,
    publish: async (candidate, isCurrent) => {
      const accepted = await publishTerminalLaunch(f.stateDir, candidate, isCurrent, f.runnerFor([a, b]));
      if (accepted) published.push(candidate.launchId);
      return accepted;
    },
  });
  launches.register(a); launches.register(b);
  await launches.reconcile();
  expect(published).toEqual([a.launchId]);
  expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual([oldInstance, invalid, a]);
  const authoritative = readFileSync(f.file, "utf8");
  current = "no-attached-owner";
  await launches.reconcile();
  expect(readFileSync(f.file, "utf8")).toBe(authoritative);
  current = a.launchId;
  await launches.reconcile();
  expect(published).toEqual([a.launchId]); // Repeating the same generation does not publish again.
  expect(readFileSync(f.file, "utf8")).toBe(authoritative);
  launches.clear();
});

for (const invalidation of ["owner-generation-changed", "cleared"] as const) {
  test(`#482 ${invalidation} during Orca validation cannot publish stale ownership`, async () => {
    const f = fixture(), a = f.row("saved-a"), b = f.row("pending-b");
    expect(await publishTerminalLaunch(f.stateDir, a, () => true, f.runnerFor([a]))).toBe(true);
    const authoritative = readFileSync(f.file, "utf8");
    let entered!: () => void, release!: () => void;
    const validationEntered = new Promise<void>(resolve => { entered = resolve; });
    const validationReleased = new Promise<void>(resolve => { release = resolve; });
    let generation = "generation-b";
    const runner: CommandRunner = async () => { entered(); await validationReleased; return f.shown(b); };
    const launches = new TerminalLaunches({
      owner: candidate => {
        const observed = generation;
        return candidate.launchId === b.launchId ? { generation: observed, isCurrent: () => generation === observed } : undefined;
      },
      publish: (candidate, isCurrent) => publishTerminalLaunch(f.stateDir, candidate, isCurrent, runner),
    });
    launches.register(b);
    const pending = launches.reconcile();
    try {
      await validationEntered;
      if (invalidation === "cleared") launches.clear(); else generation = "generation-replacement";
    } finally { release(); await pending; }
    expect(readFileSync(f.file, "utf8")).toBe(authoritative);
    launches.clear();
  });
}

test("#482 a Pi native pid outside the launcher's descendants cannot publish", async () => {
  const f = fixture(), pi = { ...f.row("pi-owner"), peer: "pi" };
  writeFileSync(f.file, "[]");
  const authoritative = readFileSync(f.file, "utf8");
  let publications = 0;
  const proof: TerminalOwnerProof = { generation: "pi-generation", nativePid: process.ppid, isCurrent: () => true };
  const launches = new TerminalLaunches({ owner: () => proof, publish: async (candidate, isCurrent) => {
    publications++;
    return publishTerminalLaunch(f.stateDir, candidate, isCurrent, f.runnerFor([pi]));
  } });
  launches.register(pi);
  await launches.reconcile();
  expect(publications).toBe(0);
  expect(readFileSync(f.file, "utf8")).toBe(authoritative);
  launches.clear();
}, 20_000);

// The admission cap preserves live/unknown candidates instead of evicting an owner.
test("#482 the 64 live-candidate cap fails closed and a reused identity is refused before admission", () => {
  const f = fixture();
  let publications = 0;
  const launches = new TerminalLaunches({ owner: () => undefined, publish: async () => { publications++; return true; } });
  expect(() => launches.register({ ...f.row("reused-pid"), launcherSignature: "different-process-start" })).toThrow("terminal launcher identity unavailable");
  for (let index = 0; index < 64; index++) launches.register(f.row(`candidate-${index}`));
  expect(() => launches.register(f.row("candidate-over-cap"))).toThrow("too many pending terminal launches");
  expect(publications).toBe(0);
  launches.clear();
  expect(() => launches.register(f.row("after-clear"))).toThrow("terminal launcher identity unavailable");
}, 20_000);
