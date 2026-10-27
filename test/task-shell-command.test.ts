import { expect, test } from "bun:test";
import { taskShellCommand, type TaskShellBinding } from "../src/hub/task-shell-command.ts";

const binding: TaskShellBinding = { branch: "feat/513-shell", defaultBranch: "main" };
const create = `gh pr create --base main --head ${binding.branch} --title "feat: scoped grants (Refs #845)"`;

test("task completion grammar returns lexical kinds and all literal path operands", () => {
  const cases = [
    ["scripts/check.sh --changed", "check", ["scripts/check.sh"]],
    ["bun run build", "build", []],
    ["bun test test/a.test.ts ./test/conformance/b.test.ts", "test", ["test/a.test.ts", "./test/conformance/b.test.ts"]],
    ["git add src/a.ts docs/operations.md", "add", ["src/a.ts", "docs/operations.md"]],
    ["git add -- src/a.ts .github/workflows/check.yml", "add", ["src/a.ts", ".github/workflows/check.yml"]],
    ['git commit -m "feat: literal punctuation (Refs #845); data only"', "commit", []],
    [`git push origin ${binding.branch}`, "push", []],
    [`git push -u origin ${binding.branch}`, "push", []],
    [`gh pr view ${binding.branch}`, "pr-view", []],
    [`gh pr checks ${binding.branch}`, "pr-checks", []],
    [`${create} --body "A literal body; no shell operator executes."`, "pr-create", []],
    [`${create} --body-file .tmp/pr-body.md`, "pr-create", [".tmp/pr-body.md"]],
  ] as const;
  for (const [command, kind, paths] of cases) {
    const result = taskShellCommand(command, binding);
    expect(result, command).toBeDefined();
    expect(result!.kind, command).toBe(kind);
    expect(result!.paths, command).toEqual(paths);
  }
});

test("task binding must contain distinct short feature and default branch names", () => {
  for (const branch of [undefined, "", "main", "MAIN", "master", "Master", "-flag", "HEAD", "refs/heads/feature", "feature..old", "feature//part", "feature/.hidden", "feature.lock", "feature/part."])
    expect(taskShellCommand("bun run build", { ...binding, branch } as TaskShellBinding), String(branch)).toBeUndefined();
  for (const defaultBranch of [undefined, "", "-flag", "refs/remotes/origin/main"])
    expect(taskShellCommand("bun run build", { ...binding, defaultBranch } as TaskShellBinding)).toBeUndefined();
  expect(taskShellCommand("bun run build", { branch: "trunk", defaultBranch: "trunk" })).toBeUndefined();
  expect(taskShellCommand("bun run build", { branch: "feat/513-shell", defaultBranch: "trunk" })).toBeDefined();
});

test("operators, expansion, wrappers and additional execution flags always ask", () => {
  for (const command of [
    "bun run build; git push", "bun run build && git push", "bun run build | cat", "bun run build > out", "bun run build &", "bun run build\npwd",
    "bun test test/*.test.ts", 'bun test "test/*.test.ts"', "bun test $(printf test/a.test.ts)", "bun test `printf test/a.test.ts`",
    "BUN_OPTIONS=--preload=bad bun run build", "env bun run build", "bash scripts/check.sh --changed", "./scripts/check.sh --changed",
    "scripts/check.sh --changed main", "scripts/check.sh --changed --full", "bun run build --watch", "bun --cwd other run build", "bun test --preload bad test/a.test.ts",
    "git -C other add src/a.ts", "git -c core.hooksPath=other commit -m x", "git commit -am x", "git commit --amend -m x", "git commit -m x --no-verify",
    `git push --force origin ${binding.branch}`, `git push origin ${binding.branch} --force-with-lease`, `git push --set-upstream origin ${binding.branch}`,
    `gh --repo other/repo pr view ${binding.branch}`, `gh pr view ${binding.branch} --json state`, `${create} --body x --draft`, `${create} --body x --repo other/repo`,
  ]) expect(taskShellCommand(command, binding), command).toBeUndefined();
});

test("literal task paths reject traversal, option operands, pathspec magic and control directories", () => {
  for (const path of [".", "..", "../other", "src/../other", "/tmp/other", "-A", "./-A", "--all", ":(glob)*", ":(top)src/a.ts", "src/*", "src/?", "src/[ab]", "~/.ssh", ".git/config", ".GIT/config", "nested/.agenthub/config.json", "src//a.ts", "src/", "src/a;touch", "src/a b.ts"])
    expect(taskShellCommand(`git add -- '${path}'`, binding), path).toBeUndefined();
  expect(taskShellCommand("git add", binding)).toBeUndefined();
  expect(taskShellCommand("git add --", binding)).toBeUndefined();
  expect(taskShellCommand(`git add ${Array.from({ length: 65 }, (_, i) => `src/a${i}.ts`).join(" ")}`, binding)).toBeUndefined();
});

test("bun test needs one to sixteen explicit test filenames", () => {
  expect(taskShellCommand("bun test", binding)).toBeUndefined();
  for (const path of ["src/a.test.ts", "test/a.ts", "test/.test.ts", "test/a.test.ts/", "test/../a.test.ts", "test/a.test.ts?x", "test/.git/a.test.ts"])
    expect(taskShellCommand(`bun test '${path}'`, binding), path).toBeUndefined();
  expect(taskShellCommand(`bun test ${Array.from({ length: 16 }, (_, i) => `test/a${i}.test.ts`).join(" ")}`, binding)?.paths).toHaveLength(16);
  expect(taskShellCommand(`bun test ${Array.from({ length: 17 }, (_, i) => `test/a${i}.test.ts`).join(" ")}`, binding)).toBeUndefined();
});

test("branch-scoped push and PR forms refuse other branches, remotes, refspecs and PR selectors", () => {
  for (const command of [
    "git push origin other", "git push -u upstream feat/513-shell", "git push origin HEAD", "git push origin feat/513-shell:other", "git push origin +feat/513-shell",
    "gh pr view other", "gh pr checks 845", "gh pr view https://github.com/other/repo/pull/1",
    "gh pr create --base other --head feat/513-shell --title x --body x", "gh pr create --base main --head other --title x --body x",
  ]) expect(taskShellCommand(command, binding), command).toBeUndefined();
});

test("PR creation accepts only a unique closed flag set and exactly one bounded body source", () => {
  expect(taskShellCommand(`gh pr create --body-file .tmp/pr.md --title x --head ${binding.branch} --base main`, binding)?.paths).toEqual([".tmp/pr.md"]);
  for (const command of [
    create, `${create} --body x --body-file .tmp/pr.md`, `${create} --body x --title again`, `${create} --body-file -`, `${create} --body-file /tmp/pr.md`,
    `${create} --body-file ../pr.md`, `${create} --body-file .git/config`, `${create} --body-file "a;other"`,
    `gh pr create --base main --base main --head ${binding.branch} --body x`, `${create} --body ""`, `${create} --body "   "`,
    `gh pr create --base main --head ${binding.branch} --title "" --body x`, `${create} --body "${"x".repeat(3001)}"`,
  ]) expect(taskShellCommand(command, binding), command).toBeUndefined();
});

test("quoted punctuation stays data only in bounded commit and PR text values", () => {
  expect(taskShellCommand("git commit -m 'literal $HOME $(word) #issue; text'", binding)?.kind).toBe("commit");
  expect(taskShellCommand('git commit -m "expanded $HOME"', binding)).toBeUndefined();
  expect(taskShellCommand('git commit -m ""', binding)).toBeUndefined();
  expect(taskShellCommand(`git commit -m "${"x".repeat(1001)}"`, binding)).toBeUndefined();
  expect(taskShellCommand("git add 'src/a$(word).ts'", binding)).toBeUndefined();
  expect(taskShellCommand(`${create} --body 'literal $(word); text'`, binding)?.kind).toBe("pr-create");
});
