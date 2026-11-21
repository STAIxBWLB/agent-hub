import packageJson from "../../package.json";

/**
 * #1611: the first-party memory core is declared as `>=X.Y.Z <M.0.0` (X.Y.Z at or above 0.33.0, M the next major), so a new minor
 * reaches users without a hub release; the host API range below, not the version number, decides whether it is compatible.
 * Legacy `~X.Y.Z` (#1605) declarations still verify in an older recovery package.
 */
export const AGENT_MEM_RANGE: string = packageJson.dependencies["@staix/agent-mem"];
/** The agent-mem host API versions this hub supports, inclusive: [min, max]. A new major host API is a reviewed hub change. */
export const AGENT_MEM_HOST_API_RANGE: readonly [number, number] = [1, 1];
/**
 * #1611: the declared form `>=X.Y.Z <M.0.0` with X.Y.Z at or above 0.33.0 and M the next major.
 * ponytail: a copy of scripts/lib/agent-mem-range.mjs, because a preserved source holds no scripts/ directory (the import failed in recovery); test/npm-pin.test.ts pins both to the same answers. Upgrade path: one shared file under src/ that the scripts import.
 */
export function isAgentMemFloorRange(value: unknown): boolean {
  const match = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.0\.0$/.exec(typeof value === "string" ? value : "");
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return Number(match[4]) === major + 1 && (major > 0 || minor >= 33);
}

/** The host API constants a staged package's src/memory/platform.ts exports, as numbers (undefined when absent). */
export function readHostApiConstants(source: string): { min: number | undefined; version: number | undefined } {
  const read = (name: string): number | undefined => { const text = new RegExp(`export const ${name} = (\\d+)`).exec(source)?.[1]; return text === undefined ? undefined : Number(text); };
  return { min: read("HOST_API_MIN"), version: read("HOST_API_VERSION") };
}
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
  const [lowest, highest] = supported;
  return positive(min) && positive(version) && min <= version && min <= highest && version >= lowest;
}
