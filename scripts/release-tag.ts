#!/usr/bin/env bun
// #787 P3b: the one guarded tag run for a release. It repeats the whole preflight, reads the person's release consent through
// `ahub sdlc release-guard` (read only, the same ledger `ahub sdlc authorize-release` fills, person only), and pushes the tag only with
// --execute and only when that consent matches this exact commit and version. Without --execute it changes nothing.
//
//   bun scripts/release-tag.ts <version>              preflight and consent check, no push
//   bun scripts/release-tag.ts <version> --execute    the single guarded tag push, after the preflight is repeated
//
// This script never grants consent and never bypasses the pre-push hook (`ahub init --release-guard`) or `--no-verify`.
import { resolve } from "node:path";
import { realRun, releaseTag } from "./lib/release-plan.ts";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2), version = args.find(arg => !arg.startsWith("--"));
const unknown = args.filter(arg => arg.startsWith("--") && arg !== "--execute");
if (!version || unknown.length || args.filter(arg => !arg.startsWith("--")).length !== 1) { console.error("usage: bun scripts/release-tag.ts <version> [--execute]"); process.exit(1); }

const ahub = process.env.AHUB_CLI ?? resolve(root, "src/cli/main.ts");
const guard = (argv: string[]) => realRun([process.execPath, ahub, "sdlc", "release-guard", "--", ...argv], { cwd: root });
const result = releaseTag(root, version, { execute: args.includes("--execute") }, { run: realRun, guard });

if (result.status === "refused") { for (const line of result.refusals) console.error(`release-tag: refused: ${line}`); process.exit(1); }
if (result.status === "dry-run") {
  console.log(`release-tag: preflight passed for v${version} at ${result.commit}`);
  console.log(result.consent ? "release-tag: the person's consent matches; rerun with --execute to push the tag" : `release-tag: no person consent yet; ask the person to run \`ahub sdlc authorize-release ${version}\` from this checkout, then rerun with --execute`);
  process.exit(result.consent ? 0 : 2);
}
console.log(`release-tag: pushed ${result.tag} at ${result.commit}`);
