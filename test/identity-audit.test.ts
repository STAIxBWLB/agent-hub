import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainCliAudits, recordCliAudit, recordDelegatedCliAudit } from "../src/cli/identity-audit.ts";
import { nativeLaunchEnv } from "../src/cli/launch.ts";
import { cliCommandLabel } from "../src/cli/identity.ts";
import { peerChildEnv } from "../src/hub/child-process.ts";

test("#410 negotiation reserves a bounded private pending row, invisible to drains", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-pending-audit-"));
  try {
    await recordDelegatedCliAudit(dir, "codex", "permission", async () => {
      expect(readdirSync(join(dir, "cli-audit"))).toEqual([expect.stringMatching(/\.tmp$/)]);
      expect(drainCliAudits(dir)).toEqual([]);
      return ["cli_audit_delegated"];
    });
    expect(drainCliAudits(dir)).toMatchObject([{ peer: "codex", outcome: "delegated" }]);
    expect(readdirSync(join(dir, "cli-audit"))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#410 failed authentication records only a compatible refusal and clears the reservation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-refused-audit-"));
  try {
    await expect(recordDelegatedCliAudit(dir, "codex", "permission", async () => { throw new Error("secret must not reach the remedy"); })).rejects.toThrow("upgrade");
    const rows = drainCliAudits(dir);
    expect(rows).toMatchObject([{ peer: "codex", outcome: "refused" }]);
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(readdirSync(join(dir, "cli-audit"))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pre-connection audit contains only validated identifiers and drains once", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-cli-audit-"));
  try {
    recordCliAudit(dir, "claude", cliCommandLabel("permit", ["sensitive-argument"]), "refused");
    expect(readFileSync(join(dir, "cli-audit", readdirSync(join(dir, "cli-audit"))[0]!), "utf8")).not.toContain("sensitive-argument");
    const rows = drainCliAudits(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ v: 1, peer: "claude", command: "permit", outcome: "refused" });
    expect(drainCliAudits(dir)).toEqual([]);
    expect(() => recordCliAudit(dir, "claude", "say private-title", "run")).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed outbox contents cannot become console text", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-cli-audit-"));
  try {
    mkdirSync(join(dir, "cli-audit"));
    const id = crypto.randomUUID();
    writeFileSync(join(dir, "cli-audit", `${id}.json`), JSON.stringify({ v: 1, id, at: Date.now(), peer: "claude", command: "secret-text", outcome: "refused", title: "private-title" }));
    writeFileSync(join(dir, "cli-audit", `${crypto.randomUUID()}.json`), "malformed");
    expect(drainCliAudits(dir)).toEqual([]);
    expect(cliCommandLabel("secret-command", [])).toBe("unknown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delegated audit retains the peer and closed command label without private arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-cli-delegated-"));
  try {
    recordCliAudit(dir, "codex", cliCommandLabel("recovery", ["dispose", "private-operation", "--reason", "private-reason"]), "delegated");
    const rows = drainCliAudits(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ peer: "codex", command: "recovery dispose", outcome: "delegated" });
    expect(JSON.stringify(rows)).not.toContain("private");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("native launch environments replace caller identity without forwarding vendor or recovery markers", () => {
  for (const tool of ["claude", "codex", "pi"] as const) {
    const env = nativeLaunchEnv(tool, { AGENTHUB_PEER_ID: "user", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "old", CODEX_THREAD_ID: "old", AGENTHUB_RECOVERY_OPERATION: "old", AGENTHUB_UNATTENDED: "1", AGENTHUB_CHANNEL: "1", AGENTHUB_DELIVERY_ONLY: "true", CANARY: "kept" });
    expect(env.AGENTHUB_PEER_ID).toBe(tool);
    expect(env.AGENTHUB_CHANNEL).toBe(tool === "claude" ? "1" : undefined); // channel evidence only beside the flag (#205)
    expect(env.CANARY).toBe("kept");
    for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_RECOVERY_OPERATION", "AGENTHUB_UNATTENDED", "AGENTHUB_DELIVERY_ONLY"]) expect(env[key]).toBeUndefined();
  }
  expect(peerChildEnv("kimi", { AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "old", CLAUDECODE: "1", AGENTHUB_CHANNEL: "1", AGENTHUB_DELIVERY_ONLY: "true", CANARY: "kept" })).toEqual({ AGENTHUB_PEER_ID: "kimi", CANARY: "kept" });
});


test("unfinished publications do not block another writer or become daemon records", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-cli-audit-"));
  try {
    mkdirSync(join(dir, "cli-audit"));
    const pending = join(dir, "cli-audit", `${crypto.randomUUID()}.tmp`);
    writeFileSync(pending, "unfinished");
    recordCliAudit(dir, "codex", "status", "run");
    expect(drainCliAudits(dir)).toHaveLength(1);
    expect(existsSync(pending)).toBe(true);
    for (let i = 0; i < 255; i++) writeFileSync(join(dir, "cli-audit", `${crypto.randomUUID()}.tmp`), "unfinished");
    expect(() => recordCliAudit(dir, "codex", "status", "run")).toThrow("full");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
