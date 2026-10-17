import { expect, test } from "bun:test";
import { resolveColor } from "../src/cli/console-state.ts";

async function flags() {
  const path = "../src/cli/upgrade-presentation-flags.ts";
  return import(path);
}

test("#466 recovery colour has exactly console precedence for TTY, pipes and environment", async () => {
  const { readRecoveryPresentationFlags } = await flags();
  for (const flag of [undefined, "auto", "always", "never"]) for (const isTTY of [false, true]) {
    for (const env of [{}, { TERM: "dumb" }, { NO_COLOR: "1" }, { TERM: "dumb", NO_COLOR: "1" }]) {
      const environment = { isTTY, ...env };
      const parsed = readRecoveryPresentationFlags(flag ? [`--color=${flag}`] : [], environment, () => 1234);
      expect(parsed.options.color).toBe(resolveColor(flag, environment));
      expect(parsed.options.now()).toBe(1234);
    }
  }
});

test("#466 presentation flags leave command arguments and audit values intact", async () => {
  const { readRecoveryPresentationFlags } = await flags();
  const original = ["dispose", "operation", "--reason", "--json", "--stop-and-archive", "--color=never", "--verbose"];
  const parsed = readRecoveryPresentationFlags(original, { isTTY: false, columns: 120 });
  expect(parsed.args).toEqual(["dispose", "operation", "--reason", "--json", "--stop-and-archive"]);
  expect(parsed.flags).toEqual(["--color=never", "--verbose"]);
  expect(parsed.json).toBe(false);
  expect(parsed.options.columns).toBe(120);
  expect(parsed.options.verbose).toBe(true);
  expect(original).toEqual(["dispose", "operation", "--reason", "--json", "--stop-and-archive", "--color=never", "--verbose"]);
  expect(readRecoveryPresentationFlags(["--to", "--json"], { isTTY: true }).args).toEqual(["--to", "--json"]);
});

test("#466 raw JSON is a separate output decision and invalid colours refuse", async () => {
  const { readRecoveryPresentationFlags } = await flags();
  const parsed = readRecoveryPresentationFlags(["status", "operation", "--json", "--color=always"], { isTTY: false });
  expect(parsed.json).toBe(true);
  expect(parsed.options.color).toBe(true);
  expect(parsed.args).toEqual(["status", "operation"]);
  expect(() => readRecoveryPresentationFlags(["--color=invalid"], { isTTY: true })).toThrow("--color=auto|always|never");
  expect(() => readRecoveryPresentationFlags(["--color"], { isTTY: true })).toThrow("--color=auto|always|never");
});

test("#466 colour grammar refuses bare, space-form and repeated flags exactly like the console", async () => {
  const { readRecoveryPresentationFlags } = await flags();
  for (const argv of [["--color"], ["--color", "never"], ["--color=auto", "--color=never"]]) {
    expect(() => readRecoveryPresentationFlags(argv, { isTTY: true })).toThrow("--color=auto|always|never");
  }
});
