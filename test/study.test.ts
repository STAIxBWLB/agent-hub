import { expect, test } from "bun:test";
import { parseStudyArgs } from "../src/cli/study.ts";
import { classifyPeerCommand, cliCommandLabel } from "../src/cli/identity.ts";
import { renderStudyEvidence, renderSynthesisReadiness } from "../src/cli/study-output.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("#931 explicit evidence and check forms are closed and preserve person authority", () => {
  const id = `ev:${"a".repeat(32)}`;
  expect(parseStudyArgs(["evidence", id])).toEqual({ op: "evidence", id });
  expect(parseStudyArgs(["evidence", id, "--revision", "2"])).toEqual({ op: "evidence", id, revision: 2 });
  expect(parseStudyArgs(["evidence", "--task", "7"])).toEqual({ op: "evidence_inventory", taskId: 7 });
  expect(parseStudyArgs(["check", "7", "manifest.json"])).toEqual({ op: "check", taskId: 7, file: "manifest.json" });
  for (const args of [["evidence"], ["evidence", id, "--revision", "0"], ["evidence", id, "extra"], ["evidence", "--task", "7", "extra"], ["check", "0", "file"], ["check", "7"], ["check", "7", "file", "extra"]])
    expect(parseStudyArgs(args)).toHaveProperty("usage");
  expect(classifyPeerCommand("study", ["evidence", id])).toBe("allowed");
  expect(classifyPeerCommand("study", ["evidence", "--task", "7"])).toBe("console");
  expect(classifyPeerCommand("study", ["check", "7", "manifest.json"])).toBe("console");
  expect(cliCommandLabel("study", ["check", "7", "manifest.json"])).toBe("study check");
});

test("#931 private evidence and readiness render neutral stubs", () => {
  for (const render of [renderStudyEvidence, renderSynthesisReadiness]) {
    const out = JSON.stringify(render({ taskId: 7, status: "private", excerpt: "SECRET_CANARY", sourceId: "ORIGIN_CANARY", claims: [{ text: "CLAIM_CANARY" }] }));
    expect(out).not.toMatch(/SECRET_CANARY|ORIGIN_CANARY|CLAIM_CANARY/);
    expect(out.toLowerCase()).toContain("private");
  }
});

test("#931 real CLI rejects invalid manifest descriptors and paired judgment flags before connecting", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-study-cli-"));
  try {
    mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub", "config.json"), "{}");
    const env = { ...process.env, HOME: root, AGENTHUB_HOME: join(root, "fake-home"), NO_COLOR: "1" } as Record<string, string>;
    for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") && key !== "AGENTHUB_HOME" || ["CODEX_THREAD_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "KIMI_CODE"].includes(key)) delete env[key];
    const ahub = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", root, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, text: stdout + stderr };
    };
    for (const [name, text, reason] of [["oversized.json", " ".repeat(64 * 1024 + 1), "over 64 KiB"], ["malformed.json", "{", "not valid JSON"], ["invalid.json", "{}", "invalid synthesis manifest"]]) {
      writeFileSync(join(root, name!), text!);
      const result = await ahub("study", "check", "7", name!);
      expect(result.code).toBe(1); expect(result.text).toContain(reason!); expect(result.text).not.toContain("hub is not running");
      if (name !== "invalid.json") expect(result.text).toContain("manifest file");
    }
    symlinkSync(join(root, "invalid.json"), join(root, "linked.json"));
    const symlink = await ahub("study", "check", "7", "linked.json");
    expect(symlink.code).toBe(1); expect(symlink.text).toContain("cannot read the manifest file");
    const flags = await ahub("task", "claim", "7", "1", "supported", "--manifest", "a".repeat(64));
    expect(flags.code).toBe(2); expect(flags.text).toContain("--disposition"); expect(flags.text).not.toContain("hub is not running");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
