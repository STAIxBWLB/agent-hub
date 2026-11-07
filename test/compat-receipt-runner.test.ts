import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { stopOwnedProcess, trackGroup } from "../src/hub/child-process.ts";
import { realPath } from "../src/hub/project.ts";
import type { CommandResult } from "../scripts/compat-receipts/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-compat-receipt-runner-"))); roots.push(root);
  const home = join(root, "home"), hubHome = join(root, "hub-home"), temp = join(root, "tmp");
  for (const directory of [home, hubHome, temp]) mkdirSync(directory, { mode: 0o700 });
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, AGENTHUB_HOME: hubHome, TMPDIR: temp, LC_ALL: "C", LANG: "C", TZ: "UTC" };
  const request = join(root, "request.json"), worker = join(root, "worker.ts"), helper = join(root, "helper.ts");
  writeFileSync(request, "{}");
  // This reproduces the production worker argv: the worker itself names the private request path.
  writeFileSync(worker, `import {runBoundedReceiptCommand} from ${JSON.stringify(resolve(import.meta.dir, "../scripts/compat-receipts/runner.ts"))};
const result=await runBoundedReceiptCommand([process.execPath,'-e',"process.stdout.write('0.99.1')"],{
cwd:process.cwd(),env:process.env,signal:AbortSignal.timeout(5000),timeoutMs:5000,maxBytes:1024});
process.stdout.write(JSON.stringify(result));\n`);
  writeFileSync(helper, "process.stdout.write('ready\\n');setInterval(()=>{},1000);\n");
  return { root, env, request, worker, helper };
}
function launch(argv: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  trackGroup(child); return child;
}
async function waitReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => { clearTimeout(timer); child.stdout?.off("data", ready); child.off("error", failed); child.off("exit", exited); error ? reject(error) : resolve(); };
    const ready = (chunk: Buffer) => { if (chunk.toString().includes("ready")) done(); };
    const failed = () => done(new Error("owned helper failed to start"));
    const exited = () => done(new Error("owned helper exited before readiness"));
    const timer = setTimeout(() => done(new Error("owned helper readiness expired")), 5000);
    child.stdout!.on("data", ready); child.once("error", failed); child.once("exit", exited);
  });
}
async function result(child: ChildProcess): Promise<CommandResult> {
  let stopPromise: Promise<void> | undefined;
  const stop = () => stopPromise ??= stopOwnedProcess(child, { group: true });
  const timer = setTimeout(() => { void stop().catch(() => {}); }, 10000);
  let stdout = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", () => {});
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
      if (child.exitCode !== null) resolve(child.exitCode);
    });
    expect(exitCode).toBe(0);
    return JSON.parse(stdout);
  } finally { clearTimeout(timer); await stop(); }
}

test("nested receipt worker naming its private request is not its own survivor", async () => {
  const f = fixture(), worker = launch([process.execPath, f.worker, f.request], f.root, f.env);
  const answer = await result(worker);
  expect(answer.stdout).toBe("0.99.1"); expect(answer.exitCode).toBe(0);
  expect(answer.ownedStopConfirmed).toBe(true); expect(answer.survivorDetected).toBe(false);
  expect(answer.processCleanup).toBe("unproven"); // Excluding self supplies no whole-lifetime proof.
}, 20000);

test("another owned process naming the private root still counts as a survivor", async () => {
  const f = fixture(), helper = launch([process.execPath, f.helper], f.root, f.env);
  try {
    await waitReady(helper);
    const worker = launch([process.execPath, f.worker, f.request], f.root, f.env);
    const answer = await result(worker);
    expect(answer.stdout).toBe("0.99.1"); expect(answer.exitCode).toBe(0);
    expect(answer.survivorDetected).toBe(true); expect(answer.ownedStopConfirmed).toBe(false);
    expect(answer.processCleanup).toBe("unproven");
    expect(helper.exitCode).toBeNull(); // Runner observation did not signal a separately owned process.
  } finally { await stopOwnedProcess(helper, { group: true }); }
}, 20000);
