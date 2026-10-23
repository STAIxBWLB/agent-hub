import { renderStatus } from "../src/cli/output.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_SCHEMA, MemoryStore, entryId, type NoteEntry } from "@staix/agent-mem";
import { MemoryClient } from "../src/memory/client.ts";
import { recallFor } from "../src/memory/recall.ts";
import { Briefs } from "../src/memory/brief.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

type Window = Parameters<MemoryStore["readPage"]>[0];
let fixture: ReturnType<typeof createFixture>;
beforeAll(() => { fixture = createFixture(); });
afterEach(() => { fixture.withhold(false); fixture.pages.length = 0; });
afterAll(() => { fixture?.client.close(); fixture?.store.close(); if (fixture) rmSync(fixture.home, { recursive: true, force: true }); });

function createFixture() {
  const home = mkdtempSync(join(tmpdir(), "ahub-amem-bounded-")), store = new MemoryStore({ home });
  const now = Date.now(), start = now - 60_000, local: string[] = [], shared: string[] = [];
  let newest = "";
  // Author valid append-only fixture segments in one small write, then let the published store build its index.
  // Thousands of individual durable note() writes would measure filesystem fsync rather than bounded recall.
  for (let i = 0; i < 4104; i++) {
    const body: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", machine: store.machine.id, at: new Date(start + i).toISOString(),
      project: "project-a", scope: "project", tier: "short", kind: "decision", peer: i === 4101 ? "kimi" : i % 2 ? "codex" : "kimi", source: "person", about: [],
      title: i === 4103 ? "newest codex boundedneedle" : i === 4101 ? "newest kimi boundedneedle" : i === 4102 ? "withheld-marker boundedneedle" : `public filler ${i}`,
      text: i === 4103 ? "known newest public codex row" : i === 4101 ? "known newest public kimi row" : i === 4102 ? "withheld-marker must never be rendered" : `public filler text ${i}`,
      expires: new Date(now + 86_400_000).toISOString() };
    const id = entryId(body); if (i === 4103) newest = id;
    local.push(JSON.stringify({ ...body, id }));
  }
  for (let i = 0; i < 48; i++) {
    const body: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", machine: store.machine.id, at: new Date(now + i).toISOString(),
      project: "project-foreign", scope: "shared", tier: "long", kind: "contract", peer: "claude", source: "person", about: [],
      title: `foreign-shared-marker boundedneedle ${i}`, text: "foreign-shared-marker must never enter this exact-project view" };
    shared.push(JSON.stringify({ ...body, id: entryId(body) }));
  }
  appendFileSync(join(store.dir, "local", `${store.machine.id}.jsonl`), local.join("\n") + "\n");
  appendFileSync(join(store.dir, "log", `${store.machine.id}.jsonl`), shared.join("\n") + "\n");
  store.refresh();
  const pages: Window[] = [], readPage = store.readPage.bind(store);
  store.readPage = window => { pages.push({ ...window }); return readPage(window); };
  store.list = () => { throw new Error("unbounded MemoryStore.list is forbidden in the client view"); };
  let withheld = false;
  const client = new MemoryClient({ project: "project-a", store, check() {}, publicText: () => true,
    screen: rows => withheld ? [] : rows.filter(row => !`${row.title ?? ""} ${row.text}`.includes("withheld-marker")) });
  return { home, store, client, newest, pages, withhold(value: boolean) { withheld = value; } };
}
function assertBoundedRead() {
  const { pages, client } = fixture;
  expect(pages.length).toBeGreaterThan(0); expect(pages.length).toBeLessThanOrEqual(17);
  expect(pages.every(page => page.project === "project-a" && page.limit >= 1 && page.limit <= 256)).toBe(true);
  expect(pages.every(page => !page.projects || page.projects.every(project => project === "project-a"))).toBe(true);
  expect(pages.map(page => page.limit)).toEqual([...Array<number>(16).fill(256), 1]);
  expect(client.readStatus()).toEqual({ truncated: true, scanned: 4096, limit: 4096 });
  expect(client.readNotice()).toContain("memory view truncated");
  pages.length = 0;
}
function assertPublic(text: string | undefined) {
  expect(text).toBeDefined(); expect(text).toContain("boundedneedle");
  expect(text).not.toContain("foreign-shared-marker"); expect(text).not.toContain("withheld-marker");
}

test("bounded production context retains newest short notes from all authors without unbounded list or foreign shared rows", async () => {
  const text = await fixture.client.contextInject(["ignored-legacy-project"]);
  assertPublic(text); expect(text).toContain("newest codex boundedneedle"); expect(text).toContain("newest kimi boundedneedle");
  expect(text).toContain("memory view truncated"); assertBoundedRead();
});

test("bounded production search and timeline retain known public rows and explicit truncation status", async () => {
  const found = await fixture.client.search("boundedneedle", "project-foreign");
  assertPublic(found); expect(found).toContain(`mem:${fixture.newest}`); assertBoundedRead();
  const around = await fixture.client.timeline(`mem:${fixture.newest}`, "project-foreign", 1, 3);
  assertPublic(around); expect(around).toContain(`mem:${fixture.newest}`); assertBoundedRead();
});

test("recall and task brief retain truncation notices when some or every scanned row is withheld", async () => {
  for (const withheld of [false, true]) {
    fixture.withhold(withheld);
    const recall = await recallFor("codex", fixture.client, ["ignored"], 2000);
    expect(recall).toContain("memory view truncated"); expect(recall).not.toContain("withheld-marker"); expect(recall).not.toContain("foreign-shared-marker");
    if (withheld) expect(recall).not.toContain("known newest public"); else expect(recall).toContain("boundedneedle");
    assertBoundedRead();
    const brief = await new Briefs(fixture.client, "project-a").forTask("codex", { id: 1, title: "boundedneedle", refs: {} });
    expect(brief).toContain("memory view truncated"); expect(brief).not.toContain("withheld-marker"); expect(brief).not.toContain("foreign-shared-marker");
    if (withheld) expect(brief).not.toContain("boundedneedle");
    // Briefs may follow a known public search hit with its timeline; each operation has the same bounded page ceiling.
    expect(fixture.pages.length).toBeGreaterThan(0); expect(fixture.pages.length).toBeLessThanOrEqual(withheld ? 17 : 34);
    expect(fixture.pages.every(page => page.project === "project-a" && page.limit <= 256)).toBe(true);
    expect(fixture.client.readStatus().truncated).toBe(true); fixture.pages.length = 0;
  }
});


test("real daemon status projects the production client's truncated memory view", async () => {
  await fixture.client.contextInject([]); assertBoundedRead();
  const prior = { AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
  process.env.AMEM_HOME = join(fixture.home, "memory"); process.env.AGENTHUB_HOME = join(fixture.home, "isolated-hub-home");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, control: ControlClient | undefined;
  try {
    const stateDir = join(fixture.home, "daemon-state");
    daemon = await startDaemon({ cwd: fixture.home, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, memoryClient: fixture.client,
      config: { ...DEFAULT_CONFIG, peers: {}, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
        snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      } });
    control = await ControlClient.connect(stateDir, { role: "console" });
    const reply = await control.request({ t: "status" });
    expect(reply.status.memoryRead).toMatchObject({ truncated: true, scanned: 4096, limit: 4096 });
    expect(fixture.pages).toHaveLength(0); // Status is a read-only projection; it cannot restart or clear the view.
  } finally {
    control?.close(); await daemon?.stop();
    for (const key of ["AMEM_HOME", "AGENTHUB_HOME"] as const) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  }
});


test("person status visibly reports a truncated project memory view", () => {
 const text=renderStatus({peers:{},memoryRead:{truncated:true,scanned:4096,limit:4096}},160).map(line=>line.map(span=>span.text).join("")).join("\n");
 expect(text).toContain("memory view");expect(text).toContain("truncated: newest 4096 project candidates considered");
 const complete=renderStatus({peers:{},memoryRead:{truncated:false,scanned:4,limit:4096}},160).map(line=>line.map(span=>span.text).join("")).join("\n");
 expect(complete).not.toContain("memory view");
});
