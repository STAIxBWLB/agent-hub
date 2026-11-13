import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { renderSdlcSurvey } from "../src/cli/sdlc-output.ts";
import { cliCommandLabel } from "../src/cli/identity.ts";

async function fixture(run: (cli: (args: string[]) => Promise<{code: number;out: string;err: string}>, requests: any[], old: () => void) => Promise<void>) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-survey-cli-"))), state = join(root, ".agenthub/state"), requests: any[] = [];
  mkdirSync(state, { recursive: true }); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  let unsupported = false;
  const identity = { cwd: root, projectId: "survey-cli", instanceId: "survey-cli", protocol: PROTOCOL };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req,srv) { return srv.upgrade(req) ? undefined : new Response("fixture"); }, websocket: { message(ws, raw) {
    const row = JSON.parse(String(raw)), reply = (data: object) => ws.send(JSON.stringify({ rid: row.rid, ...data }));
    if (row.t === "hello") return void reply({ t: "welcome", ok: true, ...identity, features: [] });
    if (row.t === "cli_audit" || row.t === "cli_audit_ack") return void reply({ ok: true, auditId: row.auditId, instanceId: identity.instanceId });
    if (row.t !== "sdlc") return void reply({ ok: false, error: "unsupported fixture request" });
    requests.push(row);
    if (unsupported) return void reply({ ok: false, error: "unknown SDLC operation" });
    if (row.op === "survey-start") return void reply({ ok: true, task: 7, survey: 3, ref: "a".repeat(40), ...(row.focus ? { focus: row.focus } : {}) });
    reply({ ok: true, survey: { task: 7, survey: 3, ref: "a".repeat(40), items: [], rejected: [{ id: "bounded-parser", reason: "Existing guard covers it", change: "unknown" }] } });
  } } });
  writeFileSync(join(state, "status.json"), JSON.stringify({ ...identity, controlPort: server.port, pid: process.pid }));
  writeFileSync(join(state, "control-token"), "synthetic-token");
  const cli = async (args: string[]) => {
    const env = { PATH: process.env.PATH ?? "", HOME: root, AGENTHUB_HOME: join(root, "home"), NO_COLOR: "1" };
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { const [code,out,err] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]); return {code,out,err}; }
    finally { clearTimeout(timer); await child.exited; }
  };
  try { await run(cli,requests,()=>{unsupported=true;}); } finally { server.stop(true); rmSync(root,{recursive:true,force:true}); }
}

test("#1403 survey CLI sends closed start/show forms and preserves explicit JSON", async () => {
  await fixture(async (cli,requests) => {
    const started = await cli(["sdlc","survey","start","--focus","tests","--json"]);
    expect(started.code,started.err).toBe(0); expect(JSON.parse(started.out)).toEqual({task:7,survey:3,ref:"a".repeat(40),focus:"tests"});
    expect(requests[0]).toMatchObject({t:"sdlc",op:"survey-start",focus:"tests"});
    const shown = await cli(["sdlc","survey","show","7"]);
    expect(shown.code,shown.err).toBe(0); expect(shown.out).toContain("rejected before"); expect(shown.out).toContain("unknown");
  });
},20_000);

test("survey human output includes per-finding prior reasons and closed audit labels", () => {
  for (const width of [80, 200]) {
    const rows = renderSdlcSurvey({ task: 7, survey: 3, items: [{ finding: { id: "bounded-parser" }, rejectedBefore: true,
      rejected: [{ id: "bounded-parser", reason: "Existing guard covers it", change: "unknown" }] }] }, width);
    const text = rows.map(row => row.map(span => span.text).join("")).join("\n");
    expect(text).toContain("rejected before"); expect(text).toContain("Existing guard covers it"); expect(text).toContain("unknown");
    for (const row of text.split("\n")) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
  }
  expect(cliCommandLabel("sdlc", ["survey", "start", "--focus", "SECRET_CANARY"])).toBe("sdlc survey start");
  expect(cliCommandLabel("sdlc", ["survey", "show", "SECRET_CANARY"])).toBe("sdlc survey show");
});

test("#1403 malformed survey arguments cause no mutation and old hubs name upgrade", async () => {
  await fixture(async (cli,requests,old) => {
    for (const args of [["start","--focus","unsafe"],["start","--focus","bugs","--focus","tests"],["start","extra"],["show","0"],["show","9999999999999999999999999"],["show"]]) expect((await cli(["sdlc","survey",...args])).code).toBe(1);
    expect(requests).toEqual([]); old();
    const result = await cli(["sdlc","survey","start"]);
    expect(result.code).toBe(1); expect(result.err).toContain("upgrade and restart");
  });
},20_000);
