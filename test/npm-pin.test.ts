import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { packEntry } from "../scripts/lib/npm-pack-shape.mjs";

// #1257: CI parses `npm pack --json` (scripts/check-package.mjs) on an npm pinned in check.yml, the version release.yml publishes with.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("#1257 check.yml keeps exactly the permissions scripts/ci-gates.mjs needs, and the env block is its own top-level key", () => {
  const check = Bun.YAML.parse(read(".github/workflows/check.yml")) as { permissions?: Record<string, string>; env?: Record<string, string> };
  expect(check.permissions).toEqual({ contents: "read", actions: "read" });
  expect(Object.keys(check.env ?? {})).toEqual(["NPM_VERSION"]);
});

test("#1257 check.yml and release.yml pin the same npm, and every gate shard installs it before the gate", () => {
  const check = Bun.YAML.parse(read(".github/workflows/check.yml")) as { env?: Record<string, string>; jobs: Record<string, { steps: { name?: string; run?: string }[] }> };
  const pinned = check.env?.NPM_VERSION;
  expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  expect(read(".github/workflows/release.yml")).toContain(`npm install -g npm@${pinned}`);
  for (const job of ["ubuntu-shard", "macos-shard"]) {
    const steps = check.jobs[job]!.steps;
    const install = steps.findIndex((step) => step.run?.includes('npm install -g "npm@$NPM_VERSION"'));
    const gate = steps.findIndex((step) => step.run?.trim() === "scripts/check.sh");
    expect(install, job).toBeGreaterThanOrEqual(0);
    expect(install, job).toBeLessThan(gate);
  }
});

const entry = { name: "@staix/agent-hub", version: "1.2.3", files: [{ path: "package.json" }] };

test("#1257 packEntry reads npm's one-element array and refuses every other shape naming npm --version and the expected shape", () => {
  expect(packEntry(JSON.stringify([entry]), "11.20.0")).toEqual(entry);
  for (const stdout of ["", "not json", "null", "{}", JSON.stringify(entry), "[]", JSON.stringify([entry, entry]), "[null]", "[1]", JSON.stringify([{ ...entry, files: undefined }]), JSON.stringify([{ ...entry, files: ["package.json"] }]), JSON.stringify([{ ...entry, name: 3 }])]) {
    expect(() => packEntry(stdout, "12.2.2"), stdout).toThrow(/unexpected shape.*expected a JSON array of exactly one package entry.*npm 12\.2\.2.*`npm --version`/);
  }
});
