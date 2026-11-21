import packageJson from "../../package.json";
import { isAgentMemFloorRange } from "../../scripts/lib/agent-mem-range.mjs";

/**
 * #1611: the first-party memory core is declared as `>=X.Y.Z <M.0.0` (X.Y.Z at or above 0.33.0, M the next major), so a new minor
 * reaches users without a hub release; the host API range below, not the version number, decides whether it is compatible.
 * Legacy `~X.Y.Z` (#1605) declarations still verify in an older recovery package.
 */
export const AGENT_MEM_RANGE: string = packageJson.dependencies["@staix/agent-mem"];
/** The agent-mem host API versions this hub supports, inclusive: [min, max]. A new major host API is a reviewed hub change. */
export const AGENT_MEM_HOST_API_RANGE: readonly [number, number] = [1, 1];
const PATCH_RANGE = /^~\d+\.\d+\.\d+$/;
const PLAIN_RELEASE = /^\d+\.\d+\.\d+$/;

/** Whether `version` is a plain release (no prerelease or build suffix) that satisfies the declared range (floor form, or legacy patch form). */
export function agentMemVersionInRange(version: unknown, range: string = AGENT_MEM_RANGE): boolean {
  if (typeof version !== "string" || !PLAIN_RELEASE.test(version)) return false;
  if (!PATCH_RANGE.test(range) && !isAgentMemFloorRange(range)) return false;
  return Bun.semver.satisfies(version, range);
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** Whether the package's host API constants are valid positive integers (MIN <= VERSION) and their range intersects the supported one. */
export function agentMemHostApiOk(min: unknown, version: unknown, supported: readonly [number, number] = AGENT_MEM_HOST_API_RANGE): boolean {
  return positive(min) && positive(version) && min <= version && min <= supported[1] && version >= supported[0];
}
