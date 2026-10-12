import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { taskRecords } from "../src/hub/research.ts";
import { readEvents } from "../src/hub/events.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
async function cli(root: string, args: string[], markers: Record<string, string> = {}) {
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const key of Object.keys(process.env)) if (key.startsWith("AGENTHUB_") || ["CODEX_THREAD_ID","CLAUDECODE","CLAUDE_CODE_SESSION_ID"].includes(key)) delete process.env[key];
Object.assign(process.env, ${JSON.stringify(markers)}, {AGENTHUB_HOME:${JSON.stringify(join(root, "home"))}});
process.argv=[process.execPath,${JSON.stringify(CLI)},...${JSON.stringify(args)}];await import(${JSON.stringify(CLI)});`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); }
}

test("planning tools and human CLI enforce actor revisions frozen scope and public PII (#263)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-planning-surfaces-")), stateDir = join(root, ".agenthub/state");
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, roles: { claude: ["planner"], codex: ["implementer"] }, batch_ms: 0 } });
  const clients: ControlClient[] = [];
  try {
    const connect = async (role: "console" | "tools", peer?: string) => { const client = await ControlClient.connect(stateDir, { role, ...(peer ? { peer } : {}) }); clients.push(client); return client; };
    const person = await connect("console"), planner = await connect("tools", "claude"), other = await connect("tools", "codex");
    const request = (client: ControlClient, op: string, args: unknown = {}) => client.request({ t: "task", op, args });
    expect(await request(other, "hub_backlog_list")).toMatchObject({ ok: false });
    expect(await request(person, "hub_task_propose", { title: "future", class: "implement", backlog: true })).toMatchObject({ ok: true });
    const listed = await request(planner, "hub_backlog_list"); expect(listed.ok).toBe(true);
    const id = JSON.parse(listed.text)[0].id;
    expect(await request(planner, "hub_backlog_plan", { id, revision: 0, fields: { priority: 1 }, reason: "needed" })).toMatchObject({ ok: true });
    expect(await request(other, "hub_backlog_plan", { id, revision: 1, fields: { priority: 0 }, reason: "override" })).toMatchObject({ ok: false });
    const pinned = await cli(root, ["backlog", "pin", String(id), "1", "true", "person hold"]); expect(pinned.code).toBe(0);
    expect(await request(planner, "hub_backlog_plan", { id, revision: 2, fields: { priority: 0 }, reason: "override" })).toMatchObject({ ok: false });
    const refused = await cli(root, ["release", "new", "next", "Deliver", "0"], { CODEX_THREAD_ID: "fixture" }); expect(refused.code).toBe(1);
    const created = await cli(root, ["release", "new", "next", "Deliver", "0"]); expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout).state).toBe("planning");
    expect((await cli(root, ["release", "activate", "next", "0"])).code).toBe(0);
    expect((await cli(root, ["release", "freeze", "next", "1"])).code).toBe(0);
    expect((await cli(root, ["release", "ship", "next", "2"])).code).toBe(0);
    const marker = "patient 900101-1234567";
    expect(await request(person, "hub_task_propose", { title: marker, class: "implement", backlog: true })).toMatchObject({ ok: true });
    const publicList = await request(planner, "hub_backlog_list"); expect(publicList.text).not.toContain(marker); expect(publicList.text).toContain("[pii]");
    const events = readEvents(join(stateDir, "events.jsonl"));
    expect(events.filter(event => event.type === "planning").length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(events.filter(event => event.type === "planning"))).not.toContain("person hold");
    expect(classifyPeerCommand("release", ["ship", "next", "2"])).toBe("console");
    expect(classifyPeerCommand("backlog", ["pin", "1", "0", "true"])).toBe("console");
  } finally { for (const client of clients) client.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("research planning metadata preserves unknown legacy values and reset generations (#263)", () => {
  const event = (event: string, state: string, at: string, fields = {}) => ({ v: 1, type: "task" as const, id: 1, by: "user", owner: "codex", reviewer: null, class: "implement", pii: false, event, state, at, ...fields });
  const records = taskRecords([
    event("backlogged", "backlog", "2026-10-12T00:00:00Z"),
    event("planned", "backlog", "2026-10-12T00:00:01Z", { release: 1, priority: 1, plannedStart: 100, due: 200 }),
    event("backlog pulled", "proposed", "2026-10-12T00:00:02Z"),
    event("done", "approved", "2026-10-12T00:00:03Z"),
    event("backlogged", "backlog", "2026-10-12T00:00:04Z"),
    event("backlog pulled", "proposed", "2026-10-12T00:00:05Z"),
    event("done", "approved", "2026-10-12T00:00:06Z"),
  ], "planning-test", { version: "fixture", source: "backfill" });
  expect(records[0]).toMatchObject({ release: 1, priority: 1, plannedStart: 100, due: 200 });
  expect(records[1]?.release).toBeUndefined(); expect(records[1]?.due).toBeUndefined();
});
