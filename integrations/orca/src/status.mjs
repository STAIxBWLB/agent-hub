// agent-hub companion for Orca: the read-only status projection (#1198 O2). Pure, with no host call and no child process: the worker runs `ahub status --json` through the same fixed-argv port
// as O1 and passes the output here. This file never keeps, returns or logs any text of that output. It copies out a closed allowlist of fields (ids, counts and closed states) and
// says, in a closed vocabulary, how much it could and could not read.
import { refuse } from "./companion.mjs";

/** The four honest outcomes besides a good reading. They stay distinct: offline is not unknown, and a partial reading is not a failure. */
export const STATUS_STATES = Object.freeze(["running", "partial", "stale", "offline", "unavailable_version", "unknown"]);
/** A reading older than this, measured from the panel's own fetch time, is stale. The panel never refreshes itself: it only says the reading is old. */
export const STALE_AFTER_MS = 60_000;
/** The hub's own peer states (`PeerState`, src/hub/envelope.ts), plus `unknown` for a value this projection does not know. A state outside this list is shown as `unknown`, never copied. */
export const PEER_STATES = Object.freeze(["idle", "busy", "paused", "offline", "unknown"]);
const MAX_PEERS = 64, MAX_TASK_STATES = 32;
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const TASK_STATE = /^[a-z_]{1,32}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]{1,32})?$/;

const count = n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 1e9;
const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Classify one `ahub status --json` run, from facts and never from its words. `stderrSaysNoHub` is a boolean computed by the caller from a fixed prefix test of stderr, which is then dropped.
 * - no hub for this project (ahub's own "no hub running" line, exit 1): offline, so the person can start it themselves;
 * - the executable was missing: reported by the caller as cli_missing, not here;
 * - any other failure: failed, and nothing of its output is kept.
 */
export function classifyStatusRun(result, stderrSaysNoHub) {
  if (!isObject(result)) return { kind: "failed" };
  if (result.timedOut === true) return { kind: "timeout" };
  if (result.truncated === true) return { kind: "too_large" };
  if (result.exitCode === 0) return { kind: "ok" };
  return stderrSaysNoHub === true ? { kind: "offline" } : { kind: "failed" };
}

/**
 * The public projection, or a refusal. `raw` is the parsed `status` object. Only the fields named here are read, each checked for its type and bound; anything else in it, including every
 * free-text field (a peer's `doing`, a notice, a title, a path), is never looked at. A field that is absent or of the wrong type is reported as missing, so the state is `partial`: the
 * panel shows what it has and names what it lacks, rather than inventing a zero.
 */
export function projectStatus(raw, fetchedAt, now) {
  if (!isObject(raw)) return refuse("unrecognized_output");
  const missing = [];
  const version = typeof raw.version === "string" && VERSION.test(raw.version) ? raw.version : (missing.push("version"), null);
  let tasks = null;
  if (isObject(raw.tasks)) {
    const entries = Object.entries(raw.tasks);
    if (entries.length <= MAX_TASK_STATES && entries.every(([state, n]) => TASK_STATE.test(state) && count(n))) tasks = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }
  if (tasks === null) missing.push("tasks");
  let peers = null;
  if (isObject(raw.peers)) {
    const rows = [];
    let ok = Object.keys(raw.peers).length <= MAX_PEERS;
    for (const [id, row] of ok ? Object.entries(raw.peers) : []) {
      if (!ID.test(id) || !isObject(row)) { ok = false; break; }
      const state = typeof row.state === "string" && PEER_STATES.includes(row.state) ? row.state : "unknown";
      rows.push({ id, state, queued: count(row.queued) ? row.queued : null, attached: row.attached === false ? false : true });
    }
    if (ok) peers = rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  if (peers === null) missing.push("peers");
  const age = Number.isFinite(now) && Number.isFinite(fetchedAt) ? now - fetchedAt : null;
  // A hub that answers but lacks the fields this projection needs is an older hub: say so, with the version when it gave one, rather than showing empty numbers as if they were zero.
  const old = version === null && tasks === null && peers === null;
  let state;
  if (old) state = "unavailable_version";
  else if (missing.length) state = "partial";
  else if (age === null) state = "unknown";
  else state = age > STALE_AFTER_MS ? "stale" : "running";
  return { ok: true, state, version, tasks, peers, missing, ageMs: age };
}

/** Re-judge an existing reading against a later clock, so the panel can call an old one stale without asking the hub again. */
export function ageReading(reading, now) {
  if (!reading || reading.ok !== true || !Number.isFinite(reading.fetchedAt)) return { ...reading, state: "unknown" };
  const age = now - reading.fetchedAt;
  const state = reading.state === "running" && age > STALE_AFTER_MS ? "stale" : reading.state;
  return { ...reading, state, ageMs: age };
}

/** Plain, fixed sentences for the states that are not a reading. Counts and closed words only. */
export const STATUS_SENTENCES = Object.freeze({
  offline: "No agent-hub is running for this project. Start it yourself with `ahub up` in a terminal; this panel does not start anything.",
  unavailable_version: "This project's agent-hub is too old to report what this panel shows. Upgrade it yourself with `ahub upgrade`; this panel does not.",
  unknown: "The reading has no time, so its age is unknown.",
  failed: "ahub did not answer the status request. Nothing was changed. Run `ahub status` in a terminal in the project to see why.",
  timeout: "ahub did not answer in time. Nothing was left running.",
  too_large: "ahub printed more than expected, so its answer was not used.",
});
