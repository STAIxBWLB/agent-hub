import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { TASK_TOOLS } from "../src/hub/hub-tools.ts";
import { realPath } from "../src/hub/project.ts";

async function rig() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-return-1154-"))), stateDir = join(cwd, ".agenthub/state");
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/routing.toml"), readFileSync(new URL("../templates/routing.toml", import.meta.url), "utf8")
    .replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"').replace(/^pii_patterns = .*$/m, 'pii_patterns = ["RETURN-PRIVATE-1154"]'));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, roles: { claude: ["planner"], codex: ["implementer"] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, tasks: { ...DEFAULT_CONFIG.tasks, auto_pull: false } } });
  const clients: ControlClient[] = [];
  async function connect(role: "console" | "tools", peer?: string) {
    const client = await ControlClient.connect(stateDir, { role, projectRoot: cwd, ...(peer ? { peer } : {}) });
    clients.push(client); return client;
  }
  const person = await connect("console"), planner = await connect("tools", "claude"), other = await connect("tools", "codex");
  const request = (client: ControlClient, op: string, args: Record<string, unknown> = {}) => client.request({ t: "task", op, args });
  const show = async (id: number) => { const response = await request(person, "task_show", { id }); expect(response.ok).toBe(true); return JSON.parse(response.text); };
  let serial = 0;
  async function card(reservationBy: ControlClient = planner, privateTask = false) {
    const title = `${privateTask ? "RETURN-PRIVATE-1154 " : ""}untouched fixture ${++serial}`;
    expect((await request(person, "hub_task_propose", { title, class: "implement", backlog: true })).ok).toBe(true);
    const listed = await request(person, "hub_backlog_list"), rows = JSON.parse(listed.text) as { id: number }[];
    const id = Math.max(...rows.map(row => row.id));
    if (!privateTask) expect((await request(reservationBy, "hub_backlog_plan", { id, revision: 0, fields: { reserved: "codex" }, reason: "reserve future work" })).ok).toBe(true);
    expect((await request(person, "backlog_pull", { id })).ok).toBe(true);
    return show(id);
  }
  const back = (client: ControlClient, row: { id: number; planningRevision?: number }, extra: Record<string, unknown> = {}) => request(client, "hub_backlog_return_untouched", { id: row.id, revision: row.planningRevision ?? 0, reason: "park the untouched receipt", ...extra });
  return { person, planner, other, card, back, show, stop: async () => { for (const client of clients) client.close(); await daemon.stop(); rmSync(cwd, { recursive: true, force: true }); } };
}

test("untouched return schema adds only optional reserved fields and keeps the existing required identity (#1154)", () => {
  const schema = TASK_TOOLS.find(tool => tool.name === "hub_backlog_return_untouched")!.inputSchema;
  expect(schema.required).toEqual(["id", "revision", "reason"]);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.fields).toEqual({ type: "object", properties: { reserved: { type: ["string", "null"], minLength: 1, maxLength: 32 } }, additionalProperties: false });
});

test("real daemon forwards a reservation clear and preserves the omitted-fields return behavior (#1154)", async () => {
  const f = await rig();
  try {
    const row = await f.card(); expect(row.reserved).toBe("codex");
    const response = await f.back(f.planner, row, { fields: { reserved: null } });
    expect(response.ok).toBe(true);
    const cleared = JSON.parse(response.text);
    expect(cleared).toMatchObject({ id: row.id, state: "backlog", owner: null, reviewer: null, reserved: null });
    expect(cleared.history.at(-1).note).toBe("park the untouched receipt");
    expect(await f.show(row.id)).toMatchObject({ state: "backlog", reserved: null });
    const legacy = await f.card(), returned = await f.back(f.planner, legacy);
    expect(returned.ok).toBe(true);
    expect(JSON.parse(returned.text)).toMatchObject({ id: legacy.id, state: "backlog", reserved: "codex" });
  } finally { await f.stop(); }
});

test("real daemon preserves the task for malformed fields, stale revisions and reservation authority refusals (#1154)", async () => {
  const f = await rig();
  try {
    const row = await f.card(), before = await f.show(row.id);
    for (const fields of [null, [], "reserved", { reserved: false }, { reserved: 1 }, { reserved: "" }, { reserved: "codex", priority: 0 }, { priority: 0 }]) {
      expect((await f.back(f.planner, row, { fields })).ok).toBe(false);
      expect(await f.show(row.id)).toEqual(before);
    }
    expect((await f.back(f.planner, row, { revision: (row.planningRevision ?? 0) + 1, fields: { reserved: null } })).ok).toBe(false);
    expect(await f.show(row.id)).toEqual(before);
    expect((await f.back(f.other, row, { fields: { reserved: null } })).ok).toBe(false);
    expect(await f.show(row.id)).toEqual(before);
    const owned = await f.card(f.person), personBefore = await f.show(owned.id);
    const refused = await f.back(f.planner, owned, { fields: { reserved: null } });
    expect(refused.ok).toBe(false); expect(refused.error).toContain("reservation");
    expect(await f.show(owned.id)).toEqual(personBefore);
    const returned = await f.back(f.person, owned, { fields: { reserved: null } });
    expect(returned.ok).toBe(true); expect(JSON.parse(returned.text)).toMatchObject({ state: "backlog", reserved: null });
  } finally { await f.stop(); }
});

test("real daemon returns the private task through publicView after the reservation-aware operation (#1154)", async () => {
  const f = await rig();
  try {
    const row = await f.card(f.person, true);
    const result = await f.back(f.person, row, { fields: { reserved: null } });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ id: row.id, state: "backlog", title: "[pii]", detail: "[pii]", refs: {}, plan: {} });
    expect(result.text).not.toContain("RETURN-PRIVATE-1154");
  } finally { await f.stop(); }
});
