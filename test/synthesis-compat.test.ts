import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { synthesisManifestHash, type SynthesisManifestV1 } from "../src/hub/synthesis-readiness.ts";

const manifest: SynthesisManifestV1 = { schemaVersion: 1, taskId: 7, taskCreated: 123,
  deliverable: { id: "d-" + "1".repeat(12), sha256: "b".repeat(64) }, bibliography: { id: "d-" + "2".repeat(12), sha256: "c".repeat(64) },
  claims: [{ claimId: "claim:7:123:1", claimRevision: "a".repeat(16), inventory: { revision: 0, sha256: "d".repeat(64) }, evidence: [] }] };

/** A real CLI process, synthetic authenticated loopback hub and isolated homes. No native/model/document network I/O. */
async function fixture(run: (f: { cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>; requests: Record<string, any>[]; file: string; root: string }) => Promise<void>,
  options: { supported?: boolean; lyingDescriptor?: boolean } = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-synthesis-compat-"))), home = join(root, "home"), state = join(root, ".agenthub/state");
  const homes = { HOME: home, AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "amem"), CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude"), KIMI_CODE_HOME: join(home, "kimi"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data") };
  for (const dir of Object.values(homes)) mkdirSync(dir, { recursive: true });
  mkdirSync(state, { recursive: true }); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const file = join(root, "manifest.json"); writeFileSync(file, JSON.stringify(manifest));
  const features = ["research_evidence", ...(options.supported ? ["research_synthesis"] : [])], token = "synthetic-token", requests: Record<string, any>[] = [];
  const identity = { cwd: root, protocol: PROTOCOL, projectId: "synthesis-compat", instanceId: "synthesis-compat" };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, srv) { return srv.upgrade(request) ? undefined : new Response("fixture"); }, websocket: { message(ws, raw) {
    const row = JSON.parse(String(raw)), reply = (value: Record<string, unknown>) => ws.send(JSON.stringify({ rid: row.rid, ...value }));
    if (row.t === "hello") { reply({ t: "welcome", ok: row.token === token, ...identity, features }); return; }
    // Auditing is a separate transport operation, never a task mutation or proof of synthesis support.
    if (row.t === "cli_audit") { reply({ ok: true, auditId: row.auditId, instanceId: identity.instanceId }); return; }
    if (row.t === "cli_audit_ack") { reply({ ok: true, auditId: row.auditId, instanceId: identity.instanceId }); return; }
    if (row.t === "status") { reply({ t: "status", ok: true, status: { ...identity, features } }); return; }
    if (row.t !== "task") { reply({ ok: false, error: "unsupported synthetic operation" }); return; }
    requests.push(row);
    let body: Record<string, unknown>;
    if (row.op === "claim_verdict") {
      const a = row.args;
      // The old hub ignores unknown synthesis/manifest fields and succeeds with a PLAIN verdict. That is the regression.
      body = { task: a.id, recorded: { slot: a.slot, verdict: a.verdict,
        ...(a.model === undefined ? {} : { model: a.model }), ...(a.modelVerdict === undefined ? {} : { modelVerdict: a.modelVerdict }),
        ...(options.supported && a.synthesis !== undefined ? { synthesis: a.synthesis } : {}) } };
    } else if (row.op === "study_evidence") body = { taskId: 7, taskCreated: 123, status: "available", deliverables: [], claims: [] };
    else if (row.op === "study_check") body = { taskId: 7, status: "ready", scope: "structural_provenance", manifestSha256: synthesisManifestHash(manifest), binding: "current", claimCoverage: "complete",
      deliverable: "unchanged", bibliography: "unchanged", citations: { state: "resolved", cited: 0, missing: 0 }, claims: [], next: [] };
    else body = { id: row.args.id, revision: 1, taskId: 7, status: "unavailable" };
    reply({ t: "task", ok: true, text: JSON.stringify(body) });
  } } });
  writeFileSync(join(state, "control-token"), token);
  writeFileSync(join(state, "status.json"), JSON.stringify({ ...identity, controlPort: server.port, pid: process.pid,
    features: options.lyingDescriptor ? ["research_evidence", "research_synthesis"] : features }));
  const cli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: root,
      env: { ...homes, TMPDIR: root, PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); await child.exited; }
  };
  try { await run({ cli, requests, file, root }); }
  finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}

for (const lyingDescriptor of [false, true]) test(`#931 extended person verdict refuses ${lyingDescriptor ? "descriptor-only" : "missing"} synthesis capability before task mutation`, async () => {
  await fixture(async f => {
    const result = await f.cli(["task", "claim", "7", "1", "supported", "--manifest", f.file, "--disposition", "qualified"]);
    expect(result.code).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toContain("research_synthesis"); expect(result.stderr).toMatch(/upgrade|restart/i);
    expect(f.requests).toEqual([]);
  }, { lyingDescriptor });
}, 20_000);

for (const op of ["inventory", "check"] as const) test(`#931 new study ${op} refuses an authenticated old hub before any task operation`, async () => {
  await fixture(async f => {
    const args = op === "inventory" ? ["study", "evidence", "--task", "7"] : ["study", "check", "7", f.file];
    const result = await f.cli(args);
    expect(result.code).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toContain("research_synthesis"); expect(result.stderr).toMatch(/upgrade|restart/i);
    expect(f.requests).toEqual([]);
  }, { lyingDescriptor: true });
}, 20_000);

test("#931 an ordinary person verdict remains compatible with the old plain receipt", async () => {
  await fixture(async f => {
    const result = await f.cli(["task", "claim", "7", "1", "supported"]);
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("claim 1 recorded as supported");
    expect(f.requests).toHaveLength(1); expect(f.requests[0]?.op).toBe("claim_verdict");
    expect(f.requests[0]?.args).toEqual({ id: 7, slot: 1, verdict: "supported" });
  });
}, 20_000);

test("#931 old single-link evidence read does not require the new synthesis capability", async () => {
  await fixture(async f => {
    const id = "ev:" + "a".repeat(32), result = await f.cli(["study", "evidence", id]);
    expect(result.code, result.stderr).toBe(0);
    expect(f.requests).toHaveLength(1); expect(f.requests[0]?.op).toBe("hub_evidence_read"); expect(f.requests[0]?.args).toEqual({ id });
  });
}, 20_000);

test("#931 authenticated synthesis capability sends the bounded descriptor and exact manifest-bound person flags", async () => {
  await fixture(async f => {
    const result = await f.cli(["task", "claim", "7", "1", "supported", "--model", "fixture-model", "--model-said", "unclear", "--manifest", f.file, "--disposition", "qualified"]);
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain(`synthesis qualified @ ${synthesisManifestHash(manifest)}`);
    expect(f.requests).toHaveLength(1); expect(f.requests[0]?.op).toBe("claim_verdict");
    expect(f.requests[0]?.args).toEqual({ id: 7, slot: 1, verdict: "supported", model: "fixture-model", modelVerdict: "unclear", manifest,
      synthesis: { manifestSha256: synthesisManifestHash(manifest), disposition: "qualified" } });
    expect(Buffer.byteLength(JSON.stringify(f.requests[0]?.args.manifest))).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.stringify(f.requests)).not.toContain(f.root);
  }, { supported: true });
}, 20_000);
