import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRecoveryDriver } from "../src/cli/upgrade-runtime.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { readRecoveryContinuity, writeRecoveryContinuity, type RecoveryContinuityBookmark } from "../src/hub/recovery-continuity.ts";

const OLD = "00000000-0000-4000-8000-000000000001", CURRENT = "00000000-0000-4000-8000-000000000002", NEWER = "00000000-0000-4000-8000-000000000003";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-continuity-release-"))), stateDir = join(root, "state");
  cleanup.push(() => rmSync(root, { recursive: true, force: true })); mkdirSync(stateDir, { mode: 0o700 });
  const project = { id: "continuity-release", root, stateDir, basePort: 0, instanceId: "target-instance", pid: null };
  const bookmark: RecoveryContinuityBookmark = { schema: 1, operationId: OLD, projectId: project.id, projectRoot: root, at: 1000, pi: { sessionId: "fixture-pi-session" } };
  let sawRelease!: () => void, reply!: (ok: boolean) => void;
  const releaseSeen = new Promise<void>(resolve => { sawRelease = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const message = JSON.parse(String(data));
      if (message.t === "hello") ws.send(JSON.stringify({ rid: message.rid, t: "welcome", ok: true, projectId: project.id, instanceId: project.instanceId, cwd: root, protocol: PROTOCOL }));
      else if (message.t === "recovery" && message.op === "release") {
        expect(message.operationId).toBe(CURRENT); expect(message.expectedInstanceId).toBe(project.instanceId);
        reply = ok => ws.send(JSON.stringify({ rid: message.rid, t: "recovery", ok, ...(ok ? { released: true } : { error: "fixture release refused" }) }));
        sawRelease();
      } else ws.send(JSON.stringify({ rid: message.rid, ok: false, error: "unexpected fixture request" }));
    } },
  });
  cleanup.push(() => server.stop(true));
  writeFileSync(join(stateDir, "control-token"), "fixture-control-token\n", { mode: 0o600 });
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: project.id, instanceId: project.instanceId, cwd: root }));
  const driver = makeRecoveryDriver(async () => { throw new Error("release must use only the authenticated control path"); });
  const begin = () => {
    // Attach rejection immediately: fixture cleanup must not turn a pending request into an unhandled rejection.
    return driver.release(project, CURRENT, project.instanceId).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  };
  const read = () => readRecoveryContinuity(stateDir, { projectId: project.id, projectRoot: root });
  const archives = () => readdirSync(stateDir).filter(name => name.startsWith("recovery-continuity.retired."));
  return { root, stateDir, project, bookmark, releaseSeen, reply: (ok: boolean) => reply(ok), begin, read, archives, file: join(stateDir, "recovery-continuity.json") };
}

test("#463 later recovery retires old continuity only after a successful authenticated release", async () => {
  const f = fixture(); writeRecoveryContinuity(f.stateDir, f.bookmark);
  const before = readFileSync(f.file, "utf8"), result = f.begin();
  await f.releaseSeen;
  expect(f.read().state).toBe("ready"); expect(f.archives()).toEqual([]);
  f.reply(true); expect(await result).toEqual({ ok: true });
  expect(f.read()).toEqual({ state: "absent" });
  const names = f.archives(); expect(names).toHaveLength(1); expect(names[0]).toContain("recovery_released");
  expect(readFileSync(join(f.stateDir, names[0]!), "utf8")).toBe(before);
});

test("#463 a refused release retains the old active continuity bookmark", async () => {
  const f = fixture(); writeRecoveryContinuity(f.stateDir, f.bookmark);
  const before = readFileSync(f.file, "utf8"), result = f.begin();
  await f.releaseSeen; f.reply(false);
  const outcome = await result; expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.message).toBe("fixture release refused");
  expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.archives()).toEqual([]);
});

test("#463 release CAS cannot retire a newer bookmark written while the release request awaited its reply", async () => {
  const f = fixture(); writeRecoveryContinuity(f.stateDir, f.bookmark);
  const result = f.begin(); await f.releaseSeen;
  const newer = { ...f.bookmark, operationId: NEWER, at: 3000, pi: { sessionId: "newer-fixture-session" } };
  writeRecoveryContinuity(f.stateDir, newer);
  const before = readFileSync(f.file, "utf8");
  f.reply(true); expect(await result).toEqual({ ok: true });
  expect(readFileSync(f.file, "utf8")).toBe(before);
  const read = f.read(); expect(read.state).toBe("ready");
  if (read.state === "ready") expect(read.bookmark).toEqual(newer);
  expect(f.archives()).toEqual([]);
});

test("#463 invalid prior continuity does not fail a successful release or become an absence", async () => {
  const f = fixture(); writeFileSync(f.file, "{", { mode: 0o600 });
  const result = f.begin(); await f.releaseSeen; f.reply(true);
  expect(await result).toEqual({ ok: true }); expect(f.read().state).toBe("invalid");
  expect(readFileSync(f.file, "utf8")).toBe("{"); expect(f.archives()).toEqual([]);
});

test("#463 release does not retire continuity created by the same recovery operation", async () => {
  const f = fixture(); writeRecoveryContinuity(f.stateDir, { ...f.bookmark, operationId: CURRENT });
  const before = readFileSync(f.file, "utf8"), result = f.begin(); await f.releaseSeen; f.reply(true);
  expect(await result).toEqual({ ok: true }); expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.archives()).toEqual([]);
});

test("#463 retirement storage failure after release is advisory and retains active evidence", async () => {
  const f = fixture(); writeRecoveryContinuity(f.stateDir, f.bookmark);
  const result = f.begin(); await f.releaseSeen;
  const lock = join(f.stateDir, "recovery-continuity-lock.db");
  expect(existsSync(lock)).toBe(true); rmSync(lock); mkdirSync(lock);
  f.reply(true); expect(await result).toEqual({ ok: true });
  expect(f.read().state).toBe("ready"); expect(f.archives()).toEqual([]);
});
