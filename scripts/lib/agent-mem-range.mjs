// #1605/#1611: the declared runtime dependency of the first-party memory core. A floor range (`>=X.Y.Z <M.0.0`) lets a plain release
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

/** #1611: the declared form `>=X.Y.Z <M.0.0` with X.Y.Z at or above 0.33.0 and M the next major; every other shape is refused. */
export function isAgentMemFloorRange(value) {
  const match = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.0\.0$/.exec(typeof value === 'string' ? value : '');
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return Number(match[4]) === major + 1 && (major > 0 || minor >= 33);
}

const triple = (version) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The newest plain release a declared range accepts (floor form or legacy `~`), from a list of published versions; undefined when none or the range is malformed. */
export function newestInRange(declared, published) {
  if (isAgentMemFloorRange(declared)) {
    const [floor, ceiling] = [triple(/^>=(\S+)/.exec(declared)[1]), triple(/<(\S+)$/.exec(declared)[1])];
    let best;
    for (const version of published) {
      const parts = triple(version);
      if (parts && compare(parts, floor) >= 0 && compare(parts, ceiling) < 0 && (best === undefined || compare(parts, triple(best)) > 0)) best = version;
    }
    return best;
  }
  return newestInRangePatch(declared, published);
}
