import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { realPath } from "../hub/project.ts";

export interface KimiReviewPolicyBinding {
  readonly lexicalCwd: string;
  readonly physicalCwd: string;
  readonly sourcePath: string;
  readonly source: string;
  readonly sourceConfig: string;
  readonly sourceConfigHash: string;
  readonly executable: string;
  readonly executableStat: Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }>;
  readonly privateFiles: readonly Readonly<{ path: string; hash: string }>[];
  readonly tool: string;
  readonly authTargets: readonly string[];
}
export const kimiReviewFingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");
export function readKimiReviewFile(file: string, limit = 262_144): string {
  const stat = lstatSync(file); if (!stat.isFile() || stat.size > limit) throw new Error("unsupported reviewer file");
  return readFileSync(file, "utf8");
}
/** Native discovery can walk above cwd; check lexical aliases as well as the physical temporary root. */
export function assertCleanCwdAncestors(...candidates: readonly string[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let ancestor = resolve(candidate);
    for (;;) {
      if (!seen.has(ancestor)) {
        seen.add(ancestor);
        for (const marker of [".git", ".kimi-code", "AGENTS.md"]) {
          if (lstatSync(join(ancestor, marker), { throwIfNoEntry: false }) !== undefined) {
            throw new Error("private cwd ancestor contains ambient configuration");
          }
        }
      }
      const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
  }
}
/** Closed projection: no input, config contents, environment or extra caller fields cross the worker boundary. */
export function projectKimiReviewPolicyBinding(binding: KimiReviewPolicyBinding): KimiReviewPolicyBinding {
  return Object.freeze({
    lexicalCwd: binding.lexicalCwd, physicalCwd: binding.physicalCwd,
    sourcePath: binding.sourcePath, source: binding.source,
    sourceConfig: binding.sourceConfig, sourceConfigHash: binding.sourceConfigHash,
    executable: binding.executable,
    executableStat: Object.freeze({ dev: binding.executableStat.dev, ino: binding.executableStat.ino,
      size: binding.executableStat.size, mtimeMs: binding.executableStat.mtimeMs, ctimeMs: binding.executableStat.ctimeMs }),
    privateFiles: Object.freeze(binding.privateFiles.map(file => Object.freeze({ path: file.path, hash: file.hash }))),
    tool: binding.tool, authTargets: Object.freeze(binding.authTargets.map(target => target)),
  });
}
/** The complete filesystem fence, shared by synchronous authority checks and the periodic worker. */
export function checkKimiReviewPolicy(binding: KimiReviewPolicyBinding): boolean {
  try {
    assertCleanCwdAncestors(binding.lexicalCwd, binding.physicalCwd);
    const now = lstatSync(binding.executable), expected = binding.executableStat;
    return realPath(binding.sourcePath) === binding.source
      && now.dev === expected.dev && now.ino === expected.ino && now.size === expected.size
      && now.mtimeMs === expected.mtimeMs && now.ctimeMs === expected.ctimeMs
      && kimiReviewFingerprint(readKimiReviewFile(binding.sourceConfig)) === binding.sourceConfigHash
      && binding.privateFiles.length === 3 && binding.privateFiles.every(file => kimiReviewFingerprint(readKimiReviewFile(file.path, 2_097_152)) === file.hash)
      && binding.authTargets.length === 3 && ["credentials", "oauth", "device_id"].every((name, index) =>
        realPath(join(binding.source, name)) === binding.authTargets[index] && realPath(join(binding.tool, name)) === binding.authTargets[index]);
  } catch { return false; }
}
