import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

class CollectingPeer extends BasePeer {
  readonly received: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envelopes: Envelope[]) { this.received.push(...envelopes); }
}

async function corpusHub() {
  const oldHome = process.env.HOME;
  const oldAgentHubHome = process.env.AGENTHUB_HOME;
  const home = mkdtempSync(join(tmpdir(), "ahub-corpus-home-"));
  process.env.HOME = home;
  process.env.AGENTHUB_HOME = join(home, ".agenthub");
  cleanup.push(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldAgentHubHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = oldAgentHubHome;
    rmSync(home, { recursive: true, force: true });
  });

  const cwd = mkdtempSync(join(tmpdir(), "ahub-corpus-project-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q");

  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  mkdirSync(join(cwd, "notes"), { recursive: true });
  mkdirSync(join(cwd, "private"), { recursive: true });
  const publicNote = "# Deployment handbook\n\n## Deploy checklist\nPUBLIC_CORPUS_CANARY: deploy the public release with the staged checklist.\n";
  const privateNote = "# Private handbook\n\nPRIVATE_PATH_CANARY: confidential release credentials and internal contact details.\n";
  const deniedNote = "# Local environment\n\nDENIED_FILE_CANARY: this file must never enter corpus evidence.\n";
  writeFileSync(join(cwd, "notes", "deployment.md"), publicNote);
  writeFileSync(join(cwd, "notes", ".env.md"), deniedNote);
  writeFileSync(join(cwd, "private", "internal.md"), privateNote);

  const routing = (await Bun.file(join(import.meta.dir, "../templates/routing.toml")).text())
    .replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"')
    .replace(/^pii_patterns = .*$/m, 'pii_patterns = ["PRIVATE-TASK-MARKER"]');
  writeFileSync(join(cwd, ".agenthub", "routing.toml"), routing);
  git("add", "-f", ".agenthub/routing.toml", "notes/deployment.md", "notes/.env.md", "private/internal.md");
  git("commit", "-qm", "fixture corpus project");

  const stateDir = join(cwd, "state");
  const daemon = await startDaemon({
    cwd,
    stateDir,
    controlPort: 0,
    codexAppPort: 0,
    codexProxyPort: 0,
    config: {
      ...DEFAULT_CONFIG,
      batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      corpus: { paths: ["notes", "private"] },
      pii: { paths: ["private"] },
    },
  });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => console_.close());
  return { cwd, stateDir, daemon, console_, publicNote, privateNote, deniedNote };
}

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 300 && !check(); attempt++) await Bun.sleep(10);
  expect(check(), label).toBe(true);
}

test("daemon corpus reads stay public, honor pii.paths and deny paths, and refuse a vault root", async () => {
  const f = await corpusHub();
  const peer = new CollectingPeer("codex");
  const local = new CollectingPeer("local");
  f.daemon.bus.add(peer);
  f.daemon.bus.add(local);
  const observed: unknown[] = [];
  f.console_.onPush = message => { if (message.t === "event") observed.push(message.e); };
  f.console_.send({ t: "tail" });
  await peer.start();
  await local.start();

  const ask = await f.console_.request({ t: "ask", question: "deployment release checklist" });
  expect(ask).toMatchObject({ ok: true, found: false, pii: false });
  const noteEvidence = ask.evidence.filter((item: { kind?: string }) => item.kind === "note");
  expect(noteEvidence.length).toBeGreaterThan(0);
  expect(noteEvidence[0]).toMatchObject({ id: "note:notes/deployment.md#deploy-checklist", kind: "note" });
  expect(JSON.stringify(noteEvidence)).toContain("PUBLIC_CORPUS_CANARY");
  expect(JSON.stringify(noteEvidence)).not.toContain("PRIVATE_PATH_CANARY");
  expect(JSON.stringify(noteEvidence)).not.toContain("DENIED_FILE_CANARY");
  expect(noteEvidence[0]).not.toHaveProperty("pii");
  expect(JSON.stringify(ask)).not.toContain("PRIVATE_PATH_CANARY");

  const proposed = await f.console_.request({ t: "task", op: "hub_task_propose", args: {
    title: "Deploy the public release",
    class: "implement",
    owner: "codex",
    refs: { paths: ["docs/deployment.md"] },
  } });
  expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
  await until(() => peer.received.some(env => env.body.includes("Knowledge brief")), "public corpus task brief delivery");
  const brief = peer.received.find(env => env.body.includes("Knowledge brief"))!.body;
  expect(brief).toContain("note:notes/deployment.md#deploy-checklist");
  expect(brief).toContain("PUBLIC_CORPUS_CANARY");
  expect(brief).not.toContain("PRIVATE_PATH_CANARY");
  expect(brief).not.toContain("DENIED_FILE_CANARY");

  const privateTask = await f.console_.request({ t: "task", op: "hub_task_propose", args: {
    title: "PRIVATE-TASK-MARKER deployment review",
    class: "implement",
    owner: "local",
    plan: { paths: ["docs/deployment.md"] },
  } });
  expect(privateTask.ok, JSON.stringify(privateTask)).toBe(true);
  await until(() => local.received.some(env => env.body.includes("PRIVATE-TASK-MARKER")), "on-prem PII task delivery");
  const privateEnvelope = local.received.find(env => env.body.includes("PRIVATE-TASK-MARKER"))!;
  expect(privateEnvelope.private).toBe(true);
  expect(privateEnvelope.body).not.toContain("PRIVATE_PATH_CANARY");
  expect(privateEnvelope.body).not.toContain("PUBLIC_CORPUS_CANARY");
  expect(privateEnvelope.body).not.toContain("DENIED_FILE_CANARY");
  expect(peer.received.map(env => env.body).join("\n")).not.toContain("PRIVATE-TASK-MARKER");
  expect(JSON.stringify(observed)).not.toContain("PRIVATE-TASK-MARKER");
  expect(readFileSync(join(f.stateDir, "hub.log"), "utf8")).not.toContain("PRIVATE-TASK-MARKER");
  expect(readFileSync(join(f.stateDir, "events.jsonl"), "utf8")).not.toContain("PRIVATE-TASK-MARKER");

  mkdirSync(join(f.cwd, "notes", "nested", ".obsidian"), { recursive: true });
  const afterVault = await f.console_.request({ t: "ask", question: "deployment release checklist" });
  expect(afterVault.evidence.filter((item: { kind?: string }) => item.kind === "note")).toEqual([]);
  expect(JSON.stringify(afterVault)).not.toContain("PUBLIC_CORPUS_CANARY");
});
