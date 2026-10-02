#!/usr/bin/env python3
"""Coordination ledger for a native CooperBench run directory (issue #110). Standard library only.

Usage: python3 scripts/benchmarks/ledger.py --run RUN_DIR [--json]

Reads runs/<NN>-<arm>.json written by native.ts, the Claude transcript each names, and the fixture's git history.
Writes ledger.json next to them. Every count names its unit and coverage in UNITS below; a measure the record cannot
support is null with a reason, never zero. Times are seconds from the first task proposal of the attempt.

Correctness is the official grader's: nothing here certifies a correct or loss-free result. The contribution measures
are heuristics that can only expose possible loss.
"""
from __future__ import annotations
import argparse, json, re, statistics, subprocess
from datetime import datetime
from pathlib import Path

UNITS = {
    "both_done_s": "seconds to the last task's done; null unless every task has one",
    "first_candidate_s": "seconds to the first applied write by any agent (Codex patch item, Claude Edit/Write/MultiEdit result)",
    "intents_s": "per task: seconds to its first hub_task_done (done, done (checking) or integration requested)",
    "integrated_s": "seconds to an integration confirmed for a turn-free cohort; null without one",
    "check_s": "seconds to a configured check's result; null when no check ran (none are configured in the benchmark)",
    "settlement_s": "seconds to the last native turn end after the last done (Codex turn_end, Claude Stop)",
    "elapsed_s": "the runner's active-work time for the attempt",
    "codex": "Codex from task assignment to its last successful hub_task_done: turns (turn/started), assistant_messages "
             "(agentMessage items), usage_events (thread/tokenUsage/updated with a last block: a request proxy; the stream "
             "carries no request identities, so provider_requests is unknown), hub_send and board_reads (hub_task_list)",
    "claude": "Claude from task assignment to its last done: provider_requests are unique assistant message ids in its "
              "transcript (each is one provider response)",
    "post_done_turns": "Codex turns started after its last done, with what started them",
    "late_replies": "Claude messages that reached Codex only after its done: seconds from sending to Codex's next turn",
    "facts": "the hub's fact offers and acknowledgements by path (hook, steer, done), with bytes and latencies",
    "quiet": "agent messages a silent cohort held back from a member (the hub's quiet events)",
    "contributions": "identifiers and whole lines an agent's applied writes introduced that the final tree lacks and that "
                     "agent did not remove itself; a heuristic, with what it could not see listed in coverage",
}
IDENT = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{3,}\b")


def at_ms(value):
    if isinstance(value, (int, float)): return float(value)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000


def median(xs):
    return round(statistics.median(xs), 1) if xs else None


def first(seq, pred, default=None):
    return next((x for x in seq if pred(x)), default)


def task_times(run):
    """t0 and per task: owner, first intent, last done (ms)."""
    states = run.get("taskStates") or []
    proposals = [h["at"] for t in states for h in t.get("history", []) if h.get("event") == "proposed"]
    if not proposals: return None, []
    t0 = min(proposals)
    out = []
    for t in states:
        hist = t.get("history", [])
        intent = first(hist, lambda h: h.get("event") in ("done", "done (checking)", "integration requested"))
        dones = [h["at"] for h in hist if h.get("event") == "done"]
        integrated = first(hist, lambda h: h.get("event") == "integrated")
        checks = [h["at"] for h in hist if h.get("event") in ("check passed", "check failed")]
        out.append({"id": t.get("id"), "owner": t.get("owner"), "state": t.get("state"), "intent": intent["at"] if intent else None,
                    "done": max(dones) if dones else None, "integrated": integrated["at"] if integrated else None, "check": max(checks) if checks else None,
                    "requests": sum(1 for h in hist if h.get("event") == "integration requested"), "unresolved": any(h.get("event") == "integration unresolved" for h in hist)})
    return t0, out


def secs(t0, ms):
    return round((ms - t0) / 1000, 1) if ms is not None and t0 is not None else None


def items(msgs, start=0, end=None):
    for m in msgs[start:end]:
        if m.get("method") == "item/completed":
            yield m, (m.get("params") or {}).get("item") or {}


def codex_in_task(run, codex_done_ms):
    """Counts from task assignment to Codex's last successful hub_task_done (or the end, without one)."""
    msgs = run.get("codexMessages") or []
    if not msgs: return None
    start = run.get("codexTaskStart") or 0
    ok_done = [i for i, m in enumerate(msgs) if i >= start and m.get("method") == "item/completed"
               and ((m.get("params") or {}).get("item") or {}).get("type") == "mcpToolCall"
               and ((m.get("params") or {}).get("item") or {}).get("tool") == "hub_task_done"
               and ((m.get("params") or {}).get("item") or {}).get("status") in (None, "completed")
               and not ((m.get("params") or {}).get("item") or {}).get("error")]
    end = (ok_done[-1] + 1) if ok_done else len(msgs)
    head = msgs[start:end]
    tools = [it.get("tool") for _, it in items(head) if it.get("type") == "mcpToolCall"]
    return {"turns": sum(1 for m in head if m.get("method") == "turn/started"),
            "assistant_messages": sum(1 for _, it in items(head) if it.get("type") == "agentMessage"),
            "usage_events": sum(1 for m in head if m.get("method") == "thread/tokenUsage/updated" and ((m.get("params") or {}).get("tokenUsage") or {}).get("last")),
            "provider_requests": None, "hub_send": tools.count("hub_send"), "board_reads": tools.count("hub_task_list"),
            "done_found": bool(ok_done)}


def transcript_rows(run):
    path = Path(((run.get("readiness") or {}).get("claude") or {}).get("transcriptPath") or "")
    if not path.is_file(): return None
    rows = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try: rows.append(json.loads(line))
        except ValueError: continue
    return rows


def row_ms(row):
    ts = row.get("timestamp")
    try: return at_ms(ts) if ts else None
    except ValueError: return None


def claude_write_times(rows):
    """When each applied Claude Edit, Write or MultiEdit returned: its tool result's timestamp."""
    uses = {c.get("id") for r in rows or [] if r.get("type") == "assistant" for c in (r.get("message") or {}).get("content", [])
            if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") in ("Edit", "Write", "MultiEdit")}
    out = []
    for r in rows or []:
        content = (r.get("message") or {}).get("content")
        for c in content if isinstance(content, list) else []:
            if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in uses and not c.get("is_error") and row_ms(r):
                out.append(row_ms(r))
    return out


def claude_in_task(rows, start_ms, done_ms):
    if rows is None: return None
    ids = set()
    for r in rows:
        if r.get("type") != "assistant": continue
        ms = row_ms(r)
        if ms is None or (start_ms and ms < start_ms) or (done_ms and ms > done_ms): continue
        mid = (r.get("message") or {}).get("id")
        if mid: ids.add(mid)
    return {"provider_requests": len(ids)}


def turn_trigger(msgs, i):
    """What the first injected message of the Codex turn starting at index i held."""
    for m in msgs[i + 1:]:
        if m.get("method") == "turn/started": break
        it = (m.get("params") or {}).get("item") or {}
        if m.get("method") == "item/completed" and it.get("type") == "userMessage":
            text = json.dumps(it.get("content"))
            kinds = [k for k, s in (("reply", 'message from \\"claude\\"'), ("notice", "is done and touches"), ("integration", "Before task #"), ("fact", "agent-hub facts [")) if s in text]
            return "+".join(kinds) or "other"
    return "?"


def post_done_turns(run, t0, codex_done):
    if codex_done is None: return []
    msgs = run.get("codexMessages") or []
    out = []
    for i, m in enumerate(msgs):
        ms = m.get("emittedAtMs")
        if m.get("method") == "turn/started" and ms is not None and ms > codex_done:
            out.append({"started_s": secs(t0, ms), "trigger": turn_trigger(msgs, i)})
    return out


def late_replies(run, t0, codex_done):
    if codex_done is None: return []
    events = run.get("events") or []
    held = {e.get("id") for e in events if e.get("type") == "quiet" and "codex" in (e.get("peers") or [])}
    starts = sorted(m["emittedAtMs"] for m in (run.get("codexMessages") or []) if m.get("method") == "turn/started" and m.get("emittedAtMs") is not None)
    out = []
    for e in events:
        if e.get("type") != "envelope" or e.get("from") != "claude" or e.get("dropped") or e.get("priority") == "important" or e.get("id") in held: continue
        if e.get("to") is not None and "codex" not in e.get("to"): continue
        sent = at_ms(e["at"])
        got = first(starts, lambda s: s >= sent)
        if got is not None and got > codex_done: out.append(round((got - sent) / 1000, 1))
    return out


def facts_of(events):
    offers = [e for e in events if e.get("type") == "fact"]
    acks = [e for e in events if e.get("type") == "fact_ack"]
    acked = {e.get("id") for e in acks}
    out = {}
    for via in ("hook", "steer", "done"):
        mine = [e for e in offers if e.get("via") == via]
        out[via] = {"offers": len(mine), "acknowledged": sum(1 for e in mine if e.get("id") in acked), "probes": sum(1 for e in mine if e.get("probe")),
                    "coverage_notices": sum(1 for e in mine if e.get("coverage")), "unknown_attribution_files": sum(e.get("unknown", 0) for e in mine),
                    "bytes": sum(e.get("bytes", 0) for e in mine), "compute_ms_median": median([e["ms"] for e in mine if isinstance(e.get("ms"), (int, float))]),
                    "hook_ms_median": median([e["hookMs"] for e in mine if isinstance(e.get("hookMs"), (int, float))]),
                    "steers_refused": sum(1 for e in mine if e.get("accepted") is False)}
    out["ack_ms_median"] = median([e["ms"] for e in acks if isinstance(e.get("ms"), (int, float))])
    return out


def capability_of(events, t0):
    out = {}
    for e in events:
        if e.get("type") != "capability": continue
        out.setdefault(e.get("peer"), []).append({"state": e.get("state"), "via": e.get("via"), "at_s": secs(t0, at_ms(e["at"])) if t0 else None})
    return out


def hooks_seen(run, rows):
    """Hooks each agent ran, as its own records show them: Claude's transcript hook rows, Codex's hook/started items."""
    claude = {}
    for r in rows or []:
        a = r.get("attachment") or {}
        if str(a.get("type", "")).startswith("hook") and a.get("hookName"):
            claude[a["hookName"]] = claude.get(a["hookName"], 0) + 1
    codex = sum(1 for m in (run.get("codexMessages") or []) if m.get("method") == "hook/started")
    return {"claude_transcript_rows": claude, "codex_hook_runs": codex, "conditions": run.get("conditions")}


# ---- contributions ---------------------------------------------------------------------------------------------

def rel(root, path):
    p = Path(path)
    if not p.is_absolute(): p = root / p
    try: return str(p.resolve().relative_to(root))
    except (ValueError, OSError): return ""


def unified_sides(diff):
    """Added and removed lines of a unified diff; only the leading ---/+++ file headers are skipped."""
    added, removed, in_hunk = [], [], False
    for line in diff.split("\n"):
        if line.startswith("@@"): in_hunk = True; continue
        if not in_hunk and (line.startswith("--- ") or line.startswith("+++ ")): continue
        if line.startswith("+"): added.append(line[1:])
        elif line.startswith("-"): removed.append(line[1:])
    return "\n".join(added), "\n".join(removed)


def writes_of(run, rows, root):
    """Applied writes in order: (agent, path, kind, added, removed). kind: edit, replace (whole file) or delete."""
    out, opaque = [], set()
    start = run.get("codexTaskStart") or 0
    for m, it in items(run.get("codexMessages") or [], start):
        if it.get("type") == "commandExecution" and any((a or {}).get("type") not in ("read", "listFiles", "search") for a in it.get("commandActions") or []):
            opaque.add("codex")
        if it.get("type") != "fileChange" or it.get("status") not in (None, "completed"): continue
        for change in it.get("changes", []):
            path = rel(root, change.get("path", ""))
            kind = ((change.get("kind") or {}).get("type") if isinstance(change.get("kind"), dict) else change.get("kind")) or "update"
            diff = change.get("diff") or ""
            if kind == "add": out.append(("codex", path, "replace", diff, ""))
            elif kind == "delete": out.append(("codex", path, "delete", "", ""))
            else:
                added, removed = unified_sides(diff)
                out.append(("codex", path, "edit", added, removed))
    if rows is not None:
        failed = set()
        for r in rows:
            content = (r.get("message") or {}).get("content")
            for c in content if isinstance(content, list) else []:
                if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("is_error"): failed.add(c.get("tool_use_id"))
        seen = set()
        for r in rows:
            if r.get("type") != "assistant": continue
            for c in (r.get("message") or {}).get("content", []):
                if not isinstance(c, dict) or c.get("type") != "tool_use" or c.get("id") in seen or c.get("id") in failed: continue
                seen.add(c.get("id"))
                i, name = c.get("input") or {}, c.get("name")
                path = rel(root, i.get("file_path", "")) if i.get("file_path") else ""
                if name == "Edit": out.append(("claude", path, "edit", i.get("new_string", ""), i.get("old_string", "")))
                elif name == "Write": out.append(("claude", path, "replace", i.get("content", ""), ""))
                elif name == "MultiEdit":
                    for e in i.get("edits", []): out.append(("claude", path, "edit", e.get("new_string", ""), e.get("old_string", "")))
                elif name in ("Bash", "NotebookEdit"): opaque.add("claude")
    return [w for w in out if w[1]], opaque


def contributions(run, rows):
    root = Path(run["cwd"]).resolve()
    base_ref = run.get("sealedCommit") or "HEAD"
    coverage = []
    if rows is None and "claude" in str(run.get("kind") or ""): coverage.append("no Claude transcript: Claude's writes are not counted")

    def base_text(path):
        p = subprocess.run(["git", "show", f"{base_ref}:{path}"], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return p.stdout.decode("utf-8", "replace") if p.returncode == 0 else ""

    def final_text(path):
        f = root / path
        try: return f.read_text(encoding="utf-8", errors="replace") if f.exists() else ""
        except OSError: return None

    lines = lambda text: {l.strip() for l in text.split("\n") if len(l.strip()) >= 8}
    writes, opaque = writes_of(run, rows, root)
    for agent in sorted(opaque): coverage.append(f"{agent} also wrote through shell commands, which no record attributes")
    own = {}  # (agent, path) -> {"ids": set, "lines": set}
    for agent, path, kind, added, removed in writes:
        base = base_text(path)
        mine = own.setdefault((agent, path), {"ids": set(), "lines": set()})
        if kind == "delete": mine["ids"].clear(); mine["lines"].clear(); continue
        if kind == "replace":  # what it no longer writes, it removed itself
            mine["ids"] &= set(IDENT.findall(added)); mine["lines"] &= lines(added)
        else:
            mine["ids"] -= set(IDENT.findall(removed)) - set(IDENT.findall(added)); mine["lines"] -= lines(removed)
        mine["ids"] |= set(IDENT.findall(added)) - set(IDENT.findall(removed)) - set(IDENT.findall(base))
        mine["lines"] |= lines(added) - lines(removed) - lines(base)
    lost_ids, lost_lines = [], []
    for (agent, path), mine in sorted(own.items()):
        final = final_text(path)
        if final is None: coverage.append(f"{path} could not be read"); continue
        for ident in sorted(mine["ids"] - set(IDENT.findall(final))): lost_ids.append({"agent": agent, "path": path, "identifier": ident})
        for line in sorted(mine["lines"] - lines(final)): lost_lines.append({"agent": agent, "path": path, "line": line[:200]})
    return {"identifiers": lost_ids, "lines": lost_lines, "coverage": coverage}


# ---- one attempt -----------------------------------------------------------------------------------------------

def ledger_of(run):
    t0, tasks = task_times(run)
    events = run.get("events") or []
    row = {"case": run.get("index"), "arm": run.get("kind"), "repeat": run.get("repeat"), "end_reason": run.get("end_reason"),
           "elapsed_s": round(run["elapsedMs"] / 1000, 1) if isinstance(run.get("elapsedMs"), (int, float)) else None}
    if t0 is None:
        row["status"] = "no tasks: a setup-only or failed-before-assignment attempt"
        return row
    rows = transcript_rows(run)
    codex_done = max((t["done"] for t in tasks if t["owner"] == "codex" and t["done"] is not None), default=None)
    claude_done = max((t["done"] for t in tasks if t["owner"] == "claude" and t["done"] is not None), default=None)
    all_done = all(t["done"] is not None for t in tasks)
    turn_ends = [at_ms(e["at"]) for e in events if e.get("type") in ("turn_end", "native_turn_end")]
    last_done = max((t["done"] for t in tasks if t["done"] is not None), default=None)
    write_times = claude_write_times(rows)
    for m, it in items(run.get("codexMessages") or [], run.get("codexTaskStart") or 0):
        if it.get("type") == "fileChange" and it.get("status") in (None, "completed") and m.get("emittedAtMs"): write_times.append(m["emittedAtMs"])
    row.update({
        "completed": row["end_reason"] == "completed" and all_done,
        "both_done_s": secs(t0, last_done) if all_done else None,
        "done_s": {str(t["id"]): secs(t0, t["done"]) for t in tasks},
        "intents_s": {str(t["id"]): secs(t0, t["intent"]) for t in tasks},
        "first_candidate_s": secs(t0, min(write_times)) if write_times else None,
        "integrated_s": secs(t0, max((t["integrated"] for t in tasks if t["integrated"]), default=None)),
        "integration": {"requests": sum(t["requests"] for t in tasks), "unresolved": sum(1 for t in tasks if t["unresolved"])},
        "check_s": secs(t0, max((t["check"] for t in tasks if t["check"]), default=None)),
        "settlement_s": secs(t0, max((e for e in turn_ends if last_done is not None and e >= last_done), default=None)),
        "codex": codex_in_task(run, codex_done),
        "claude": claude_in_task(rows, run.get("startedAt"), claude_done),
        "post_done_turns": post_done_turns(run, t0, codex_done),
        "late_replies": late_replies(run, t0, codex_done),
        "facts": facts_of(events),
        "capability": capability_of(events, t0),
        "quiet": sum(1 for e in events if e.get("type") == "quiet"),
        "fyi": sum(1 for e in events if e.get("type") == "envelope" and e.get("from") in ("claude", "codex") and e.get("dropped") == "fyi"),
        "stale": sum(1 for e in events if e.get("type") == "stale"),
        "split_predictions": [{k: e.get(k) for k in ("task", "verdict", "single", "splitS", "singleS", "reason") if e.get(k) is not None} for e in events if e.get("type") == "split"],
        "hooks": hooks_seen(run, rows),
        "contributions": contributions(run, rows),
    })
    return row


def summarize(rows):
    by = {}
    for r in rows: by.setdefault(r["arm"], []).append(r)
    out = {}
    for arm, rs in by.items():
        done = [r for r in rs if r.get("completed")]
        out[arm] = {
            "attempts": len(rs), "completed": len(done),
            "not_completed": sorted({str(r.get("end_reason")) for r in rs if not r.get("completed")}),
            "both_done_s_median_completed": median([r["both_done_s"] for r in done]),
            "codex_usage_events_median": median([r["codex"]["usage_events"] for r in done if r.get("codex")]),
            "codex_turns_median": median([r["codex"]["turns"] for r in done if r.get("codex")]),
            "claude_provider_requests_median": median([r["claude"]["provider_requests"] for r in done if r.get("claude")]),
            "hub_send_total": sum(r["codex"]["hub_send"] for r in rs if r.get("codex")),
            "post_done_turns_total": sum(len(r.get("post_done_turns", [])) for r in rs),
            "late_replies_total": sum(len(r.get("late_replies", [])) for r in rs),
            "quiet_total": sum(r.get("quiet", 0) for r in rs),
            "fact_offers_total": sum(sum(r["facts"][v]["offers"] for v in ("hook", "steer", "done")) for r in rs if r.get("facts")),
            "fact_bytes_total": sum(sum(r["facts"][v]["bytes"] for v in ("hook", "steer", "done")) for r in rs if r.get("facts")),
            "integration_requests_total": sum(r.get("integration", {}).get("requests", 0) for r in rs),
            "integration_unresolved_total": sum(r.get("integration", {}).get("unresolved", 0) for r in rs),
            "lost_identifiers_total": sum(len(r["contributions"]["identifiers"]) for r in rs if r.get("contributions")),
            "lost_lines_total": sum(len(r["contributions"]["lines"]) for r in rs if r.get("contributions")),
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
