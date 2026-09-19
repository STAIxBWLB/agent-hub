import pkg from "../package.json";

/** The one version. `scripts/build.mjs` stamps it into the plugin manifest and the bundle, and `--check` fails when they differ. */
export const VERSION: string = pkg.version;
