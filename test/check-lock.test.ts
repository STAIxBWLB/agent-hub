import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The heavy-job slot at the top of scripts/check.sh (#398), run from a copy in a scratch repo: the gate itself
// holds the real repo's slot, and nothing after the slot exists here, so a run that gets past it fails right after.
test("check.sh refuses a held heavy-job slot, and reaps a dead holder's slot and releases its own on exit (#398)", () => {
  const repo = mkdtempSync(join(tmpdir(), "ahub-check-lock-"));
  try {
    mkdirSync(join(repo, "scripts"));
    copyFileSync(join(import.meta.dir, "../scripts/check.sh"), join(repo, "scripts/check.sh"));
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    const lock = join(repo, ".git/ahub-heavy.lock");
    const run = () => Bun.spawnSync(["bash", "scripts/check.sh"], { cwd: repo, env: { ...process.env, AHUB_CHECK_LOCK_WAIT_S: "0" } });

    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), `${process.pid} since now in elsewhere`);
    const held = run();
    expect(held.exitCode).toBe(1);
    expect(held.stderr.toString()).toContain(`heavy-job slot still held by ${process.pid} since now in elsewhere`);
    expect(existsSync(lock)).toBe(true); // a live holder keeps its slot

    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(join(lock, "owner"), `${dead} since then in elsewhere`);
    const reaped = run();
    expect(reaped.stderr.toString()).not.toContain("heavy-job slot");
    expect(reaped.stderr.toString()).toContain("check-docs.mjs"); // past the slot: the next step is missing here
    expect(existsSync(lock)).toBe(false); // released on exit
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
