import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProbeDataPolicyV1, ProbeSlot } from "../src/hub/guidance-probes.ts";
import { collectProbeOutput, materializeProbeWorkspace, PROBE_WORKSPACE_LIMITS, previewRetained, removeRetained, retainProbeOutput, type ProbeRetained, type ProbeWorkspace } from "../src/local/probe-workspace.ts";

// #1226 T3 (AC6): collect only what is declared, retain only what the host created, remove only what the host still owns. Real directories, no mocks.
const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0).reverse()) rmSync(directory, { recursive: true, force: true }); });
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function workspace(role: ProbeSlot["role"] = "worker"): Promise<ProbeWorkspace> {
  const bytes = Buffer.from("admitted input"), id = "src", digest = sha(bytes);
  const policy: ProbeDataPolicyV1 = { v: 1, admittedData: [{ id, sha256: digest, bytes: bytes.length }], allowedWrites: [{ root: "output", relative: "answer.txt" }, { root: "output", relative: "more" }, { root: "scratch", relative: "work" }],
    roles: { worker: { dataIds: [id], guidanceOnlyExperience: true }, proposal: { dataIds: [id], improverContext: false }, compose: { dataIds: [id], improverContext: false },
      select: { dataIds: [id], anonymizedDeliverables: true }, reflect: { dataIds: [id], closedRoundOnly: true } } };
  const made = await materializeProbeWorkspace({ role, policy, files: [{ dataId: id, relative: "input/task.txt", sha256: digest, bytes }], maxBytes: PROBE_WORKSPACE_LIMITS.workspaceBytes,
    verifySource: () => "task_source", reserveStorage: () => {}, current: () => {} });
  cleanups.push(dirname(made.root)); return made;
}
const scratchRoot = () => { const directory = mkdtempSync(join(tmpdir(), "ahub-probe-retain-")); cleanups.push(directory); return directory; };

describe("output collection reads only the declared output, through captured identity", () => {
  test("regular files are hashed with their exact bytes and sorted", async () => {
    const w = await workspace();
    writeFileSync(join(w.output, "answer.txt"), "answer"); mkdirSync(join(w.output, "more")); writeFileSync(join(w.output, "more", "b.txt"), "bee");
    const { manifest } = collectProbeOutput(w, 1024);
    expect(manifest.entries).toEqual([{ relative: "output/answer.txt", sha256: sha("answer"), bytes: 6 }, { relative: "output/more/b.txt", sha256: sha("bee"), bytes: 3 }]);
    expect(manifest.excluded).toEqual([]); expect(manifest.totalBytes).toBe(9);
  });
  test("a symlink, a hardlink and a name outside the declared writes are excluded and never hashed", async () => {
    const w = await workspace();
    writeFileSync(join(w.output, "answer.txt"), "answer");
    writeFileSync(join(dirname(w.root), "outside.txt"), "SECRET-OUTSIDE");
    symlinkSync(join(dirname(w.root), "outside.txt"), join(w.output, "more-link"));
    writeFileSync(join(w.output, "hard-a"), "x"); linkSync(join(w.output, "hard-a"), join(w.output, "hard-b"));
    writeFileSync(join(w.output, "undeclared.txt"), "u");
    const { manifest } = collectProbeOutput(w, 1024);
    expect(manifest.entries.map(item => item.relative)).toEqual(["output/answer.txt"]);
    const reasons = Object.fromEntries(manifest.excluded.map(item => [item.relative, item.reason]));
    expect(reasons["output/more-link"]).toBe("not_regular");
    expect(reasons["output/hard-a"]).toBe("linked"); expect(reasons["output/hard-b"]).toBe("linked");
    expect(reasons["output/undeclared.txt"]).toBe("outside_declared_writes");
    expect(JSON.stringify(manifest)).not.toContain("SECRET-OUTSIDE");
    expect(sha("SECRET-OUTSIDE")).not.toBe(manifest.entries[0]!.sha256);
  });
  test("a file past the per-file cap is excluded without being read, and bytes past the budget are not collected", async () => {
    const w = await workspace();
    writeFileSync(join(w.output, "answer.txt"), Buffer.alloc(1024 * 1024 + 1, 1));
    mkdirSync(join(w.output, "more")); writeFileSync(join(w.output, "more", "a"), "12345"); writeFileSync(join(w.output, "more", "b"), "67890");
    const { manifest } = collectProbeOutput(w, 7);
    expect(manifest.excluded.find(item => item.relative === "output/answer.txt")?.reason).toBe("over_file_cap");
    expect(manifest.totalBytes).toBeLessThanOrEqual(7);
    expect(manifest.entries).toHaveLength(1);
  });
  test("scratch bytes are measured from what is actually there, not from the declaration", async () => {
    const w = await workspace();
    mkdirSync(join(w.scratch, "work")); writeFileSync(join(w.scratch, "work", "tmp"), Buffer.alloc(300)); writeFileSync(join(w.scratch, "loose"), Buffer.alloc(40));
    expect(collectProbeOutput(w, 1024).scratchBytes).toBe(340);
  });
  test("an empty output is an empty manifest, not an error", async () => {
    const w = await workspace();
    expect(collectProbeOutput(w, 1024).manifest).toEqual({ v: 1, entries: [], excluded: [], totalBytes: 0 });
  });
});

describe("retention copies exactly the manifest, and removal touches only what the host created", () => {
  async function retained(): Promise<{ w: ProbeWorkspace; kept: ProbeRetained; root: string }> {
    const w = await workspace(); writeFileSync(join(w.output, "answer.txt"), "answer");
    mkdirSync(join(w.output, "more")); writeFileSync(join(w.output, "more", "b.txt"), "bee");
    const root = scratchRoot(), { manifest } = collectProbeOutput(w, 1024);
    return { w, root, kept: retainProbeOutput(w, manifest, root) };
  }
  test("retained bytes equal the manifest hashes and are read-only, link-count-1 regular files", async () => {
    const { kept } = await retained();
    for (const file of kept.files) {
      const stat = lstatSync(join(kept.directory, file.relative));
      expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true);
      expect(stat.mode & 0o222).toBe(0);
    }
    expect(sha(readFileSync(join(kept.directory, "output/answer.txt")))).toBe(sha("answer"));
  });
  test("previewRetained is read-only and lists exactly what removal would do", async () => {
    const { kept } = await retained();
    const before = readdirSync(kept.directory, { recursive: true }).sort();
    const preview = previewRetained(kept);
    expect(preview.remove.map(item => item.relative).sort()).toEqual(["output/answer.txt", "output/more/b.txt"]);
    expect(preview.keep).toEqual([]);
    expect(readdirSync(kept.directory, { recursive: true }).sort()).toEqual(before);
  });
  test("removal deletes the host's own files and directory and nothing else", async () => {
    const { kept, root } = await retained();
    const bystander = join(root, "bystander.txt"); writeFileSync(bystander, "keep me");
    const result = removeRetained(kept);
    expect(result.removed.sort()).toEqual(["output/answer.txt", "output/more/b.txt"]);
    expect(existsSync(kept.directory)).toBe(false);
    expect(readFileSync(bystander, "utf8")).toBe("keep me");
  });
  test("a file replaced after retention (same name, new inode) is a bystander and survives", async () => {
    const { kept } = await retained();
    const target = join(kept.directory, "output/answer.txt");
    // Linux recycles an inode number straight after an unlink, so the replacement may reuse it; the change time still tells the two files apart once the
    // filesystem's timestamp tick has passed, which it always has between a retention and a prune (days apart). Wait one tick rather than race it.
    await Bun.sleep(30);
    rmSync(target); writeFileSync(target, "someone else's file");
    const result = removeRetained(kept);
    expect(result.kept).toContainEqual({ relative: "output/answer.txt", reason: "identity_changed" });
    expect(readFileSync(target, "utf8")).toBe("someone else's file");
    expect(existsSync(kept.directory)).toBe(true);
  });
  test("the same device and inode with a different change time is another file: kept, in preview and in removal (a recycled inode)", async () => {
    const { kept } = await retained();
    const recycled = { ...kept, files: kept.files.map(file => ({ ...file, ctimeNs: (BigInt(file.ctimeNs) - 1_000_000n).toString() })) };
    expect(previewRetained(recycled).remove).toEqual([]);
    expect(previewRetained(recycled).keep).toContainEqual({ relative: "output/answer.txt", reason: "identity_changed" });
    const result = removeRetained(recycled);
    expect(result.removed).toEqual([]);
    expect(result.kept).toContainEqual({ relative: "output/answer.txt", reason: "identity_changed" });
    expect(readFileSync(join(kept.directory, "output/answer.txt"), "utf8")).toBe("answer");
  });
  test("a file swapped for a symlink to a victim never deletes the victim", async () => {
    const { kept, root } = await retained();
    const victim = join(root, "victim.txt"); writeFileSync(victim, "PRECIOUS");
    const target = join(kept.directory, "output/answer.txt");
    rmSync(target); symlinkSync(victim, target);
    removeRetained(kept);
    expect(readFileSync(victim, "utf8")).toBe("PRECIOUS");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });
  test("a hardlink made after retention is not removed through the original name", async () => {
    const { kept, root } = await retained();
    const second = join(root, "second-name"); linkSync(join(kept.directory, "output/answer.txt"), second);
    const result = removeRetained(kept);
    expect(result.kept).toContainEqual({ relative: "output/answer.txt", reason: "identity_changed" });
    expect(readFileSync(second, "utf8")).toBe("answer");
  });
  test("the whole directory replaced by another (same path, new inode) is left alone entirely", async () => {
    const { kept, root } = await retained();
    const moved = join(root, "moved-away"); renameSync(kept.directory, moved);
    mkdirSync(kept.directory); writeFileSync(join(kept.directory, "stranger.txt"), "not ours");
    expect(previewRetained(kept).keep).toEqual([{ relative: ".", reason: "directory_replaced_or_missing" }]);
    expect(removeRetained(kept).removed).toEqual([]);
    expect(readFileSync(join(kept.directory, "stranger.txt"), "utf8")).toBe("not ours");
  });
  test("an EMPTY directory swapped in at the retained path is not removed either (rmdir alone would delete it)", async () => {
    const { kept, root } = await retained();
    renameSync(kept.directory, join(root, "moved-away"));
    mkdirSync(kept.directory);
    expect(removeRetained(kept).kept).toEqual([{ relative: ".", reason: "directory_replaced_or_missing" }]);
    expect(existsSync(kept.directory)).toBe(true);
    expect(lstatSync(kept.directory).ino).not.toBe(kept.ino);
  });
  test("a stray file a stranger put inside the retained directory stays, and so does its directory", async () => {
    const { kept } = await retained();
    writeFileSync(join(kept.directory, "output/more/stranger.txt"), "not ours");
    const result = removeRetained(kept);
    expect(result.removed).toContain("output/answer.txt");
    expect(readFileSync(join(kept.directory, "output/more/stranger.txt"), "utf8")).toBe("not ours");
    expect(existsSync(kept.directory)).toBe(true);
  });
  test("removal is idempotent: a second call finds nothing and deletes nothing more", async () => {
    const { kept } = await retained(); removeRetained(kept);
    expect(removeRetained(kept).removed).toEqual([]);
  });
  test("two sessions' retained directories are independent: removing one never touches the other", async () => {
    const root = scratchRoot();
    const make = async (text: string) => { const w = await workspace(); writeFileSync(join(w.output, "answer.txt"), text); return retainProbeOutput(w, collectProbeOutput(w, 1024).manifest, root); };
    const a = await make("A"), b = await make("B");
    expect(a.directory).not.toBe(b.directory);
    removeRetained(a);
    expect(existsSync(a.directory)).toBe(false);
    expect(readFileSync(join(b.directory, "output/answer.txt"), "utf8")).toBe("B");
  });
});
