import { expect, test } from "bun:test";
import { parseSimpleShell, READ_ONLY_SHELL_LIMITS } from "../src/hub/read-only-shell.ts";

// These tests establish literal argv grammar only. Program, option and quoted-metachar grant rules are separate.
test("read-only shell lexer preserves basic literal words spaces and quote concatenation", () => {
  for (const [command, words] of [
    ["pwd", ["pwd"]],
    ["  ls\t-la  src  ", ["ls", "-la", "src"]],
    ["cat 'a file.txt'", ["cat", "a file.txt"]],
    ['head -n 5 "a file.txt"', ["head", "-n", "5", "a file.txt"]],
    ['cat before"middle part"after', ["cat", "beforemiddle partafter"]],
    ['cat "" last', ["cat", "", "last"]],
    ["cat a\\ file.txt", ["cat", "a file.txt"]],
  ] as [string, string[]][]) expect(parseSimpleShell(command)?.words).toEqual(words);
});

test("read-only shell lexer refuses active control operators expansions and malformed grammar", () => {
  for (const command of [
    "", " \t ", "cat a; cat b", "cat a && cat b", "cat a || cat b", "cat a | wc", "cat a &",
    "cat a > out", "cat < input", "cat << EOF", "cat `pwd`", "cat $(pwd)", "cat ${ROOT}", "cat $ROOT",
    "cat *.txt", "cat file?", "cat [ab]", "cat {a,b}", "cat ~/file", "cat a # comment",
    'cat "a\\q"', 'cat "unterminated', "cat 'unterminated", "cat trailing\\", 'cat "trailing\\',
    "cat a\ncat b", "cat a\rcat b", "cat a\0b", 'cat "$ROOT"',
  ]) expect(parseSimpleShell(command), command).toBeUndefined();
  expect(parseSimpleShell(undefined)).toBeUndefined();
  expect(parseSimpleShell({ command: "pwd" })).toBeUndefined();
});

test("read-only shell lexer bounds the whole input and total word count", () => {
  expect(parseSimpleShell("x".repeat(READ_ONLY_SHELL_LIMITS.characters))?.words).toHaveLength(1);
  expect(parseSimpleShell("x".repeat(READ_ONLY_SHELL_LIMITS.characters + 1))).toBeUndefined();
  expect(parseSimpleShell(Array(READ_ONLY_SHELL_LIMITS.words).fill("x").join(" "))?.words).toHaveLength(128);
  expect(parseSimpleShell(Array(READ_ONLY_SHELL_LIMITS.words + 1).fill("x").join(" "))).toBeUndefined();
});


test("read-only shell parser preserves quoted regex data and its provenance without deciding a grant", () => {
  const result=parseSimpleShell("rg 'a*[bc]' src");
  expect(result?.words).toEqual(["rg","a*[bc]","src"]);
  expect(result?.quotedMeta).toBe(true);
  expect(parseSimpleShell("rg alpha src")?.quotedMeta).toBe(false);
});


test("read-only shell parser refuses leading environment assignments while preserving ordinary equals arguments", () => {
  for (const command of ["FOO=bar cat file", "FOO+=bar cat file", "_FOO_1=bar pwd", "FOO=bar", "FOO+=bar"])
    expect(parseSimpleShell(command)).toBeUndefined();
  expect(parseSimpleShell("rg 'x=y' src")?.words).toEqual(["rg", "x=y", "src"]);
});

import { readOnlyShellForm } from "../src/hub/read-only-shell.ts";
import { guardPath } from "../src/local/tools.ts";
const form=(command:string)=>readOnlyShellForm(command,import.meta.dir,(path,base=import.meta.dir)=>guardPath({cwd:import.meta.dir,deny:["private"]},`${base}/${path}`,"read"));

test("closed program rules accept literal bounded read forms and single quoted regex data",()=>{
  for(const command of ["ls -la .","cat read-only-shell.test.ts","head -n 5 read-only-shell.test.ts","tail -n 5 read-only-shell.test.ts","wc -l read-only-shell.test.ts","rg -n 'a*[bc]$' .","grep -r -e 'x=y' .","stat .","file -b read-only-shell.test.ts","tree -L 2 .","pwd","find . -name '*.ts' -type f -print","git status --short","git log --oneline -n 5","git log main..topic","git rev-parse HEAD~1","git ls-files","git branch --list 'feat/*'","git describe --always","git cat-file -p HEAD","git diff --no-ext-diff --no-textconv HEAD~1","git show --no-ext-diff --no-textconv HEAD","git log -p --no-ext-diff --no-textconv"])expect(form(command),command).toBeDefined();
});

test("closed program rules ask for writers helper execution unknown options or outside paths",()=>{
  for(const command of ["ls --unknown", "ls -L .", "tail -f x", "tail -F x", "rg --pre helper x .","rg --pre-glob '*.ts' x .","rg --hostname-bin helper x .","rg -z x .","grep -R x .","find -L .","find -H .","find . -exec pwd ';'","find . -execdir pwd ';'","find . -ok pwd ';'","find . -delete","find . -fprint out","find . -fprint0 out","find . -fls out","find . -files0-from paths","file -C","file -f paths","file -z x","wc --files0-from paths","tree -l .","tree -o out","tree --fromfile x","git -c core.fsmonitor=helper status","git --exec-path=x status","git -C ../ status","git commit -m x","git checkout x","git diff --output=x","git diff --no-ext-diff","git show --no-textconv","git log -p","git blame x","git grep x","git branch x", "git diff --no-ext-diff --no-textconv -- '*.txt'", "git ls-files '[ab]*'","cat ../outside","cat private-data","unknown x","bash -c pwd","rg x . | wc -l","FOO=bar pwd",'cat "a\\q"','rg "$ROOT" .'])expect(form(command),command).toBeUndefined();
});


test("Git clustered patch flags require both helper-disabling flags after option parsing",()=>{
  for(const patch of ["-pn1", "-p -n1", "--patch -n1", "--stat -n1"]){
    for(const disables of ["", " --no-ext-diff", " --no-textconv"])
      expect(form(`git log ${patch}${disables}`),`${patch}${disables}`).toBeUndefined();
    expect(form(`git log ${patch} --no-ext-diff --no-textconv`),patch).toBeDefined();
  }
  expect(form("git log -n1 --oneline")).toBeDefined();
});

// Signature placeholders invoke GPG even when gpg.program/log.showSignature are absent.
test("custom pretty formats cannot trigger default signature helpers automatically", () => {
  for (const command of ["git log --format='%G?'", "git log --format=%GS", "git log --pretty='format:%G?'", "git show --no-ext-diff --no-textconv --format='%G?'"])
    expect(form(command), command).toBeUndefined();
  expect(form("git log --oneline -n 1")).toBeDefined();
});
