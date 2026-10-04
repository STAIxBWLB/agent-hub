#!/usr/bin/env python3
"""Pilot peer bus for the joint Pi/Qwen CooperBench arm (issue #140): one MCP tool, hub_send, that forwards a
short implementation contract to the arm's tool server, which publishes it to the other assigned peer. The URL
and bearer token come from the environment the driver sets; nothing else is served."""
import sys, json, os, urllib.request

for line in sys.stdin:
    try:
        m = json.loads(line)
        rid = m.get("id")
        method = m.get("method")
        if rid is None:
            continue
        if method == "initialize":
            result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "pilot-peer-bus", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "hub_send", "description": "Send a short implementation contract to the other assigned peer. No tool output.", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}]}
        elif method == "tools/call":
            args = m.get("params", {}).get("arguments", {})
            req = urllib.request.Request(os.environ["AGENTHUB_PILOT_TOOL_URL"], data=json.dumps({"text": str(args.get("text", ""))[:4000]}).encode(), headers={"Authorization": "Bearer " + os.environ["AGENTHUB_PILOT_TOOL_TOKEN"], "Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=5).read()
            result = {"content": [{"type": "text", "text": "sent to assigned peer"}]}
        else:
            result = {}
        print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}), flush=True)
    except Exception:
        if "rid" in locals() and rid is not None:
            print(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": "pilot tool failed"}}), flush=True)
