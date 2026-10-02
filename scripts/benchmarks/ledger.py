#!/usr/bin/env python3
"""Coordination ledger for a native CooperBench run directory (issue #110). Standard library only.

Usage: python3 scripts/benchmarks/ledger.py --run RUN_DIR [--json]

Reads runs/<NN>-<arm>.json written by native.ts, the Claude transcript each names, and the fixture's git history.
Writes ledger.json next to them. Definitions:
- both_done_s: from the first proposal to the last recorded `done` of the run's tasks.
- codex in-task: Codex requests whose usage arrived, and tool calls made, before its last hub_task_done completed.
- post_done_turns: Codex turns that started after its last recorded done, with what the turn's injected message held
  (reply: a peer message from claude; notice: a completed-change notice; other).
- late_replies: Claude-to-Codex chats that are not important, taken as delivered at Codex's next turn start, counted
  when that is after Codex's done.
- facts, stale, integration_prompts, quiet: the hub's `fact`, `stale`, `task`/`integration prompted` events and
  agents' chat envelopes dropped as fyi.
- lost_contributions: identifiers an agent's own writes introduced (Codex patches; Claude Edit, Write and MultiEdit)
  that the base file did not have and the final file lacks, unless that agent's own later write removed them. A
  heuristic: identifiers in comments and strings count too.
"""
from __future__ import annotations
import argparse, json, re, statistics, subprocess
from datetime import datetime
from pathlib import Path

IDENT = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{3,}\b")


def at_ms(value):
    if isinstance(value, (int, float)): return float(value)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000


def task_times(run):
    t0 = min(h["at"] for t in run.get("taskStates", []) for h in t.get("history", []) if h["event"] == "proposed")
    done = {}
    for t in run.get("taskStates", []):
        dones = [h["at"] for h in t.get("history", []) if h["event"] == "done"]
        if dones: done[t.get("owner")] = (max(dones) - t0) / 1000
    return t0, done


def codex_in_task(msgs):
    """Requests, hub_send calls and board reads before Codex's last hub_task_done completed."""
    last_done = max((i for i, m in enumerate(msgs) if m.get("method") == "item/completed" and m["params"]["item"].get("type") == "mcpToolCall" and m["params"]["item"].get("tool") == "hub_task_done"), default=len(msgs))
    head = msgs[:last_done + 1]
    requests = sum(1 for m in head if m.get("method") == "thread/tokenUsage/updated" and (m.get("params", {}).get("tokenUsage") or {}).get("last"))
    tools = [m["params"]["item"].get("tool") for m in head if m.get("method") == "item/completed" and m["params"]["item"].get("type") == "mcpToolCall"]
    return {"requests": requests, "hub_send": tools.count("hub_send"), "board_reads": tools.count("hub_task_list")}


def post_done_turns(run, t0, codex_done):
    """The k-th Codex turn_start event is the k-th turn/started on the stream; its first injected message says why."""
    if codex_done is None: return []
    starts = [at_ms(e["at"]) for e in run.get("events", []) if e.get("type") == "turn_start" and e.get("peer") == "codex"]
    first, turn = {}, 0
    for m in run.get("codexMessages", []):
        turn += m.get("method") == "turn/started"
        item = (m.get("params") or {}).get("item") or {}
        if turn and turn not in first and m.get("method") == "item/completed" and item.get("type") == "userMessage":
            text = json.dumps(item.get("content"))
            kinds = [k for k, s in (("reply", 'message from \\"claude\\"'), ("notice", "is done and touches")) if s in text]
            first[turn] = "+".join(kinds) or "other"
    return [{"started_s": round((s - t0) / 1000, 1), "trigger": first.get(k + 1, "?")} for k, s in enumerate(starts) if (s - t0) / 1000 > codex_done]


def late_replies(run, t0, codex_done):
    if codex_done is None: return []
    starts = [at_ms(e["at"]) for e in run.get("events", []) if e.get("type") == "turn_start" and e.get("peer") == "codex"]
    out = []
    for e in run.get("events", []):
        if e.get("type") != "envelope" or e.get("from") != "claude" or "codex" not in (e.get("to") or []) or e.get("dropped") or e.get("priority") == "important": continue
        sent = at_ms(e["at"])
        got = next((s for s in starts if s >= sent), None)
        if got is not None and (got - t0) / 1000 > codex_done: out.append(round((got - sent) / 1000, 1))
    return out


def writes_of(run):
    """(agent, path relative to the fixture, added text, removed text) in order."""
    root = Path(run["cwd"]).resolve()
    out = []
    for m in run.get("codexMessages", []):
        item = (m.get("params") or {}).get("item") or {}
        if m.get("method") != "item/completed" or item.get("type") != "fileChange": continue
        for change in item.get("changes", []):
            diff = change.get("diff", "")
            added = "\n".join(l[1:] for l in diff.split("\n") if l.startswith("+") and not l.startswith("+++"))
            removed = "\n".join(l[1:] for l in diff.split("\n") if l.startswith("-") and not l.startswith("---"))
            out.append(("codex", rel(root, change.get("path", "")), added, removed))
    transcript = Path(((run.get("readiness") or {}).get("claude") or {}).get("transcriptPath") or "")
    if transcript.is_file():
        seen = set()
        for line in transcript.read_text(encoding="utf-8").splitlines():
            try: row = json.loads(line)
            except ValueError: continue
            if row.get("type") != "assistant": continue
            for c in row.get("message", {}).get("content", []):
                if not isinstance(c, dict) or c.get("type") != "tool_use" or c.get("id") in seen: continue
                seen.add(c.get("id"))
                i = c.get("input") or {}
                if c.get("name") == "Edit": out.append(("claude", rel(root, i.get("file_path", "")), i.get("new_string", ""), i.get("old_string", "")))
                elif c.get("name") == "Write": out.append(("claude", rel(root, i.get("file_path", "")), i.get("content", ""), ""))
                elif c.get("name") == "MultiEdit":
                    for e in i.get("edits", []): out.append(("claude", rel(root, i.get("file_path", "")), e.get("new_string", ""), e.get("old_string", "")))
    return [w for w in out if w[1]]


def rel(root, path):
    try: return str(Path(path).resolve().relative_to(root))
    except ValueError: return ""


def lost_contributions(run):
    root = Path(run["cwd"])
    base = run.get("sealedCommit", "HEAD")
    def base_text(path):
        p = subprocess.run(["git", "show", f"{base}:{path}"], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return p.stdout.decode("utf-8", "replace") if p.returncode == 0 else ""
    def final_text(path):
        try: return (root / path).read_text(encoding="utf-8", errors="replace")
        except OSError: return ""
    writes = writes_of(run)
    lost = []
    for i, (agent, path, added, removed) in enumerate(writes):
        introduced = set(IDENT.findall(added)) - set(IDENT.findall(removed)) - set(IDENT.findall(base_text(path)))
        final = set(IDENT.findall(final_text(path)))
        own_later = set().union(*[set(IDENT.findall(w[3])) for w in writes[i + 1:] if w[0] == agent and w[1] == path] or [set()])
        for ident in sorted(introduced - final - own_later):
            lost.append({"agent": agent, "path": path, "identifier": ident})
    return lost


def ledger_of(run):
    t0, done = task_times(run)
    codex_done = done.get("codex")
    events = run.get("events", [])
    row = {
        "case": run.get("index"), "arm": run.get("kind"), "end_reason": run.get("end_reason"),
        "both_done_s": round(max(done.values()), 1) if done else None,
        "done_s": {k: round(v, 1) for k, v in done.items()},
        "codex_in_task": codex_in_task(run.get("codexMessages", [])) if run.get("codexMessages") else None,
        "post_done_turns": post_done_turns(run, t0, codex_done),
        "late_replies": late_replies(run, t0, codex_done),
        "facts": {"hook": sum(1 for e in events if e.get("type") == "fact" and e.get("via") == "hook"), "steer": sum(1 for e in events if e.get("type") == "fact" and e.get("via") == "steer" and not e.get("dropped")), "dropped": sum(1 for e in events if e.get("type") == "fact" and e.get("dropped"))},
        "stale": sum(1 for e in events if e.get("type") == "stale"),
        "integration_prompts": sum(1 for e in events if e.get("type") == "task" and e.get("event") == "integration prompted"),
        "quiet": sum(1 for e in events if e.get("type") == "envelope" and e.get("from") in ("claude", "codex") and e.get("kind") == "chat" and e.get("dropped") == "fyi"),
        "lost_contributions": lost_contributions(run),
    }
    return row


def summarize(rows):
    by = {}
    for r in rows: by.setdefault(r["arm"], []).append(r)
    med = lambda xs: round(statistics.median(xs), 1) if xs else None
    return {arm: {
        "runs": len(rs),
        "both_done_s_median": med([r["both_done_s"] for r in rs if r["both_done_s"] is not None]),
        "codex_in_task_requests_median": med([r["codex_in_task"]["requests"] for r in rs if r["codex_in_task"]]),
        "hub_send_total": sum(r["codex_in_task"]["hub_send"] for r in rs if r["codex_in_task"]),
        "post_done_turns_total": sum(len(r["post_done_turns"]) for r in rs),
        "late_replies_total": sum(len(r["late_replies"]) for r in rs),
        "facts_total": sum(r["facts"]["hook"] + r["facts"]["steer"] for r in rs),
        "integration_prompts_total": sum(r["integration_prompts"] for r in rs),
        "lost_contributions_total": sum(len(r["lost_contributions"]) for r in rs),
    } for arm, rs in by.items()}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    rows = [ledger_of(json.loads(f.read_text(encoding="utf-8"))) for f in sorted((a.run / "runs").glob("*.json"))]
    out = {"rows": rows, "summary": summarize(rows)}
    (a.run / "ledger.json").write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if a.json: print(json.dumps(out, indent=2, sort_keys=True))
    else:
        for arm, s in out["summary"].items(): print(arm, json.dumps(s, sort_keys=True))


if __name__ == "__main__":
    main()
