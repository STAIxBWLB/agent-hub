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
