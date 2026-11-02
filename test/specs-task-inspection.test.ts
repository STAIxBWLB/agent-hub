import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { parseSpecsConfig, SpecsEngine } from "../src/hub/specs.ts";
import { SpecTaskInspector } from "../src/hub/specs-task.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-spec-head-"))); roots.push(root);
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed`);
    return result.stdout.trim();
  };
  git("init", "-q"); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/bus.ts"), "export const bus = 1;\n");
  writeFileSync(join(root, "src/other.ts"), "export const other = 1;\n");
  git("add", "."); git("commit", "-qm", "source baseline");
  const baseline = git("rev-parse", "HEAD");
  const spec = (scope = "src/bus.ts", type = "goal") => `---\nid: bus\ntype: ${type}\ntitle: Bus\npaths: [${scope}]\nverified-against: ${baseline}\n---\nBus design.\n`;
  return { root, git, baseline, spec };
}

test("submitted-head coverage ignores the daemon checkout and dirty spec edits", () => {
  const { root, git, spec } = repo();
  writeFileSync(join(root, "bus.md"), spec()); git("add", "."); git("commit", "-qm", "main design");
  const main = git("rev-parse", "HEAD");
  writeFileSync(join(root, "src/bus.ts"), "export const bus = 2;\n"); git("add", "."); git("commit", "-qm", "branch source change");
  const submitted = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", main);
  writeFileSync(join(root, "bus.md"), spec("src/other.ts"));
  const inspector = new SpecTaskInspector(root, () => parseSpecsConfig(undefined));
  expect(inspector.notice(["src/bus.ts"])).toBeUndefined();
  const report = inspector.inspect(submitted, [{ path: "src/bus.ts", status: "M" }], { complete: true });
  expect(report).toMatchObject({ head: submitted, complete: true, errors: 0, unchanged: [{ id: "bus", path: "bus.md", title: "Bus" }], changed: [] });
  const check = new SpecsEngine(root, parseSpecsConfig(undefined), { commit: submitted }).check();
  expect(check.freshness[0]).toMatchObject({ state: "stale", commitsSince: 1, dirty: false });
  expect(git("rev-parse", "HEAD")).toBe(main);
});

test("branch-added spec updates and schema errors are read from the same submitted tree", () => {
  const { root, git, baseline, spec } = repo();
  writeFileSync(join(root, "bus.md"), spec("src/bus.ts", "invalid-type"));
  writeFileSync(join(root, "src/bus.ts"), "export const bus = 2;\n");
  git("add", "."); git("commit", "-qm", "submitted invalid design");
  const head = git("rev-parse", "HEAD"); git("checkout", "-q", "--detach", baseline);
  const inspector = new SpecTaskInspector(root, () => parseSpecsConfig(undefined));
  expect(inspector.status()).toBeUndefined();
  const report = inspector.inspect(head, [{ path: "src/bus.ts", status: "M" }, { path: "bus.md", status: "A" }], { complete: true });
  expect(report?.errors).toBeGreaterThan(0);
  expect(report).toMatchObject({ head, complete: true, unchanged: [], changed: [{ id: "bus", path: "bus.md", title: "Bus" }] });
  expect(existsSync(join(root, "bus.md"))).toBe(false);
});

test("unknown changed-file evidence cannot produce an acknowledged complete report", () => {
  const { root, git, spec } = repo();
  writeFileSync(join(root, "bus.md"), spec()); git("add", "."); git("commit", "-qm", "design");
  const head = git("rev-parse", "HEAD"), inspector = new SpecTaskInspector(root, () => parseSpecsConfig(undefined));
  const report = inspector.inspect(head, undefined, { complete: false, acks: [{ id: "bus", reason: "public reason" }] });
  expect(report).toMatchObject({ head, complete: false, unchanged: [], changed: [] });
  expect(inspector.inspect("", [], { complete: true })?.complete).toBe(false);
  expect(inspector.inspect("a".repeat(40), [], { complete: true })?.complete).toBe(false);
});

test("empty projects and effective off switches are quiet while explicit reads still work", () => {
  const { root, git, baseline, spec } = repo();
  let config = parseSpecsConfig(undefined);
  const inspector = new SpecTaskInspector(root, () => config);
  expect(inspector.inspect(baseline, undefined, { complete: false })).toBeUndefined();
  expect(inspector.status()).toBeUndefined();
  writeFileSync(join(root, "bus.md"), spec()); git("add", "."); git("commit", "-qm", "design");
  const head = git("rev-parse", "HEAD");
  expect(inspector.notice(["src/bus.ts"])?.specs[0]?.id).toBe("bus");
  config = { ...config, enabled: false };
  expect(inspector.notice(["src/bus.ts"])).toBeUndefined(); expect(inspector.status()).toBeUndefined();
  expect(inspector.inspect(head, [], { complete: true })).toBeUndefined();
  expect(inspector.read("check", []).specCount).toBe(1);
  config = { ...config, enabled: true, review: "off" };
  expect(inspector.inspect(head, [], { complete: true })).toBeUndefined();
  expect(inspector.read("covers", ["src/bus.ts"]).specs[0]?.id).toBe("bus");
});

test("committed symlink specs are skipped without reading their targets", () => {
  const { root, git, spec } = repo();
  const outside = realPath(mkdtempSync(join(tmpdir(), "ahub-spec-target-"))); roots.push(outside);
  writeFileSync(join(outside, "secret.md"), spec()); symlinkSync(join(outside, "secret.md"), join(root, "linked.md"));
  git("add", "."); git("commit", "-qm", "symlink source");
  const report = new SpecsEngine(root, parseSpecsConfig(undefined), { commit: git("rev-parse", "HEAD") }).check();
  expect(report).toMatchObject({ specCount: 0, errors: 0, items: [] });
});

test("committed scope matching excludes files only present in the daemon index", () => {
  const { root, git, spec } = repo();
  writeFileSync(join(root, "bus.md"), spec("src/future.ts")); git("add", "."); git("commit", "-qm", "invalid submitted scope");
  const submitted = git("rev-parse", "HEAD");
  writeFileSync(join(root, "src/future.ts"), "export const future = true;\n"); git("add", ".");
  const check = new SpecsEngine(root, parseSpecsConfig(undefined), { commit: submitted }).check();
  expect(check.items.some(item => item.code === "invalid-paths")).toBe(true);
});
