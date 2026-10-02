import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commandRuntime, daemonProjectRootFromArgv, ownedProcesses, parseProcessSnapshot, processBelongsToRun } from "../scripts/process-ownership.mjs";

const runRoot = "/tmp/ahub-check.run-7fcd3e";

test("the leak guard owns only exact daemon processes rooted in this test invocation", () => {
  const owned = "bun /workspace/src/cli/main.ts --project /tmp/ahub-check.run-7fcd3e/ahub-lifecycle-x/project daemon";
  expect(processBelongsToRun(owned, runRoot)).toBe(true);
  expect(processBelongsToRun("bun /workspace/src/cli/main.js --project /tmp/ahub-check.run-7fcd3e/project with spaces daemon", runRoot)).toBe(true);

  const unrelatedHub = "bun /workspace/src/cli/main.ts --project /tmp/ahub-benchmark-hub/project daemon";
  const unrelatedHelper = "python3 /tmp/audit-ahub-check.run-7fcd3e/grading.py";
  const forgedHelper = "python3 -c \"print('bun /workspace/src/cli/main.ts --project /tmp/ahub-check.run-7fcd3e/project daemon')\"";
  const lookalike = "bun /workspace/src/cli/main.ts --project /tmp/ahub-check.run-7fcd3e/project doctor";
  const prefixSibling = "bun /workspace/src/cli/main.ts --project /tmp/ahub-check.run-7fcd3e-other/project daemon";
  expect(processBelongsToRun(unrelatedHub, runRoot)).toBe(false);
  expect(processBelongsToRun(unrelatedHelper, runRoot)).toBe(false);
  expect(processBelongsToRun(forgedHelper, runRoot)).toBe(false);
  expect(processBelongsToRun(lookalike, runRoot)).toBe(false);
  expect(processBelongsToRun(prefixSibling, runRoot)).toBe(false);
  expect(daemonProjectRootFromArgv(["/opt/bun", "/workspace/src/cli/main.ts", "--project", `${runRoot}/project`, "daemon"], "/opt/bun")).toBe(`${runRoot}/project`);
  expect(daemonProjectRootFromArgv(["python3", "audit.py", "bun /workspace/src/cli/main.ts --project /tmp/ahub-check.run-7fcd3e/project daemon"], "/usr/bin/python3")).toBeUndefined();
});

test("the guard includes live members of a current-run daemon process group", () => {
  const rows = [
    { pid: "100", ppid: "1", pgid: "100", started: "Fri Oct  2 08:00:00 2026", command: "bun /workspace/src/cli/main.ts --project /tmp/ahub-check.run-7fcd3e/project daemon" },
    { pid: "101", ppid: "100", pgid: "100", started: "Fri Oct  2 08:00:01 2026", command: "claude --resume session" },
    { pid: "105", ppid: "100", pgid: "105", started: "Fri Oct  2 08:00:01 2026", command: "node codex-appserver.js" },
    { pid: "200", ppid: "1", pgid: "200", started: "Fri Oct  2 08:00:02 2026", command: "python3 /tmp/ahub-check.run-7fcd3e/audit.py" },
    { pid: "300", ppid: "1", pgid: "300", started: "Fri Oct  2 08:00:03 2026", command: "bun /workspace/src/cli/main.ts --project /tmp/ahub-benchmark/project daemon" },
  ];
  expect(ownedProcesses(rows, runRoot, []).map((row) => row.pid)).toEqual(["100", "101", "105"]);
});

test("birth ledger finds an orphaned child and rejects a reused daemon PID", () => {
  const birth = { kind: "daemon" as const, pid: "100", pgid: "100", started: "Fri Oct  2 08:00:00 2026", root: `${runRoot}/project`, command: "bun /workspace/src/cli/main.ts --project /tmp/ahub-check.run-7fcd3e/project daemon", runtime: "bun", exclusive: true };
  const orphan = { pid: "101", ppid: "1", pgid: "100", started: "Fri Oct  2 08:00:01 2026", command: "claude --resume session" };
  expect(ownedProcesses([orphan], runRoot, [birth]).map((row) => row.pid)).toEqual(["101"]);

  const reused = { pid: "100", ppid: "1", pgid: "100", started: "Fri Oct  2 08:00:05 2026", command: "bun /workspace/src/cli/main.ts --project /tmp/other-hub daemon" };
  expect(ownedProcesses([reused], runRoot, [birth])).toEqual([]);
});

test("births from detached Bun children remain owned after their parent exits", () => {
  const parent = { kind: "owned_process" as const, pid: "410", pgid: "410", started: "Fri Oct  2 08:00:00 2026", root: `${runRoot}/project`, command: "/opt/bun -e parent", runtime: "bun", exclusive: true };
  const child = { kind: "owned_process" as const, pid: "411", pgid: "411", started: "Fri Oct  2 08:00:01 2026", root: `${runRoot}/project`, command: "/opt/bun -e child", runtime: "bun", exclusive: true };
  const liveChild = { pid: "411", ppid: "1", pgid: "411", started: child.started, command: child.command };
  expect(ownedProcesses([liveChild], runRoot, [parent, child]).map((row) => row.pid)).toEqual(["411"]);
});

test("a short-lived Bun parent leaves a detached child with a verifiable owned birth", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-check-owned-child-"));
  const canonicalRoot = realpathSync(root);
  const ledger = join(root, "births.jsonl"), childPidFile = join(root, "child.pid");
  writeFileSync(ledger, "");
  const preload = resolve("scripts/record-test-process.mjs");
  const env = { ...process.env, AHUB_CHECK_RUN_ROOT: root, AHUB_CHECK_PROCESS_LEDGER: ledger, BUN_OPTIONS: `--preload=${preload}`, AHUB_TEST_CHILD_PID_FILE: childPidFile };
  const parentCode = `const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), env: process.env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); await Bun.write(process.env.AHUB_TEST_CHILD_PID_FILE, String(child.pid)); child.unref();`;
  let childBirth: any;
  try {
    const parent = Bun.spawn([process.execPath, "-e", parentCode], { cwd: root, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    expect(await parent.exited).toBe(0);
    for (let i = 0; i < 100; i++) {
      const childPid = existsSync(childPidFile) ? readFileSync(childPidFile, "utf8") : "";
      if (childPid && readFileSync(ledger, "utf8").includes(`\"pid\":\"${childPid}\"`)) break;
      await Bun.sleep(20);
    }
    const births = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const childPid = readFileSync(childPidFile, "utf8");
    childBirth = births.find((birth) => birth.kind === "owned_process" && birth.pid === childPid && birth.root === canonicalRoot);
    expect(childBirth).toBeDefined();
    expect(births.some((birth) => birth.kind === "owned_process" && birth.pid !== childPid)).toBe(true);

    const snapshot = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,args="], { encoding: "utf8" });
    const current = parseProcessSnapshot(snapshot);
    expect(ownedProcesses(current, canonicalRoot, [childBirth]).some((row) => row.pid === childPid)).toBe(true);
  } finally {
    if (!childBirth && existsSync(ledger)) {
      childBirth = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((birth) => birth.kind === "owned_process" && birth.exclusive && birth.pid !== process.pid);
    }
    if (childBirth) {
      const current = parseProcessSnapshot(execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,args="], { encoding: "utf8" }));
      const live = current.find((row) => row.pid === childBirth.pid && row.started === childBirth.started && row.pgid === childBirth.pgid && commandRuntime(row.command) === childBirth.runtime);
      if (live) {
        process.kill(Number(live.pid), "SIGTERM");
        for (let i = 0; i < 50; i++) {
          await Bun.sleep(20);
          const rows = parseProcessSnapshot(execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,args="], { encoding: "utf8" }));
          if (!rows.some((row) => row.pid === live.pid && row.started === childBirth.started && row.pgid === childBirth.pgid && commandRuntime(row.command) === childBirth.runtime)) break;
        }
        const rows = parseProcessSnapshot(execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,args="], { encoding: "utf8" }));
        const stillOwned = rows.find((row) => row.pid === live.pid && row.started === childBirth.started && row.pgid === childBirth.pgid && commandRuntime(row.command) === childBirth.runtime);
        if (stillOwned) process.kill(Number(stillOwned.pid), "SIGKILL");
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
