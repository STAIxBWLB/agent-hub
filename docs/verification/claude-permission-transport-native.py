# Model-free native receipt of the headless Claude permission transport (#843 AC5, task #507).
# Repeats the case table of 2026-10-23-headless-claude-permissions.md on each installed binary given.
# Usage: python3 claude-permission-transport-native.py OUTPUT --claude /absolute/claude [--claude ...]
# No account, no provider, no model: a loopback server answers with a fixed Write tool call, then a completion.
import argparse, hashlib, http.server, json, os, pathlib, signal, subprocess, threading, time

parser = argparse.ArgumentParser()
parser.add_argument('output')
parser.add_argument('--claude', action='append', required=True)
args = parser.parse_args()
ROOT = pathlib.Path(args.output).resolve()
ROOT.mkdir(mode=0o700, parents=False, exist_ok=False)

# Fixture stdio MCP server. It records the call first, then behaves as the case says.
MCP = r'''import sys, json, os, time
case = os.environ['CASE']
for line in sys.stdin:
    try: q = json.loads(line)
    except Exception: continue
    method, rid = q.get('method'), q.get('id')
    if rid is None: continue
    if method == 'initialize':
        r = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'fixture', 'version': '1'}}
    elif method == 'tools/list':
        tools = [] if case == 'missing-tool' else [{'name': 'approve', 'description': 'Person approval fixture', 'inputSchema': {'type': 'object', 'properties': {'tool_name': {'type': 'string'}, 'input': {'type': 'object'}, 'tool_use_id': {'type': 'string'}}, 'required': ['tool_name', 'input']}}]
        r = {'tools': tools}
    elif method == 'tools/call':
        args = q.get('params', {}).get('arguments', {})
        with open(os.environ['RECEIPT'], 'a') as f: print(json.dumps({'arguments': args}), file=f)
        if case == 'pending': time.sleep(120)
        if case == 'disconnect': sys.exit(1)
        if case == 'mcp-error':
            print(json.dumps({'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32000, 'message': 'fixture hub unavailable'}}), flush=True); continue
        if case == 'deadline': time.sleep(.1)
        if case in ('deny', 'hook-deny', 'deadline'):
            value = {'behavior': 'deny', 'message': 'no person answered' if case == 'deadline' else 'fixture denied'}
        else:
            value = {'behavior': 'allow', 'updatedInput': args.get('input', {})}
        r = {'content': [{'type': 'text', 'text': json.dumps(value)}]}
    else:
        r = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': rid, 'result': r}), flush=True)
'''
(ROOT / 'mcp.py').write_text(MCP)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_POST(self):
        q = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        state = self.server.state
        state['requests'] += 1
        if 'count_tokens' in self.path:
            self.send_response(200); self.end_headers(); self.wfile.write(json.dumps({'input_tokens': 100}).encode()); return
        if state.get('tools_file') and not os.path.exists(state['tools_file']):
            with open(state['tools_file'], 'w') as f: json.dump(q.get('tools', []), f)
        msgs = q.get('messages', [])
        results = sum(1 for m in msgs if isinstance(m.get('content'), list) for x in m['content'] if isinstance(x, dict) and x.get('type') == 'tool_result')
        done = results >= 1
        content = [{'type': 'text', 'text': 'Fixture finished.'}] if done else [{'type': 'tool_use', 'id': 'toolu_probe_0', 'name': 'Write', 'input': {'file_path': state['target'], 'content': 'probe'}}]
        result = {'id': 'msg_probe_%d' % results, 'type': 'message', 'role': 'assistant', 'model': 'claude-sonnet-4-5', 'content': content, 'stop_reason': 'end_turn' if done else 'tool_use', 'stop_sequence': None, 'usage': {'input_tokens': 100, 'output_tokens': 10}}
        if not q.get('stream'):
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(result).encode()); return
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        start = dict(result); start.update(content=[], stop_reason=None, usage={'input_tokens': 100, 'output_tokens': 0})
        events = [('message_start', {'type': 'message_start', 'message': start})]
        for i, c in enumerate(content):
            block = dict(c)
            if c['type'] == 'tool_use': block['input'] = {}
            else: block['text'] = ''
            delta = {'type': 'input_json_delta', 'partial_json': json.dumps(c['input'])} if c['type'] == 'tool_use' else {'type': 'text_delta', 'text': c['text']}
            events.extend([('content_block_start', {'type': 'content_block_start', 'index': i, 'content_block': block}), ('content_block_delta', {'type': 'content_block_delta', 'index': i, 'delta': delta}), ('content_block_stop', {'type': 'content_block_stop', 'index': i})])
        events.extend([('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': result['stop_reason'], 'stop_sequence': None}, 'usage': {'output_tokens': 10}}), ('message_stop', {'type': 'message_stop'})])
        try:
            for e, v in events:
                self.wfile.write(('event: ' + e + '\ndata: ' + json.dumps(v) + '\n\n').encode()); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def sha(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def empty_group(pid):
    try:
        table = subprocess.run(['/bin/ps', '-axo', 'pgid=,stat='], env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'TZ': 'UTC'}, capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return False
    if table.returncode or len(table.stdout) > 1024 * 1024: return False
    rows = [line.split() for line in table.stdout.splitlines() if line.strip()]
    return bool(rows) and all(len(r) == 2 for r in rows) and not any(r[0] == str(pid) and not r[1].startswith('Z') for r in rows)


def rows(file):
    return [json.loads(line) for line in file.read_text().splitlines() if line] if file.exists() else []


HOOK_FAIL = {'hooks': {'PreToolUse': [{'matcher': 'Write', 'hooks': [{'type': 'command', 'command': 'exit 1'}]}]}}
# case -> (settings, expected native exit, mcp calls, file written, tool_result is_error, external stop expected)
CASES = {
    'allow':         ({}, 0, 1, True, False, False),
    'deny':          ({}, 0, 1, False, True, False),
    'missing-tool':  ({}, 1, 0, False, None, False),
    'hook-deny':     (HOOK_FAIL, 0, 1, False, True, False),
    'hook-allow':    (HOOK_FAIL, 0, 1, True, False, False),
    'mcp-error':     ({}, 0, 1, False, True, False),
    'disconnect':    ({}, 0, 1, False, True, False),
    'pending':       ({}, None, 1, False, None, True),
    'deadline':      ({}, 0, 1, False, True, False),
}

results = []
for index, raw in enumerate(args.claude):
    binary = pathlib.Path(raw).resolve()
    digest = sha(binary)
    # The index keeps two binaries with the same basename or the same version in separate directories.
    ident = ROOT / ('identity-%d-%s' % (index, binary.name)); ident.mkdir()
    v = subprocess.run([str(binary), '--version'], env={'HOME': str(ident), 'CLAUDE_CONFIG_DIR': str(ident / 'config'), 'PATH': '/usr/bin:/bin'}, capture_output=True, text=True, timeout=10)
    assert v.returncode == 0, v
    version = v.stdout.strip().split()[0]
    for case, (settings, want_exit, want_calls, want_file, want_error, want_stop) in CASES.items():
        d = ROOT / ('%d-%s-%s' % (index, version, case)); d.mkdir()
        home = d / 'home'; home.mkdir(); work = d / 'work'; work.mkdir(); work = work.resolve()
        target = work / 'probe.txt'
        out = {'version': version, 'binarySha256': digest, 'case': case}
        srv = native = None
        try:
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            srv.state = {'requests': 0, 'target': str(target), 'tools_file': str(d / 'tools.json')}
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            (d / 'mcp.json').write_text(json.dumps({'mcpServers': {'fixture': {'command': '/usr/bin/python3', 'args': [str(ROOT / 'mcp.py')], 'env': {'CASE': case, 'RECEIPT': str(d / 'mcp.jsonl')}}}}))
            (d / 'settings.json').write_text(json.dumps(settings))
            env = {'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(home / 'config'), 'PATH': '/usr/bin:/bin', 'ANTHROPIC_BASE_URL': 'http://127.0.0.1:%d' % srv.server_port, 'ANTHROPIC_API_KEY': 'synthetic-probe-not-a-credential', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1'}
            argv = [str(binary), '-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', str(d / 'mcp.json'), '--setting-sources', '', '--settings', str(d / 'settings.json'), '--permission-mode', 'default', '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__fixture__approve', '--model', 'claude-sonnet-4-5', 'Run the fixture write.']
            started = time.monotonic()
            native = subprocess.Popen(argv, cwd=work, env=env, stdout=open(d / 'stdout', 'w'), stderr=open(d / 'stderr', 'w'), start_new_session=True)
            stopped_externally = False
            try:
                native.wait(timeout=25)
            except subprocess.TimeoutExpired:
                stopped_externally = True
                os.killpg(native.pid, signal.SIGKILL); native.wait(timeout=5)
            elapsed = round(time.monotonic() - started, 3)
            calls = rows(d / 'mcp.jsonl')
            frames = rows(d / 'stdout')
            tool_results = [b for f in frames if f.get('type') == 'user' for b in f.get('message', {}).get('content', []) if isinstance(b, dict) and b.get('type') == 'tool_result']
            final = [f for f in frames if f.get('type') == 'result']
            written = target.exists() and target.read_text() == 'probe'
            out.update(nativeExit=None if stopped_externally else native.returncode, stoppedExternally=stopped_externally, mcpCalls=len(calls), fileWritten=written, toolResultErrors=[b.get('is_error') for b in tool_results], resultFrame=[{'is_error': f.get('is_error'), 'denials': len(f.get('permission_denials', []))} for f in final], elapsedSeconds=elapsed, requests=srv.state['requests'])
            assert stopped_externally == want_stop, ('external stop', stopped_externally)
            if want_exit is not None: assert native.returncode == want_exit, ('exit', native.returncode, (d / 'stderr').read_text()[-400:])
            assert len(calls) == want_calls, ('mcp calls', calls)
            if want_calls:
                call = calls[0]['arguments']
                assert call['tool_name'] == 'Write' and call['input'] == {'file_path': str(target), 'content': 'probe'} and call['tool_use_id'] == 'toolu_probe_0', call
            assert written == want_file, ('file written', written)
            # A successful native tool_result carries no is_error key at all; only a failed one sets it to true.
            if want_error is not None: assert [b.get('is_error') is True for b in tool_results] == [want_error], tool_results
            if case in ('deny', 'hook-deny', 'deadline'): assert final and final[0].get('permission_denials') and len(final[0]['permission_denials']) == 1, final
            out['passed'] = True
        except Exception as error:
            out.update(passed=False, error=repr(error))
        finally:
            if native is not None:
                if native.poll() is None:
                    try: os.killpg(native.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    native.wait(timeout=5)
                end = time.monotonic() + 1
                while not empty_group(native.pid) and time.monotonic() < end: time.sleep(.02)
                out['nativeGroupEmpty'] = empty_group(native.pid)
                if not out['nativeGroupEmpty']: out.update(passed=False, cleanup='native group not established empty')
            if srv: srv.shutdown()
            out['binaryUnchanged'] = sha(binary) == digest
            if not out['binaryUnchanged']: out.update(passed=False, error='native binary changed during probe')
        results.append(out)
        print(json.dumps(out), flush=True)
receipt = {'cases': results, 'certified': all(r['passed'] for r in results), 'account': False, 'inference': False}
(ROOT / 'receipt.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps({'receipt': str(ROOT / 'receipt.json'), 'certified': receipt['certified']}), flush=True)
raise SystemExit(0 if receipt['certified'] else 1)
