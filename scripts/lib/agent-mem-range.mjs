// #1605: the declared runtime dependency of the first-party memory core. A patch range (`~X.Y.Z`) lets a plain patch
// release reach users without a hub release; a new minor stays a reviewed raise, so `^`, `*`, `x`, compound ranges and
// prereleases are refused. Plain Node: scripts/check-package.mjs and scripts/agent-mem-latest.mjs run without Bun.
export function isAgentMemPatchRange(value) {
  return typeof value === 'string' && /^~\d+\.\d+\.\d+$/.test(value);
}

/** The newest plain release of `declared`'s minor at or above its floor, from a list of published versions; undefined when the range is malformed. */
export function newestInRangePatch(declared, published) {
  const match = /^~(\d+)\.(\d+)\.(\d+)$/.exec(typeof declared === 'string' ? declared : '');
  if (!match) return undefined;
  const sameMinor = new RegExp(`^${match[1]}\\.${match[2]}\\.(\\d+)$`), floor = Number(match[3]);
  let best;
  for (const version of published) {
    const patch = sameMinor.exec(version)?.[1];
    if (patch === undefined || Number(patch) < floor) continue;
    if (best === undefined || Number(patch) > Number(sameMinor.exec(best)[1])) best = version;
  }
  return best;
}
