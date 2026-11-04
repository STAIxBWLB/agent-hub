import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { repoOf, snapshot } from "../src/hub/snapshots.ts";
import { createReviewMaterialReader, type ReviewMaterialOptions } from "../src/hub/review-material.ts";
import type { ProjectedText } from "../src/hub/text-projection.ts";
import { gitProject } from "./fakes/git-project.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-review-material-"))); dirs.push(root); gitProject(root);
  const repo = repoOf(root)!; expect(repo).toBeDefined();
  const write = (file: string, bytes: string | Buffer) => writeFileSync(join(root, file), bytes);
  const snap = () => { const tree = snapshot(repo); expect(tree).toBeDefined(); return tree!; };
  const plain = { handles: () => false, projectBytes: (): ProjectedText | undefined => undefined };
  const reader = (base: string, head = base, options: Partial<ReviewMaterialOptions> = {}) => createReviewMaterialReader({ repo, base, head, paths: [""], projections: plain, ...options });
  return { root, repo, write, snap, reader };
}

test("review material reads immutable base/head bytes and hashes raw bytes without consulting dirty files", () => {
  const f = fixture(); f.write("note.md", "hello"); const base = f.snap();
  f.write("note.md", "한국어 🙂\nsecond line"); const head = f.snap();
  f.write("note.md", "DIRTY_WORKTREE_CANARY");
  const reader = f.reader(base, head), before = reader.read("note.md", "base"), after = reader.read("note.md");
  expect(reader.head).toBe(head);
  expect(before).toEqual({ state: "available", path: "note.md", side: "base", text: "hello", rawHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", contentHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
  expect(after.state).toBe("available");
  if (after.state !== "available") throw new Error("expected immutable head text");
  expect(after.text).toBe("한국어 🙂\nsecond line"); expect(after.contentHash).toBe(sha256(Buffer.from(after.text)));
  expect(JSON.stringify([before, after])).not.toContain("DIRTY_WORKTREE_CANARY");
});

test("trusted scope uses directory boundaries and execution-root-relative names inside a repository prefix", () => {
  const f = fixture(); mkdirSync(join(f.root, "sub/docs"), { recursive: true }); mkdirSync(join(f.root, "sub/docs-other"));
  f.write("sub/docs/report.md", "in scope"); f.write("sub/docs-other/report.md", "outside scope"); f.write("outside.md", "outside execution root"); const tree = f.snap();
  const reader = f.reader(tree, tree, { repo: { ...f.repo, prefix: "sub/" }, paths: ["docs"] });
  expect(reader.read("docs/report.md")).toMatchObject({ state: "available", text: "in scope" });
  for (const path of ["docs-other/report.md", "outside.md", "../outside.md", "/outside.md", "docs/../docs-other/report.md"]) {
    expect(reader.read(path).state).toBe("unavailable");
  }
  expect(f.reader(tree, tree, { paths: [] }).read("outside.md").state).toBe("unavailable");
});

test("metadata, symlinks, denied/private paths, absent blobs and invalid UTF-8 never become anchor material", () => {
  const f = fixture(); f.write("public.md", "public"); f.write("secret.md", "PRIVATE_TEXT_CANARY"); f.write("binary.dat", Buffer.from([255, 254]));
  symlinkSync("public.md", join(f.root, "link.md")); const tree = f.snap();
  const reader = f.reader(tree, tree, { deny: ["secret.md"], privatePath: path => path === "public.md" });
  for (const path of [".git/config", ".agenthub/state/hub.db", "secret.md", "public.md", "link.md", "missing.md", "binary.dat"]) expect(reader.read(path).state).toBe("unavailable");
  expect(f.reader("f".repeat(40)).read("public.md").state).toBe("unavailable");
  expect(f.reader(tree, tree, { privatePath: () => { throw new Error("PRIVATE_TEXT_CANARY"); } }).read("public.md")).toEqual({ state: "unavailable", path: "public.md", side: "head" });
  expect(f.reader(tree, tree, { nameable: () => false }).read("public.md").state).toBe("unavailable");
});

test("rich text keeps separate raw/text hashes and binds its configured converter identity", () => {
  const f = fixture(), bytes = Buffer.from([80, 75, 0, 255, 1]); f.write("report.DOCX", bytes); const tree = f.snap();
  const text = "문서의 정확한 단락 🙂\nsecond", configHash = "a".repeat(64);
  let calls = 0, deadline: number | undefined;
  const projections = { handles: () => true, projectBytes: (_file: string, raw: Buffer, limit?: number): ProjectedText => {
    calls++; deadline = limit; expect(raw).toEqual(bytes);
    return { inputHash: sha256(raw), rawHash: "legacy-sha1", rawBlob: "legacy-blob", configHash, text };
  } };
  const material = f.reader(tree, tree, { projections }).read("report.DOCX");
  expect(calls).toBe(1); expect(typeof deadline).toBe("number");
  expect(material).toEqual({ state: "available", path: "report.DOCX", side: "head", text, rawHash: sha256(bytes), contentHash: sha256(Buffer.from(text, "utf8")), projection: { name: "text-projection:.docx", version: configHash } });
  // Projection metadata is checked independently by anchorStatus; it is never folded into the content hash.
  expect(material.state === "available" && material.contentHash).not.toBe(sha256(JSON.stringify({ projection: { name: "text-projection:.docx", version: configHash }, text })));
});

test("privacy and the shared deadline are checked again after conversion, with no partial text", () => {
  const f = fixture(); f.write("report.docx", "source"); const tree = f.snap();
  for (const revoke of ["path", "deny", "text", "time", "throw", "wrong input"] as const) {
    let privateNow = false, textPrivate = false, clock = performance.now();
    const deny: string[] = [];
    const projections = { handles: () => true, projectBytes: (_file: string, raw: Buffer): ProjectedText => {
      if (revoke === "path") privateNow = true;
      if (revoke === "deny") deny.push("report.docx");
      if (revoke === "text") textPrivate = true;
      if (revoke === "time") clock += 8000;
      if (revoke === "throw") throw new Error("PRIVATE_CONVERTER_ERROR_CANARY");
      return { inputHash: revoke === "wrong input" ? "f".repeat(64) : sha256(raw), rawHash: "legacy", rawBlob: "legacy", configHash: "b".repeat(64), text: "PRIVATE_PROJECTION_CANARY" };
    } };
    const material = f.reader(tree, tree, { projections, deny, now: () => clock, privatePath: () => privateNow, nameable: value => !(textPrivate && value.includes("PRIVATE_PROJECTION_CANARY")) }).read("report.docx");
    expect(material).toEqual({ state: "unavailable", path: "report.docx", side: "head" });
  }
});

test("one reader shares eight distinct file slots across both sides and keeps a shared presentation budget", () => {
  const f = fixture(); for (let i = 0; i < 9; i++) f.write(`f${i}.md`, String(i)); const tree = f.snap(), reader = f.reader(tree);
  expect(reader.read("f0.md", "base").state).toBe("available"); expect(reader.read("f0.md", "head").state).toBe("available");
  for (let i = 1; i < 8; i++) expect(reader.read(`f${i}.md`).state).toBe("available");
  expect(reader.read("f8.md").state).toBe("unavailable");
  f.write("large.md", "x".repeat(6000)); const large = f.snap(), budget = f.reader(large);
  const first = budget.read("large.md", "base"), second = budget.read("large.md", "head");
  expect(first.state).toBe("available"); expect(second).toEqual({ state: "unavailable", path: "large.md", side: "head" });
  expect(f.reader(large).read("large.md").state).toBe("available"); // budgets belong to this operation only
  f.write("oversized.md", "한".repeat(4001)); const oversized = f.snap();
  expect(f.reader(oversized).read("oversized.md").state).toBe("unavailable");
  let clock = performance.now(); const expired = f.reader(tree, tree, { now: () => clock }); clock += 8000;
  expect(expired.read("f0.md").state).toBe("unavailable");
  const earlierDeadline = clock + 100, shared = f.reader(tree, tree, { now: () => clock, deadline: earlierDeadline });
  clock += 100;
  expect(shared.read("f0.md").state).toBe("unavailable"); // head/scope preparation already spent the call's allowance
});
