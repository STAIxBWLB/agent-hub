import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFingerprint, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { writeOperation } from "../src/hub/recovery-store.ts";
import { VERSION } from "../src/version.ts";

const main = join(import.meta.dir, "../src/cli/main.ts");
const id = "00000000-0000-4000-8000-000000000463";
async function fixture(kind: "older" | "missing-receipt" | "missing-root" | "missing-entry") {
  const root = mkdtempSync(join(tmpdir(), "ahub-463-coordinator-")), home = join(root, "home"), source = join(root, "older coordinator"), marker = join(root, "delegated");
  mkdirSync(join(root, ".agenthub")); mkdirSync(join(source, "src/cli"), { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, snapshots: { enabled: false } }));
  writeFileSync(join(source, "src/cli/upgrade.ts"), "export async function disposeRecovery() {}\n");
  if (kind !== "missing-entry") writeFileSync(join(source, "src/cli/main.js"), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "wrong old coordinator"); console.log("older coordinator was incorrectly delegated");`);
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: VERSION, sourceRoot: source, sourceDigest: "fixture", projects: [], blockers: [] };
  const op: RecoveryOperation = { schema: 1, id, plan: { ...body, fingerprint: planFingerprint(body) }, sourceRoot: source, projects: [], createdAt: 1, updatedAt: 1, phase: "completed", step: "completed" };
  if (kind === "missing-root") delete (op as Partial<RecoveryOperation>).sourceRoot;
  if (kind !== "missing-receipt") writeOperation(id, op, home);
  const wrapper = join(root, "fixture.ts");
  writeFileSync(wrapper, `for(const key of ["AGENTHUB_PEER_ID","CLAUDECODE","CLAUDE_CODE_SESSION_ID","CODEX_THREAD_ID","AGENTHUB_STATE_DIR","AGENTHUB_PROJECT_DIR","AGENTHUB_UNATTENDED","AGENTHUB_RECOVERY_OPERATION","AGENTHUB_DELIVERY_ONLY"]) delete process.env[key];
process.env.AGENTHUB_HOME=${JSON.stringify(home)};
process.argv=[process.execPath,${JSON.stringify(main)},"recovery","reattach",${JSON.stringify(id)},"pi"];
await import(${JSON.stringify(main)});`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err, delegated: existsSync(marker) };
  } finally { clearTimeout(timer); rmSync(root, { recursive: true, force: true }); }
}

test("#463 reattach CLI does not redelegate its fallback to a coordinator lacking the action", async () => {
  const result = await fixture("older");
  expect(result.delegated).toBe(false); expect(result.code).toBe(1);
  expect(result.err).toContain("reattach is available only");
});

for (const kind of ["missing-receipt", "missing-root", "missing-entry"] as const) test(`#463 reattach CLI gives actionable guidance for ${kind}`, async () => {
  const result = await fixture(kind);
  expect(result.code).toBe(1); expect(result.delegated).toBe(false);
  expect(result.err).toContain("recovery status"); expect(result.err).toContain("no session was started");
  expect(result.err).not.toContain("TypeError"); expect(result.err).not.toContain("ENOENT");
});
