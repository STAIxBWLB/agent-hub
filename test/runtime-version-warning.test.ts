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

// #718 (#1179): the lines `ahub upgrade` ends with.
import { globalUpdateAfterUpgrade } from "../src/cli/runtime-version-warning.ts";

test("after an upgrade the step names the CLI and the plugin only when one is older than the upgraded daemon, with the exact version", () => {
  const both = globalUpdateAfterUpgrade("0.31.0", "0.30.0", "0.30.0");
  expect(both[0]).toContain("does not update the global CLI or the shared Claude plugin");
  expect(both.join(" ")).toContain("bun add -g @staix/agent-hub@0.31.0");
  expect(both.join(" ")).toContain("`ahub setup`");
  expect(both.join(" ")).not.toContain("@latest");
  // a current CLI with a stale plugin: setup only, no install command
  const pluginOnly = globalUpdateAfterUpgrade("0.31.0", "0.31.0", "0.30.0").join(" ");
  expect(pluginOnly).toContain("ahub setup"); expect(pluginOnly).not.toContain("bun add");
  // everything current, or newer than the daemon: nothing to say
  expect(globalUpdateAfterUpgrade("0.31.0", "0.31.0", "0.31.0")).toEqual([]);
  expect(globalUpdateAfterUpgrade("0.30.0", "0.31.0", "0.31.0")).toEqual([]);
});

test("the upgrade step agrees with the doctor rows: it speaks exactly when doctor would warn, for every pairing", () => {
  for (const daemon of ["0.29.0", "0.30.0", "0.31.0"]) for (const cli of ["0.29.0", "0.30.0", "0.31.0"]) for (const plugin of ["0.29.0", "0.30.0", "0.31.0", undefined]) {
    const doctor = runtimeVersionWarnings(daemon, cli, plugin).some(row => row.level === "warn");
    expect(globalUpdateAfterUpgrade(daemon, cli, plugin).length > 0).toBe(doctor);
  }
});

test("an unknown version is never a claim: no daemon, no plugin, a malformed value and a missing claude print nothing", () => {
  expect(globalUpdateAfterUpgrade(undefined, "0.30.0", "0.30.0")).toEqual([]);
  expect(globalUpdateAfterUpgrade("not a version; rm -rf /", "0.30.0", "0.30.0")).toEqual([]);
  expect(globalUpdateAfterUpgrade("0.31.0", "0.31.0", undefined)).toEqual([]);         // the plugin could not be read
  expect(globalUpdateAfterUpgrade("0.31.0", "0.31.0", "garbage")).toEqual([]);
  const injected = globalUpdateAfterUpgrade("0.31.0", "0.30.0; rm -rf /", "0.30.0").join(" ");
  expect(injected).not.toContain("rm -rf");                                            // a malformed CLI version is never copied into a command
});

test("when an older CLI handed the upgrade over, the target's own coordinator speaks for the CLI that started it", () => {
  const handed = globalUpdateAfterUpgrade("0.31.0", "0.31.0", "0.31.0", true).join(" ");
  expect(handed).toContain("The CLI that started this upgrade is older");
  expect(handed).toContain("bun add -g @staix/agent-hub@0.31.0");
  expect(globalUpdateAfterUpgrade("0.31.0", "0.31.0", "0.31.0", false)).toEqual([]);
  expect(globalUpdateAfterUpgrade(undefined, "0.31.0", "0.31.0", true)).toEqual([]);   // without a daemon version there is nothing to name
});

import { globalUpdateAdvice } from "../src/cli/runtime-version-warning.ts";
import { PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";

// The plugin probe is the same `claude plugin list --json` doctor runs; a failure to read it is an unknown plugin, never a claim and never an error.
const listing = (version: string | undefined) => JSON.stringify([{ id: "agent-hub@agent-hub", scope: "user", ...(version ? { version } : {}) }, { id: "other@market", scope: "user", version: "9.9.9" }]);
const advice = (probe: Parameters<typeof globalUpdateAdvice>[0]["probe"], over: Partial<Parameters<typeof globalUpdateAdvice>[0]> = {}) => globalUpdateAdvice({ target: "0.31.0", cli: "0.31.0", handedOver: false, packageRoot: PACKAGE_ROOT, probe, ...over });

test("the advice reads the plugin version from the probe's list and names setup when it is older than the daemon", () => {
  const old = advice(() => ({ status: 0, stdout: listing("0.30.0") }));
  expect(old.join(" ")).toContain("The installed plugin is older than the daemon this upgrade installs (0.31.0): run `ahub setup` yourself.");
  expect(old.join(" ")).not.toContain("bun add");
  expect(advice(() => ({ status: 0, stdout: listing("0.31.0") }))).toEqual([]);
  expect(advice(() => ({ status: 0, stdout: listing("0.32.0") }))).toEqual([]);
  expect(advice(() => ({ status: 0, stdout: listing("0.30.0") }), { cli: "0.30.0" }).join(" ")).toContain("bun add -g @staix/agent-hub@0.31.0");   // an older CLI too: the install command comes first
});

test("a missing claude, a probe that throws or times out, a failing exit, garbage output and a list without the plugin all read as no advice", () => {
  expect(advice(() => { throw new Error("spawn claude ENOENT"); })).toEqual([]);
  expect(advice(() => ({ status: null, stdout: "" }))).toEqual([]);                    // a timeout leaves no status
  expect(advice(() => ({ status: 1, stdout: listing("0.30.0") }))).toEqual([]);        // a failing probe's output is not trusted
  expect(advice(() => ({ status: 0, stdout: "not json" }))).toEqual([]);
  expect(advice(() => ({ status: 0, stdout: undefined }))).toEqual([]);
  expect(advice(() => ({ status: 0, stdout: "[]" }))).toEqual([]);                     // not installed: nothing to compare
  expect(advice(() => ({ status: 0, stdout: listing(undefined) }))).toEqual([]);       // an installed plugin with no version
});

test("a handed-over upgrade speaks for the CLI that started it even when the plugin cannot be read", () => {
  const lines = advice(() => { throw new Error("no claude"); }, { handedOver: true }).join(" ");
  expect(lines).toContain("The CLI that started this upgrade is older");
  expect(lines).toContain("bun add -g @staix/agent-hub@0.31.0");
});
