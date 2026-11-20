import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hubGitSync } from "../src/hub/git.ts";

const script = join(import.meta.dir, "../scripts/check-roadmap.mjs");
test("roadmap validator accepts valid tracked spec paths and refuses missing ids and paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "roadmap-ci-"));
  const run = async (committed = false) => {
    const env = { ...process.env }; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
    const proc = Bun.spawn(["node", script, root, ...(committed ? ["--committed"] : [])], { stdout: "pipe", stderr: "pipe", env });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); return { out, err, code };
  };
  try {
    expect(hubGitSync(["-C", root, "init", "-q"], { encoding: "utf8" }).status).toBe(0);
    mkdirSync(join(root, "docs/design"), { recursive: true }); mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export {};\n");
    writeFileSync(join(root, "docs/design/a.md"), "---\nid: a\ntype: module\ntitle: A\nstatus: active\npaths:\n  - src/a.ts\n---\n\n# A\n");
    expect(hubGitSync(["-C", root, "add", "src/a.ts", "docs/design/a.md"], { encoding: "utf8" }).status).toBe(0);
    const progress = { tasks: { approved: 0, total: 0 }, issues: { closed: 0, total: 0, unknown: 0 }, specs: { fresh: 0, stale: 0, unverified: 0, unknown: 1, total: 1 }, releases: { shipped: 0, total: 0, unknown: 0 } };
    const row = { id: 1, title: "A", outcome: "A", state: "active", horizon: "now", order: 0, target: null, parent: null, issues: [], specs: [{ id: "a", state: "unknown" }], progress, withheld: 0 };
    const save = () => writeFileSync(join(root, "docs/roadmap.json"), JSON.stringify({ version: 1, milestones: [row] }));
    save(); expect(await run()).toMatchObject({ code: 0 });
    writeFileSync(join(root, "docs/design/a.md"), "---\nid: a\ntype: module\ntitle: A\nstatus: active\npaths:\n  - src/**\n---\n\n# A\n");
    expect(hubGitSync(["-C", root, "add", "docs/roadmap.json", "docs/design/a.md"], { encoding: "utf8" }).status).toBe(0);
    expect(hubGitSync(["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { encoding: "utf8" }).status).toBe(0);
    expect(await run(true)).toMatchObject({ code: 0 });
    row.specs[0]!.id = "missing"; save(); expect((await run()).err).toContain("unknown roadmap spec");
    row.specs[0]!.id = "a"; save(); writeFileSync(join(root, "docs/design/a.md"), "---\nid: a\ntype: module\ntitle: A\nstatus: active\npaths:\n  - src/missing.ts\n---\n\n# A\n");
    const missing = await run(); expect(missing.code).not.toBe(0); expect(missing.err).toContain("missing roadmap spec path");
    rmSync(join(root, "docs/roadmap.json")); symlinkSync(join(root, "src/a.ts"), join(root, "docs/roadmap.json"));
    expect((await run()).err).toContain("bounded plain file");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
