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
    ['cat "a\\q"', ["cat", "a\\q"]],
  ] as [string, string[]][]) expect(parseSimpleShell(command)?.words).toEqual(words);
});

test("read-only shell lexer refuses active control operators expansions and malformed grammar", () => {
  for (const command of [
    "", " \t ", "cat a; cat b", "cat a && cat b", "cat a || cat b", "cat a | wc", "cat a &",
    "cat a > out", "cat < input", "cat << EOF", "cat `pwd`", "cat $(pwd)", "cat ${ROOT}", "cat $ROOT",
    "cat *.txt", "cat file?", "cat [ab]", "cat {a,b}", "cat ~/file", "cat a # comment",
    'cat "unterminated', "cat 'unterminated", "cat trailing\\", 'cat "trailing\\',
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
