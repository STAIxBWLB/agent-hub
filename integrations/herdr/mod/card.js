// The status card's projection (#1199 H2). Pure: no host call, no timer, no import. It copies a closed allowlist of ids, counts and closed words out of the parsed `ahub status --json` object and
// never keeps, returns or logs any text from it. Every free-text field (a peer's `doing`, a task title, a notice, a path, a note) is never read, so a private-task stub stays a stub.
// The mod runtime has its own exec caps (30 s, 8 MiB); this file adds a smaller bound of its own for a card.

export const CARD_STATES = Object.freeze(["running", "partial", "stale", "offline", "unavailable_version", "unknown", "cannot_start", "timeout", "too_large", "failed", "bad_output"]);
/** A reading older than this, measured from the entry's own fetch time, is stale. Nothing refreshes it: the card only says it is old. */
export const STALE_AFTER_MS = 60_000;
export const CARD_MAX_BYTES = 512 * 1024;
/** The hub's own peer states, plus `unknown` for a value this projection does not know. An unknown value is shown as `unknown`, never copied. */
export const PEER_STATES = Object.freeze(["idle", "busy", "paused", "offline", "unknown"]);
const MAX_PEERS = 64, MAX_TASK_STATES = 32;
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const TASK_STATE = /^[a-z_]{1,32}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const count = n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 1e9;
const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

/** Fixed sentences: counts and closed words only. They name the next step and never carry output from ahub. */
export const CARD_SENTENCES = Object.freeze({
  offline: "No agent-hub is running for this project. Start it yourself with `ahub up` in a terminal there; this entry does not start anything.",
  unavailable_version: "This project's agent-hub is too old to report what this card shows. Upgrade it yourself with `ahub upgrade`; this entry does not.",
  unknown: "The reading has no time, so its age is unknown.",
  cannot_start: "Could not run ahub there. It may not be installed on that machine, or the folder may be gone. Nothing was changed.",
  timeout: "ahub did not answer in time. Nothing was left running by this entry.",
  too_large: "ahub printed more than a card reads, so its answer was not used.",
  failed: "ahub exited with an error. Nothing was changed. Run `ahub status` in a terminal in the project to see why.",
  bad_output: "ahub answered in a shape this card does not recognize. Update ahub or this entry.",
  machine_unavailable: "That machine is not ready (still loading or offline), so nothing was run.",
  changed: "The project this card was read for is not the selected one any more. Refresh.",
});

/**
 * Classify one `ahub status --json` run from facts and never from its words.
 * - the host rejected the call: if it took about as long as the documented 30 s limit it was a timeout, otherwise it could not start (a missing program, a missing folder; the host does not say which);
 * - exit 127 is a shell's "not found" and is treated the same as a call that could not start;
 * - exit 1 with ahub's own "no hub running" prefix (a boolean computed by the caller, then dropped) is offline;
 * - any other failure is `failed`, and none of its output is kept.
 */
export function classifyRun({ rejected, elapsedMs, timeoutMs, result, stderrSaysNoHub }) {
  if (rejected === true) return { kind: Number.isFinite(elapsedMs) && Number.isFinite(timeoutMs) && elapsedMs >= timeoutMs - 1000 ? "timeout" : "cannot_start" };
  if (!isObject(result) || !Number.isSafeInteger(result.code)) return { kind: "failed" };
  if (typeof result.stdout === "string" && result.stdout.length > CARD_MAX_BYTES) return { kind: "too_large" };
  if (result.code === 127) return { kind: "cannot_start" };
  if (result.code === 0) return { kind: "ok" };
  return stderrSaysNoHub === true ? { kind: "offline" } : { kind: "failed" };
}

/**
 * The public projection of a parsed status object, or `bad_output`. `projectId` must be a string: the caller compares it with the selected id. A field that is absent or of the wrong type is
 * reported as missing, so the state is `partial` and the card names what it lacks instead of showing a zero. A hub that answers with none of the three is an older hub.
 */
export function projectStatus(raw, fetchedAt, now) {
  if (!isObject(raw) || typeof raw.projectId !== "string") return { ok: false, state: "bad_output" };
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
      rows.push({ id, state, queued: count(row.queued) ? row.queued : null, pullOnly: row.pullOnly === true });
    }
    if (ok) peers = rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  if (peers === null) missing.push("peers");
  const age = Number.isFinite(now) && Number.isFinite(fetchedAt) ? now - fetchedAt : null;
  let state;
  if (version === null && tasks === null && peers === null) state = "unavailable_version";
  else if (missing.length) state = "partial";
  else if (age === null) state = "unknown";
  else state = age > STALE_AFTER_MS ? "stale" : "running";
  return { ok: true, state, projectId: raw.projectId, version, tasks, peers, missing, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null, ageMs: age };
}

/** Re-judge an existing reading against a later clock, so the card can call an old one stale without asking the hub again. */
export function ageCard(card, now) {
  if (!card || card.ok !== true || !Number.isFinite(card.fetchedAt) || !Number.isFinite(now)) return card && card.ok === true ? { ...card, state: "unknown", ageMs: null } : card;
  const age = now - card.fetchedAt;
  return { ...card, state: card.state === "running" && age > STALE_AFTER_MS ? "stale" : card.state, ageMs: age };
}

/**
 * The lines the card shows, as plain text: a pure function of the card this file projected, so a test can check exactly what a person reads. Only ids, counts, versions and closed words go in.
 * A peer's queue is `queue N` when the hub reported a count (including `queue 0`) and `queue ?` when it did not, so a peer with nothing waiting is never confused with one whose queue is unknown.
 * `sentence(state)` supplies the fixed sentence for a card that is not a reading.
 */
export function formatCard(card, sentence) {
  if (!card) return ["Status: not read. Click Status."];
  if (card.ok !== true) return [`Status (${card.state}): ${sentence(card.state)}`];
  const tasks = Object.entries(card.tasks ?? {}).map(([state, n]) => `${state} ${n}`).join(", ") || "no task counts";
  const peers = (card.peers ?? []).map(p => `${p.id} ${p.state}, queue ${p.queued === null || p.queued === undefined ? "?" : p.queued}${p.pullOnly ? ", pull-only" : ""}`);
  const lines = [`Status (${card.state}): hub ${card.version ?? "version unknown"}; tasks: ${tasks}`];
  lines.push(peers.length ? `Peers: ${peers.join("; ")}` : "Peers: none reported");
  if (card.missing && card.missing.length) lines.push(`Missing from the reading: ${card.missing.join(", ")}`);
  return lines;
}
