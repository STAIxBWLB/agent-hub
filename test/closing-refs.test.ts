import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closingMisuse, commitMisuse, intentionalCloses, keywordReferences, mentioned } from "../scripts/check-closing-refs.mjs";

// #760: agent-mem PR #36 said "Does not close #15", GitHub read `close #15` as a closing keyword, and the design issue closed with T3 open.
const repo = "STAIxBWLB/agent-hub";
// the shape `gh pr view --json closingIssuesReferences` prints (checked against agent-mem PR #36): repository.name and repository.owner.login
const closes = (...numbers: number[]) => numbers.map(number => ({ number, repository: { name: "agent-hub", owner: { login: "STAIxBWLB" } } }));

test("a PR body that only references or negates an issue fails when GitHub would close it, and one that means it passes", () => {
  const fails: Array<[string, number[]]> = [
    ["Refs #15. Does not close #15.", [15]],
    ["Refs #15. Does not close #15: T3, T4 and the rest stay open.", [15]],
    ["This does NOT fix #7.", [7]],
    ["It doesn't resolve #7 yet.", [7]],
    ["Will never close #7", [7]],
    ["Not fix or close #7", [7]],
    ["Without closing nothing, but without fixes #7", [7]],
    ["Refs #7. Cannot close #7.", [7]],
    ["Doesn’t close #7", [7]],                                                      // a typographic apostrophe
    ["Refs STAIxBWLB/agent-hub#9. Does not close STAIxBWLB/agent-hub#9.", [9]],
    ["Does not close https://github.com/STAIxBWLB/agent-hub/issues/9", [9]],
    ["Part of #3, not fixes #3", [3]],
    // claude round 1: a comma or colon does not end a sentence, "nothing" negates, and a qualifier is not intent
    ["Refs #15. It does not, however, close #15.", [15]],
    ["Refs #15. It does not: close #15.", [15]],
    ["Refs #15. Nothing here fixes #15 yet.", [15]],
    ["Refs #15. None of this resolves #15.", [15]],
    ["Partially fixes #15.", [15]],
    ["Partly closes #15", [15]],
    ["Part of the work, fixes #15", [15]],
    ["Half fixes #15", [15]],
    ["Hardly resolves #15", [15]],
    ["No longer closes #15", [15]],
    ["Mostly fixes #15", [15]],
  ];
  for (const [body, numbers] of fails) expect(closingMisuse(body, closes(...numbers), repo), body).toEqual(numbers.map(number => `staixbwlb/agent-hub#${number}`));
  const passes: Array<[string, number[]]> = [
    ["Refs #15.", []],                                                              // nothing closes
    ["Fixes #15", [15]],
    ["fixes #15. Refs #3.", [15]],
    ["Closes: #15", [15]],
    ["Resolved [#15]", [15]],
    ["Fixes #1 and fixes #2", [1, 2]],
    ["Refs #15. Does not close #15.\nFixes #15", [15]],                              // an explicit closing keyword elsewhere is the author's intent
    ["Fixes STAIxBWLB/agent-hub#9", [9]],
    ["Fixes https://github.com/STAIxBWLB/agent-hub/issues/9", [9]],
    ["No keyword here, but linked in the sidebar", [41]],                            // a deliberate sidebar link names nothing in the text
    ["Refs #2. First, this fixes #3: it does not touch #2.", [3]],
    ["Not a typo. Fixes #4", [4]],                                                  // the negation is in another clause
    ["Does not break anything; fixes #4", [4]],
    ["Does not break anything.\nFixes #4", [4]],                                    // a line break ends the sentence
    ["Nothing broke! Fixes #4", [4]],
    ["Fixes #4, which was not reproducible before.", [4]],                          // the negation comes after the reference
  ];
  for (const [body, numbers] of passes) expect(closingMisuse(body, closes(...numbers), repo), body).toEqual([]);
});

test("the issue's table: 'Refs #N. Does not close #N.' fails and 'Refs #N.' passes", () => {
  expect(closingMisuse("Refs #15. Does not close #15.", closes(15), repo)).toEqual(["staixbwlb/agent-hub#15"]);
  expect(closingMisuse("Refs #15.", [], repo)).toEqual([]);
  expect(closingMisuse("Refs #15.", closes(15), repo)).toEqual(["staixbwlb/agent-hub#15"]);   // closed through some other route, but only referenced in the text
});

test("a commit message with a closing keyword the PR text does not mean fails, since a squash merge would close the issue", () => {
  const text = "Refs #15. Fixes #2.";
  expect(commitMisuse(["fix: a (Fixes #2)"], text, repo)).toEqual([]);
  expect(commitMisuse(["feat: b\n\nCloses #15"], text, repo)).toEqual(["staixbwlb/agent-hub#15"]);
  expect(commitMisuse(["feat: b\n\nDoes not close #15"], text, repo)).toEqual(["staixbwlb/agent-hub#15"]);   // a negated verb in a commit closes it too
  expect(commitMisuse(["feat: c\n\nRefs #15"], text, repo)).toEqual([]);
  expect(commitMisuse(["a\n\nCloses #15", "b\n\nFixes #15"], text, repo)).toEqual(["staixbwlb/agent-hub#15"]);   // listed once
  expect(commitMisuse(["x\n\nCloses #15"], "Closes #15", repo)).toEqual([]);
  expect(keywordReferences("Fixes #1. Not fixes #2", repo)).toEqual([{ id: "staixbwlb/agent-hub#1", negated: false }, { id: "staixbwlb/agent-hub#2", negated: true }]);
});

test("a closing reference in another repository is compared as that repository's issue", () => {
  const other = [{ number: 15, repository: { name: "agent-mem", owner: { login: "STAIxBWLB" } } }];
  expect(closingMisuse("Refs STAIxBWLB/agent-mem#15. Does not close STAIxBWLB/agent-mem#15.", other, repo)).toEqual(["staixbwlb/agent-mem#15"]);
  expect(closingMisuse("Fixes STAIxBWLB/agent-mem#15", other, repo)).toEqual([]);
  expect(closingMisuse("Fixes #15", other, repo)).toEqual([]);   // `#15` in the text is this repository's issue, the closing one is agent-mem's: not named, so not judged
});

test("mentioned and intentionalCloses read the reference forms GitHub accepts", () => {
  expect([...mentioned("see #1, org/r#2 and https://github.com/Org/R/issues/3", repo)].sort()).toEqual(["org/r#2", "org/r#3", "staixbwlb/agent-hub#1"]);
  expect([...intentionalCloses("Fixes #1. Does not close #2. Resolves org/r#3", repo)].sort()).toEqual(["org/r#3", "staixbwlb/agent-hub#1"]);
  expect([...intentionalCloses("closes #5 fix:#6 prefix #7 fixture #8", repo)].sort()).toEqual(["staixbwlb/agent-hub#5", "staixbwlb/agent-hub#6"]);   // a keyword is a whole word: `prefix` and `fixture` are not
});

test("the command reads the PR through gh and exits 1 with the explanation for a misused keyword, 0 otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-closing-refs-"));
  try {
    const gh = join(dir, "gh");
    writeFileSync(gh, `#!/bin/sh\nif [ "$1" = pr ]; then printf '%s' "$FAKE_PR"; else printf '{"nameWithOwner":"${repo}"}'; fi\n`); chmodSync(gh, 0o755);
    const run = (pr: unknown) => spawnSync(process.execPath, ["scripts/check-closing-refs.mjs", "753"], { cwd: join(import.meta.dir, ".."), encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, FAKE_PR: JSON.stringify(pr), GITHUB_REPOSITORY: repo } });
    const bad = run({ title: "fix(x): y", body: "Refs #15. Does not close #15.", closingIssuesReferences: closes(15) });
    expect(bad.status).toBe(1); expect(bad.stderr).toContain("would close staixbwlb/agent-hub#15"); expect(bad.stderr).toContain("Refs #N");
    const good = run({ title: "fix(x): y", body: "Refs #15.", closingIssuesReferences: [] });
    expect(good.status, good.stderr).toBe(0); expect(good.stdout).toContain("closing-refs: OK");
    const commit = run({ title: "t", body: "Refs #15.", closingIssuesReferences: [], commits: [{ messageHeadline: "feat: b", messageBody: "Closes #15" }] });
    expect(commit.status).toBe(1); expect(commit.stderr).toContain("a commit message of PR #753"); expect(commit.stderr).toContain("staixbwlb/agent-hub#15");
    expect(run({ title: "t", body: "Refs #15.", closingIssuesReferences: [], commits: [{ messageHeadline: "feat: b", messageBody: "Refs #15" }] }).status).toBe(0);
    const titled = run({ title: "Fixes #15", body: "Does not close #15", closingIssuesReferences: closes(15) });   // the title names the intent too
    expect(titled.status).toBe(0);
    expect(spawnSync(process.execPath, ["scripts/check-closing-refs.mjs"], { cwd: join(import.meta.dir, ".."), encoding: "utf8", env: { PATH: process.env.PATH } }).status).not.toBe(0);   // no PR number: usage error
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
