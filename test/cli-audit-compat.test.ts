import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { drainCliAudits, recordCliAudit } from "../src/cli/identity-audit.ts";
import { drainCliAudits as legacyDrain } from "./fakes/legacy-cli-audit.ts";
import { createOperation, planFingerprint, type UpgradePlan } from "../src/cli/upgrade.ts";

test("#410 real legacy consumer deletes an unknown delegated outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-old-audit-"));
  try {
    recordCliAudit(dir, "codex", "permission", "delegated");
    expect(readdirSync(join(dir, "cli-audit"))).toHaveLength(1);
    expect(legacyDrain(dir)).toEqual([]);
    expect(readdirSync(join(dir, "cli-audit"))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const supported of [false, true]) test(`#410 authenticated welcome ${supported ? "supports" : "refuses"} delegated audit before effects`, async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-audit-compat-")));
  const state = join(root, ".agenthub/state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false } }));
  let effects = 0;
  const hellos: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (req.headers.has("origin")) return new Response("refused", { status: 403 }); if (server.upgrade(req)) return; return new Response("no", { status: 404 }); },
    websocket: { message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.t === "hello") {
        if (msg.token !== "fixture-token") return ws.close(4401, "bad token");
        hellos.push(msg.role);
        ws.send(JSON.stringify({ t: "welcome", rid: msg.rid, cwd: root, features: supported ? ["cli_audit_delegated"] : [] }));
      } else if (msg.t === "permission") {
        effects++;
        ws.send(JSON.stringify({ rid: msg.rid, ok: true }));
      }
    } },
  });
  // Disk advertisement is deliberately misleading; only authenticated welcome counts.
  writeFileSync(join(state, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, cwd: root, features: ["cli_audit_delegated"] }));
  writeFileSync(join(state, "control-token"), "fixture-token");
  const cli = join(import.meta.dir, "../src/cli/main.ts");
  const wrapper = join(root, "invoke.ts");
  writeFileSync(wrapper, `for (const key of ["CLAUDECODE","CLAUDE_CODE_SESSION_ID","CODEX_THREAD_ID","AGENTHUB_PROJECT_DIR","AGENTHUB_STATE_DIR","AGENTHUB_INSTANCE_ID","AGENTHUB_RECOVERY_OPERATION"]) delete process.env[key];\nObject.assign(process.env,{AGENTHUB_PEER_ID:"codex",AGENTHUB_HOME:${JSON.stringify(join(root, "home"))}});\nprocess.argv=[process.execPath,${JSON.stringify(cli)},"--project",${JSON.stringify(root)},"--live-test","permission","pi","ask"];\nawait import(${JSON.stringify(cli)});`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (supported) {
      expect(code, stderr).toBe(0);
      expect(effects).toBe(1);
      expect(hellos).toEqual(["console", "console"]);
      expect(drainCliAudits(state)).toMatchObject([{ peer: "codex", command: "permission", outcome: "delegated" }]);
    } else {
      expect(code, stderr).toBe(1);
      expect(effects).toBe(0);
      expect(stderr).toContain("upgrade");
      expect(hellos).toEqual(["console"]);
      expect(legacyDrain(state)).toMatchObject([{ peer: "codex", command: "permission", outcome: "refused" }]);
    }
  } finally { clearTimeout(timer); child.kill(); server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("#410 parsed resume action audits before a retained old coordinator, including presentation-first flags", async () => {
  for (const prefix of [["resume"], ["--json", "resume"], ["--color=never", "--verbose", "resume"]]) {
    const root = realPath(mkdtempSync(join(tmpdir(), "ahub-old-handoff-")));
    const home = join(root, "home"), source = join(root, "old-source"), seen = join(root, "seen.json");
    mkdirSync(join(root, ".agenthub"), { recursive: true });
    writeFileSync(join(root, ".agenthub/config.json"), "{}");
    mkdirSync(join(source, "src/cli"), { recursive: true });
    // No new audit logic: the retained coordinator observes what the caller durably wrote before spawn.
    writeFileSync(join(source, "src/cli/main.js"), `import {readFileSync,writeFileSync} from "node:fs"; import {join} from "node:path"; const id=process.argv.at(-1); const path=join(process.env.AGENTHUB_HOME,"recovery",id+".json"); const op=JSON.parse(readFileSync(path,"utf8")); writeFileSync(${JSON.stringify(seen)},JSON.stringify(op.delegatedAudits??[])); op.step="old-save"; writeFileSync(path,JSON.stringify(op));`);
    const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: "0.12.28", sourceRoot: source, sourceDigest: "fixture", blockers: [], projects: [{ project: { id: "fixture", root, stateDir: join(root, ".agenthub/state"), pid: 123, instanceId: "old", basePort: 4600 }, source: { state: "running", instanceId: "old", version: "0.12.28", protocol: PROTOCOL, peers: [], blockers: [] }, terminals: [], blockers: [] }] };
    const op = createOperation({ ...body, fingerprint: planFingerprint(body) }, source, home);
    const cli = join(import.meta.dir, "../src/cli/main.ts"), wrapper = join(root, "invoke.ts");
    writeFileSync(wrapper, `for(const key of ["CLAUDECODE","CLAUDE_CODE_SESSION_ID","CODEX_THREAD_ID","AGENTHUB_PROJECT_DIR","AGENTHUB_STATE_DIR","AGENTHUB_INSTANCE_ID","AGENTHUB_RECOVERY_OPERATION"])delete process.env[key]; Object.assign(process.env,{AGENTHUB_PEER_ID:"codex",AGENTHUB_HOME:${JSON.stringify(home)}}); process.argv=[process.execPath,${JSON.stringify(cli)},"--project",${JSON.stringify(root)},"--live-test","recovery",...${JSON.stringify(prefix)},${JSON.stringify(op.id)}]; await import(${JSON.stringify(cli)});`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0);
      const deadline = Date.now() + 5000;
      while ((!existsSync(seen) || !readFileSync(join(home, "recovery", `${op.id}.json`), "utf8").includes("old-save")) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(seen)).toBe(true);
      const expected = [{ at: expect.any(Number), peer: "codex", command: "recovery resume", operationId: op.id }];
      expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual(expected);
      expect(JSON.parse(readFileSync(join(home, "recovery", `${op.id}.json`), "utf8")).delegatedAudits).toEqual(expected);
    } finally { clearTimeout(timer); child.kill(); rmSync(root, { recursive: true, force: true }); }
  }
}, 20_000);
