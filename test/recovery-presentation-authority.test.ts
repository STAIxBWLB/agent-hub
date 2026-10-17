import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";

const formats = [[], ["--json"], ["--verbose"], ["--color=never"], ["--json", "--verbose", "--color=auto"]];
const cleanup: string[] = [];
afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("#466 presentation prefixes never hide person-only reattach from either authority guard", () => {
  for (const flags of formats) {
    const args = [...flags, "reattach", "00000000-0000-4000-8000-000000000466", "pi"];
    expect(classifyPeerCommand("recovery", args)).toBe("console");
    expect(liveTestRefusal("recovery", args)).toBe(true);
    expect(liveTestRefusal("recovery", [...flags, "resume", args[flags.length + 1]!])).toBe(false);
  }
});

test("#466 real CLI refuses live-test reattach before reading a receipt regardless of presentation prefixes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-466-authority-")); cleanup.push(root);
  const home = join(root, "home"), hub = join(root, "hub"), amem = join(root, "amem");
  for (const dir of [home, hub, amem]) mkdirSync(dir);
  for (const flags of formats) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, "--live-test", "recovery", ...flags, "reattach", "00000000-0000-4000-8000-000000000466", "pi"], {
      cwd: root, env: { PATH: process.env.PATH, HOME: home, AGENTHUB_HOME: hub, AMEM_HOME: amem, AGENTHUB_PEER_ID: "codex", TERM: "dumb" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(out).toBe("");
    expect(err).toContain("live-test cannot write person-attributed content");
    expect(err).not.toContain("recovery operation unavailable");
  }
});

test("#466 every flag consumed by the parser is the same shared prefix recognized by authority", async () => {
  const path = "../src/cli/recovery-presentation-options.ts";
  const { recoveryPresentationFlag } = await import(path);
  const { readRecoveryPresentationFlags } = await import("../src/cli/upgrade-presentation-flags.ts");
  const candidates = ["--json", "--verbose", "--color=auto", "--color=always", "--color=never", "--color=invalid", "--color", "--full", "--unknown"];
  const accepted = candidates.filter(flag => {
    try { return readRecoveryPresentationFlags([flag], { isTTY: false }).flags.includes(flag); }
    catch { return false; }
  });
  expect(accepted).toEqual(["--json", "--verbose", "--color=auto", "--color=always", "--color=never"]);
  for (const flag of accepted) {
    expect(recoveryPresentationFlag(flag)).toBeDefined();
    const args = [flag, "reattach", "00000000-0000-4000-8000-000000000466", "pi"];
    expect(readRecoveryPresentationFlags(args, { isTTY: false }).args).toEqual(args.slice(1));
    expect(classifyPeerCommand("recovery", args)).toBe("console");
    expect(liveTestRefusal("recovery", args)).toBe(true);
  }
  // Recognition and value validation remain separate, preserving refusal order for invalid colours.
  expect(recoveryPresentationFlag("--color=invalid")).toEqual({ kind: "color", value: "invalid" });
  for (const flag of ["--color", "--full", "--unknown", "reattach"]) expect(recoveryPresentationFlag(flag)).toBeUndefined();
});

test("#168 repaired-loss context narrows live-test delegation without changing ordinary recovery grammar", () => {
  for (const flags of formats) {
    const args = [...flags, "dispose", "00000000-0000-4000-8000-000000000468", "--fresh-session", "codex", "--reason", "fixture"];
    expect(liveTestRefusal("recovery", args, { repairedFresh: true })).toBe(true);
    expect(liveTestRefusal("recovery", args, { repairedFresh: false })).toBe(false);
    expect(liveTestRefusal("recovery", args)).toBe(false);
    expect(liveTestRefusal("recovery", [...flags, "resume"], { repairedFresh: true })).toBe(false);
  }
});
