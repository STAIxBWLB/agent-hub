import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { globalCliUpdateStep, stableBunRuntime, stablePackageRoot } from "../src/cli/install-paths.ts";
import { realPath } from "../src/hub/project.ts";
import { handoffConnectFailure } from "../src/hub/handoff.ts";
import { planScreen, type ScreenIO, type UpgradeHost } from "../src/cli/upgrade-interactive.ts";
import { planFingerprint, type UpgradePlan } from "../src/cli/upgrade.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-install-paths-1245-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = (name: string) => { const target = join(root, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "fixture executable\n", { mode: 0o755 }); return target; };
  const link = (target: string, name: string) => { const entry = join(root, name); mkdirSync(dirname(entry), { recursive: true }); symlinkSync(target, entry); return entry; };
  return { root, file, link };
}
function versionedInstall() {
  const f = fixture(), a = join(f.root, "tools/ahub/A/lib/node_modules/@staix/agent-hub"), b = join(f.root, "tools/ahub/B/lib/node_modules/@staix/agent-hub");
  f.file(relative(f.root, join(a, "src/cli/main.js"))); f.file(relative(f.root, join(b, "src/cli/main.js")));
  const current = f.link("A", "tools/ahub/current"), alias = join(current, "lib/node_modules/@staix/agent-hub");
  const entry = f.link(relative(join(f.root, "bin"), join(alias, "src/cli/main.js")), "bin/ahub");
  return { ...f, a, b, current, alias, entry };
}

test("PATH ahub keeps a lexical current alias across version A and B instead of pinning its real directory", () => {
  const f = versionedInstall(), previous = process.env.PATH;
  try {
    process.env.PATH = join(f.root, "bin");
    expect(stablePackageRoot(realPath(f.a))).toBe(f.alias);
    unlinkSync(f.current); symlinkSync("B", f.current);
    expect(stablePackageRoot(realPath(f.b))).toBe(f.alias);
    // A different installation on PATH cannot supply this process's marketplace/script path.
    expect(stablePackageRoot(realPath(f.a))).toBe(realPath(f.a));
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test("unknown, missing, cyclic and non-CLI invocation paths fall back without adopting another copy", () => {
  const f = versionedInstall(), root = realPath(f.a);
  const missing = f.link("absent-main", "bin/missing");
  const cycle = f.link("cycle-b", "bin/cycle-a"); f.link("cycle-a", "bin/cycle-b");
  const wrongShape = f.file("tools/ahub/A/lib/node_modules/@staix/agent-hub/not-main.js");
  for (const invocation of [join(f.root, "absent"), missing, cycle, wrongShape]) expect(stablePackageRoot(root, { invocation })).toBe(root);
  expect(stablePackageRoot(realPath(f.b), { invocation: f.entry })).toBe(realPath(f.b));
});

test("lexical invocation follows at most eight leaf symlinks while preserving parent aliases", () => {
  const f = versionedInstall(), root = realPath(f.a);
  const chain = (length: number) => {
    for (let i = length - 1; i >= 0; i--) {
      const target = i === length - 1 ? relative(join(f.root, "bin"), join(f.alias, "src/cli/main.js")) : `chain-${length}-${i + 1}`;
      f.link(target, `bin/chain-${length}-${i}`);
    }
    return join(f.root, `bin/chain-${length}-0`);
  };
  expect(stablePackageRoot(root, { invocation: chain(8) })).toBe(f.alias);
  expect(stablePackageRoot(root, { invocation: chain(9) })).toBe(root);
});

test("the PATH-stable Bun spelling is kept only when it resolves to the running runtime", () => {
  const f = fixture(), runtime = f.file("Cellar/bun/A/bin/bun"), other = f.file("Cellar/bun/B/bin/bun");
  const stable = f.link("../Cellar/bun/A/bin/bun", "bin/bun");
  expect(stableBunRuntime({ runtime, pathRuntime: stable })).toBe(stable);
  unlinkSync(stable); symlinkSync("../Cellar/bun/B/bin/bun", stable);
  expect(stableBunRuntime({ runtime, pathRuntime: stable })).toBe(runtime);
  expect(stableBunRuntime({ runtime, pathRuntime: other })).toBe(runtime);
  expect(stableBunRuntime({ runtime, pathRuntime: join(f.root, "missing") })).toBe(runtime);
  const cycle = f.link("bun-cycle-b", "bin/bun-cycle-a"); f.link("bun-cycle-a", "bin/bun-cycle-b");
  expect(stableBunRuntime({ runtime, pathRuntime: cycle })).toBe(runtime);
});

test("update advice resolves PATH ahub, proving the Bun-global boundary independently of this process", () => {
  const f = fixture(), home = join(f.root, "home"), prefix = join(f.root, "bun-prefix"), global = join(prefix, "install/global/node_modules");
  const installed = join(global, "@staix/agent-hub"), outside = join(global + "-sibling", "@staix/agent-hub");
  const fallback = join(home, ".bun/install/global/node_modules/@staix/agent-hub");
  const pathFor = (root: string, name: string) => {
    f.file(relative(f.root, join(root, "src/cli/main.js")));
    const bin = join(f.root, name);
    f.link(relative(bin, join(root, "src/cli/main.js")), `${name}/ahub`);
    return bin;
  };
  const options = { env: { BUN_INSTALL: prefix, PATH: pathFor(installed, "bun-bin") }, home };
  expect(globalCliUpdateStep("0.33.1", options)).toBe("run `bun add -g @staix/agent-hub@0.33.1`");
  expect(globalCliUpdateStep(undefined, options)).toBe("run `bun add -g @staix/agent-hub`");
  expect(globalCliUpdateStep("0.33.1", { ...options, globalFlag: "--global" })).toBe("run `bun add --global @staix/agent-hub@0.33.1`");
  const fallbackPath = pathFor(fallback, "fallback-bin");
  expect(globalCliUpdateStep("0.33.1", { env: { PATH: fallbackPath }, home })).toBe("run `bun add -g @staix/agent-hub@0.33.1`");
  const siblingAdvice = globalCliUpdateStep("0.33.1", { ...options, env: { ...options.env, PATH: pathFor(outside, "sibling-bin") } });
  expect(siblingAdvice).toContain("the way it was installed"); expect(siblingAdvice).toContain(outside); expect(siblingAdvice).not.toContain("bun add");
  const barePrefix = globalCliUpdateStep("0.33.1", { ...options, env: { ...options.env, PATH: pathFor(global, "bare-prefix-bin") } });
  expect(barePrefix).toContain("the way it was installed"); expect(barePrefix).toContain(global); expect(barePrefix).not.toContain("bun add");
  const otherPrefix = globalCliUpdateStep("0.33.1", { ...options, env: { ...options.env, PATH: fallbackPath } });
  expect(otherPrefix).toContain(fallback); expect(otherPrefix).not.toContain("bun add");
  const missingPrefix = globalCliUpdateStep("0.33.1", { ...options, env: { ...options.env, BUN_INSTALL: join(f.root, "not-installed") } });
  expect(missingPrefix).toContain(installed); expect(missingPrefix).not.toContain("bun add");
});

test("unknown PATH CLI never claims this process's staged or bun-x package as the global install", () => {
  const f = fixture(), generic = "update the global CLI to 0.33.1 the way it was installed";
  const missing = join(f.root, "empty-bin"); mkdirSync(missing);
  expect(globalCliUpdateStep("0.33.1", { env: { PATH: missing } })).toBe(generic);
  expect(globalCliUpdateStep("0.33.1", { env: { PATH: "" } })).toBe(generic);
  f.file("not-a-package/ahub");
  expect(globalCliUpdateStep("0.33.1", { env: { PATH: join(f.root, "not-a-package") } })).toBe(generic);
});

test("a dotfiles-style PATH alias is named even while this module runs from another package", () => {
  const f = versionedInstall();
  const advice = globalCliUpdateStep("0.33.1", { env: { PATH: dirname(f.entry), BUN_INSTALL: join(f.root, "bun") } });
  expect(advice).toContain(f.alias); expect(advice).not.toContain("bun add");
  expect(advice).not.toContain(resolve(import.meta.dir, ".."));
});

test("handoff wire-skew guidance stays generic and names doctor without claiming an installation", () => {
  const f = fixture(), previous = process.env.BUN_INSTALL;
  try {
    process.env.BUN_INSTALL = join(f.root, "bun"); mkdirSync(join(process.env.BUN_INSTALL, "install/global/node_modules"), { recursive: true });
    const result = handoffConnectFailure({ code: 4426 }, { id: "target", root: join(f.root, "project") });
    expect(result.code).toBe("older_target"); expect(result.cause).toBe("wire version differs");
    expect(result.message).toContain("the way it was installed");
    expect(result.message).not.toContain(resolve(import.meta.dir, "..")); expect(result.message).not.toContain("bun add");
    expect(result.message).not.toContain("running from"); expect(result.message).toContain("`ahub doctor` names the exact step");
    expect(result.message).toContain("then hand the task off again");
  } finally { if (previous === undefined) delete process.env.BUN_INSTALL; else process.env.BUN_INSTALL = previous; }
});

test("the interactive no-hub upgrade screen names this outside install without executing an update", async () => {
  const f = versionedInstall(), previous = process.env.BUN_INSTALL, previousPath = process.env.PATH, root = resolve(import.meta.dir, "..");
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: "0.33.1", integrity: "sha512-fixture", sourceRoot: root, sourceDigest: "d".repeat(64), blockers: ["no running registered projects in scope"], projects: [] };
  const plan = { ...body, fingerprint: planFingerprint(body) }, lines: string[] = [];
  const unexpected = (): never => { throw new Error("no-hub advice must not perform lifecycle work"); };
  const host: UpgradeHost = { version: "0.33.0", entry: join(root, "src/cli/main.js"), plan: async () => plan, lock: () => undefined,
    apply: async () => unexpected(), endPeer: async () => unexpected(), read: unexpected, runner: () => undefined, live: async () => ({}), runnerStoppable: () => false, stopRunner: async () => unexpected() };
  const io: ScreenIO = { ask: async () => "q", out: line => lines.push(line), run: async () => unexpected(), sleep: async () => unexpected(), interrupted: () => false, typed: () => false };
  try {
    process.env.BUN_INSTALL = join(f.root, "bun"); mkdirSync(join(process.env.BUN_INSTALL, "install/global/node_modules"), { recursive: true });
    process.env.PATH = dirname(f.entry);
    await planScreen(host, io);
    const output = lines.join("\n");
    expect(output).toContain("no hub is running"); expect(output).toContain("the way it was installed");
    expect(output).toContain(f.alias); expect(output).not.toContain(`running from ${root}`); expect(output).not.toContain("bun add"); expect(output).toContain("ahub setup");
  } finally {
    if (previous === undefined) delete process.env.BUN_INSTALL; else process.env.BUN_INSTALL = previous;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
});
