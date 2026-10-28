# Model-free native receipt of the headless Claude permission transport (#843 AC5, task #507).
# Repeats the case table of 2026-10-23-headless-claude-permissions.md on each installed binary given.
# Usage: python3 claude-permission-transport-native.py OUTPUT --claude /absolute/claude [--claude ...]
# Default: nine Write cases. --tool Bash selects a harmless fixture writer; --rewrite-bash narrows Bash to two replacement cases.
# No account, no provider, no model: a loopback server supplies the fixed tool call, then a completion.
import argparse, hashlib, http.server, json, os, pathlib, re, shlex, signal, subprocess, threading, time

def mcp_name(value):
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', value):
        raise argparse.ArgumentTypeError('MCP names must be 1..64 ASCII letters, digits, underscores or hyphens, starting with a letter')
    return value


parser = argparse.ArgumentParser()
parser.add_argument('output')
parser.add_argument('--claude', action='append', required=True)
parser.add_argument('--tool', choices=('Write', 'Bash'), default='Write')
parser.add_argument('--rewrite-bash', action='store_true', help='Bash only: two allow/deny cases proving native updatedInput command replacement')
parser.add_argument('--server-name', type=mcp_name, default='fixture')
parser.add_argument('--permission-tool', type=mcp_name, default='approve')
parser.add_argument('--require-tool-use-id', action='store_true', help='Advertise the three required production permission fields and reject extra properties')
args = parser.parse_args()
if args.rewrite_bash and args.tool != 'Bash': parser.error('--rewrite-bash requires --tool Bash')
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
        r = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': os.environ.get('SERVER_NAME', 'fixture'), 'version': '1'}}
    elif method == 'tools/list':
        schema = {'type': 'object', 'properties': {'tool_name': {'type': 'string'}, 'input': {'type': 'object'}, 'tool_use_id': {'type': 'string'}}, 'required': ['tool_name', 'input']}
        if os.environ.get('REQUIRE_TOOL_USE_ID') == '1':
            schema['required'].append('tool_use_id'); schema['additionalProperties'] = False
            schema['properties']['tool_name']['maxLength'] = 128; schema['properties']['tool_use_id']['maxLength'] = 256
        tools = [] if case == 'missing-tool' else [{'name': os.environ.get('PERMISSION_TOOL', 'approve'), 'description': 'Person approval fixture', 'inputSchema': schema}]
        r = {'tools': tools}
    elif method == 'tools/call':
        args = q.get('params', {}).get('arguments', {})
        record = {'arguments': args}
        if os.environ.get('PERMISSION_TOOL') or os.environ.get('REQUIRE_TOOL_USE_ID') == '1': record['tool'] = q.get('params', {}).get('name')
        rewrite = os.environ.get('REWRITE_COMMAND')
        if rewrite:
            record['response'] = {'behavior': 'allow', 'updatedInput': {**args.get('input', {}), 'command': rewrite}}
        with open(os.environ['RECEIPT'], 'a') as f: print(json.dumps(record), file=f)
        if case == 'pending': time.sleep(120)
        if case == 'disconnect': sys.exit(1)
        if case == 'mcp-error':
            print(json.dumps({'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32000, 'message': 'fixture hub unavailable'}}), flush=True); continue
        if case == 'deadline': time.sleep(.1)
        if case in ('deny', 'hook-deny', 'deadline'):
            value = {'behavior': 'deny', 'message': 'no person answered' if case == 'deadline' else 'fixture denied'}
        else:
            value = record.get('response', {'behavior': 'allow', 'updatedInput': args.get('input', {})})
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
        content = [{'type': 'text', 'text': 'Fixture finished.'}] if done else [{'type': 'tool_use', 'id': 'toolu_probe_0', 'name': state['tool'], 'input': state['input']}]
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


HOOK_FAIL = {'hooks': {'PreToolUse': [{'matcher': args.tool, 'hooks': [{'type': 'command', 'command': 'exit 1'}]}]}}
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

selected_cases = {case: value for case, value in CASES.items() if not args.rewrite_bash or case in ('allow', 'deny')}
results = []
for index, raw in enumerate(args.claude):
    binary = pathlib.Path(raw).resolve()
    digest = sha(binary)
    # The index keeps two binaries with the same basename or the same version in separate directories.
    ident = ROOT / ('identity-%d-%s' % (index, binary.name)); ident.mkdir()
    v = subprocess.run([str(binary), '--version'], env={'HOME': str(ident), 'CLAUDE_CONFIG_DIR': str(ident / 'config'), 'PATH': '/usr/bin:/bin'}, capture_output=True, text=True, timeout=10)
    assert v.returncode == 0, v
    version = v.stdout.strip().split()[0]
    for case, (settings, want_exit, want_calls, want_file, want_error, want_stop) in selected_cases.items():
        d = ROOT / ('%d-%s-%s' % (index, version, case)); d.mkdir()
        home = d / 'home'; home.mkdir(); work = d / 'work'; work.mkdir(); work = work.resolve()
        target = work / 'probe.txt'
        out = {'version': version, 'binarySha256': digest, 'case': case}
        if args.tool != 'Write': out.update(tool=args.tool, rewriteBash=args.rewrite_bash)
        if args.server_name != 'fixture' or args.permission_tool != 'approve' or args.require_tool_use_id: out.update(serverName=args.server_name, permissionTool=args.permission_tool, requireToolUseId=args.require_tool_use_id)
        srv = native = None
        try:
            harmless = 'printf %s probe > ' + shlex.quote(str(target))
            tool_input = {'file_path': str(target), 'content': 'probe'} if args.tool == 'Write' else {'command': 'bun test test/ci-watch.test.ts' if args.rewrite_bash else harmless}
            settings = dict(settings)
            if args.tool == 'Bash': settings['permissions'] = {'ask': ['Bash']}
            fixture_path = '/usr/bin:/bin'
            original_marker = work / 'original-command-ran'
            if args.rewrite_bash:
                (work / 'test').mkdir()
                (work / 'test' / 'ci-watch.test.ts').write_text('throw new Error("original command must not execute");\n')
                (work / 'test' / 'ci-watch.test.ts').chmod(0o600)
                fixture_bin = d / 'bin'; fixture_bin.mkdir(mode=0o700)
                fake_bun = fixture_bin / 'bun'
                fake_bun.write_text('#!/bin/sh\nprintf %s original > ' + shlex.quote(str(original_marker)) + '\nexit 97\n')
                fake_bun.chmod(0o700)
                fixture_path = str(fixture_bin.resolve()) + ':' + fixture_path
            mcp_env = {'CASE': case, 'RECEIPT': str(d / 'mcp.jsonl')}
            if args.server_name != 'fixture': mcp_env['SERVER_NAME'] = args.server_name
            if args.permission_tool != 'approve': mcp_env['PERMISSION_TOOL'] = args.permission_tool
            if args.require_tool_use_id: mcp_env['REQUIRE_TOOL_USE_ID'] = '1'
            if args.rewrite_bash and case == 'allow': mcp_env['REWRITE_COMMAND'] = harmless
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            srv.state = {'requests': 0, 'target': str(target), 'tools_file': str(d / 'tools.json'), 'tool': args.tool, 'input': tool_input}
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            (d / 'mcp.json').write_text(json.dumps({'mcpServers': {args.server_name: {'command': '/usr/bin/python3', 'args': [str(ROOT / 'mcp.py')], 'env': mcp_env}}}))
            (d / 'settings.json').write_text(json.dumps(settings))
            env = {'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(home / 'config'), 'PATH': fixture_path, 'ANTHROPIC_BASE_URL': 'http://127.0.0.1:%d' % srv.server_port, 'ANTHROPIC_API_KEY': 'synthetic-probe-not-a-credential', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1'}
            argv = [str(binary), '-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', str(d / 'mcp.json'), '--setting-sources', '', '--settings', str(d / 'settings.json'), '--permission-mode', 'default', '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__%s__%s' % (args.server_name, args.permission_tool), '--model', 'claude-sonnet-4-5', 'Run the fixture write.' if args.tool == 'Write' else 'Run the fixture Bash command.']
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
                assert call['tool_name'] == args.tool and call['input'] == tool_input and call['tool_use_id'] == 'toolu_probe_0', call
                if args.permission_tool != 'approve' or args.require_tool_use_id: assert calls[0]['tool'] == args.permission_tool, calls[0]
                if args.rewrite_bash and case == 'allow':
                    assert calls[0]['response'] == {'behavior': 'allow', 'updatedInput': {'command': harmless}}, calls[0]
            if args.rewrite_bash:
                out['originalCommandExecuted'] = original_marker.exists()
                assert not original_marker.exists(), 'original bun command executed instead of the rewritten fixture writer'
                assert tool_input == {'command': 'bun test test/ci-watch.test.ts'}, tool_input
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
            if args.rewrite_bash:
                out['originalCommandExecuted'] = original_marker.exists()
                if out['originalCommandExecuted']: out.update(passed=False, error='original bun command executed instead of the rewritten fixture writer')
            out['binaryUnchanged'] = sha(binary) == digest
            if not out['binaryUnchanged']: out.update(passed=False, error='native binary changed during probe')
        results.append(out)
        print(json.dumps(out), flush=True)
receipt = {'cases': results, 'certified': all(r['passed'] for r in results), 'account': False, 'inference': False}
if args.tool != 'Write': receipt.update(tool=args.tool, rewriteBash=args.rewrite_bash)
if args.server_name != 'fixture' or args.permission_tool != 'approve' or args.require_tool_use_id: receipt.update(serverName=args.server_name, permissionTool=args.permission_tool, requireToolUseId=args.require_tool_use_id)
(ROOT / 'receipt.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps({'receipt': str(ROOT / 'receipt.json'), 'certified': receipt['certified']}), flush=True)
raise SystemExit(0 if receipt['certified'] else 1)
