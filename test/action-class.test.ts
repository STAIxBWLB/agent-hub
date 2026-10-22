import { expect, test } from "bun:test";
import { ACTION_CLASSES, classifyAction, type ActionClass } from "../src/hub/action-class.ts";

const root = "/work/project";
const cases: Array<[string, ActionClass[]]> = [
  ["git push origin main", ["publish"]],
  ["'/usr/bin/git' -C '/work/my project' push --tags", ["publish"]],
  ["git --no-pager push origin v1", ["publish"]],
  ["git tag v1", []],
  ["git status", []],
  ["printf 'git push origin main'", []],
  ["npm publish --access public", ["publish"]],
  ["cargo publish", ["publish"]],
  ["gh release create v1 --notes 'a release'", ["publish"]],
  ["gh release view v1", []],
  ["gh release list", []],
  ["git reset --hard HEAD~1", ["destroy"]],
  ["git reset --soft HEAD~1", []],
  ["git clean -fdx", ["destroy"]],
  ["git clean -f -d -x", ["destroy"]],
  ["git clean -ndx", []],
  ["git branch -D feature", ["destroy"]],
  ["git branch --delete --force feature", ["destroy"]],
  ["git branch -d feature", []],
  ["rm -rf ../archive", ["destroy"]],
  ["rm --recursive -- '/work/private records'", ["destroy"]],
  ["rm -r /work/project-other", ["destroy"]],
  ["rm -rf ./cache", []],
  ["rm -rf /work/project/cache", []],
  ["rm ../single-file", []],
  ["cp -f input ../output", ["destroy"]],
  ["mv --force 'input file' /tmp/output", ["destroy"]],
  ["cp -f input ./output", []],
  ["cp input ../output", []],
  ["printf 'replacement' > ../output", ["destroy"]],
  ["> ../output", ["destroy"]],
  ["cp -f -t ../output input", ["destroy"]],
  ["printf 'replacement' > ./output", []],
  ["printf 'append' >> ../output", []],
  ["cd /tmp && rm -rf target", ["destroy"]],
  ["cd ../archive; cp -f input output", ["destroy"]],
  ["cd ./cache && rm -rf target", []],
  ["cd /tmp; cd /work/project; rm -rf target", ["destroy"]],
  ["printf 'literal > ../output'", []],
  ["curl -X POST https://example.test", ["external-write"]],
  ["curl --request=PATCH https://example.test", ["external-write"]],
  ["curl -XDELETE https://example.test", ["external-write"]],
  ["curl -d 'git push; rm -rf /tmp/data' https://example.test", ["external-write"]],
  ["curl --json '{}' https://example.test", ["external-write"]],
  ["curl --data-binary @file https://example.test", ["external-write"]],
  ["curl -T input https://example.test", ["external-write"]],
  ["curl https://example.test", []],
  ["curl --head https://example.test", []],
  ["curl -X GET https://example.test", []],
  ["curl --get -d q=term https://example.test", []],
  ["http POST https://example.test key=value", ["external-write"]],
  ["http GET https://example.test", []],
  ["gh api repos/org/repo", []],
  ["gh api -X GET repos/org/repo -f q=value", []],
  ["gh api repos/org/repo/issues -f title=hello", ["external-write"]],
  ["gh api --method DELETE repos/org/repo", ["external-write"]],
  ["gh issue comment 636 --body 'read me'", ["external-write"]],
  ["gh pr review 2 --approve", ["external-write"]],
  ["gh issue view 636", []],
  ["mail -s 'hello' person@example.test", ["external-write"]],
  ["sendmail person@example.test", ["external-write"]],
  ["slack chat.postMessage --channel test --text hello", ["external-write"]],
  ["telegram send --text hello", ["external-write"]],
  ["slack history", []],
  ["npm install -g tool", ["install"]],
  ["npm install --global tool", ["install"]],
  ["npm --global install tool", ["install"]],
  ["pnpm add -g tool", ["install"]],
  ["yarn global add tool", ["install"]],
  ["cargo install tool", ["install"]],
  ["brew install tool", ["install"]],
  ["pipx install tool", ["install"]],
  ["pip install --user tool", ["install"]],
  ["pip install package", []],
  ["npm install package", []],
  ["bun install", []],
  ["npm test && git push origin main; curl -X POST https://example.test | cat", ["publish", "external-write"]],
  ["git push && rm -rf ../old && npm install -g tool && gh issue comment 1 --body hi", [...ACTION_CLASSES]],
  ["printf 'git push && npm install -g tool'; git status", []],
  ["env TOKEN=placeholder git push", ["publish"]],
  ["TOKEN=placeholder git push", ["publish"]],
  ["command git push", ["publish"]],
  ["bash -lc 'git push && curl -X POST https://example.test'", ["publish", "external-write"]],
  ["git status # git push\nnpm publish", ["publish"]],
  ["git push && git push", ["publish"]],
  ["printf '한국어'; git push", ["publish"]],
  ["git push 'unterminated", []],
  ["git push $(choose_remote)", []],
  ["git push `choose_remote`", []],
  ["git push $REMOTE", []],
  ["git push >", []],
  ["cat << EOF\ngit push\nEOF", []],
];

for (const [command, expected] of cases) {
  test(`#636 literal action classes: ${command}`, () => {
    expect(classifyAction("Bash", { command }, root)).toEqual(expected);
  });
}

test("#636 shell argv and native string arguments retain literal quoting", () => {
  expect(classifyAction("exec_command", { cmd: ["git", "push", "origin", "main"] }, root)).toEqual(["publish"]);
  expect(classifyAction("shell", { command: ["printf", "git push"] }, root)).toEqual([]);
  expect(classifyAction("bash", JSON.stringify({ command: "npm publish" }), root)).toEqual(["publish"]);
  expect(classifyAction("run_shell_command", "git push", root)).toEqual(["publish"]);
});

test("#636 direct HTTP tools classify methods while unknown tools remain native", () => {
  expect(classifyAction("http_request", { method: "POST", url: "https://example.test" }, root)).toEqual(["external-write"]);
  expect(classifyAction("fetch", { method: "HEAD" }, root)).toEqual([]);
  expect(classifyAction("fetch", { url: "https://example.test" }, root)).toEqual([]);
  expect(classifyAction("unknown", { command: "git push" }, root)).toEqual([]);
  expect(classifyAction("Read", { command: "git push" }, root)).toEqual([]);
});

test("#636 malformed and bounded inputs never become permission decisions", () => {
  for (const args of [null, 2, [], { cmd: ["git", 2] }, { command: "x".repeat(16_385) }, { command: "git push\0" }, { command: "git push;".repeat(65) }]) {
    expect(classifyAction("bash", args, root)).toEqual([]);
  }
  expect(classifyAction("bash", { command: "rm -rf ../outside" }, "relative-root")).toEqual([]);
});


test("#636 literal shell cwd/workdir and direct git argv use their actual shape", () => {
  expect(classifyAction("bash", { command: "rm -rf target", cwd: "/tmp" }, root)).toEqual(["destroy"]);
  expect(classifyAction("exec_command", { cmd: "cp -f input output", workdir: "../archive" }, root)).toEqual(["destroy"]);
  expect(classifyAction("bash", { command: "rm -rf target", cwd: "/work/project/cache" }, root)).toEqual([]);
  expect(classifyAction("git", { args: ["push", "origin", "main"] }, root)).toEqual(["publish"]);
  expect(classifyAction("git", { args: ["reset", "--hard"] }, root)).toEqual(["destroy"]);
  expect(classifyAction("git", { args: ["status"] }, root)).toEqual([]);
});

const reviewCases: Array<[string, ActionClass[]]> = [
  ["git push </dev/null>/tmp/out", ["publish", "destroy"]],
  ["git push >file<in", ["publish"]],
  ["git push >../out; printf done", ["publish", "destroy"]],
  ["(git push >/tmp/out)", ["publish", "destroy"]],
  ["git push >", []],
  ["git push 2>&1", ["publish"]],
  ["git push >&2", ["publish"]],
  ["git push 1>&2 2>&1", ["publish"]],
  ["git push <input", ["publish"]],
  ["git push 0< 'input file'", ["publish"]],
  ["printf hello 2>&1", []],
  ["printf hello >> ../output 2>&1", []],
  ["git push; printf $UNKNOWN", ["publish"]],
  ["npm publish && printf `unsupported`", ["publish"]],
  ["git push; cat << EOF\nunknown\nEOF", ["publish"]],
  ["git push; printf 'unterminated", ["publish"]],
  ["git push; printf ending\\", ["publish"]],
  ["git push; printf >", ["publish"]],
  ["git push $UNKNOWN; npm publish", []],
  ["sudo git push", ["publish"]],
  ["sudo -u root -- npm install -g tool", ["install"]],
  ["sudo -n git push", ["publish"]],
  ["time git push", ["publish"]],
  ["/usr/bin/time -p git push", ["publish"]],
  ["timeout 10 git push", ["publish"]],
  ["timeout --signal TERM 10 git push", ["publish"]],
  ["nohup git push", ["publish"]],
  ["exec git push", ["publish"]],
  ["exec -- git push", ["publish"]],
  ["printf main | xargs git push origin", ["publish"]],
  ["xargs -n 1 git push", ["publish"]],
  ["xargs -I '{}' git push origin '{}'", ["publish"]],
  ["nice git push", ["publish"]],
  ["nice -n 10 git push", ["publish"]],
  ["! git push", ["publish"]],
  ["if true; then git push; fi", ["publish"]],
  ["if git push; then printf ok; fi", ["publish"]],
  ["if true; then printf 'git push'; fi", []],
  ["/usr/bin/env -i git push", ["publish"]],
  ["env -i TOKEN=placeholder git push", ["publish"]],
  ["env -- git push", ["publish"]],
  ["bash -lic 'git push'", ["publish"]],
  ["zsh -fc 'npm publish'", ["publish"]],
  ["sh -c -- 'git push'", ["publish"]],
  ["bash --noprofile -lc 'git push'", ["publish"]],
  ["(git push)", ["publish"]],
  ["{ git push; }", ["publish"]],
  ["(git push) && npm install -g tool", ["publish", "install"]],
  ["npm --registry https://registry.example.test publish", ["publish"]],
  ["pnpm --filter package publish", ["publish"]],
  ["yarn npm publish", ["publish"]],
  ["git -P push", ["publish"]],
  ["curl -sXPOST https://example.test", ["external-write"]],
  ["curl -sd'payload' https://example.test", ["external-write"]],
  ["curl -sXGET https://example.test", []],
  ["curl -sGd'query' https://example.test", []],
  ["rm -rf ~/archive", ["destroy"]],
  ["printf replacement > ~/archive", ["destroy"]],
  ["printf append >> ~/archive", []],
  ["cd; rm -rf target", ["destroy"]],
  ["cd ~ && rm -rf target", ["destroy"]],
  ["sudo -n timeout 5 nice -n 1 /usr/bin/env -i git push", ["publish"]],
  ["time printf 'npm publish'", []],
  ["xargs printf 'git push'", []],
];

for (const [command, expected] of reviewCases) {
  test(`#636 R2 transparent literal forms: ${command}`, () => {
    expect(classifyAction("Bash", { command }, root)).toEqual(expected);
  });
}

test("#636 R2 an explicit home cwd is conservatively outside for relative destruction", () => {
  expect(classifyAction("bash", { command: "rm -rf target", cwd: "~" }, root)).toEqual(["destroy"]);
  expect(classifyAction("exec_command", { cmd: "cp -f input target", workdir: "~/archive" }, root)).toEqual(["destroy"]);
  expect(classifyAction("bash", { command: "rm target", cwd: "~" }, root)).toEqual([]);
});


test("#636 R2 home uncertainty survives a saturated cwd candidate set", () => {
  const command = [...Array.from({ length: 8 }, (_, i) => `cd d${i}`), "cd", "rm -rf target"].join(";");
  expect(classifyAction("bash", { command }, root)).toEqual(["destroy"]);
});

const curlValueCases: Array<[string, ActionClass[]]> = [
  ["curl -XGET -XPOST https://example.test", ["external-write"]],
  ["curl -XPOST -XGET https://example.test", []],
  ["curl -G --no-get -d payload https://example.test", ["external-write"]],
  ["curl -o '-XGET' -d payload https://example.test", ["external-write"]],
  ["curl -A '-G' --data payload https://example.test", ["external-write"]],
  ["curl --header=-XGET --data=-G https://example.test", ["external-write"]],
  ["curl -d payload https://example.test --next -XGET https://example.test", ["external-write"]],
  ["curl -d '-XGET' https://example.test", ["external-write"]],
  ["curl -d '-G' https://example.test", ["external-write"]],
  ["curl --data '-XGET' https://example.test", ["external-write"]],
  ["curl -H '-XGET' -d payload https://example.test", ["external-write"]],
  ["curl --header '-G' --data payload https://example.test", ["external-write"]],
  ["curl -G --data '-XPOST' --header '-XDELETE' https://example.test", []],
];
for (const [command, expected] of curlValueCases) {
  test(`#636 R2 curl option values stay data: ${command}`, () => {
    expect(classifyAction("Bash", { command }, root)).toEqual(expected);
  });
}


test("#636 R2 unlisted curl options cannot erase known write evidence", () => {
  for (const value of ["-XGET", "-G"]) {
    expect(classifyAction("Bash", { command: `curl --url-query '${value}' -d payload https://example.test` }, root)).toEqual(["external-write"]);
    expect(classifyAction("Bash", { command: `curl --future-value '${value}' -d payload https://example.test` }, root)).toEqual(["external-write"]);
  }
  expect(classifyAction("Bash", { command: "curl -X POST --future-value '-XGET' https://example.test" }, root)).toEqual(["external-write"]);
  expect(classifyAction("Bash", { command: "curl --url-query q=value --compressed -X GET -d query https://example.test" }, root)).toEqual([]);
});


const r3Cases: Array<[string, ActionClass[]]> = [
  ["git clean -fd", ["destroy"]],
  ["git clean -f", ["destroy"]],
  ["git clean --force", ["destroy"]],
  ["git clean --force -d", ["destroy"]],
  ["git clean -fdx", ["destroy"]],
  ["git clean -fdn", []],
  ["git clean -n -fdx", []],
  ["git clean --dry-run --force", []],
  ["git clean -f -e '-n'", ["destroy"]],
  ["git clean -n -e '-f'", []],
  ["git clean -eforce", []],
  ["git clean -- -f", []],
  ["git clean -f -- -n", ["destroy"]],
  ["npm --prefix /tmp/p publish", ["publish"]],
  ["npm -C dir publish", ["publish"]],
  ["npm -Cdir publish", ["publish"]],
  ["pnpm --dir x publish", ["publish"]],
  ["yarn --cwd x npm publish", ["publish"]],
  ["git -C dir push", ["publish"]],
  ["git -c k=v push", ["publish"]],
  ["git -Cdir push", ["publish"]],
  ["git -ck=v push", ["publish"]],
  ["npm --future-option value publish", ["publish"]],
  ["pnpm --future-option value publish", ["publish"]],
  ["yarn --future-option value npm publish", ["publish"]],
  ["git --future-option value push", ["publish"]],
  ["git --future-option value reset --hard", ["destroy"]],
  ["npm --future-option value install -g tool", ["install"]],
  ["git -C push status", []],
  ["git -c push status", []],
  ["npm --prefix publish test", []],
  ["npm -C publish test", []],
  ["npm test publish", []],
];
for (const [command, expected] of r3Cases) {
  test(`#636 R3 clean and global options: ${command}`, () => {
    expect(classifyAction("Bash", { command }, root)).toEqual(expected);
  });
}
