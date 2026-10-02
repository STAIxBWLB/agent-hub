#!/usr/bin/env python3
"""Coordination ledger for a native CooperBench run directory (issue #110). Standard library only.

Usage: python3 scripts/benchmarks/ledger.py --run RUN_DIR [--run RUN_DIR ...] [--plan NAME] [--json]

Reads runs/<NN>-<arm>.json written by native.ts, the Claude transcript each names, and the fixture's git history.
Writes ledger.json into the first run directory (with one, next to its records). ledger.json holds code fragments
from the agents' writes and local paths: it is private run data, never committed; the summary on stdout is not. Every measure names its unit and coverage in UNITS below; a measure the records
cannot support is null with a reason, never zero. Times are seconds from the first task proposal of the attempt.

Correctness is the official grader's: nothing here certifies a correct or loss-free result. The contribution measures
can only expose possible loss.
"""
from __future__ import annotations
import argparse, json, keyword, re, shlex, statistics, subprocess, sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner import TURN_FREE, active_window, hook_rows, isolation_failure, transcript, treatment_failure  # noqa: E402  the grader's gates: one definition

UNITS = {
    "end_reason": "the runner's class (completed, timeout, interrupted, infrastructure-error, ...); end_reason_detail "
                  "says which (wall-timeout, needs-review, claude-exited, ...). Completed and timed-out attempts are graded",
    "completed": "the runner completed the attempt and every task has a done",
    "setup_s": "seconds of setup before the first task (native launches, readiness and sandbox probes)",
    "elapsed_s": "the runner's active-work seconds for the attempt (teardown is not recorded)",
    "done_s": "per task: seconds to its last done",
    "both_done_s": "seconds to the last task's done; null unless every task has one",
    "intents_s": "per task: seconds to its first hub_task_done (done, done (checking) or integration requested)",
    "first_candidate_s": "seconds to the first applied write by any agent (a Codex patch item, a Claude Edit, Write or "
                         "MultiEdit with a successful tool result)",
    "integration": "integration requests and unresolved outcomes recorded on the board (turn-free cohorts)",
    "integrated_s": "seconds to an integration confirmed for a turn-free cohort; null without one",
    "check_s": "seconds to a configured check's result; null when no check ran (none are configured in the benchmark)",
    "settlement": "per agent, seconds to the end of its last native turn after the last done (turns that late "
                  "messages started included), read from its own record (Codex turn/completed, Claude's end_turn "
                  "responses); the last done itself when it did not work after it; null when it was still in a turn "
                  "when its record ended (a synthetic error response ends a turn). settlement_s is the later of the two, "
                  "null when either is unknown",
    "codex": "Codex on its own thread (a sub-agent's left out) from task assignment to its last done on the board (in "
             "task): turns (turn/started), "
             "assistant_messages (agentMessage items), usage_growth (token-usage updates whose running total grew past "
             "the total before the window: one per model call; compaction estimates, rate-limit refreshes and replays "
             "left out), usage_events (all updates), tokens (growth of the running total over the window), "
             "provider_requests (unique rawResponse ids when the stream carries them; app-server 0.159 does not send "
             "them, so null: unknown), hub_send, board_reads (hub_task_list)",
    "codex_attempt": "the same over the whole attempt, from task assignment to the end of the record. In-task windows "
                     "end at different points by arm (a turn-free integration step comes before the done, an advisory "
                     "completed-change notice turn after it), so arms are compared on this",
    "claude": "Claude from task assignment to its last done: assistant_messages (unique message ids: successful "
              "main-loop responses), turns (end_turn responses), tokens (input, cache creation, cache read and output "
              "tokens of those messages; null when no usage was recorded), provider_requests (unique request ids of "
              "those messages: main-loop requests only; side requests such as titles and retried calls are not in the "
              "transcript; null when none is recorded)",
    "claude_attempt": "the same over the whole attempt, from task assignment to the end of the transcript",
    "post_done_turns": "Codex turns started after its last done, with what their first injected message held; null when "
                       "Codex has no done",
    "late_replies": "Claude messages that reached Codex only after its done (by steer into a running turn, or at the "
                    "next turn start): seconds from sending to arrival. Held, dropped, overflowed and undeliverable "
                    "envelopes are left out; null when Codex has no done",
    "facts": "the hub's fact offers in the task window (from the first task proposal to the end of the active time) by "
             "path (hook, steer, done): offers, acknowledged, probes, coverage notices, files shown with attribution "
             "unknown, bytes offered (a re-offer and a refused steer count again) and bytes acknowledged (offers a "
             "readback or done confirmed), build time, the hook process's start-up time, steer round trip, refused "
             "and unanswered steers; ack_ms_median is offer-to-acknowledgement",
    "capability": "per peer, the hub's capability events (verified or lost) with their time, setup included",
    "validity": "whether the attempt is a valid run of its arm, by the grader's own gates: a turn-free attempt needs both "
                "context paths verified before its tasks and none lost, no cohort lifted and none formed open while the "
                "agents worked (teardown is after that); every arm needs isolation (no Codex hook, no Codex MCP server "
                "but the hub's, only the hub's facts hook in Claude's transcript). null with a reason when Claude's "
                "transcript cannot be read. Invalid and unknown attempts are left out of the summary's medians",
    "treatment": "turn-free only: whether the treatment was received, a silent cohort holding every task of the attempt "
                 "while the agents worked. Not a validity condition: whether the plans overlapped is the agents' doing "
                 "after assignment, so every attempt without a capability failure counts for the arm (a capability "
                 "failure is the one exclusion after assignment, which #110 AC3 requires); the summary also gives the "
                 "median over treated attempts",
    "quiet": "agent messages a silent cohort held back from a member (the hub's quiet events), in the task window",
    "fyi": "agent messages sent as [FYI] in the task window (recorded, nobody's turn), the final [FYI] the instructions "
           "ask for included",
    "stale": "notices dropped as stale at delivery (#106), in the task window",
    "stopped_s": "seconds from the end of the active time until every actor the attempt started was stopped: what a "
                 "timed-out attempt could still write before its tree was collected; teardown_s is to the patch",
    "split_predictions": "the hub's shadow split predictions (#109) with their traces; they never changed an assignment",
    "hooks": "hooks each agent ran as its own records show: Claude transcript hook rows by hook and command label (the "
             "hub's facts hook, or other: the program's name; never paths or arguments), with the durationMs they "
             "carry (Claude Code writes rows for hooks that printed something and for Stop hooks), Codex hook/started "
             "items, and the labels of hooks that are not the hub's (foreign); the hub's own timing of every facts "
             "hook call (calls, process start-up and hub time, from hook_stats); the attempt's configured conditions. "
             "Claude's part is null with a reason when its transcript cannot be read",
    "contributions": "identifiers (Python keywords left out) and changed fragments an agent's applied writes "
                     "introduced that the final tree lacks and that agent did not remove itself (a fragment counts as "
                     "present anywhere in the file; a moved file's contributions follow it to its new path); a "
                     "heuristic, with what it could not see listed in coverage",
    "summary": "per arm, over every run directory given (one repeat per directory; a repeat given twice is refused): "
               "attempts, completions with the reasons for the rest, attempts left out as invalid or unknown "
               "(excluded), and planned attempts that wrote no record (missing: from each directory's cohort.json, or "
               "with --plan from the manifest's plan, whole repeats included); medians over valid completed attempts, "
               "over the (case, repeat) pairs every arm completed validly (common) and, for turn-free, over treated "
               "attempts; totals over the attempts whose tasks were handed out and to which the measure applies, each "
               "with the number of those attempts where it was unknown (<name>_unknown; lost contributions are unknown "
               "when an agent's writes could not be counted), and the coverage notes of the contribution heuristic",
}
IDENT = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{3,}\b")
SHELL_READS = ("read", "listFiles", "search")


def at_ms(value):
    if isinstance(value, (int, float)): return float(value)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000


def median(xs):
    return round(statistics.median(xs), 1) if xs else None


def first(seq, pred, default=None):
    return next((x for x in seq if pred(x)), default)


def secs(t0, ms):
    return round((ms - t0) / 1000, 1) if ms is not None and t0 is not None else None


def item_of(m):
    return (m.get("params") or {}).get("item") or {}


def task_times(run):
    """t0 (the first proposal) and per task: owner, first intent, last done, integration and check times (ms)."""
    states = run.get("taskStates") or []
    proposals = [h["at"] for t in states for h in t.get("history", []) if h.get("event") == "proposed"]
    if not proposals: return None, []
    out = []
    for t in states:
        hist = t.get("history", [])
        intent = first(hist, lambda h: h.get("event") in ("done", "done (checking)", "integration requested"))
        dones = [h["at"] for h in hist if h.get("event") == "done"]
        integrated = [h["at"] for h in hist if h.get("event") == "integrated"]
        checks = [h["at"] for h in hist if h.get("event") in ("check passed", "check failed")]
        out.append({"id": t.get("id"), "owner": t.get("owner"), "intent": intent["at"] if intent else None, "done": max(dones) if dones else None,
                    "integrated": max(integrated) if integrated else None, "check": max(checks) if checks else None,
                    "requests": sum(1 for h in hist if h.get("event") == "integration requested"),
                    "unresolved": [h.get("note") for h in hist if h.get("event") == "integration unresolved"]})
    return min(proposals), out


# ---- Codex -------------------------------------------------------------------------------------------------------

def on_thread(run, m):
    """Whether a Codex message is about the benchmark's own thread (or about no thread at all)."""
    tid = (m.get("params") or {}).get("threadId")
    return not run.get("codexThreadId") or not tid or tid == run["codexThreadId"]


def codex_window(run, done_ms):
    """Codex's messages on its own thread from task assignment to its last done on the board (all of them when it has
    none)."""
    msgs = run.get("codexMessages") or []
    start = run.get("codexTaskStart") or 0
    out = []
    for m in msgs[start:]:
        if done_ms is not None and m.get("emittedAtMs") is not None and m["emittedAtMs"] > done_ms: break
        if on_thread(run, m): out.append(m)
    return out


def total_of(m):
    """The running token total a usage update carries, or None."""
    if m.get("method") != "thread/tokenUsage/updated": return None
    now = (((m.get("params") or {}).get("tokenUsage") or {}).get("total") or {}).get("totalTokens")
    return now if isinstance(now, (int, float)) else None


def codex_usage(run, done_ms, label):
    msgs = run.get("codexMessages") or []
    if not msgs: return None
    window = codex_window(run, done_ms)
    tools = [item_of(m).get("tool") for m in window if m.get("method") == "item/completed" and item_of(m).get("type") == "mcpToolCall"]
    # The running total before the window (the setup probe's): the window's first model call grows past it.
    base = max((t for t in map(total_of, [m for m in msgs[:run.get("codexTaskStart") or 0] if on_thread(run, m)]) if t is not None), default=0)
    total, growth, events, responses = base, 0, 0, set()
    for m in window:
        if m.get("method") == "rawResponse/completed":
            rid = (m.get("params") or {}).get("responseId")
            if rid: responses.add(rid)
        if m.get("method") == "thread/tokenUsage/updated": events += 1
        now = total_of(m)
        if now is not None and now > total: growth, total = growth + 1, now
    return {"turns": sum(1 for m in window if m.get("method") == "turn/started"),
            "assistant_messages": sum(1 for m in window if m.get("method") == "item/completed" and item_of(m).get("type") == "agentMessage"),
            "usage_growth": growth, "usage_events": events, "tokens": total - base, "provider_requests": len(responses) if responses else None,
            "hub_send": tools.count("hub_send"), "board_reads": tools.count("hub_task_list"), "window": label}


def turn_trigger(msgs, i):
    """What the first injected message of the Codex turn starting at index i held."""
    for m in msgs[i + 1:]:
        if m.get("method") == "turn/started": break
        it = item_of(m)
        if m.get("method") == "item/completed" and it.get("type") == "userMessage":
            text = json.dumps(it.get("content"))
            kinds = [k for k, s in (("reply", 'message from \\"claude\\"'), ("notice", "is done and touches"), ("integration", "Before task #"), ("fact", "agent-hub facts [")) if s in text]
            return "+".join(kinds) or "other"
    return "?"


def post_done_turns(run, t0, codex_done):
    if codex_done is None: return None
    msgs = run.get("codexMessages") or []
    return [{"started_s": secs(t0, m["emittedAtMs"]), "trigger": turn_trigger(msgs, i)} for i, m in enumerate(msgs)
            if m.get("method") == "turn/started" and m.get("emittedAtMs") is not None and m["emittedAtMs"] > codex_done]


def codex_turns(run):
    """(start, end) of each Codex turn on its stream, in ms; end is None for one still open at the end."""
    out, open_at = [], None
    for m in run.get("codexMessages") or []:
        ms = m.get("emittedAtMs")
        if ms is None: continue
        if m.get("method") == "turn/started": open_at = ms
        elif m.get("method") == "turn/completed" and open_at is not None: out.append((open_at, ms)); open_at = None
    if open_at is not None: out.append((open_at, None))
    return out


def late_replies(run, codex_done):
    if codex_done is None: return None
    events = run.get("events") or []
    gone = {e.get("id") for e in events if (e.get("type") == "quiet" and "codex" in (e.get("peers") or [])) or (e.get("type") in ("overflow", "undeliverable") and e.get("peer") == "codex")}
    turns = codex_turns(run)
    out = []
    for e in events:
        if e.get("type") != "envelope" or e.get("from") != "claude" or e.get("dropped") or e.get("id") in gone: continue
        if e.get("to") is not None and "codex" not in e.get("to"): continue
        sent = at_ms(e["at"])
        running = any(s <= sent and (end is None or end > sent) for s, end in turns)
        arrival = sent if running and e.get("priority") == "important" else first(sorted(s for s, _ in turns), lambda s: s >= sent)
        if arrival is not None and arrival > codex_done: out.append(round((arrival - sent) / 1000, 1))
    return out


# ---- Claude ------------------------------------------------------------------------------------------------------

def transcript_rows(run):
    """The Claude transcript's rows, or (None, why)."""
    return transcript(run)


def row_ms(row):
    ts = row.get("timestamp")
    try: return at_ms(ts) if ts else None
    except ValueError: return None


def results_of(rows):
    """Tool use id -> (ok, ms) of its tool result."""
    out = {}
    for r in rows or []:
        content = (r.get("message") or {}).get("content")
        for c in content if isinstance(content, list) else []:
            if isinstance(c, dict) and c.get("type") == "tool_result": out[c.get("tool_use_id")] = (not c.get("is_error"), row_ms(r))
    return out


def claude_usage(rows, start_ms, end_ms):
    if rows is None: return None
    usage, turns, requests = {}, set(), set()
    for r in rows:
        if r.get("type") != "assistant": continue
        msg = r.get("message") or {}
        ms = row_ms(r)
        if ms is None or (start_ms and ms < start_ms) or (end_ms and ms > end_ms) or msg.get("model") == "<synthetic>" or not msg.get("id"): continue
        # One response is written as a row per content block, each with its usage: the last row's counts stand.
        if msg["id"] not in usage or msg.get("usage"): usage[msg["id"]] = msg.get("usage")
        if msg.get("stop_reason") == "end_turn": turns.add(msg["id"])
        if r.get("requestId"): requests.add(r["requestId"])
    counted = [u for u in usage.values() if isinstance(u, dict)]
    keys = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
    tokens = sum(u.get(k) or 0 for u in counted for k in keys) if counted else None
    return {"assistant_messages": len(usage), "turns": len(turns), "tokens": tokens, "provider_requests": len(requests) if requests else None}


# ---- shared ------------------------------------------------------------------------------------------------------

def settlement(run, rows, t0, last_done):
    if last_done is None: return {}
    arm = str(run.get("kind") or "")
    out = {}
    if "codex" in arm: out["codex"] = None  # unknown unless its record says
    if "claude" in arm: out["claude"] = None
    if run.get("codexMessages"):
        turns = codex_turns(run)
        still = turns and turns[-1][1] is None  # its record ended inside a turn
        out["codex"] = None if still else secs(t0, max([last_done] + [e for _, e in turns if e is not None and e >= last_done]))
    if rows is not None:
        # A synthetic response (an API error Claude Code reports) ends its turn too.
        replies = sorted((row_ms(r), "end_turn" if (r.get("message") or {}).get("model") == "<synthetic>" else (r.get("message") or {}).get("stop_reason")) for r in rows if r.get("type") == "assistant" and row_ms(r) is not None)
        after = [(ms, stop) for ms, stop in replies if ms >= last_done]
        before = [stop for ms, stop in replies if ms < last_done]
        still = (after and after[-1][1] != "end_turn") or (not after and before and before[-1] != "end_turn")
        out["claude"] = None if still else secs(t0, max([last_done] + [ms for ms, stop in after if stop == "end_turn"]))
    return out


def facts_of(events):
    offers = [e for e in events if e.get("type") == "fact"]
    acks = [e for e in events if e.get("type") == "fact_ack"]
    acked = {e.get("id") for e in acks}
    num = lambda es, k: [e[k] for e in es if isinstance(e.get(k), (int, float))]
    out = {}
    for via in ("hook", "steer", "done"):
        mine = [e for e in offers if e.get("via") == via]
        out[via] = {"offers": len(mine), "acknowledged": sum(1 for e in mine if e.get("id") in acked), "probes": sum(1 for e in mine if e.get("probe")),
                    "coverage_notices": sum(1 for e in mine if e.get("coverage")), "unknown_attribution_files": sum(e.get("unknown", 0) for e in mine),
                    "bytes_offered": sum(e.get("bytes", 0) for e in mine), "bytes_acknowledged": sum(e.get("bytes", 0) for e in mine if e.get("id") in acked),
                    "build_ms_median": median(num(mine, "ms")), "hook_startup_ms_median": median(num(mine, "hookMs")),
                    "steers_unanswered": sum(1 for e in mine if e.get("unanswered")),
                    "steer_rtt_ms_median": median(num(mine, "rttMs")), "steers_refused": sum(1 for e in mine if e.get("accepted") is False and not e.get("unanswered"))}
    out["ack_ms_median"] = median(num(acks, "ms"))
    return out


def capability_of(events, t0):
    out = {}
    for e in events:
        if e.get("type") == "capability":
            out.setdefault(e.get("peer"), []).append({"state": e.get("state"), "via": e.get("via"), "at_s": secs(t0, at_ms(e["at"]))})
    return out


def validity_of(run):
    why = treatment_failure(str(run.get("kind") or ""), run) or isolation_failure(run)
    if why and why.startswith("hook isolation unknown"): return {"valid": None, "why": why}
    return {"valid": not why, "why": why}


def treatment_of(run, window):
    if run.get("kind") != TURN_FREE: return None
    ids = {t.get("id") for t in run.get("taskStates") or []}
    return {"silent_cohort": any(e.get("type") == "cohort" and e.get("silent") and ids <= set(e.get("tasks") or []) for e in window)}


def hook_label(command):
    """A hook command as a label: never its paths or arguments (they can carry a home path or a token)."""
    if not command: return "(command not recorded)"
    if "facts-hook.ts" in command: return "agent-hub facts hook"
    try: words = shlex.split(command)
    except ValueError: return "other: ?"  # unbalanced quotes: nothing of it is safe to show
    words = [w for w in words if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w)]  # environment assignments carry values
    return f"other: {Path(words[0]).name if words else '?'}"


def hooks_seen(run, rows, rows_why, events):
    stats = [e for e in events if e.get("type") == "hook_stats"]
    timing = {"calls": sum(e.get("n", 0) for e in stats), "startup_ms_total": sum(e.get("startupMs", 0) for e in stats), "hub_ms_total": sum(e.get("hubMs", 0) for e in stats),
              "startup_ms_max": max((e.get("maxStartupMs", 0) for e in stats), default=0)} if stats else None
    codex = sum(1 for m in (run.get("codexMessages") or []) if m.get("method") == "hook/started")
    out = {"codex_hook_runs": codex, "facts_hook_timing": timing, "conditions": run.get("conditions")}
    if "claude" not in str(run.get("kind") or ""): return out
    if rows is None: return {**out, "claude_transcript_rows": None, "claude_hook_ms": None, "foreign": None, "claude_why": rows_why}
    seen, durations, foreign = {}, [], set()
    for name, command, ms in hook_rows(rows):
        label = hook_label(command)
        seen[f"{name} {label}"] = seen.get(f"{name} {label}", 0) + 1
        if isinstance(ms, (int, float)): durations.append(ms)
        if command and "facts-hook.ts" not in command: foreign.add(label)
    return {**out, "claude_transcript_rows": seen, "claude_hook_ms": {"timed_rows": len(durations), "median": median(durations), "total": sum(durations)}, "foreign": sorted(foreign)}


# ---- contributions -----------------------------------------------------------------------------------------------

def rel(root, path):
    p = Path(path)
    if not p.is_absolute(): p = root / p
    try: return str(p.resolve().relative_to(root))
    except (ValueError, OSError): return ""


def unified_sides(diff):
    """Added and removed lines of a unified diff; only the --- and +++ file headers before the first hunk are skipped."""
    added, removed, in_hunk = [], [], False
    for line in diff.split("\n"):
        if line.startswith("@@"): in_hunk = True; continue
        if not in_hunk and (line.startswith("--- ") or line.startswith("+++ ")): continue
        if line.startswith("+"): added.append(line[1:])
        elif line.startswith("-"): removed.append(line[1:])
    return "\n".join(added), "\n".join(removed)


def writes_of(run, rows, root):
    """Applied writes in time order: (ms, agent, path, kind, added, removed); kind is edit, replace, delete or move (then
    `added` is the new path). Also how many shell commands each agent ran during the task, whose writes nothing
    attributes."""
    out, shell = [], {"claude": 0, "codex": 0}
    for m in (run.get("codexMessages") or [])[run.get("codexTaskStart") or 0:]:
        it = item_of(m)
        if m.get("method") != "item/completed": continue
        if it.get("type") == "commandExecution" and any((a or {}).get("type") not in SHELL_READS for a in it.get("commandActions") or []): shell["codex"] += 1
        if it.get("type") != "fileChange" or it.get("status") not in (None, "completed"): continue
        for change in it.get("changes", []):
            kind_obj = change.get("kind") if isinstance(change.get("kind"), dict) else {"type": change.get("kind")}
            path = rel(root, kind_obj.get("move_path") or change.get("path", ""))
            if kind_obj.get("move_path"): out.append((m.get("emittedAtMs") or 0, "codex", rel(root, change.get("path", "")), "move", path, ""))
            kind, diff = kind_obj.get("type") or "update", change.get("diff") or ""
            if kind == "add": out.append((m.get("emittedAtMs") or 0, "codex", path, "replace", diff, ""))
            elif kind == "delete": out.append((m.get("emittedAtMs") or 0, "codex", path, "delete", "", ""))
            else: out.append((m.get("emittedAtMs") or 0, "codex", path, "edit", *unified_sides(diff)))
    if rows is not None:
        results, seen, start = results_of(rows), set(), run.get("startedAt") or 0
        for r in rows:
            if r.get("type") != "assistant": continue
            for c in (r.get("message") or {}).get("content", []):
                if not isinstance(c, dict) or c.get("type") != "tool_use" or c.get("id") in seen: continue
                seen.add(c.get("id"))
                ok, ms = results.get(c.get("id"), (False, None))
                i, name = c.get("input") or {}, c.get("name")
                if name in ("Bash", "NotebookEdit") and (ms or 0) >= start: shell["claude"] += 1
                if not ok: continue  # refused, failed or never answered: nothing was applied
                path = rel(root, i.get("file_path", "")) if i.get("file_path") else ""
                if name == "Edit": out.append((ms or 0, "claude", path, "edit", i.get("new_string", ""), i.get("old_string", "")))
                elif name == "Write": out.append((ms or 0, "claude", path, "replace", i.get("content", ""), ""))
                elif name == "MultiEdit":
                    for e in i.get("edits", []): out.append((ms or 0, "claude", path, "edit", e.get("new_string", ""), e.get("old_string", "")))
    return sorted((w for w in out if w[2]), key=lambda w: w[0]), shell


def idents(text):
    return {x for x in IDENT.findall(text) if not keyword.iskeyword(x)}


def fragments(text):
    return {l.strip() for l in text.split("\n") if len(l.strip()) >= 8}


def contributions(run, rows, rows_why):
    root = Path(run["cwd"]).resolve()
    if not root.is_dir(): return {"identifiers": None, "fragments": None, "coverage": ["the fixture is gone: nothing to compare with"]}
    base_ref = run.get("sealedCommit") or "HEAD"
    coverage = []
    if rows is None and "claude" in str(run.get("kind") or ""): coverage.append(f"Claude's writes are not counted: {rows_why}")

    def base_text(path):
        p = subprocess.run(["git", "show", f"{base_ref}:{path}"], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return p.stdout.decode("utf-8", "replace") if p.returncode == 0 else ""

    def final_text(path):
        f = root / path
        try: return f.read_text(encoding="utf-8", errors="replace") if f.exists() else ""
        except OSError: return None

    writes, shell = writes_of(run, rows, root)
    for agent, n in sorted(shell.items()):
        if n: coverage.append(f"{agent} ran {n} shell command(s) during the task; what they wrote is not attributed")
    own = {}  # (agent, path) -> {"ids": set, "frags": set}
    for _, agent, path, kind, added, removed in writes:
        if kind == "move":  # every agent's contributions at the old path are checked at the new one
            for (a, p) in [k for k in own if k[1] == path]:
                moved = own.pop((a, p))
                into = own.setdefault((a, added), {"ids": set(), "frags": set()})
                into["ids"] |= moved["ids"]; into["frags"] |= moved["frags"]
            continue
        base = base_text(path)
        mine = own.setdefault((agent, path), {"ids": set(), "frags": set()})
        others_ids = set().union(*[v["ids"] for (a, p), v in own.items() if p == path and a != agent] or [set()])
        others_frags = set().union(*[v["frags"] for (a, p), v in own.items() if p == path and a != agent] or [set()])
        if kind == "delete": mine["ids"].clear(); mine["frags"].clear(); continue
        if kind == "replace":  # what it no longer writes, it removed itself; what others wrote is not its
            mine["ids"] &= idents(added); mine["frags"] = {f for f in mine["frags"] if f in added}
            mine["ids"] |= idents(added) - idents(base) - others_ids
            mine["frags"] |= fragments(added) - fragments(base) - others_frags
            continue
        mine["ids"] -= idents(removed) - idents(added); mine["frags"] -= fragments(removed)
        mine["ids"] |= idents(added) - idents(removed) - idents(base)
        mine["frags"] |= fragments(added) - fragments(removed) - fragments(base)
    lost_ids, lost_frags = [], []
    for (agent, path), mine in sorted(own.items()):
        final = final_text(path)
        if final is None: coverage.append(f"{path} could not be read"); continue
        for ident in sorted(mine["ids"] - idents(final)): lost_ids.append({"agent": agent, "path": path, "identifier": ident})
        for frag in sorted(f for f in mine["frags"] if f not in final): lost_frags.append({"agent": agent, "path": path, "fragment": frag[:200]})
    return {"identifiers": lost_ids, "fragments": lost_frags, "coverage": coverage}


# ---- one attempt -------------------------------------------------------------------------------------------------

def ledger_of(run):
    t0, tasks = task_times(run)
    events = run.get("events") or []
    row = {"case": run.get("index"), "arm": run.get("kind"), "repeat": run.get("repeat"), "end_reason": run.get("end_reason"), "end_reason_detail": run.get("end_reason_detail"),
           "setup_s": round(run["setupMs"] / 1000, 1) if isinstance(run.get("setupMs"), (int, float)) else None,
           "elapsed_s": round(run["elapsedMs"] / 1000, 1) if isinstance(run.get("elapsedMs"), (int, float)) else None}
    if t0 is None:
        row.update({"completed": False, "status": "no tasks: a setup-only or failed-before-assignment attempt"})
        return row
    rows, rows_why = transcript_rows(run) if "claude" in str(run.get("kind") or "") else (None, "no Claude in this arm")
    end = active_window(run)[1]
    # The task window: setup probes before it and teardown after it are left out.
    window = [e for e in events if e.get("at") is not None and at_ms(e["at"]) >= t0 and (end is None or at_ms(e["at"]) <= end)]
    codex_done = max((t["done"] for t in tasks if t["owner"] == "codex" and t["done"] is not None), default=None)
    claude_done = max((t["done"] for t in tasks if t["owner"] == "claude" and t["done"] is not None), default=None)
    all_done = all(t["done"] is not None for t in tasks)
    last_done = max((t["done"] for t in tasks if t["done"] is not None), default=None)
    edits = {c.get("id") for r in rows or [] if r.get("type") == "assistant" for c in (r.get("message") or {}).get("content", []) if isinstance(c, dict) and c.get("name") in ("Edit", "Write", "MultiEdit")}
    writes = [ms for uid, (ok, ms) in results_of(rows).items() if ok and ms and uid in edits]
    writes += [m["emittedAtMs"] for m in codex_window(run, None) if m.get("method") == "item/completed" and item_of(m).get("type") == "fileChange" and item_of(m).get("status") in (None, "completed") and m.get("emittedAtMs")]
    settle = settlement(run, rows, t0, last_done)
    row.update({
        "completed": row["end_reason"] == "completed" and all_done,
        "both_done_s": secs(t0, last_done) if all_done else None,
        "done_s": {str(t["id"]): secs(t0, t["done"]) for t in tasks},
        "intents_s": {str(t["id"]): secs(t0, t["intent"]) for t in tasks},
        "first_candidate_s": secs(t0, min(writes)) if writes else None,
        "integration": {"requests": sum(t["requests"] for t in tasks), "unresolved": [n for t in tasks for n in t["unresolved"]]},
        "integrated_s": secs(t0, max((t["integrated"] for t in tasks if t["integrated"]), default=None)),
        "check_s": secs(t0, max((t["check"] for t in tasks if t["check"]), default=None)),
        "settlement": settle,
        "settlement_s": None if None in settle.values() else max(settle.values(), default=None),  # unknown if either is
        "codex": codex_usage(run, codex_done, "to its last done" if codex_done is not None else "to the end: no done"),
        "codex_attempt": codex_usage(run, None, "to the end of the record"),
        "claude": claude_usage(rows, run.get("startedAt"), claude_done),
        "claude_attempt": claude_usage(rows, run.get("startedAt"), None),
        "post_done_turns": post_done_turns(run, t0, codex_done),
        "late_replies": late_replies(run, codex_done),
        "facts": facts_of(window),
        "capability": capability_of(events, t0),
        "validity": validity_of(run),
        "treatment": treatment_of(run, window),
        "stopped_s": round(run["stoppedMs"] / 1000, 1) if isinstance(run.get("stoppedMs"), (int, float)) else None,
        "teardown_s": round(run["teardownMs"] / 1000, 1) if isinstance(run.get("teardownMs"), (int, float)) else None,
        "quiet": sum(1 for e in window if e.get("type") == "quiet"),
        "fyi": sum(1 for e in window if e.get("type") == "envelope" and e.get("from") in ("claude", "codex") and e.get("dropped") == "fyi"),
        "stale": sum(1 for e in window if e.get("type") == "stale"),
        "split_predictions": [{k: e.get(k) for k in ("task", "verdict", "single", "splitS", "singleS", "reason", "trace") if e.get(k) is not None} for e in events if e.get("type") == "split"],
        "hooks": hooks_seen(run, rows, rows_why, events),
        "contributions": contributions(run, rows, rows_why),
    })
    return row


def summarize(rows, missing=()):
    by = {}
    for r in rows: by.setdefault(r["arm"], []).append(r)
    ok = lambda r: r.get("completed") and (r.get("validity") or {}).get("valid") is True
    arms = set(by)
    pairs = {(r["case"], r.get("repeat")) for r in rows}
    common = {p for p in pairs if all(any(r["case"] == p[0] and r.get("repeat") == p[1] and ok(r) for r in by[a]) for a in arms)}
    med = lambda rs, part, key: median([r[part][key] for r in rs if r.get(part) and r[part].get(key) is not None])
    worked = lambda rs: [r for r in rs if r.get("done_s") is not None]  # attempts whose tasks were handed out
    codex_arm = lambda r: "codex" in str(r.get("arm"))
    joint = lambda r: str(r.get("arm")).startswith("hub-")

    def total(rs, name, get, applies=lambda r: True):
        """A total over the attempts it applies to that know it, and how many did not: an unknown is never a zero."""
        values = [get(r) for r in worked(rs) if applies(r)]
        return {f"{name}_total": sum(v for v in values if v is not None), f"{name}_unknown": sum(1 for v in values if v is None)}

    def lost(r, key):
        """Lost contributions, unknown when an agent's writes could not be counted at all."""
        c = r.get("contributions") or {}
        return None if any("are not counted" in n or "could not be read" in n for n in c.get("coverage") or []) else size(c.get(key))

    def size(v):
        return None if v is None else len(v)

    out = {}
    for arm, rs in by.items():
        done = [r for r in rs if ok(r)]
        shared = [r for r in done if (r["case"], r.get("repeat")) in common]
        treated = [r for r in done if (r.get("treatment") or {}).get("silent_cohort")]
        out[arm] = {
            "attempts": len(rs), "completed": sum(1 for r in rs if r.get("completed")), "valid_completed": len(done),
            "not_completed": sorted(str(r.get("end_reason_detail") or r.get("end_reason")) for r in rs if not r.get("completed")),
            "excluded": sorted(str((r.get("validity") or {}).get("why")) for r in rs if r.get("completed") and not ok(r)),
            "missing": sorted(f"case {c} repeat {rep}" for c, a, rep in missing if a == arm),
            "both_done_s_median": median([r["both_done_s"] for r in done]),
            "both_done_s_median_common": median([r["both_done_s"] for r in shared]),
            "settlement_s_median": median([r["settlement_s"] for r in done if r.get("settlement_s") is not None]),
            "setup_s_median": median([r["setup_s"] for r in rs if r.get("setup_s") is not None]),
            "codex_turns_median": med(done, "codex", "turns"),
            "codex_usage_growth_median": med(done, "codex", "usage_growth"),
            "codex_attempt_turns_median": med(done, "codex_attempt", "turns"),
            "codex_attempt_usage_growth_median": med(done, "codex_attempt", "usage_growth"),
            "codex_attempt_tokens_median": med(done, "codex_attempt", "tokens"),
            "codex_attempt_tokens_median_common": med(shared, "codex_attempt", "tokens"),
            "claude_assistant_messages_median": med(done, "claude", "assistant_messages"),
            "claude_attempt_assistant_messages_median": med(done, "claude_attempt", "assistant_messages"),
            "claude_attempt_tokens_median": med(done, "claude_attempt", "tokens"),
            "claude_attempt_tokens_median_common": med(shared, "claude_attempt", "tokens"),
            **({"treatment_received": len(treated), "both_done_s_median_treated": median([r["both_done_s"] for r in treated])} if arm == TURN_FREE else {}),
            **total(rs, "hub_send", lambda r: (r.get("codex") or {}).get("hub_send"), codex_arm),
            **total(rs, "post_done_turns", lambda r: size(r.get("post_done_turns")), codex_arm),
            **total(rs, "late_replies", lambda r: size(r.get("late_replies")), joint),
            **total(rs, "quiet", lambda r: r.get("quiet")),
            **total(rs, "stale", lambda r: r.get("stale")),
            **total(rs, "fact_offers", lambda r: sum(r["facts"][v]["offers"] for v in ("hook", "steer", "done")) if r.get("facts") else None),
            **total(rs, "fact_bytes_offered", lambda r: sum(r["facts"][v]["bytes_offered"] for v in ("hook", "steer", "done")) if r.get("facts") else None),
            **total(rs, "fact_bytes_acknowledged", lambda r: sum(r["facts"][v]["bytes_acknowledged"] for v in ("hook", "steer", "done")) if r.get("facts") else None),
            **total(rs, "integration_requests", lambda r: (r.get("integration") or {}).get("requests")),
            **total(rs, "integration_unresolved", lambda r: size((r.get("integration") or {}).get("unresolved"))),
            **total(rs, "lost_identifiers", lambda r: lost(r, "identifiers")),
            **total(rs, "lost_fragments", lambda r: lost(r, "fragments")),
            "contribution_coverage_notes": sum(len((r.get("contributions") or {}).get("coverage") or []) for r in worked(rs)),
        }
    return out


def expected(run_dir):
    """(case, arm, repeat) of every attempt the run directory's cohort planned, or none without cohort.json."""
    try: c = json.loads((run_dir / "cohort.json").read_text(encoding="utf-8"))
    except (OSError, ValueError): return set()
    return {(case, arm, c.get("repeat")) for case in c.get("cases") or [] for arm in c.get("arms") or []}


def planned(run_dir, plan):
    """(case, arm, repeat) of every attempt the manifest's plan names, whole repeats included."""
    m = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    spec = (m.get("plan") or {}).get(plan)
    if not isinstance(spec, dict): raise SystemExit(f"ledger: the manifest has no plan {plan!r}")
    return {(case, arm, rep) for case in spec.get("cases") or [] for arm in m.get("arms") or [] for rep in range(spec.get("repeats") or 0)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run", type=Path, action="append", required=True, help="a run directory; give several to pool repeats")
    p.add_argument("--plan", help="the manifest plan these directories carry out (pilot, study): its whole repeats are expected")
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    rows, plan = [], set()
    for run_dir in a.run:
        for f in sorted((run_dir / "runs").glob("*.json")): rows.append({**ledger_of(json.loads(f.read_text(encoding="utf-8"))), "run": run_dir.name})
        plan |= expected(run_dir)
    if a.plan: plan |= planned(a.run[0], a.plan)
    seen = {}
    for r in rows:
        key = (r["case"], r["arm"], r.get("repeat"))
        if key in seen: raise SystemExit(f"ledger: case {key[0]} {key[1]} repeat {key[2]} is in both {seen[key]} and {r['run']}")
        seen[key] = r["run"]
    missing = sorted(plan - set(seen), key=str)
    out = {"units": UNITS, "rows": rows, "missing": [{"case": c, "arm": arm, "repeat": rep} for c, arm, rep in missing], "summary": summarize(rows, missing)}
    (a.run[0] / "ledger.json").write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if a.json: print(json.dumps(out, indent=2, sort_keys=True))
    else:
        for arm, s in out["summary"].items(): print(arm, json.dumps(s, sort_keys=True))


if __name__ == "__main__":
    main()
