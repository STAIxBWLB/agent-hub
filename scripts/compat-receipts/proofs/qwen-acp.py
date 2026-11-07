"""Parameterized promotion of receipt 749's 897ff1b6 ACP producer.

The original protocol assertions remain; receipt-observed metadata and positive
network/group observations are explicit gates. Importing this file runs nothing.
Process-group emptiness is a bounded observation, not runner-lifetime proof.
"""
import json
import os
import pathlib
import selectors
import signal
import subprocess
import sys
import time


def run_qwen_acp(config):
    root = pathlib.Path(config['root'])
    root.mkdir(mode=0o700, exist_ok=False)
    home, cwd, tmp = root / 'home', root / 'cwd', root / 'tmp'
    for directory in [home, cwd, tmp, home / 'config']:
        directory.mkdir(mode=0o700, exist_ok=True)
    network = root / 'network-attempts.log'
    positive_log = root / 'network-positive.log'
    env = {'PATH': config['runtimePath'], 'HOME': str(home), 'QWEN_HOME': str(home),
           'QWEN_RUNTIME_DIR': str(home), 'TMPDIR': str(tmp), 'XDG_CONFIG_HOME': str(home / 'config'),
           'OPENAI_API_KEY': 'fixture-not-a-real-key', 'PROBE_NETWORK_LOG': str(network),
           'NODE_OPTIONS': '--require ' + json.dumps(config['guard']), 'NO_COLOR': '1', 'CI': '1'}
    node, cli = config['node'], config['cli']
    argv = [node, cli, '--acp', '--bare', '--advisor', 'off', '--auth-type', 'openai',
            '--model', 'fixture-model', '--openai-base-url', 'http://127.0.0.1:9/v1', '--telemetry=false']
    result = {'schemaVersion': 1, 'version': config['version'], 'promptsSent': 0,
              'passed': False, 'guardPositiveControl': False, 'groupGone': False,
              'identity': False, 'protocol': False, 'auth': False, 'session': False,
              'fixtureModel': False, 'modes': False}
    p = None
    sel = selectors.DefaultSelector()
    buffer, errors, allout, responses = b'', b'', b'', []
    maximum = min(config['maxBytes'], 1048576)
    checkpoint = 'network-positive'
    interrupted = False

    def interrupt(_number, _frame):
        nonlocal interrupted
        interrupted = True
        raise InterruptedError('producer interrupted')

    previous = {number: signal.signal(number, interrupt) for number in [signal.SIGTERM, signal.SIGINT]}

    def rpc(identifier, method, params):
        nonlocal buffer, errors, allout
        p.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params}) + '\n').encode())
        p.stdin.flush()
        deadline = time.monotonic() + min(30, config['rpcTimeoutMs'] / 1000)
        while time.monotonic() < deadline:
            for key, _ in sel.select(.1):
                data = os.read(key.fileobj.fileno(), 16384)
                if not data:
                    sel.unregister(key.fileobj)
                    continue
                if key.data == 'err':
                    errors += data
                else:
                    buffer += data
                    allout += data
                if len(errors) + len(allout) > maximum:
                    raise RuntimeError('output cap')
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                try:
                    value = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                responses.append(value)
                if isinstance(value, dict) and value.get('id') == identifier:
                    assert value.get('jsonrpc') == '2.0' and 'error' not in value
                    return value
            if p.poll() is not None:
                raise RuntimeError('native exited')
        raise TimeoutError('rpc deadline')

    try:
        # Exercise the unchanged preload before any candidate code. The exact
        # denial message and its log distinguish it from an unrelated failure.
        positive_env = {**env, 'PROBE_NETWORK_LOG': str(positive_log)}
        positive = subprocess.run([node, '-e', "try{require('node:net').connect(9,'203.0.113.1');process.exit(4)}catch(e){if(e.message!=='model-free receipt refuses network')throw e;process.stdout.write('NETWORK_BLOCKED')}"],
                                  cwd=cwd, env=positive_env, capture_output=True, timeout=min(10, config['rpcTimeoutMs'] / 1000))
        assert positive.returncode == 0 and positive.stdout == b'NETWORK_BLOCKED'
        assert positive_log.is_file() and 'blocked network attempt' in positive_log.read_text()
        result['guardPositiveControl'] = True
        p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             cwd=cwd, env=env, start_new_session=True)
        sel.register(p.stdout, selectors.EVENT_READ, 'out')
        sel.register(p.stderr, selectors.EVENT_READ, 'err')
        checkpoint = 'identity'
        init = rpc(1, 'initialize', {'protocolVersion': 1, 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}})
        assert init.get('result', {}).get('agentInfo', {}).get('name') == 'qwen-code'
        assert init['result']['agentInfo']['version'] == config['version']
        assert init['result']['agentInfo']['title'] == 'Qwen Code'
        result['identity'] = True
        checkpoint = 'protocol'
        assert init['result']['protocolVersion'] == 1
        result['protocol'] = True
        checkpoint = 'auth'
        auth = init['result']['authMethods']
        assert len(auth) == 1 and auth[0]['id'] == 'openai' and auth[0]['_meta']['type'] == 'terminal'
        result['auth'] = True
        checkpoint = 'session'
        session = rpc(2, 'session/new', {'cwd': str(cwd), 'mcpServers': []})
        assert 'result' in session
        sid = session['result']['sessionId']
        assert isinstance(sid, str) and sid
        result['session'] = True
        checkpoint = 'fixture-model'
        models = session['result']['models']
        assert len(models['availableModels']) == 1
        model = models['availableModels'][0]
        assert model['name'] == 'fixture-model' and models['currentModelId'] == model['modelId']
        result['fixtureModel'] = True
        checkpoint = 'modes'
        modes = {mode['id'] for mode in session['result']['modes']['availableModes']}
        assert {'default', 'auto-edit', 'yolo'} <= modes
        assert session['result']['modes']['currentModeId'] == 'default'
        for identifier, mode in enumerate(['default', 'auto-edit', 'yolo', 'default'], 3):
            answer = rpc(identifier, 'session/set_mode', {'sessionId': sid, 'modeId': mode})
            assert 'result' in answer
        result['modes'] = True
        result['passed'] = True
    except Exception as error:
        result['failureCheckpoint'] = checkpoint
        result['errorClass'] = type(error).__name__
    finally:
        # Never signal a group after reaping its leader: that PGID may be reused.
        # A still-owned live Popen child and its current PGID are the signal fence.
        for number in previous:
            signal.signal(number, signal.SIG_IGN)
        if p is None:
            result['groupGone'] = True  # No candidate group was started.
        if p is not None:
            if p.poll() is None:
                try:
                    if os.getpgid(p.pid) == p.pid:
                        os.killpg(p.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    p.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    if p.poll() is None and os.getpgid(p.pid) == p.pid:
                        os.killpg(p.pid, signal.SIGKILL)
                    p.wait(timeout=3)
            result['leaderExit'] = p.returncode
            for _ in range(30):
                try:
                    os.killpg(p.pid, 0)
                except ProcessLookupError:
                    result['groupGone'] = True
                    break
                except PermissionError:
                    break
                time.sleep(.1)
        result['interrupted'] = interrupted
        result['networkAttempts'] = network.read_text().count('blocked') if network.is_file() and network.stat().st_size <= maximum else -1
        result['records'] = responses
        for name, data in [('stderr.log', errors), ('stdout.jsonl', allout)]:
            fd = os.open(root / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
        fd = os.open(config['output'], os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(result, output, indent=2)
        sel.close()
        for number, handler in previous.items():
            signal.signal(number, handler)
    return result


def main():
    config = json.loads(pathlib.Path(sys.argv[1]).read_text())
    result = run_qwen_acp(config)
    print(json.dumps({key: value for key, value in result.items() if key != 'records'}))
    return 0 if result['passed'] and result['guardPositiveControl'] and result['groupGone'] and not result['interrupted'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
