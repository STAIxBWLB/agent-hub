/** Measurement only: no production deadline, installer, trust or account state changes. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const CHILD_MS = 15_000, OUTPUT_BYTES = 4096, WARM_REPEATS = 5;
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_CONTENT = 'public startup fixture\n';
const metadataCode = 'import json,sys,platform;print(json.dumps({"version":list(sys.version_info[:3]),"implementation":platform.python_implementation()}))';

/** Tiny public ustar, generated without invoking Python, tar, a package manager or native agent. */
export function startupArchive(name = 'payload.txt') {
  const header = Buffer.alloc(512), content = Buffer.from(PUBLIC_CONTENT);
  header.write(name, 0, 100, 'ascii');
  for (const [offset, width, value] of [[100, 8, 0o600], [108, 8, 0], [116, 8, 0], [124, 12, content.length], [136, 12, 0]]) {
    header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
  }
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return gzipSync(Buffer.concat([header, content, Buffer.alloc(512 - content.length), Buffer.alloc(1024)]));
}

/** The port is for fake tests. Raw child output/errors are never returned in a measurement. */
export function measureCommand(request, ports = {}) {
  const now = ports.now ?? (() => performance.now()), run = ports.run ?? spawnSync;
  const started = now(); let result;
  try {
    result = run(request.command, request.args, { cwd: request.cwd, env: request.env, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', request.directoryFd ?? 'ignore'], timeout: CHILD_MS, killSignal: 'SIGKILL', maxBuffer: OUTPUT_BYTES });
  } catch { result = { error: { code: 'SPAWN' }, status: null }; }
  const elapsedMs = Math.max(0, now() - started), code = result.error?.code;
  const censored = code === 'ETIMEDOUT';
  const signal = result.signal ? ['SIGKILL', 'SIGTERM'].includes(result.signal) ? result.signal : 'other' : null;
  const exitCode = Number.isInteger(result.status) ? result.status : null;
  let outcome = 'unexpected-exit';
  if (censored) outcome = 'timeout';
  else if (code === 'ENOBUFS') outcome = 'output-cap';
  else if (result.error) outcome = 'spawn-error';
  else if (signal) outcome = 'signal';
  else if (exitCode === request.expectedExit) outcome = request.expectedExit === 0 ? 'success' : 'refused';
  return { observation: { elapsedMs, timeoutMs: CHILD_MS, censored, outcome, exitCode, signal }, result };
}

function pythonCommand() {
  for (const command of ['/usr/bin/python3', '/bin/python3']) {
    try { accessSync(command, constants.X_OK); return command; } catch { /* Lookup only, never execute a version probe. */ }
  }
  throw new Error('measurement interpreter unavailable');
}
const scalar = value => typeof value === 'string' && /^[A-Za-z0-9 ._+-]{1,100}$/.test(value) ? value : 'unavailable';

/** First invocation is an exact production helper; interpreter metadata is collected afterward. */
export function measurePythonStartup(input, ports = {}) {
  if (!['output-check', 'extract'].includes(input.mode) || !/^[a-f0-9]{40}$/.test(input.sourceSha)
    || !Number.isInteger(input.replicate) || input.replicate < 1 || input.replicate > 3) throw new Error('measurement input invalid');
  const helper = join(HERE, input.mode === 'output-check' ? 'write-output.py' : 'extract-archive.py');
  const helperSha256 = createHash('sha256').update(readFileSync(helper)).digest('hex');
  const command = ports.command ?? pythonCommand();
  const root = mkdtempSync(join(tmpdir(), 'ahub-python-startup-'));
  const flags = input.mode === 'output-check' ? ['-I'] : [];
  const home = join(root, 'home');
  const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: root, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  let directoryFd;
  try {
    mkdirSync(home, { mode: 0o700 });
    const outputDir = join(root, 'output'); mkdirSync(outputDir, { mode: 0o700 });
    if (input.mode === 'output-check') directoryFd = openSync(outputDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const archive = join(root, 'public.tar.gz');
    if (input.mode === 'extract') writeFileSync(archive, startupArchive(), { flag: 'wx', mode: 0o600 });
    const sample = (index, refused = false) => {
      const target = join(root, `extract-${index}`);
      if (input.mode === 'extract') mkdirSync(target, { mode: 0o700 });
      const args = input.mode === 'output-check' ? [...flags, helper, 'check'] : [helper, archive, target, '4', '1024'];
      const { observation } = measureCommand({ command, args, cwd: root, env, directoryFd, expectedExit: refused ? 2 : 0 }, ports);
      if (input.mode === 'extract' && observation.outcome === 'success') {
        try { if (readFileSync(join(target, 'payload.txt'), 'utf8') !== PUBLIC_CONTENT) observation.outcome = 'unexpected-content'; }
        catch { observation.outcome = 'unexpected-content'; }
      }
      if (refused && input.mode === 'extract' && (existsSync(join(root, 'escape.txt')) || readdirSync(target).length)) observation.outcome = 'unexpected-content';
      if (refused && input.mode === 'output-check' && readFileSync(join(outputDir, 'summary.json'), 'utf8') !== 'occupied public fixture') observation.outcome = 'unexpected-content';
      return observation;
    };
    const cold = sample(0), warm = [];
    for (let index = 1; index <= WARM_REPEATS; index++) warm.push(sample(index));
    if (input.mode === 'output-check') writeFileSync(join(outputDir, 'summary.json'), 'occupied public fixture', { flag: 'wx', mode: 0o600 });
    else writeFileSync(archive, startupArchive('../escape.txt'));
    const refusal = sample(WARM_REPEATS + 1, true);
    // This is deliberately later than every actual-helper invocation above.
    const metadata = measureCommand({ command, args: [...flags, '-c', metadataCode], cwd: root, env, expectedExit: 0 }, ports);
    let interpreter = { status: metadata.observation.outcome, version: null, implementation: null };
    if (metadata.observation.outcome === 'success') {
      try {
        const value = JSON.parse(metadata.result.stdout);
        if (!Array.isArray(value.version) || value.version.length !== 3 || !value.version.every(n => Number.isInteger(n) && n >= 0 && n < 1000)
          || !['CPython', 'PyPy'].includes(value.implementation)) throw new Error();
        interpreter = { status: 'success', version: value.version.join('.'), implementation: value.implementation };
      } catch { interpreter.status = 'invalid-metadata'; }
    }
    const result = { schemaVersion: 1, sourceSha: input.sourceSha, helperSha256, mode: input.mode, replicate: input.replicate,
      flags, pythonSelection: 'system-python3', coldDefinition: 'first Python invocation in this job; OS/image caches are not claimed cold',
      runner: { os: process.platform, architecture: process.arch, node: process.version,
        imageOS: scalar(process.env.ImageOS), imageVersion: scalar(process.env.ImageVersion),
        runnerOS: scalar(process.env.RUNNER_OS), runnerArchitecture: scalar(process.env.RUNNER_ARCH) },
      cold, warm, refusal, interpreter, metadataObservation: metadata.observation };
    if (input.output) {
      mkdirSync(dirname(resolve(input.output)), { recursive: true, mode: 0o700 });
      writeFileSync(input.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    return result;
  } finally { if (directoryFd !== undefined) closeSync(directoryFd); rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), fields = {};
    while (args.length) {
      const key = args.shift();
      if (!['--mode', '--output', '--source-sha', '--replicate'].includes(key) || fields[key] || !args.length) throw new Error();
      fields[key] = args.shift();
    }
    if (!fields['--output']) throw new Error();
    const result = measurePythonStartup({ mode: fields['--mode'], output: fields['--output'], sourceSha: fields['--source-sha'], replicate: Number(fields['--replicate']) });
    if (process.env.MEASURE_EXPECTED_OS !== result.runner.os || process.env.MEASURE_EXPECTED_ARCH !== result.runner.architecture) process.exitCode = 1;
  } catch { console.error('measurement failed; inspect the bounded job status, no native output is printed'); process.exitCode = 1; }
}
