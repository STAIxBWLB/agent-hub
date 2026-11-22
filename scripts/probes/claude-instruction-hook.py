#!/usr/bin/env python3
"""Isolated native probe. Usage: python3 scripts/probes/claude-instruction-hook.py /absolute/claude ..."""
import http.server
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
PLUGIN = ROOT / 'plugins/agent-hub'
PROMPT = '/agent-hub:ahub show status'

class Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if 'count_tokens' in self.path:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"input_tokens":100}')
            return
        self.server.requests.append(request)
        tool_result = any(isinstance(message.get('content'), list) and any(isinstance(block, dict) and block.get('type') == 'tool_result' for block in message['content']) for message in request.get('messages', []))
        call_skill = self.server.mode in ('skill', 'subagent') and len(self.server.requests) == 1
        tool_name = 'Skill' if self.server.mode == 'skill' else 'Agent'
        tool_input = {'skill': 'agent-hub:ahub', 'args': 'show status'} if self.server.mode == 'skill' else {'description': 'probe', 'prompt': '/agent-hub:ahub show status', 'subagent_type': 'general-purpose'}
        result = {'id': 'msg_probe', 'type': 'message', 'role': 'assistant', 'model': 'claude-sonnet-4-5', 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 100, 'output_tokens': 0}}
        block = {'type': 'tool_use', 'id': 'toolu_probe', 'name': tool_name, 'input': {}} if call_skill else {'type': 'text', 'text': ''}
        delta = {'type': 'input_json_delta', 'partial_json': json.dumps(tool_input)} if call_skill else {'type': 'text_delta', 'text': 'done'}
        events = [('message_start', {'type': 'message_start', 'message': result}),
                  ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': block}),
                  ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': delta}),
                  ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                  ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if call_skill else 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}),
                  ('message_stop', {'type': 'message_stop'})]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        try:
            for name, data in events:
                self.wfile.write(('event: ' + name + '\ndata: ' + json.dumps(data) + '\n\n').encode())
                self.wfile.flush()
        except BrokenPipeError:
            pass


def probe(binary):
    with tempfile.TemporaryDirectory(prefix='ahub-instruction-probe-') as tmp:
        root = pathlib.Path(tmp).resolve()
        home = root / 'home'; home.mkdir()
        config = home / 'config'; config.mkdir()
        work = root / 'work'; work.mkdir()
        events = root / 'events.jsonl'
        hook = root / 'hook.py'
        hook.write_text("""import json,sys,pathlib,time
x=json.load(sys.stdin)
p=pathlib.Path(x.get('transcript_path',''))
def count():
 try: return len([line for line in p.read_text().splitlines() if line.strip()])
 except OSError: return 0
x['probe_initial_rows']=count()
time.sleep(2)
x['probe_delayed_rows']=count()
with open(""" + repr(str(events)) + """,'a') as f: f.write(json.dumps(x)+'\\n')
""")
        (config / 'settings.json').write_text(json.dumps({'hooks': {'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': '/usr/bin/python3 ' + shlex.quote(str(hook))}]}]}}))
        # Both paths are isolated. The experiment records whether native onboarding still appears.
        state = {'hasCompletedOnboarding': True, 'projects': {str(work): {'hasTrustDialogAccepted': True}}}
        (home / '.claude.json').write_text(json.dumps(state))
        (config / '.claude.json').write_text(json.dumps(state))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Api); server.requests = []; server.mode = 'typed'
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(config), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'TERM': 'xterm-256color', 'ANTHROPIC_BASE_URL': 'http://127.0.0.1:' + str(server.server_port), 'ANTHROPIC_API_KEY': 'synthetic-probe-not-a-credential', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1'}
        version = subprocess.run([binary, '--version'], cwd=work, env=env, capture_output=True, text=True, timeout=10).stdout.strip()
        socket = 'ahub-instruction-' + uuid.uuid4().hex
        tmux = ['tmux', '-L', socket]
        def run(*args):
            return subprocess.run(tmux + list(args), capture_output=True, text=True, timeout=10)
        command = 'cd ' + shlex.quote(str(work)) + ' && ' + ' '.join(shlex.quote(x) for x in ['/usr/bin/env', '-i'] + [k + '=' + v for k, v in env.items()] + [binary, '--setting-sources', 'user', '--strict-mcp-config', '--plugin-dir', str(PLUGIN), '--model', 'claude-sonnet-4-5']) + '; printf "\\nprobe exited %s\\n" "$?"; sleep 36'
        result = {'version': version, 'typed': 'not_driven', 'skill_tool': 'not_driven', 'subagent': 'not_driven', 'compact': 'not_driven', 'channel': 'not_driven'}
        try:
            started = run('new-session', '-d', '-s', 'probe', '-x', '140', '-y', '40', command)
            if started.returncode:
                result['reason'] = 'tmux start failed'; return result
            start = time.monotonic(); handled = set(); sent = False
            while time.monotonic() - start < 35:
                capture = run('capture-pane', '-p', '-t', 'probe'); pane = capture.stdout
                if capture.returncode:
                    result['reason'] = 'tmux capture failed: ' + capture.stderr.strip(); return result
                if 'Detected a custom API key' in pane and 'key' not in handled:
                    run('send-keys', '-t', 'probe', 'Up', 'Enter'); handled.add('key')
                elif 'trust this folder' in pane and 'trust' not in handled:
                    run('send-keys', '-t', 'probe', 'Down', 'Enter'); handled.add('trust')
                elif 'Syntax theme' in pane and 'theme' not in handled:
                    run('send-keys', '-t', 'probe', 'Enter'); handled.add('theme')
                elif not sent and ('Try "' in pane or 'bypass permissions' in pane or 'Claude Code' in pane and '❯' in pane):
                    run('send-keys', '-t', 'probe', '-l', PROMPT)
                    run('send-keys', '-t', 'probe', 'Enter'); sent = True
                if events.exists():
                    try:
                        rows = [json.loads(line) for line in events.read_text().splitlines() if line.strip()]
                    except json.JSONDecodeError:
                        rows = []
                    if any(row.get('prompt') == PROMPT and row.get('session_id') for row in rows):
                        result['typed'] = 'pass'; result['transcript_counts'] = [rows[-1].get('probe_initial_rows'), rows[-1].get('probe_delayed_rows')]; break
                time.sleep(0.2)
            result['onboarding'] = sorted(handled)
            if result['typed'] != 'pass':
                result['reason'] = 'no matching hook input after bounded TUI attempt'
                result['pane_tail'] = pane[-1200:]
            else:
                # Wait for the typed turn to finish before asking the same TUI to compact.
                for _ in range(100):
                    pane = run('capture-pane', '-p', '-t', 'probe').stdout
                    if server.requests and 'done' in pane:
                        break
                    time.sleep(0.1)
                initial_requests = len(server.requests)
                run('send-keys', '-t', 'probe', '-l', '/compact')
                run('send-keys', '-t', 'probe', 'Enter')
                for _ in range(150):
                    pane = run('capture-pane', '-p', '-t', 'probe').stdout
                    if len(server.requests) > initial_requests and ('compacted' in pane.lower() or 'compaction' in pane.lower()):
                        break
                    time.sleep(0.1)
                rows = [json.loads(line) for line in events.read_text().splitlines() if line.strip()]
                prefixed = [row for row in rows if str(row.get('prompt', '')).startswith('/agent-hub:ahub')]
                driven = len(server.requests) > initial_requests and ('compacted' in pane.lower() or 'compaction' in pane.lower())
                result['compact'] = 'pass' if driven and len(prefixed) == 1 else ('fail' if driven else 'not_driven')
                result['compact_detail'] = pane[-400:]
                # Drive a synthetic model Skill request under a separate print session.
                # Only a new prefixed hook event would fail this negative case.
                before = len([json.loads(line) for line in events.read_text().splitlines() if line.strip()])
                server.requests = []; server.mode = 'skill'
                cmd = [binary, '-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'user', '--strict-mcp-config', '--plugin-dir', str(PLUGIN), '--permission-mode', 'bypassPermissions', '--model', 'claude-sonnet-4-5', 'Probe model skill invocation.']
                child = subprocess.run(cmd, cwd=work, env=env, capture_output=True, text=True, timeout=45)
                rows = [json.loads(line) for line in events.read_text().splitlines() if line.strip()][before:]
                driven = 'disable-model-invocation' in child.stdout and 'toolu_probe' in child.stdout
                result['skill_tool'] = 'pass' if child.returncode == 0 and driven and not any(str(row.get('prompt', '')).startswith('/agent-hub:ahub') for row in rows) else 'fail'
                before = len([json.loads(line) for line in events.read_text().splitlines() if line.strip()])
                server.requests = []; server.mode = 'subagent'
                child = subprocess.run(cmd[:-1] + ['Probe subagent invocation.'], cwd=work, env=env, capture_output=True, text=True, timeout=45)
                rows = [json.loads(line) for line in events.read_text().splitlines() if line.strip()][before:]
                frames = [json.loads(line) for line in child.stdout.splitlines() if line.startswith('{')]
                driven = any(frame.get('parent_tool_use_id') == 'toolu_probe' for frame in frames)
                result['subagent'] = 'pass' if child.returncode == 0 and driven and not any(str(row.get('prompt', '')).startswith('/agent-hub:ahub') for row in rows) else ('fail' if driven else 'not_driven')
                # Native MCP channel sends a prefixed notification into a fresh TUI.
                channel_script = root / 'channel.py'
                marker = root / 'channel-sent'
                channel_script.write_text("""import json,sys,threading,time,pathlib
marker = pathlib.Path(""" + repr(str(marker)) + """)
def send():
 time.sleep(4)
 print(json.dumps({'jsonrpc':'2.0','method':'notifications/claude/channel','params':{'content':'/agent-hub:ahub channel probe','meta':{'source':'probe'}}}),flush=True)
 marker.write_text('sent')
for line in sys.stdin:
 try: msg=json.loads(line)
 except ValueError: continue
 rid=msg.get('id'); method=msg.get('method')
 if method=='initialize':
  print(json.dumps({'jsonrpc':'2.0','id':rid,'result':{'protocolVersion':'2024-11-05','capabilities':{'experimental':{'claude/channel':{}},'tools':{}},'serverInfo':{'name':'probe','version':'1'}}}),flush=True)
 elif method=='notifications/initialized': threading.Thread(target=send,daemon=True).start()
 elif rid is not None: print(json.dumps({'jsonrpc':'2.0','id':rid,'result':{'tools':[]} if method=='tools/list' else {}}),flush=True)
""")
                mcp = root / 'mcp.json'
                mcp.write_text(json.dumps({'mcpServers': {'probe': {'command': '/usr/bin/python3', 'args': [str(channel_script)]}}}))
                channel_command = 'cd ' + shlex.quote(str(work)) + ' && ' + ' '.join(shlex.quote(x) for x in ['/usr/bin/env', '-i'] + [k + '=' + v for k, v in env.items()] + [binary, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', str(mcp), '--dangerously-load-development-channels', 'server:probe', '--model', 'claude-sonnet-4-5']) + '; sleep 36'
                server.requests = []; server.mode = 'typed'
                before = len([json.loads(line) for line in events.read_text().splitlines() if line.strip()])
                started = run('new-session', '-d', '-s', 'channel', '-x', '140', '-y', '40', channel_command)
                channel_sent = False; approved = False
                for _ in range(150):
                    pane = run('capture-pane', '-p', '-t', 'channel').stdout
                    if not approved and ('development channel' in pane.lower() or 'locally' in pane.lower() and 'channel' in pane.lower()):
                        run('send-keys', '-t', 'channel', 'Enter'); approved = True
                    if marker.exists() and not channel_sent:
                        run('send-keys', '-t', 'channel', '-l', 'Check the channel notification.')
                        run('send-keys', '-t', 'channel', 'Enter'); channel_sent = True
                    if channel_sent and '/agent-hub:ahub channel probe' in json.dumps(server.requests):
                        break
                    time.sleep(0.1)
                rows = [json.loads(line) for line in events.read_text().splitlines() if line.strip()][before:]
                driven = started.returncode == 0 and marker.exists() and '/agent-hub:ahub channel probe' in json.dumps(server.requests)
                result['channel'] = 'pass' if driven and not any(str(row.get('prompt', '')).startswith('/agent-hub:ahub') for row in rows) else ('fail' if driven else 'not_driven')
                result['reason'] = 'channel not observed by model' if not driven else ''
                result['channel_detail'] = {'sent': marker.exists(), 'model_received': driven, 'approval_seen': approved, 'pane': pane[-600:]}

            return result
        finally:
            run('kill-server')
            server.shutdown(); server.server_close()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('pass absolute Claude binary paths')
    results = [probe(str(pathlib.Path(arg).resolve())) for arg in sys.argv[1:]]
    print(json.dumps(results, indent=2))
    if any(any(row[key] != 'pass' for key in ('typed', 'skill_tool', 'subagent', 'compact', 'channel')) for row in results):
        raise SystemExit(1)
