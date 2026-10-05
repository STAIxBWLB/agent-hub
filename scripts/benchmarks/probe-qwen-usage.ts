/** Isolated, bounded counter-only Qwen ACP capability probe (#161). No native payload/text is retained. */
import { AcpPeer, type ACPUsageDiagnostic } from '../../src/adapters/acp.ts';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { loadConfig } from '../../src/hub/daemon.ts';
import { newEnvelope } from '../../src/hub/envelope.ts';
import { OmniRoute } from '../../src/omniroute/client.ts';
import { startModelRelay, type RelayRequestRecord } from '../../src/models/relay.ts';
import { profile } from '../../src/local/sandbox.ts';
import { sbplString } from '../../src/local/deny.ts';
import { effectiveBuild, parseVersion, ActiveFailureLatch } from './native-pi-qwen.ts';
async function main() {
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const pkg = arg('--qwen-package'), run = arg('--run');
if (!pkg || !run) throw new Error('required: --qwen-package PINNED_PACKAGE --run NEW_PRIVATE_DIR [--config-dir PROJECT]');
const config = loadConfig(resolve(arg('--config-dir') ?? process.cwd()));
const root = resolve(run), cwd = join(root, 'fixture'), home = join(root, 'qwen-home');
mkdirSync(root, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
const sourcePath = join(resolve(pkg), 'chunks/acpAgent-UCU7OI47.js');
writeFileSync(join(root, 'pinned-source-capability.json'), JSON.stringify({ path: sourcePath, sha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'), build: '0.24.7', shape: 'usage_update {used,size}', unit: 'current context occupancy and capacity; not cumulative consumed tokens' }, null, 2), { flag: 'wx', mode: 0o600 });
const env = { QWEN_HOME: home, QWEN_RUNTIME_DIR: home, TMPDIR: home };
const command = [Bun.which('node')!, '--expose-gc', join(resolve(pkg), 'cli.js')];
const observations: ACPUsageDiagnostic[] = [];
const reject = args.includes("--reject-upstream");
const latch = new ActiveFailureLatch();
const requests: RelayRequestRecord[] = [];
let nativeUsage: number | null = null, answer = false;
const relay = await startModelRelay({ omni: new OmniRoute(config.omniroute), allowedDGXmodels: { 'dgx/coding': config.pi.dgx_coding }, ...(reject ? { admitRequest: async () => ({ allowed: false, reason: 'controlled probe rejection' }) } : {}), onRequest: (r) => { requests.push(r); } });
const sandboxFile = join(root, 'qwen.sb');
writeFileSync(sandboxFile, profile(cwd, false, [], []) + `\n(allow file-read* (subpath ${sbplString(resolve(pkg))}))\n(allow file-read* file-write* (subpath ${sbplString(home)}))\n(allow network-outbound (remote ip ${sbplString('localhost:' + new URL(relay.url).port)}))\n(deny file-write* (subpath ${sbplString(cwd)}))`);
const peer = new AcpPeer('qwen', {
  cwd, cmd: ['/usr/bin/sandbox-exec', '-f', sandboxFile, ...command, '--acp', '--bare', '--advisor', 'off', '--auth-type', 'openai', '--model', 'dgx/coding', '--openai-base-url', relay.url, '--telemetry=false'],
  env: { ...env, OPENAI_API_KEY: relay.token }, watchdogMs: 60_000,
  onTokens: (n) => { nativeUsage = n; },
  onUsageDiagnostic: (reading) => { if (observations.length < 32) observations.push(reading); },
  onPermission: async () => undefined,
  ...{ onTurnFailure: (_envs: unknown, reason: string) => { latch.note("qwen", reason, Date.now()); } },
});
peer.onMessage = () => { answer = true; };
let result: Record<string, unknown> | undefined;
try {
  const version = parseVersion(await effectiveBuild([...command, '--version'], { cwd, env, sandboxProfile: sandboxFile, timeoutMs: 15_000 }));
  if (version !== '0.24.7') throw new Error('effective Qwen build is not 0.24.7');
  await peer.start();
  latch.begin(Date.now());
  await peer.deliver([newEnvelope('user', 'Reply only COUNTER_OK without tools.', { to: ['qwen'] })]);
  const deadline = Date.now() + 65_000;
  while (!latch.failure && peer.state === 'busy' && Date.now() < deadline) await Bun.sleep(50);
  result = { version, verdict: latch.failure ? 'peer-failure' : answer ? 'answered' : peer.state === 'busy' ? 'timeout' : 'no-answer', failedPeer: latch.failure?.peer, failureClass: latch.failure ? 'acp-prompt-failed' : undefined, activeElapsedMs: latch.failure?.activeElapsedMs, processReachableAtFailure: latch.failure ? peer.state !== 'offline' : undefined, nativeUsage,
    nativeAvailability: nativeUsage === null ? 'no-reading' : 'known', observations,
    requestUsage: requests.map((r) => ({ id: r.id, outcome: r.outcome, usage: r.requestUsage ?? null, availability: r.usageAvailability, providerSource: r.providerSource, providerAvailability: r.providerAvailability })) };
} catch { result = { verdict: 'probe-error', nativeUsage, observations }; }
finally { await peer.stop(); await relay.close(); rmSync(home, { recursive: true, force: true }); }
writeFileSync(join(root, 'usage-capability.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result));
if (result?.verdict !== (reject ? 'peer-failure' : 'answered')) process.exitCode = 1;

}
void main().catch(() => { console.log(JSON.stringify({ verdict: 'probe-error' })); process.exitCode = 1; });
