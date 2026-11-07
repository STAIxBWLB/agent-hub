import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMPAT, isCompatId } from "../src/adapters/compat.ts";

type Category = "linux-ci" | "macos-runner" | "account-or-model" | "tui-desktop";
interface Evidence { path: string; section: string; quote: string }
interface Leg {
  id: string;
  category: Category;
  runnerOS: string[];
  requiredForAdmission: boolean;
  evidence: Evidence;
  automation?: string;
  onChangedSource?: string;
}
interface Entry {
  receipt: string;
  runnerOS: string[];
  autoAdmit: boolean;
  autoAdmitReason: string;
  install: {
    method: "npm-exact" | "github-release-asset-checksum" | "unavailable";
    package?: string;
    versionPolicy?: string;
    integrityPolicy?: string;
    repository?: string;
    tagTemplate?: string;
    asset?: string;
    checksumAsset?: string;
    receiptEvidence?: Evidence;
    reason?: string;
  };
  legs: Leg[];
  unverifiedFollowups: Leg[];
}
const ROOT = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../scripts/compat-receipts/manifest.json"), "utf8")) as {
  schemaVersion: number;
  entries: Record<string, Entry>;
};
const documents = new Map<string, string>();
function readDocument(file: string): string {
  expect(file.startsWith("docs/") && !file.split("/").includes(".."), file).toBe(true);
  let text = documents.get(file);
  if (text === undefined) { text = readFileSync(join(ROOT, file), "utf8"); documents.set(file, text); }
  return text;
}
function assertEvidence(evidence: Evidence): void {
  const lines = readDocument(evidence.path).split("\n"), start = lines.indexOf(evidence.section);
  expect(start, `${evidence.path}: ${evidence.section}`).toBeGreaterThanOrEqual(0);
  const heading = /^(#{1,6}) /.exec(evidence.section);
  expect(heading).not.toBeNull();
  const depth = heading![1]!.length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const next = /^(#{1,6}) /.exec(lines[index]!);
    if (next && next[1]!.length <= depth) { end = index; break; }
  }
  expect(evidence.quote.length).toBeGreaterThan(0);
  expect(lines.slice(start, end).join("\n"), `${evidence.path}: ${evidence.section}`).toContain(evidence.quote);
}

test("receipt manifest includes every COMPAT id", () => {
  expect(manifest.schemaVersion).toBe(1);
  for (const id of Object.keys(COMPAT)) expect(Object.hasOwn(manifest.entries, id), `missing manifest id: ${id}`).toBe(true);
});

test("receipt manifest never names an unknown COMPAT id", () => {
  for (const id of Object.keys(manifest.entries)) expect(isCompatId(id), `unknown manifest id: ${id}`).toBe(true);
});

test("every classified leg quotes its actual receipt section", () => {
  const categories = new Set<Category>(["linux-ci", "macos-runner", "account-or-model", "tui-desktop"]);
  const runnerOS = new Set(["linux", "macos", "unspecified"]);
  for (const [id, entry] of Object.entries(manifest.entries)) {
    expect(readDocument(entry.receipt).length, id).toBeGreaterThan(0);
    expect(entry.legs.length, id).toBeGreaterThan(0);
    expect(entry.runnerOS.length, id).toBeGreaterThan(0);
    const legs = [...entry.legs, ...entry.unverifiedFollowups];
    expect(new Set(legs.map(leg => leg.id)).size, id).toBe(legs.length);
    for (const leg of legs) {
      expect(categories.has(leg.category), `${id}/${leg.id}`).toBe(true);
      expect(typeof leg.requiredForAdmission).toBe("boolean");
      expect(leg.runnerOS.length).toBeGreaterThan(0);
      for (const os of leg.runnerOS) expect(runnerOS.has(os), `${id}/${leg.id}: ${os}`).toBe(true);
      assertEvidence(leg.evidence);
    }
    for (const leg of entry.unverifiedFollowups) expect(leg.requiredForAdmission, `${id}/${leg.id}`).toBe(false);
    if (entry.install.receiptEvidence) assertEvidence(entry.install.receiptEvidence);
  }
});

test("Qwen's passing additional Linux evidence is recorded without replacing required Mac qualification", () => {
  const qwen = manifest.entries.qwen!;
  const additional = qwen.legs.find(leg => leg.id === "additional-linux");
  expect(additional).toBeDefined();
  expect(additional!.category).toBe("linux-ci");
  expect(additional!.requiredForAdmission).toBe(false);
  expect(qwen.unverifiedFollowups.some(leg => leg.id === "additional-linux")).toBe(false);
  expect(qwen.runnerOS).toEqual(["macos"]);
});

test("auto-admission cannot bypass model, TUI, unknown-platform or unavailable-install requirements", () => {
  expect(manifest.entries["codex-review"]!.autoAdmit).toBe(false);
  expect(manifest.entries.agy!.autoAdmit).toBe(false);
  for (const [id, entry] of Object.entries(manifest.entries)) {
    expect(typeof entry.autoAdmit).toBe("boolean");
    expect(entry.autoAdmitReason.length).toBeGreaterThan(0);
    const blocked = entry.install.method === "unavailable" || entry.legs.some(leg => leg.requiredForAdmission &&
      (leg.category === "account-or-model" || leg.category === "tui-desktop" || leg.runnerOS.includes("unspecified")));
    if (blocked) expect(entry.autoAdmit, id).toBe(false);
    if (entry.autoAdmit) for (const os of entry.runnerOS) {
      for (const leg of entry.legs.filter(leg => leg.requiredForAdmission)) {
        expect(leg.runnerOS.includes(os), `${id}/${leg.id}: complete receipt runner ${os}`).toBe(true);
      }
    }
    for (const leg of entry.legs) if (leg.automation) expect(leg.onChangedSource, `${id}/${leg.id}`).toContain("not-run");
  }
});

test("public install recipes bind exact npm versions or checksummed release assets", () => {
  for (const [id, { install }] of Object.entries(manifest.entries)) {
    if (install.method === "npm-exact") {
      expect(install.package, id).toBeTruthy();
      expect(install.versionPolicy, id).toContain("exact requested version");
      expect(install.integrityPolicy, id).toContain("dist.integrity");
    } else if (install.method === "github-release-asset-checksum") {
      expect(install.repository, id).toBeTruthy();
      expect(install.tagTemplate, id).toContain("{version}");
      expect(install.asset, id).toBeTruthy();
      expect(install.checksumAsset, id).toBeTruthy();
      expect(install.integrityPolicy, id).toContain("SHA-256");
    } else {
      expect(install.method, id).toBe("unavailable");
      expect(install.reason, id).toBeTruthy();
    }
  }
});
