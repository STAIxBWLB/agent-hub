#!/usr/bin/env python3
"""Coordination ledger for a native CooperBench run directory (issue #110). Standard library only.

Usage: python3 scripts/benchmarks/ledger.py --run RUN_DIR [--json]

Reads runs/<NN>-<arm>.json written by native.ts, the Claude transcript each names, and the fixture's git history.
Writes ledger.json next to them. Every measure names its unit and coverage in UNITS below; a measure the records
cannot support is null with a reason, never zero. Times are seconds from the first task proposal of the attempt.

Correctness is the official grader's: nothing here certifies a correct or loss-free result. The contribution measures
can only expose possible loss.
"""
from __future__ import annotations
import argparse, json, re, statistics, subprocess
from datetime import datetime
from pathlib import Path

UNITS = {
    "end_reason": "the runner's class (completed, interrupted, infrastructure-error, ...); end_reason_detail says which "
                  "(wall-timeout, needs-review, claude-exited, ...). Only completed attempts are graded",
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
    "settlement": "per agent, seconds to its first native turn end after the last done, read from its own record: "
                  "Codex turn/completed on its stream, Claude's first end_turn response in its transcript; settlement_s "
                  "is the later of the two",
    "codex": "Codex from task assignment to its last done on the board: turns (turn/started), assistant_messages "
             "(agentMessage items), usage_growth (token-usage updates whose running total grew: one per model call, "
             "compaction estimates, rate-limit refreshes and replays left out), usage_events (all updates), "
             "provider_requests (unique rawResponse ids when the stream carries them, else null: unknown), hub_send, "
             "board_reads (hub_task_list)",
    "claude": "Claude from task assignment to its last done: assistant_messages (unique message ids: successful "
              "main-loop responses), turns (end_turn responses); provider_requests is null: side requests such as "
              "titles and retried calls are not in the transcript",
    "post_done_turns": "Codex turns started after its last done, with what their first injected message held",
    "late_replies": "Claude messages that reached Codex only after its done (by steer into a running turn, or at the "
                    "next turn start): seconds from sending to arrival. Held, dropped, overflowed and undeliverable "
                    "envelopes are left out",
    "facts": "the hub's fact offers by path (hook, steer, done): offers, acknowledged, probes, coverage notices, files "
             "shown with attribution unknown, injected bytes, build time, the hook process's own time, steer round "
             "trip, refused steers; ack_ms_median is offer-to-acknowledgement",
    "capability": "per peer, the hub's capability events (verified or lost) with their time",
    "treatment": "turn-free only: whether both context paths were verified before the first task (a silent cohort is "
                 "decided when it forms); an attempt without it is not a valid turn-free run and is not graded",
    "quiet": "agent messages a silent cohort held back from a member (the hub's quiet events)",
    "fyi": "agent messages sent as [FYI] (recorded, nobody's turn)",
    "stale": "notices dropped as stale at delivery (#106)",
    "split_predictions": "the hub's shadow split predictions (#109); they never changed an assignment",
    "hooks": "hooks each agent ran as its own records show: Claude transcript hook rows by hook and command, Codex "
             "hook/started items; with the attempt's configured conditions",
    "contributions": "identifiers and changed fragments an agent's applied writes introduced that the final tree lacks "
                     "and that agent did not remove itself (a fragment counts as present anywhere in the file); a "
                     "heuristic, with what it could not see listed in coverage",
    "summary": "per arm: attempts and completions with the reasons for the rest; medians over completed attempts, and "
               "over the (case, repeat) pairs completed by every arm of the run directory (common); totals over all "
               "attempts",
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

def codex_window(run, done_ms):
    """Codex's messages from task assignment to its last done on the board (all of them when it has none)."""
    msgs = run.get("codexMessages") or []
    start = run.get("codexTaskStart") or 0
    out = []
    for m in msgs[start:]:
        if done_ms is not None and m.get("emittedAtMs") is not None and m["emittedAtMs"] > done_ms: break
        out.append(m)
    return out


def codex_in_task(run, done_ms):
    if not run.get("codexMessages"): return None
    window = codex_window(run, done_ms)
    tools = [item_of(m).get("tool") for m in window if m.get("method") == "item/completed" and item_of(m).get("type") == "mcpToolCall"]
    total, growth, events, responses = None, 0, 0, set()
    for m in window:
        if m.get("method") == "rawResponse/completed":
            rid = (m.get("params") or {}).get("responseId")
            if rid: responses.add(rid)
        if m.get("method") != "thread/tokenUsage/updated": continue
        events += 1
        now = (((m.get("params") or {}).get("tokenUsage") or {}).get("total") or {}).get("totalTokens")
        if isinstance(now, (int, float)):
            if total is not None and now > total: growth += 1
            total = now if total is None else max(total, now)
    return {"turns": sum(1 for m in window if m.get("method") == "turn/started"),
            "assistant_messages": sum(1 for m in window if m.get("method") == "item/completed" and item_of(m).get("type") == "agentMessage"),
            "usage_growth": growth, "usage_events": events, "provider_requests": len(responses) if responses else None,
            "hub_send": tools.count("hub_send"), "board_reads": tools.count("hub_task_list"), "window": "to its last done" if done_ms is not None else "to the end: no done"}


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
    if codex_done is None: return []
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
    if codex_done is None: return []
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
    raw = ((run.get("readiness") or {}).get("claude") or {}).get("transcriptPath")
    if not raw: return None, "no transcript path"
    try: text = Path(raw).read_text(encoding="utf-8", errors="replace")
    except OSError as e: return None, f"transcript unreadable ({e.__class__.__name__})"
    rows = []
    for line in text.splitlines():
        try: rows.append(json.loads(line))
        except ValueError: continue
    return rows, None


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


def claude_in_task(rows, start_ms, done_ms):
    if rows is None: return None
    ids, turns = set(), set()
    for r in rows:
        if r.get("type") != "assistant": continue
        msg = r.get("message") or {}
        ms = row_ms(r)
        if ms is None or (start_ms and ms < start_ms) or (done_ms and ms > done_ms) or msg.get("model") == "<synthetic>": continue
        if msg.get("id"): ids.add(msg["id"])
        if msg.get("stop_reason") == "end_turn" and msg.get("id"): turns.add(msg["id"])
    return {"assistant_messages": len(ids), "turns": len(turns), "provider_requests": None}


# ---- shared ------------------------------------------------------------------------------------------------------

def settlement(run, rows, t0, last_done):
    if last_done is None: return {}
    out = {}
    if run.get("codexMessages"):
        end = first(sorted(e for _, e in codex_turns(run) if e is not None), lambda e: e >= last_done)
        out["codex"] = secs(t0, end)
    if rows is not None:
        ends = sorted(row_ms(r) for r in rows if r.get("type") == "assistant" and (r.get("message") or {}).get("stop_reason") == "end_turn" and row_ms(r) is not None)
        out["claude"] = secs(t0, first(ends, lambda e: e >= last_done))
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
                    "bytes": sum(e.get("bytes", 0) for e in mine), "build_ms_median": median(num(mine, "ms")), "hook_ms_median": median(num(mine, "hookMs")),
                    "steer_rtt_ms_median": median(num(mine, "rttMs")), "steers_refused": sum(1 for e in mine if e.get("accepted") is False)}
    out["ack_ms_median"] = median(num(acks, "ms"))
    return out


def capability_of(events, t0):
    out = {}
    for e in events:
        if e.get("type") == "capability":
            out.setdefault(e.get("peer"), []).append({"state": e.get("state"), "via": e.get("via"), "at_s": secs(t0, at_ms(e["at"]))})
    return out


def treatment_of(run, events, t0):
    if run.get("kind") != "hub-turnfree-codex-claude": return None
    verified = {e.get("peer") for e in events if e.get("type") == "capability" and e.get("state") == "verified" and t0 is not None and at_ms(e["at"]) <= t0}
    missing = sorted({"claude", "codex"} - verified)
    return {"verified_before_tasks": not missing, "missing": missing}


def hooks_seen(run, rows):
    claude = {}
    for r in rows or []:
        a = r.get("attachment") or {}
        if a.get("type") == "hook_additional_context" or not str(a.get("type", "")).startswith("hook"): continue
        key = f"{a.get('hookName') or a.get('hookEvent')} {a.get('command') or '(command not recorded)'}"
        claude[key] = claude.get(key, 0) + 1
    codex = sum(1 for m in (run.get("codexMessages") or []) if m.get("method") == "hook/started")
    return {"claude_transcript_rows": claude, "codex_hook_runs": codex, "conditions": run.get("conditions")}


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
    """Applied writes in time order: (ms, agent, path, kind, added, removed); kind is edit, replace or delete. Also how
    many shell commands each agent ran during the task, whose writes nothing attributes."""
    out, shell = [], {"claude": 0, "codex": 0}
    for m in (run.get("codexMessages") or [])[run.get("codexTaskStart") or 0:]:
        it = item_of(m)
        if m.get("method") != "item/completed": continue
        if it.get("type") == "commandExecution" and any((a or {}).get("type") not in SHELL_READS for a in it.get("commandActions") or []): shell["codex"] += 1
        if it.get("type") != "fileChange" or it.get("status") not in (None, "completed"): continue
        for change in it.get("changes", []):
            kind_obj = change.get("kind") if isinstance(change.get("kind"), dict) else {"type": change.get("kind")}
            path = rel(root, kind_obj.get("move_path") or change.get("path", ""))
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
        base = base_text(path)
        mine = own.setdefault((agent, path), {"ids": set(), "frags": set()})
        others_ids = set().union(*[v["ids"] for (a, p), v in own.items() if p == path and a != agent] or [set()])
        others_frags = set().union(*[v["frags"] for (a, p), v in own.items() if p == path and a != agent] or [set()])
        if kind == "delete": mine["ids"].clear(); mine["frags"].clear(); continue
        if kind == "replace":  # what it no longer writes, it removed itself; what others wrote is not its
            mine["ids"] &= set(IDENT.findall(added)); mine["frags"] = {f for f in mine["frags"] if f in added}
            mine["ids"] |= set(IDENT.findall(added)) - set(IDENT.findall(base)) - others_ids
            mine["frags"] |= fragments(added) - fragments(base) - others_frags
            continue
        mine["ids"] -= set(IDENT.findall(removed)) - set(IDENT.findall(added)); mine["frags"] -= fragments(removed)
        mine["ids"] |= set(IDENT.findall(added)) - set(IDENT.findall(removed)) - set(IDENT.findall(base))
        mine["frags"] |= fragments(added) - fragments(removed) - fragments(base)
    lost_ids, lost_frags = [], []
    for (agent, path), mine in sorted(own.items()):
        final = final_text(path)
        if final is None: coverage.append(f"{path} could not be read"); continue
        for ident in sorted(mine["ids"] - set(IDENT.findall(final))): lost_ids.append({"agent": agent, "path": path, "identifier": ident})
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
        "settlement_s": max((v for v in settle.values() if v is not None), default=None),
        "codex": codex_in_task(run, codex_done),
        "claude": claude_in_task(rows, run.get("startedAt"), claude_done),
        "post_done_turns": post_done_turns(run, t0, codex_done),
        "late_replies": late_replies(run, codex_done),
        "facts": facts_of(events),
        "capability": capability_of(events, t0),
        "treatment": treatment_of(run, events, t0),
        "quiet": sum(1 for e in events if e.get("type") == "quiet"),
        "fyi": sum(1 for e in events if e.get("type") == "envelope" and e.get("from") in ("claude", "codex") and e.get("dropped") == "fyi"),
        "stale": sum(1 for e in events if e.get("type") == "stale"),
        "split_predictions": [{k: e.get(k) for k in ("task", "verdict", "single", "splitS", "singleS", "reason") if e.get(k) is not None} for e in events if e.get("type") == "split"],
        "hooks": hooks_seen(run, rows),
        "contributions": contributions(run, rows, rows_why),
    })
    return row


def summarize(rows):
    by = {}
    for r in rows: by.setdefault(r["arm"], []).append(r)
    arms = set(by)
    pairs = {(r["case"], r.get("repeat")) for r in rows}
    common = {p for p in pairs if all(any(r["case"] == p[0] and r.get("repeat") == p[1] and r.get("completed") for r in by[a]) for a in arms)}
    total = lambda rs, f: sum(f(r) for r in rs)
    out = {}
    for arm, rs in by.items():
        done = [r for r in rs if r.get("completed")]
        shared = [r for r in done if (r["case"], r.get("repeat")) in common]
        out[arm] = {
            "attempts": len(rs), "completed": len(done),
            "not_completed": sorted(str(r.get("end_reason_detail") or r.get("end_reason")) for r in rs if not r.get("completed")),
            "treatment_invalid": sum(1 for r in rs if r.get("treatment") and not r["treatment"]["verified_before_tasks"]),
            "both_done_s_median": median([r["both_done_s"] for r in done]),
            "both_done_s_median_common": median([r["both_done_s"] for r in shared]),
            "setup_s_median": median([r["setup_s"] for r in rs if r.get("setup_s") is not None]),
            "codex_usage_growth_median": median([r["codex"]["usage_growth"] for r in done if r.get("codex")]),
            "codex_turns_median": median([r["codex"]["turns"] for r in done if r.get("codex")]),
            "claude_assistant_messages_median": median([r["claude"]["assistant_messages"] for r in done if r.get("claude")]),
            "hub_send_total": total(rs, lambda r: (r.get("codex") or {}).get("hub_send", 0)),
            "post_done_turns_total": total(rs, lambda r: len(r.get("post_done_turns", []))),
            "late_replies_total": total(rs, lambda r: len(r.get("late_replies", []))),
            "quiet_total": total(rs, lambda r: r.get("quiet", 0)),
            "stale_total": total(rs, lambda r: r.get("stale", 0)),
            "fact_offers_total": total(rs, lambda r: sum(r["facts"][v]["offers"] for v in ("hook", "steer", "done")) if r.get("facts") else 0),
            "fact_bytes_total": total(rs, lambda r: sum(r["facts"][v]["bytes"] for v in ("hook", "steer", "done")) if r.get("facts") else 0),
            "integration_requests_total": total(rs, lambda r: (r.get("integration") or {}).get("requests", 0)),
            "integration_unresolved_total": total(rs, lambda r: len((r.get("integration") or {}).get("unresolved", []))),
            "lost_identifiers_total": total(rs, lambda r: len((r.get("contributions") or {}).get("identifiers") or [])),
            "lost_fragments_total": total(rs, lambda r: len((r.get("contributions") or {}).get("fragments") or [])),
        }
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    rows = [ledger_of(json.loads(f.read_text(encoding="utf-8"))) for f in sorted((a.run / "runs").glob("*.json"))]
    out = {"units": UNITS, "rows": rows, "summary": summarize(rows)}
    (a.run / "ledger.json").write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if a.json: print(json.dumps(out, indent=2, sort_keys=True))
    else:
        for arm, s in out["summary"].items(): print(arm, json.dumps(s, sort_keys=True))


if __name__ == "__main__":
    main()
