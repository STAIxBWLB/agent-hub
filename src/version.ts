import pkg from "../package.json";

/** The one version. `scripts/build.mjs` stamps it into the plugin manifest and the bundle, and `--check` fails when they differ. */
export const VERSION: string = pkg.version;

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
/** A version another process reported, kept only when it is a plain semver of at most 64 characters; anything else is unknown, never shown. Display only (#1385). */
export const displayVersion = (value: unknown): string | undefined => typeof value === "string" && value.length <= 64 && SEMVER.exec(value)?.[0] === value ? value : undefined;
