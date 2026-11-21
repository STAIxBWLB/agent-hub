import packageJson from "../../package.json";

/**
 * #1605: the first-party memory core is declared as a patch range (`~MAJOR.MINOR.PATCH`). A plain release inside it is
 * accepted without a hub change; a new minor stays a reviewed pin raise, so any other declared shape is refused.
 */
export const AGENT_MEM_RANGE: string = packageJson.dependencies["@staix/agent-mem"];
const PATCH_RANGE = /^~\d+\.\d+\.\d+$/;
const PLAIN_RELEASE = /^\d+\.\d+\.\d+$/;

/** Whether `version` is a plain release (no prerelease or build suffix) that satisfies the declared patch range. */
export function agentMemVersionInRange(version: unknown, range: string = AGENT_MEM_RANGE): boolean {
  return typeof version === "string" && PLAIN_RELEASE.test(version) && PATCH_RANGE.test(range) && Bun.semver.satisfies(version, range);
}
