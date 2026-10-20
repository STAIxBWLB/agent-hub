import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openManager, stopManager } from "../src/hub/manager.ts";

const roots: string[] = [];
const running: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const child of running.splice(0)) child.kill("SIGTERM");
  for (const home of roots.splice(0)) {
    try { cli(home, ["ui", "--all", "--stop"]); } catch { /* already dead */ }
    try {
      const db = new Database(join(home, "registry.db"), { readonly: true });
      for (const row of db.query("SELECT pid FROM projects WHERE pid IS NOT NULL").all() as { pid: number }[]) {
        try { process.kill(row.pid, "SIGTERM"); } catch { /* exited */ }
      }
      db.close();
    } catch { /* no registry */ }
  }
});

function env(home: string) { return { ...process.env, AGENTHUB_HOME: home, AGENTHUB_STATE_DIR: undefined, AGENTHUB_PROJECT_DIR: undefined }; }
function cli(home: string, args: string[]) {
  const result = spawnSync(process.execPath, [join(import.meta.dir, "..", "src/cli/main.ts"), ...args], { encoding: "utf8", env: env(home), timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr || `ahub failed: ${args.join(" ")}`);
  return result.stdout.trim();
}
async function concurrent(home: string): Promise<string[]> {
  const run = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dir, "..", "src/cli/main.ts"), "ui", "--all", "--no-open"], { env: env(home) });
    running.push(child); let out = ""; let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; }); child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
  });
  return await Promise.all([run(), run()]);
}

test("separate CLI processes share one manager and manager stop preserves registered hubs", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-home-")); roots.push(home);
  const project = mkdtempSync(join(tmpdir(), "ahub-manager-project-")); roots.push(project); mkdirSync(join(project, "nested"));
  cli(home, ["--project", project, "init"]);
  const urls = await concurrent(home);
  const first = new URL(urls[0]!); const second = new URL(urls[1]!);
  expect(first.origin).toBe(second.origin);
  expect(first.hash).not.toBe(second.hash);

  const ticket = first.hash.slice(1);
  const session = await fetch(`${first.origin}/session`, { method: "POST", headers: { origin: first.origin, "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
  expect(session.status).toBe(200);
  const cookie = session.headers.get("set-cookie")!;
  const projects = await fetch(`${first.origin}/projects`, { method: "POST", headers: { origin: first.origin, cookie, "content-type": "application/json" }, body: "{}" });
  expect(projects.status).toBe(200);
  const listing = await projects.json() as any;
  expect(listing.mode).toBe("all"); expect(listing.projects).toHaveLength(1);
  expect(listing.projects[0].state).toBe("stopped");
  const projectId = listing.projects[0].id as string;
  const started = await fetch(`${first.origin}/action`, { method: "POST", headers: { origin: first.origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "start", projectId }) });
  expect(started.status).toBe(200);
  const running = await fetch(`${first.origin}/projects`, { method: "POST", headers: { origin: first.origin, cookie, "content-type": "application/json" }, body: "{}" });
  const runningRow = (await running.json() as any).projects[0];
  expect(runningRow.state).toBe("running"); expect(typeof runningRow.instanceId).toBe("string");
  const stopped = cli(home, ["ui", "--all", "--stop"]);
  expect(stopped).toContain("dashboard manager stopped");
  const preserved = JSON.parse(cli(home, ["projects", "--json"]));
  expect(preserved[0].state).toBe("running");
  const reopened = cli(home, ["ui", "--all", "--no-open"]);
  const reopenedUrl = new URL(reopened); expect(reopenedUrl.origin).not.toBe("");
  const reopenedSession = await fetch(`${reopenedUrl.origin}/session`, { method: "POST", headers: { origin: reopenedUrl.origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: reopenedUrl.hash.slice(1) }) });
  const reopenedCookie = reopenedSession.headers.get("set-cookie")!;
  const stoppedHub = await fetch(`${reopenedUrl.origin}/action`, { method: "POST", headers: { origin: reopenedUrl.origin, cookie: reopenedCookie, "content-type": "application/json" }, body: JSON.stringify({ action: "stop", projectId, instanceId: runningRow.instanceId }) });
  expect(stoppedHub.status).toBe(200);
  cli(home, ["ui", "--all", "--stop"]);
});

test("dead manager ownership is recovered once under concurrent open", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-stale-")); roots.push(home);
  const first = (await concurrent(home))[0]!;
  const url = new URL(first);
  const manifest = JSON.parse(readFileSync(join(home, "manager", "status.json"), "utf8")) as { pid: number };
  expect(existsSync(join(home, "manager", "control-token"))).toBe(true);
  process.kill(manifest.pid, "SIGKILL");
  for (let i = 0; i < 30; i++) { try { process.kill(manifest.pid, 0); } catch { break; } await new Promise((resolve) => setTimeout(resolve, 20)); }
  const urls = await concurrent(home);
  expect(new URL(urls[0]!).origin).toBe(new URL(urls[1]!).origin);
  expect(new URL(urls[0]!).origin).not.toBe(url.origin);
  cli(home, ["ui", "--all", "--stop"]);
});

test("manager starts outside any project and rejects a corrupted stop token", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-empty-")); roots.push(home);
  const outside = mkdtempSync(join(tmpdir(), "ahub-manager-cwd-")); roots.push(outside);
  const first = spawnSync(process.execPath, [join(import.meta.dir, "..", "src/cli/main.ts"), "ui", "--all", "--no-open"], { cwd: outside, encoding: "utf8", env: env(home), timeout: 30_000 });
  expect(first.status).toBe(0);
  const url = new URL(first.stdout.trim());
  const tokenFile = join(home, "manager", "control-token"); const token = readFileSync(tokenFile, "utf8");
  writeFileSync(tokenFile, "corrupted");
  const bad = spawnSync(process.execPath, [join(import.meta.dir, "..", "src/cli/main.ts"), "ui", "--all", "--stop"], { cwd: outside, encoding: "utf8", env: env(home), timeout: 30_000 });
  expect(bad.status).not.toBe(0);
  writeFileSync(tokenFile, token);
  const reopened = cli(home, ["ui", "--all", "--no-open"]);
  expect(new URL(reopened).origin).toBe(url.origin);
  cli(home, ["ui", "--all", "--stop"]);
});

// #584: two concurrent opens each spawn a detached manager and only one wins the owner claim. A spawn that is still booting
// when the winner is stopped finds the owner row gone and claims it, and nothing stops that manager. The stand-in below holds
// the loser at startup, so the test can answer the opens from the winner, stop it, release the loser and look for a manager.
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** A stand-in for `ahub manager` (the `cli` option of openManager). Every pid it ever started is in the log, so stop() reaches
 * them whatever failed in the test; and a stand-in whose wait runs out exits instead of becoming the real manager. */
function gatedManager(home: string, polls = 1000) {
  const main = join(import.meta.dir, "..", "src/cli/main.ts"), wrapper = join(home, "gated-manager.ts");
  const log = join(home, "spawns.log"), release = join(home, "release");
  // Both spawns announce their pid first. The one that creates "first" waits until both have started, so the other is
  // certainly alive when the winner answers; the other waits for "release".
  writeFileSync(wrapper, [
    'import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";',
    `const log = ${JSON.stringify(log)}, release = ${JSON.stringify(release)};`,
    'let role = "late";',
    `try { closeSync(openSync(${JSON.stringify(join(home, "first"))}, "wx")); role = "early"; } catch { /* another spawn is first */ }`,
    'appendFileSync(log, `${process.pid} ${role}\\n`);',
    `const until = async (done: () => boolean) => { for (let i = 0; i < ${polls}; i++) { if (done()) return true; await Bun.sleep(20); } return false; };`,
    'const ready = role === "early" ? await until(() => readFileSync(log, "utf8").trim().split("\\n").length >= 2) : await until(() => existsSync(release));',
    'if (!ready) process.exit(3);',
    `await import(${JSON.stringify(main)});`,
  ].join("\n"));
  const spawns = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => Number(line.split(" ")[0])) : [];
  const stop = async () => {
    for (const pid of spawns()) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    for (const pid of spawns()) for (let i = 0; i < 150 && pidAlive(pid); i++) await Bun.sleep(20);
  };
  return { wrapper, release, spawns, stop };
}

test("a spawn that boots after the answering manager was stopped does not leave a manager running (#584)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-redundant-")); roots.push(home);
  const gate = gatedManager(home);
  try {
    const urls = await Promise.all([openManager({ home, cli: gate.wrapper }), openManager({ home, cli: gate.wrapper })]);
    expect(new URL(urls[0]!).origin).toBe(new URL(urls[1]!).origin);
    expect(gate.spawns()).toHaveLength(2);
    await stopManager({ home });
    appendFileSync(gate.release, "");
    // The released spawn now either exits (an owner is not free) or claims the owner row. Wait for it to settle, then look.
    for (let i = 0; i < 100 && !existsSync(join(home, "manager", "status.json")) && gate.spawns().some(pidAlive); i++) await Bun.sleep(20);
    const left = existsSync(join(home, "manager", "status.json"));
    if (left) await stopManager({ home }).catch(() => {}); // clean up before asserting, so a red run leaves nothing behind
    expect(left).toBe(false);
    for (const pid of gate.spawns()) { for (let i = 0; i < 150 && pidAlive(pid); i++) await Bun.sleep(20); expect(pidAlive(pid)).toBe(false); }
  } finally {
    // Reread the log here: a failure before the assertions above must still reach every wrapper that started.
    await gate.stop();
  }
});

test("the stand-in is reached by its teardown on a failed open and never turns into the real manager (#584)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-failed-open-")); roots.push(home);
  const gate = gatedManager(home);
  const child = spawn(process.execPath, [gate.wrapper], { env: { ...env(home), AGENTHUB_HOME: home }, stdio: "ignore" }); running.push(child);
  try {
    // One spawn only: it is the "early" one and waits for a second that never comes, which is a setup that failed midway.
    for (let i = 0; i < 150 && gate.spawns().length < 1; i++) await Bun.sleep(20);
    expect(gate.spawns()).toEqual([child.pid]);
  } finally { await gate.stop(); }
  expect(pidAlive(child.pid!)).toBe(false);
  await Bun.sleep(200);
  expect(existsSync(join(home, "manager", "status.json"))).toBe(false);
});

test("a stand-in whose wait runs out exits instead of starting the real manager (#584)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-gate-timeout-")); roots.push(home);
  const gate = gatedManager(home, 5);
  const child = spawn(process.execPath, [gate.wrapper], { env: { ...env(home), AGENTHUB_HOME: home }, stdio: "ignore" }); running.push(child);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect(code).toBe(3);
  expect(existsSync(join(home, "manager", "status.json"))).toBe(false);
});
