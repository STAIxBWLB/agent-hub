import { expect, test } from "bun:test";
import { OwnedPrintChild } from "../src/adapters/claude-print-child.ts";
import { registerPrintConformance } from "../src/adapters/conformance/index.ts";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { assign, loadRouting } from "../src/hub/routing.ts";
import { parseConfiguredAcpArguments } from "../src/cli/configured-acp-entry.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { newEnvelope, USER } from "../src/hub/envelope.ts";
import { sandboxAvailable } from "../src/local/sandbox.ts";
import { gitProject } from "./fakes/git-project.ts";

test("owned print captures the bounded raw stdout prefix and reports truncation", async () => {
  const chunks: Uint8Array[] = [];
  let truncated = false;
  const child = new OwnedPrintChild({ peer: "print-fixture", command: [process.execPath],
    args: ["-e", 'process.stdout.write("line\\nsecond line without a newline")'], cwd: import.meta.dir,
    envMode: "replace", env: {}, input: "", maxOutputBytes: 11,
    onOutput: chunk => chunks.push(chunk), onLimit: () => { truncated = true; } });
  expect(await child.done).toBe(0);
  expect(Buffer.concat(chunks).toString()).toBe("line\nsecond");
  expect(truncated).toBe(true);
});

test("owned print retains a bounded stderr tail after a nonzero exit", async () => {
  const child = new OwnedPrintChild({ peer: "print-fixture", command: [process.execPath],
    args: ["-e", 'process.stderr.write("x".repeat(70_000) + "last diagnostic", () => { process.exitCode = 7; })'],
    cwd: import.meta.dir, envMode: "replace", env: {}, input: "", onOutput: () => {}, captureStderrTail: true });
  expect(await child.done).toBe(7);
  const receipt = child.stderrAfterSettlement();
  expect(receipt.status).toBe("complete");
  if (receipt.status === "complete") {
    expect(Buffer.byteLength(receipt.text)).toBe(64 * 1024);
    expect(receipt.text.endsWith("last diagnostic")).toBe(true);
  }
});


registerPrintConformance();

const config = { transport: "print", command: "/bin/sh", args: ["-c", "printf fixture", "{prompt}"],
  versionArgs: ["-c", "printf fixture-v1"], versionPin: "fixture-v1", displayName: "Print fixture",
  timeoutS: 2, roles: ["reviewer", "advisor"] };

test("configured print accepts advisory roles and a single prompt source", () => {
  const catalog = createProjectAdapterCatalog({ printer: config });
  expect(catalog.definitionOf("printer")).toMatchObject({ roles: ["reviewer", "advisor"], trust: { onPrem: false, hubSandboxed: true } });
  expect(parseConfiguredAcpArguments("printer", [], catalog).peer).toBe("printer");
  expect(() => parseConfiguredAcpArguments("printer", ["--session-id", "other"], catalog)).toThrow("no instances or sessions");
  for (const invalid of [{ roles: ["implementer"] }, { roles: ["conductor"] }, { invented: true },
    { versionPin: undefined }, { stdin: true }, { args: ["{prompt}{prompt}"] }, { args: [] }]) {
    expect(() => createProjectAdapterCatalog({ printer: { ...config, ...invalid } })).toThrow();
  }
  expect(createProjectAdapterCatalog({ printer: { ...config, args: [], stdin: true } }).kindOf("printer")).toBe("printer");
});

test("reviewer assignment walks past a configured print peer with the reviewer label", () => {
  const catalog = createProjectAdapterCatalog({ printer: config });
  const routing = loadRouting("/private/tmp");
  routing.classes.review = { ...routing.classes.review, peers: ["printer", "claude"] };
  const task = { class: "implement" as const, signals: [], reserved: null };
  const result = assign(task, { codex: "idle", printer: "idle", claude: "idle" }, routing, {
    adapterCatalog: catalog, roles: { printer: ["reviewer"], claude: ["reviewer"], codex: ["implementer"] }, notReviewer: "codex",
  });
  expect(result.reviewer).toBe("claude");
  expect(result.refusals?.some(row => row.peer === "printer" && row.reason.includes("advisory answers"))).toBe(true);
  const pooled = assign(task, { codex: "idle", printer: "idle", "claude-review": "idle" }, routing, {
    adapterCatalog: catalog, candidates: ["codex"], roles: { printer: ["reviewer"], "claude-review": ["reviewer"] },
    instances: { printer: { kind: "printer", roles: ["reviewer"], start_mode: "headless" },
      "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" } },
    reviewPool: { pool: ["printer", "claude"], required: true },
  });
  expect(pooled.reviewer).toBe("claude-review");
  expect(pooled.reviewSelection?.walk.map(row => row.id).filter(Boolean)).toEqual(["claude-review"]);
});

test.skipIf(!sandboxAvailable())("daemon starts a configured print declaration and delivers public advice only", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-configured-print-daemon-")));
  const stateDir = join(root, ".agenthub/state");
  gitProject(root);
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({
    adapters: { printer: { ...config, stdin: true, args: ["-c", "cat"] } }, roster: { printer: true },
  }));
  const loaded = loadConfig(root);
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...loaded, memory: { ...loaded.memory, enabled: false, native: false },
      snapshots: { ...loaded.snapshots, enabled: false }, inference: { ...loaded.inference, enabled: false, triage: false },
      pi: { ...loaded.pi, enabled: false, auto_start: false }, mlx: { ...loaded.mlx, enabled: false } } });
  try {
    const client = await ControlClient.connect(stateDir, { role: "console" });
    try {
      const reply = await client.request({ t: "start", peer: "printer", args: { mode: "headless" } });
      expect(reply).toMatchObject({ ok: true, policy: "unmanaged" });
      const peer = daemon.bus.peers.get("printer")!;
      const answers: string[] = [];
      peer.onFinalAnswer = answer => { answers.push(answer); };
      await peer.deliver([newEnvelope(USER, "public fixture")]);
      await peer.deliver([newEnvelope(USER, "private fixture", { private: true })]);
      expect(answers).toHaveLength(1);
      expect(answers[0]).toContain("public fixture");
      expect(peer).toMatchObject({ permissionModeState: "unmanaged", form: "headless" });
    } finally { client.close(); }
  } finally { await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
});
