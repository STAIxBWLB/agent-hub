import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, taskClaimIdentity } from "../src/hub/board.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { inventoryBinding, synthesisManifestHash } from "../src/hub/synthesis-readiness.ts";
import { hashDeliverables } from "../src/hub/deliverable-files.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { realPath } from "../src/hub/project.ts";
import { SourceRegistry, sourceProjectionReceipt } from "../src/hub/sources.ts";

test("#931 daemon keeps explicit synthesis reads console-only, current and closed", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-synthesis-daemon-"))), stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".agenthub", "config.json"), "{}");
  const board = new Board(join(stateDir, "hub.db"));
  const sources = new SourceRegistry(stateDir), bytes = Buffer.from("Public offline evidence fixture"), text = bytes.toString("utf8");
  const projection = sourceProjectionReceipt(bytes, text)!;
  const source = sources.add({ bytes, text, projection, kind: "file", origin: "fixture-source.txt", private: false });
  const task = board.propose("user", { title: "Public synthesis fixture", class: "test", profile: "research", plan: { claims: ["CLAIM_TEXT_CANARY"] } });
  board.update(task.id, "user", "fixture accepted", { owner: "codex", state: "in_progress" });
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, sdlc: sdlcConfig(undefined),
    config: { ...DEFAULT_CONFIG, profile: "research", roles: { codex: ["implementer"] }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  const clients: ControlClient[] = [];
  try {
    const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); clients.push(person);
    const owner = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: root }); clients.push(owner);
    const call = (client: ControlClient, op: string, args: unknown) => client.request({ t: "task", op, args });
    const before = board.statusRevision(), metadata = await call(person, "study_evidence", { taskId: task.id });
    expect(Boolean(metadata.ok), metadata.error).toBe(true);
    const view = JSON.parse(metadata.text);
    expect(view.status).toBe("available"); expect(view.claims).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("CLAIM_TEXT_CANARY");
    const identity = taskClaimIdentity(task, 1), manifest = { schemaVersion: 1, taskId: task.id, taskCreated: task.created,
      deliverable: { id: `d-${"0".repeat(12)}`, sha256: "0".repeat(64) }, bibliography: { id: `d-${"1".repeat(12)}`, sha256: "1".repeat(64) },
      claims: [{ claimId: identity.claimId, claimRevision: identity.claimRevision, inventory: inventoryBinding([], true), evidence: [] }] };
    const response = await call(person, "study_check", { taskId: task.id, manifest });
    expect(Boolean(response.ok), response.error).toBe(true);
    const result = JSON.parse(response.text);
    expect(result.status).not.toBe("ready"); expect(result.deliverable).toBe("missing");
    expect(result.claims[0].judgment).toBe("missing"); expect(result.claims[0].inventory).toBe("current");
    const ahub = async (...args: string[]) => {
      const env = { ...process.env, HOME: root, AGENTHUB_HOME: join(root, "fake-home"), NO_COLOR: "1" } as Record<string, string>;
      for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") && key !== "AGENTHUB_HOME" || ["CODEX_THREAD_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "KIMI_CODE"].includes(key)) delete env[key];
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", root, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout, stderr };
    };
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
    const checked = await ahub("study", "check", String(task.id), "manifest.json", "--json");
    expect(checked.code, checked.stderr).toBe(1); expect(JSON.parse(checked.stdout)).toEqual(result);
    const plain = await ahub("study", "check", String(task.id), "manifest.json");
    expect(plain.code, plain.stderr).toBe(1); expect(plain.stdout).toContain("structural/provenance only");
    const inventoryCli = await ahub("study", "evidence", "--task", String(task.id), "--json");
    expect(inventoryCli.code, inventoryCli.stderr).toBe(0); expect(JSON.parse(inventoryCli.stdout)).toEqual(view);
    for (const op of ["study_evidence", "study_check"]) expect((await call(owner, op, { taskId: task.id, manifest })).ok).toBe(false);
    expect((await call(person, "study_check", { taskId: task.id, manifest, current: "SPOOFED_CANARY" })).ok).toBe(false);
    expect(board.statusRevision()).toBe(before);
    const synthesis = { manifestSha256: "a".repeat(64), disposition: "qualified" };
    expect((await call(owner, "claim_verdict", { id: task.id, slot: 1, verdict: "supported", synthesis })).ok).toBe(false);
    expect((await call(person, "claim_verdict", { id: task.id, slot: 1, verdict: "supported", synthesis: { ...synthesis, text: "NARRATIVE_CANARY" } })).ok).toBe(false);
    expect(board.statusRevision()).toBe(before);
    const judgment = await call(person, "claim_verdict", { id: task.id, slot: 1, verdict: "supported", synthesis });
    expect(judgment.ok).toBe(false); expect(board.statusRevision()).toBe(before);
    expect(board.hasWithdrawnEvidenceState()).toBe(false);
    const payload = { taskId: task.id, claimId: identity.claimId, claimRevision: identity.claimRevision,
      sourceId: source.id, rawSha256: sources.get(source.id)!.sha256, projectionSha256: projection.projectionSha256,
      projectionVersion: projection.projectionVersion, locator: { start: 0, end: 4 }, relation: "supports" };
    const recorded = await call(owner, "hub_evidence_record", payload);
    expect(Boolean(recorded.ok), recorded.error).toBe(true);
    const link = JSON.parse(recorded.text);
    const counter = await call(owner, "hub_evidence_record", { ...payload, relation: "contradicts" });
    expect(Boolean(counter.ok), counter.error).toBe(true);
    writeFileSync(join(root, "report.md"), "Fixture conclusion [@fixture]\n");
    writeFileSync(join(root, "references.bib"), "@article{fixture, title={Fixture}}\n");
    const artifacts = await hashDeliverables([{ path: "report.md", format: "md" }, { path: "references.bib", format: "bib" }], { cwd: root, deny: [], private: () => false });
    board.update(task.id, "codex", "lifecycle", {}, undefined, { deliverables: artifacts });
    const inventory = JSON.parse((await call(person, "study_evidence", { taskId: task.id })).text);
    const currentManifest = { ...manifest, deliverable: { id: artifacts[0]!.id, sha256: artifacts[0]!.sha256 }, bibliography: { id: artifacts[1]!.id, sha256: artifacts[1]!.sha256 },
      claims: [{ ...manifest.claims[0]!, inventory: inventory.claims[0].inventory, evidence: [{ id: link.id, revision: 1, citationKey: "fixture" }] }] };
    const currentHash = synthesisManifestHash(currentManifest), revision = board.statusRevision();
    const mismatch = await call(person, "claim_verdict", { id: task.id, slot: 1, verdict: "supported", synthesis, manifest: currentManifest });
    expect(mismatch.ok).toBe(false); expect(mismatch.error).toContain(currentHash); expect(board.statusRevision()).toBe(revision);
    writeFileSync(join(root, "current-manifest.json"), JSON.stringify(currentManifest));
    const entered = await ahub("task", "claim", String(task.id), "1", "supported", "--manifest", "current-manifest.json", "--disposition", "qualified");
    expect(entered.code, entered.stderr).toBe(0); expect(entered.stdout).toContain(`qualified @ ${currentHash}`);
    expect(board.get(task.id)!.history.at(-1)?.claim?.synthesis).toEqual({ manifestSha256: currentHash, disposition: "qualified" });
    const withdrawn = await call(owner, "hub_evidence_record", { ...payload, id: link.id, revision: 2, status: "withdrawn" });
    expect(Boolean(withdrawn.ok), withdrawn.error).toBe(true);
    expect(board.hasWithdrawnEvidenceState()).toBe(true);
    const status = (await person.request({ t: "status" })).status;
    expect(status.features).toContain("research_evidence_withdrawal");
    for (const op of ["prepare", "commit", "inspect"]) {
      const refusal = await person.request({ t: "recovery", op, operationId: "synthesis-compatibility", expectedInstanceId: status.instanceId,
        targetFeatures: status.features.filter((name: string) => name !== "research_evidence_withdrawal") });
      expect(refusal.ok).toBe(false); expect(refusal.error).toContain("target lacks research_evidence_withdrawal");
    }
    board.update(task.id, "user", "fixture privacy upgrade", { signals: ["pii"] });
    const privateRead = await call(person, "study_check", { taskId: task.id, manifest });
    expect(JSON.parse(privateRead.text)).toEqual({ taskId: task.id, status: "private" });
  } finally {
    for (const client of clients) client.close();
    board.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
