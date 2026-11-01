import { expect, test } from "bun:test";
import { runtimeVersionWarnings } from "../src/cli/runtime-version-warning.ts";

test("doctor warns about an older CLI and plugin with separate manual update commands", () => {
  const rows = runtimeVersionWarnings("0.25.0", "0.24.0", "0.23.1");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ section: "Hub", level: "warn", name: "CLI versus daemon" });
  expect(rows[0]!.detail).toContain("bun add --global @staix/agent-hub@0.25.0");
  expect(rows[1]).toMatchObject({ section: "Hub", level: "warn", name: "plugin versus daemon" });
  expect(rows[1]!.detail).toContain("ahub setup after the CLI update");
});

test("compatible or newer installed versions produce no staged-upgrade warning", () => {
  expect(runtimeVersionWarnings("0.25.0", "0.25.0", "0.25.0")).toEqual([]);
  expect(runtimeVersionWarnings("0.25.0", "0.26.0", "0.26.0")).toEqual([]);
});

test("an older plugin with a newer CLI needs setup without a CLI downgrade suggestion", () => {
  const rows = runtimeVersionWarnings("0.25.0", "0.26.0", "0.24.0");
  expect(rows).toHaveLength(1); expect(rows[0]!.name).toBe("plugin versus daemon");
  expect(rows[0]!.detail).toContain("ahub setup"); expect(rows[0]!.detail).not.toContain("bun add");
  expect(rows[0]!.detail).not.toContain("after the CLI update");
});

test("semver prereleases compare by order rather than lexically", () => {
  expect(runtimeVersionWarnings("0.25.0", "0.25.0-rc.1", "0.25.0")).toHaveLength(1);
  expect(runtimeVersionWarnings("0.25.0-rc.1", "0.25.0", "0.25.0")).toEqual([]);
});

test("unknown or malformed authenticated metadata stays unknown and is never copied into commands", () => {
  for (const bad of [undefined, null, {}, "", "0.25.0\nPRIVATE_CANARY", "0.25.0; echo PRIVATE_CANARY", "v0.25.0", "x".repeat(1000)]) {
    const missingDaemon = runtimeVersionWarnings(bad, "0.24.0", "0.24.0");
    expect(missingDaemon).toMatchObject([{ level: "unknown", name: "runtime version comparison" }]);
    expect(JSON.stringify(missingDaemon)).not.toContain("PRIVATE_CANARY");
    const missingInstalled = runtimeVersionWarnings("0.25.0", bad, bad);
    expect(missingInstalled).toHaveLength(2); expect(missingInstalled.every(row => row.level === "unknown")).toBe(true);
    expect(JSON.stringify(missingInstalled)).not.toContain("PRIVATE_CANARY");
  }
});
