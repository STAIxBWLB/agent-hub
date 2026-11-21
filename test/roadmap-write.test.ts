import { expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { roadmapWorktree, writeRoadmap } from "../src/cli/roadmap-write.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const policy = { deny: [], readOnly: [], pii: [] };
test("roadmap export writes only plain fixed paths and rejects protected or linked targets", () => {
  const root = mkdtempSync(join(tmpdir(), "roadmap-write-")), outside = mkdtempSync(join(tmpdir(), "roadmap-outside-"));
  try {
    mkdirSync(join(root, "docs"));
    writeRoadmap(root, { json: "{}\n", markdown: "# Roadmap\n" }, policy);
    expect(readFileSync(join(root, "docs/roadmap.md"), "utf8")).toBe("# Roadmap\n");
    expect(readFileSync(join(root, "docs/roadmap.json"), "utf8")).toBe("{}\n");
    expect(() => writeRoadmap(root, { json: "new", markdown: "new" }, { ...policy, readOnly: ["docs/roadmap.md"] })).toThrow();
    rmSync(join(root, "docs/roadmap.md")); writeFileSync(join(outside, "target"), "unchanged");
    symlinkSync(join(outside, "target"), join(root, "docs/roadmap.md"));
    expect(() => writeRoadmap(root, { json: "new", markdown: "new" }, policy)).toThrow();
    expect(readFileSync(join(outside, "target"), "utf8")).toBe("unchanged");
    rmSync(join(root, "docs/roadmap.md")); linkSync(join(outside, "target"), join(root, "docs/roadmap.md"));
    expect(() => writeRoadmap(root, { json: "new", markdown: "new" }, policy)).toThrow();
    expect(readFileSync(join(outside, "target"), "utf8")).toBe("unchanged");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("roadmap worktree binds the caller to the selected repository", () => {
  const root = mkdtempSync(join(tmpdir(), "roadmap-git-")), other = mkdtempSync(join(tmpdir(), "roadmap-other-"));
  try {
    expect(hubGitSync(["-C", root, "init", "-q"], { encoding: "utf8" }).status).toBe(0);
    expect(hubGitSync(["-C", other, "init", "-q"], { encoding: "utf8" }).status).toBe(0);
    mkdirSync(join(root, "nested"));
    expect(roadmapWorktree(root, join(root, "nested"))).toBe(realPath(root));
    expect(() => roadmapWorktree(root, other)).toThrow("different repository");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});
