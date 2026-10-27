#!/usr/bin/env bun
// #787 P3b: release preparation as an agent task. The mechanical half of AGENTS.md "Releasing" steps 1 and 2: the version bump, the README
// Status line, the bundle, the CHANGELOG section and a verification report skeleton, on a release/<version> branch. It restamps nothing
// on its own, tags nothing, and never touches the person's release consent (`ahub sdlc authorize-release`, person only).
//
//   bun scripts/release-prepare.ts [--version X.Y.Z] [--dry-run]     bump and write the files (refuses on main, a dirty tree or a wrong version)
//   bun scripts/release-prepare.ts restamp <document>... --reviewed  set verifiedAgainst to HEAD for the named documents you read
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileReader, prepareRelease, realRun, restampDocuments } from "./lib/release-plan.ts";

// The checkout to release. Defaults to the repository these scripts live in; tests (and anyone releasing a sibling checkout) point it elsewhere.
const root = resolve(process.env.AHUB_RELEASE_ROOT ?? resolve(import.meta.dir, ".."));
const args = process.argv.slice(2);
const read = fileReader(root), write = (path: string, data: string) => writeFileSync(join(root, path), data);
const die = (lines: string[]): never => { for (const line of lines) console.error(`release-prepare: ${line}`); process.exit(1); };

if (args[0] === "restamp") {
  const names = args.slice(1).filter(arg => !arg.startsWith("--")), unknown = args.slice(1).filter(arg => arg.startsWith("--") && arg !== "--reviewed");
  if (unknown.length) die([`unknown option ${unknown.join(", ")}`]);
  const result = restampDocuments(root, names, { reviewed: args.includes("--reviewed"), run: realRun, read, write });
  if (!result.ok) die(result.refusals);
  else console.log(`release-prepare: restamped ${result.stamped.join(", ")} at ${result.head.slice(0, 12)}; commit docs/verified.json, then recheck with node scripts/check-docs.mjs --require-fresh`);
} else {
  const version = args.includes("--version") ? args[args.indexOf("--version") + 1] : undefined;
  const bad = args.filter((arg, i) => arg.startsWith("--") ? !["--version", "--dry-run"].includes(arg) : args[i - 1] !== "--version");
  if (bad.length || args.includes("--version") && (!version || version.startsWith("--"))) die(["usage: bun scripts/release-prepare.ts [--version X.Y.Z] [--dry-run] | restamp <document>... --reviewed"]);
  const result = prepareRelease(root, { version, dryRun: args.includes("--dry-run"), today: new Date().toISOString().slice(0, 10), write, read, run: realRun });
  if (!result.ok) die(result.refusals);
  else if (result.ok) {
    const { plan } = result;
    console.log(`release-prepare: ${plan.current} -> ${plan.version} (${plan.bump}; ${plan.subjects.length} commits since ${plan.lastTag}, PRs ${plan.prs.map(pr => `#${pr}`).join(" ") || "none named"})`);
    console.log(`release-prepare: native acceptance receipts since ${plan.lastTag}: ${plan.receipts.length ? plan.receipts.join(", ") : "none"}`);
    if (!result.wrote) console.log("release-prepare: dry run, nothing written");
    else {
      console.log(`release-prepare: wrote package.json, README.md, CHANGELOG.md, the bundle and docs/verification/*-${plan.version}.md`);
      console.log(`release-prepare: ${result.stale.length} stale document${result.stale.length === 1 ? "" : "s"} to review before restamping: ${result.stale.join(", ") || "none"}`);
      console.log("release-prepare: next, fill every TODO(agent) in the report, review and restamp, open the release PR, merge it with a MERGE COMMIT, then ask the person for `ahub sdlc authorize-release`");
    }
  }
}
