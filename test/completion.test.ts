import { expect, test } from "bun:test";
import { join } from "node:path";
import { HELP, helpCommands } from "../src/cli/help.ts";
import { COMPLETION_SHELLS, completeWords, completionScript, completionTable, FILES } from "../src/cli/completion.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

const MAIN = join(import.meta.dir, "../src/cli/main.js");

test("#603 every documented command is a top-level candidate", () => {
  const root = completionTable().get("")!;
  const offered = new Set([...root.children, ...root.options.keys()]);
  expect(HELP.flatMap(helpCommands).filter(command => !offered.has(command))).toEqual([]);
});

test("#603 candidates follow commands, subcommands, enum values, = forms and paths", () => {
  expect(completeWords(["ta"])).toEqual(["tail", "task"]);
  expect(completeWords(["task", ""])).toContain("assign");
  expect(completeWords(["task", "assign", "7", "codex", "--r"])).toEqual(["--revision", "--role"]);
  expect(completeWords(["queue", "resolve", "x", "--action", ""])).toEqual(["completed", "retry", "discard"]);
  expect(completeWords(["status", "--c"])).toEqual(["--color="]);
  expect(completeWords(["status", "--color=a"])).toEqual(["--color=auto", "--color=always"]);
  expect(completeWords(["init", "--profile", "w"])).toEqual(["writing"]);
  expect(completeWords(["recovery", "re"])).toEqual(["reattach", "resume"]);
  expect(completeWords(["--project", "/x", "st"])).toEqual(["status", "stop"]);
  expect(completeWords(["--project", ""])).toEqual([FILES]);
  expect(completeWords(["upgrade", "--to", ""])).toEqual([]); // <version> is free text, never the word "version"
  expect(completeWords(["completion", ""])).toEqual(["bash", "fish", "zsh"]);
});

test("#603 review: placeholders are not values, <a|b|c> lists are, and positionals end subcommands", () => {
  expect(completeWords(["task", "assign", "7", "codex", "--revision", ""])).toEqual([]); // N is a placeholder
  expect(completeWords(["pet", "--palette", ""]).sort()).toEqual(["blue", "ochre", "teal", "violet"]);
  expect(completeWords(["review", ""])).toContain("brief");
  expect(completeWords(["review", "42", ""])).not.toContain("brief");
});

test("#603 review: the fish script passes an empty current word, so Tab after a space completes the next word", () => {
  expect(completionScript("fish")).toContain('"$cur"');
});

test("#603 the scripts parse in their shells, an unknown shell has none, and agents may print them", () => {
  expect(COMPLETION_SHELLS).toEqual(["zsh", "bash", "fish"]);
  expect(completionScript("tcsh")).toBeUndefined();
  for (const shell of COMPLETION_SHELLS) {
    if (!Bun.which(shell)) continue; // fish is optional on CI runners
    const run = Bun.spawnSync([shell, "-n"], { stdin: new TextEncoder().encode(completionScript(shell)!), stdout: "pipe", stderr: "pipe" });
    expect({ shell, code: run.exitCode, stderr: run.stderr.toString() }).toEqual({ shell, code: 0, stderr: "" });
  }
  expect(classifyPeerCommand("completion", ["zsh"])).toBe("allowed");
});

test("#603 ahub __complete answers from the entrypoint without loading the CLI", () => {
  const run = Bun.spawnSync([process.execPath, MAIN, "__complete", "--", "ta"], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toBe("tail\ntask\n");
});
