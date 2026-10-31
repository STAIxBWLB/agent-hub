import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeDoctorCheck, nativeMemoryCaptureRow, DOCTOR_MEMORY_CAPTURE_PEERS, type MemorySetupReading } from "../src/adapters/registry.ts";
import { realPath } from "../src/hub/project.ts";

// #1008: `ahub doctor` reads memory-capture readiness from agent-mem's own setup state (`amem setup <tool> --json`), not from `dot ai memory status` text.
// The plan shape below is what agent-mem's `planSetup` returns in preview mode; fixtures are fake and never touch a real home or client config.
const plan = (tool: string, over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  targets: [tool], mode: "preview", notes: [],
  actions: [{ target: tool, available: true, files: [], receipt: "r", registration: ["amem"], lifecycle: "SessionEnd incremental ingest", hooks: [], mcpChange: "unchanged", commands: [], state: "applied", ...over }], ...top,
});
const read = (value: unknown): MemorySetupReading => ({ kind: "read", plan: value });

test("applied: the receipt and entries match, so the row is ready and names agent-mem as its source", () => {
  for (const tool of DOCTOR_MEMORY_CAPTURE_PEERS) {
    const row = nativeMemoryCaptureRow(tool, read(plan(tool)));
    expect(row.ok, tool).toBe(true);
    expect(row.detail).toContain(`amem setup ${tool}`);
    expect(row.detail).not.toContain("dot ai memory");
  }
});

test("Codex notes the native /hooks review, because amem setup registers hooks but does not grant their trust; Kimi does not", () => {
  expect(nativeMemoryCaptureRow("codex", read(plan("codex"))).detail).toContain("/hooks review");
  expect(nativeMemoryCaptureRow("codex", read(plan("codex"))).detail).toContain("does not grant hook trust");
  expect(nativeMemoryCaptureRow("kimi", read(plan("kimi"))).detail).not.toContain("/hooks");
});

test("pending: setup would add, replace or restore something, so the row says not set up and names the fix", () => {
  for (const mcpChange of ["add", "replace", "restore"]) for (const tool of DOCTOR_MEMORY_CAPTURE_PEERS) {
    const row = nativeMemoryCaptureRow(tool, read(plan(tool, { mcpChange, state: mcpChange === "add" ? "not installed" : "runtime changed; managed entries will update" })));
    expect(row.ok, `${tool} ${mcpChange}`).toBe(false);
    expect(row.detail).toContain("not set up");
    expect(row.detail).toContain(`amem setup ${tool} --apply`);
  }
  expect(nativeMemoryCaptureRow("kimi", read(plan("kimi", { mcpChange: "add", state: "not installed" }))).detail).toContain("not installed");
});

test("client missing: the native CLI is not installed, and the row says so instead of 'not ready'", () => {
  for (const tool of DOCTOR_MEMORY_CAPTURE_PEERS) {
    const row = nativeMemoryCaptureRow(tool, read(plan(tool, { available: false, mcpChange: "add", state: "not installed" })));
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("client missing");
    expect(row.detail).toContain(`${tool} CLI is not installed`);
    expect(row.detail).not.toContain("not ready");
    expect(row.detail).not.toContain("--apply");   // there is nothing to apply until the client exists
  }
});

test("a reading that is not the documented plan is unknown, never ready: no plan, wrong target, wrong mode, bad fields, several actions", () => {
  const unknown = (reading: MemorySetupReading) => expect(nativeMemoryCaptureRow("codex", reading)).toEqual({ ok: undefined, detail: expect.stringContaining("unknown (") });
  unknown({ kind: "unavailable", reason: "`amem` is not on PATH" });
  expect(nativeMemoryCaptureRow("codex", { kind: "unavailable", reason: "`amem` is not on PATH" }).detail).toContain("not on PATH");
  for (const value of [null, undefined, "ready", 5, [], {}, { mode: "preview" }, { mode: "preview", actions: [] }, plan("kimi"), plan("codex", {}, { mode: "apply" }), plan("codex", { available: "yes" }),
    plan("codex", { mcpChange: "maybe" }), plan("codex", { mcpChange: undefined }), plan("codex", {}, { actions: [plan("codex").actions[0], plan("codex").actions[0]] }), { mode: "preview", actions: [null] }])
    unknown(read(value));
});

test("the state text from agent-mem is bounded and printable before it reaches the row", () => {
  const row = nativeMemoryCaptureRow("kimi", read(plan("kimi", { mcpChange: "replace", state: `x${"y".repeat(500)}\u001b[31m\n` })));
  expect(row.detail.length).toBeLessThan(200);
  expect(row.detail).not.toMatch(/[\x00-\x1f\x7f]/);
});

test("the row keeps its section and optional severity: a failed capture row is a warning in Memory, an unknown one is unknown", () => {
  expect(nativeDoctorCheck(false, "memory capture: codex", "x")).toMatchObject({ section: "Memory", level: "warn" });
  expect(nativeDoctorCheck(undefined, "memory capture: kimi", "x")).toMatchObject({ section: "Memory", level: "unknown" });
  expect(nativeDoctorCheck(true, "memory capture: kimi", "x")).toMatchObject({ section: "Memory", level: "ok" });
});

// ---- through the real CLI, with a fake amem and a fake dot on PATH and a fake home

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function doctor(amem: string | undefined) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-doctor-capture-")));
  roots.push(root);
  mkdirSync(join(root, ".agenthub")); mkdirSync(join(root, "bin")); mkdirSync(join(root, "home"));
  writeFileSync(join(root, ".agenthub/config.json"), "{}");
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ memory: { enabled: false }, mlx: { enabled: false } }));
  const calls = join(root, "calls.log");
  for (const name of ["bun", "claude", "codex", "kimi", "jcode", "qwen", "agy", "pi"]) writeFileSync(join(root, "bin", name), '#!/bin/sh\ncase "$1" in --version) echo "fixture 1.0";; plugin) echo "[]";; esac\n', { mode: 0o755 });
  // `dot` records every call: the doctor must never ask it about memory again (#1008).
  writeFileSync(join(root, "bin", "dot"), `#!/bin/sh\necho "dot $*" >> '${calls}'\necho "✓ codex ready"\necho "✓ kimi ready"\n`, { mode: 0o755 });
  if (amem !== undefined) writeFileSync(join(root, "bin", "amem"), amem, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), AGENTHUB_HOME: join(root, "ahub"), AMEM_HOME: join(root, "mem"), PATH: `${join(root, "bin")}:/usr/bin:/bin`, AGENTHUB_OMNIROUTE_URL: "http://127.0.0.1:9/v1" };
  for (const marker of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "AGENTHUB_DELIVERY_ONLY", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID"]) delete env[marker];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "doctor", "--json"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([code, out, err]) => [code, out, err] as const);
  const rows = JSON.parse(stdout) as { name: string; level: string; section: string; detail: string }[];
  return { rows: rows.filter(row => row.name.startsWith("memory capture")), dotCalled: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}
// A fake `amem setup <tool> --json`: prints a fixed plan per tool from the shell, like the real preview, and exits as told.
const fakeAmem = (perTool: Record<string, unknown>, exit = 0) => `#!/bin/sh\nif [ "$1" = setup ]; then\n  case "$2" in\n${Object.entries(perTool).map(([tool, value]) => `    ${tool}) cat <<'JSON'\n${JSON.stringify(value)}\nJSON\n;;`).join("\n")}\n  esac\n  exit ${exit}\nfi\nexit 1\n`;

test("through the CLI: applied, pending and client-missing rows come from amem, and dot is never asked", async () => {
  const applied = await doctor(fakeAmem({ codex: plan("codex"), kimi: plan("kimi") }));
  expect(applied.rows.map(row => [row.name, row.level, row.section])).toEqual([["memory capture: codex", "ok", "Memory"], ["memory capture: kimi", "ok", "Memory"]]);
  expect(applied.rows[0]!.detail).toContain("/hooks review");
  expect(applied.dotCalled).toBe("");

  const mixed = await doctor(fakeAmem({ codex: plan("codex", { mcpChange: "add", state: "not installed" }), kimi: plan("kimi", { available: false, mcpChange: "add", state: "not installed" }) }));
  expect(mixed.rows[0]).toMatchObject({ name: "memory capture: codex", level: "warn" });
  expect(mixed.rows[0]!.detail).toContain("amem setup codex --apply");
  expect(mixed.rows[1]).toMatchObject({ name: "memory capture: kimi", level: "warn" });
  expect(mixed.rows[1]!.detail).toContain("client missing");
  expect(mixed.dotCalled).toBe("");
}, 20_000);

test("through the CLI: no amem, a refusal and unparseable output are unknown rows, never ready, and dot is still not asked", async () => {
  const none = await doctor(undefined);
  expect(none.rows.map(row => row.level)).toEqual(["unknown", "unknown"]);
  expect(none.rows[0]!.detail).toContain("amem");
  const refused = await doctor(fakeAmem({ codex: plan("codex"), kimi: plan("kimi") }, 1));
  expect(refused.rows.map(row => row.level)).toEqual(["unknown", "unknown"]);
  expect(refused.rows[0]!.detail).toContain("refused or failed");
  const garbled = await doctor("#!/bin/sh\necho 'not json'\n");
  expect(garbled.rows.map(row => row.level)).toEqual(["unknown", "unknown"]);
  expect(garbled.rows[0]!.detail).toContain("did not print JSON");
  for (const result of [none, refused, garbled]) expect(result.dotCalled).toBe("");
}, 30_000);
