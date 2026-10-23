import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { USER } from "../src/hub/envelope.ts";

// #509a through the real daemon and its control socket: the tool ops pass `deliverables` through, the owner's root is the project here, and
// `task_show` reports the live state. A plain folder: no git repository is initialised.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function rig() {
  const root = mkdtempSync(join(tmpdir(), "ahub-daemon-deliverables-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, peers: { kimi: { start_mode: "headless" } }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false }, kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")], local: { ...DEFAULT_CONFIG.local, deny: ["secret"] } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "kimi" }); cleanup.push(() => tools.close());
  const claude = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => claude.close()); // an attached reviewer candidate
  const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
  const op = (client: ControlClient, name: string, args: Record<string, unknown>) => client.request({ t: "task", op: name, args }, 15000);
  const propose = async (reviewer = false) => {
    const made = await op(console_, "hub_task_propose", { title: "write the report", class: "implement", owner: "kimi" });
    expect(made.ok).toBe(true);
    const id = Number(/#(\d+)/.exec(String(made.text))![1]);
    expect((await op(tools, "hub_task_accept", { id })).ok).toBe(true);
    // Only a task with a reviewer reaches in_review: without one, done approves directly and there is no verdict to give.
    if (reviewer) expect((await op(console_, "task_assign", { id, peer: "claude", role: "reviewer" })).ok).toBe(true);
    return id;
  };
  const show = async (id: number) => JSON.parse((await op(console_, "task_show", { id })).text);
  return { root, daemon, console_, tools, write, op, propose, show };
}

test("hub_task_done passes deliverables through, the hub hashes them, and task_show reports them live (plain folder, no git)", async () => {
  const r = await rig(); r.write("out/report.md", "# Report v1\n");
  const id = await r.propose();
  const done = await r.op(r.tools, "hub_task_done", { id, summary: "wrote the report", deliverables: [{ path: "out/report.md", format: "md", version: "v1" }] });
  expect(done.ok, String(done.error ?? done.text)).toBe(true);
  const shown = await r.show(id);
  expect(shown.deliverables).toMatchObject({ state: "delivered", changedSinceReview: false, files: [{ path: "out/report.md", format: "md", version: "v1", sha256: sha("# Report v1\n"), state: "unchanged" }] });
  expect(shown.history.find((h: any) => h.event === "done").deliverables[0]).toMatchObject({ sha256: sha("# Report v1\n"), bytes: 12 });
  r.write("out/report.md", "# Report v1, edited\n");
  expect((await r.show(id)).deliverables).toMatchObject({ changedSinceReview: true, files: [{ state: "changed" }] });
});

test("an approval over the control socket after an edit binds the current hashes and says the files changed since delivery", async () => {
  const r = await rig(); r.write("report.md", "reviewed bytes");
  const id = await r.propose(true);
  expect((await r.op(r.tools, "hub_task_done", { id, summary: "done", deliverables: [{ path: "report.md", format: "md" }] })).ok).toBe(true);
  r.write("report.md", "edited after the review request");
  const approved = await r.op(r.console_, "hub_review", { id, verdict: "approved", note: "ok" });
  expect(approved.ok).toBe(true); // the person approves the bytes on disk now
  const shown = await r.show(id);
  expect(shown.state).toBe("approved");
  expect(shown.history.findLast((h: any) => h.event === "approved").deliverables[0].sha256).toBe(sha("edited after the review request"));
  expect(shown.history.findLast((h: any) => h.event === "approved").note).toContain("Approved with the deliverable files changed since delivery");
});

test("a claimed hash, a denied path and a path outside the project are refused over the socket with nothing recorded", async () => {
  const r = await rig(); r.write("report.md", "x"); r.write("notes/secret.txt", "s");
  const id = await r.propose();
  const before = JSON.stringify((await r.show(id)).history);
  for (const [deliverables, why] of [
    [[{ path: "report.md", format: "md", sha256: sha("x") }], /a claimed hash is not used/],
    [[{ path: "notes/secret.txt", format: "txt" }], /denylist/],
    [[{ path: "../outside.md", format: "md" }], /\.\. segments/],
    [[{ path: "absent.md", format: "md" }], /does not exist/],
  ] as const) {
    const result = await r.op(r.tools, "hub_task_done", { id, summary: "done", deliverables });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(why);
  }
  expect(JSON.stringify((await r.show(id)).history)).toBe(before);
});

test("hub_sdlc_record carries deliverables through recordSdlc, and a peer's task_show shows a private record by id, hash and size only", async () => {
  const r = await rig(); r.write("deck.pptx", "slides");
  const id = await r.propose();
  const recorded = await r.op(r.tools, "hub_sdlc_record", { id, receipt: { deliverables: [{ path: "deck.pptx", format: "pptx" }] } });
  expect(recorded.ok, String(recorded.error ?? recorded.text)).toBe(true);
  expect((await r.show(id)).history.find((h: any) => h.event === "lifecycle").deliverables[0]).toMatchObject({ sha256: sha("slides"), path: "deck.pptx" });
  const peer = await r.op(r.tools, "task_show", { id });
  expect(peer.ok).toBe(true);
  expect(JSON.parse(peer.text).deliverables).toMatchObject({ state: "delivered", files: [{ sha256: sha("slides"), state: "unchanged" }] });
});
