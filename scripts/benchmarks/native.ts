import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync, statSync, lstatSync, readdirSync, readlinkSync, openSync, fstatSync, closeSync, constants as fsConstants } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { ControlClient } from '../../src/hub/control-client.ts';
import { realPath } from '../../src/hub/project.ts';
import { sessionSettings, statusLineSettings } from '../../src/cli/launch.ts';
import { readEvents } from '../../src/hub/events.ts';
import { processTable } from '../../src/hub/child-process.ts';
import { awaitTurnEnd, captureActors, cwdOf, restoreModes, restoreTrust, teardown, transcriptRows, turnEnded, type Actor } from './teardown.ts';
process.umask(0o077);
const argv = process.argv.slice(2), runArg = argv[argv.indexOf('--run') + 1], inputArg = argv[argv.indexOf('--private-inputs') + 1], upstreamArg = argv[argv.indexOf('--upstream-root') + 1], probeArg = argv[argv.indexOf('--probe-target') + 1];
if (!runArg || !inputArg || !upstreamArg || !probeArg)
    throw new Error('usage: bun scripts/benchmarks/native.ts --run RUN_DIR --private-inputs PRIVATE_DIR --upstream-root COOPERBENCH_ROOT --probe-target HIDDEN_FILE');
const repo = resolve(import.meta.dir, '../..');
const out = realPath(runArg), privateInputs = realPath(inputArg), upstreamRoot = realPath(upstreamArg), runs = out;
if (out === repo || out.startsWith(repo + '/') || repo.startsWith(out + '/'))
    throw new Error('private run root must be outside the repository');
if (!existsSync(join(out, 'prepared.json')))
    throw new Error('prepared run missing');
const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), prepared = JSON.parse(readFileSync(join(out, 'prepared.json'), 'utf8'));
if ((statSync(out).mode & 0o777) !== 0o700)
    throw new Error('run directory must have mode 0700');
const sourceHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
if (prepared.runner_sha256 !== sourceHash(join(import.meta.dir, 'runner.py')) || prepared.native_runner_sha256 !== sourceHash(join(import.meta.dir, 'native.ts')) || prepared.teardown_sha256 !== sourceHash(join(import.meta.dir, 'teardown.ts')) || prepared.process_table_sha256 !== sourceHash(join(import.meta.dir, '../../src/hub/child-process.ts')) || prepared.evaluator_sha256 !== sourceHash(join(import.meta.dir, 'evaluate.py')) || resolve(prepared.upstream_root ?? '') !== upstreamRoot)
    throw new Error('benchmark runner changed after preparation');
class NativeCommandError extends Error { constructor(message: string, readonly code?: string) { super(message); } }
const log = (event: string, data: any = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
let stopRequested = false;
process.on('SIGINT', () => { stopRequested = true; });
process.on('SIGTERM', () => { stopRequested = true; });
process.on('SIGHUP', () => { stopRequested = true; }); // a closed terminal is a stop too: tear down, do not die mid-arm
// Each command in a process group of its own (issue #113): a Ctrl-C reaches the runner, which stops in order, and not
// the command it is running, whose failure would cut the teardown short.
// Bounded too: out of reach of a Ctrl-C, a hung command would otherwise hang the runner, teardown included.
async function cmd(args: string[], cwd?: string, env?: Record<string, string>, timeoutMs = 180_000) { const p = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', detached: true, ...(env ? { env: { ...process.env, ...env } } : {}) }); const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch { } }, timeoutMs); const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).finally(() => clearTimeout(timer)); if (code) {
    let detail = stderr.trim(); let errorCode: string | undefined;
    if (!detail) { try { const parsed = JSON.parse(stdout); errorCode = parsed.error?.code; detail = typeof parsed.error === 'string' ? parsed.error : [parsed.error?.code, parsed.error?.message].filter(Boolean).join(': '); } catch { detail = `exit ${code}`; } }
    throw new NativeCommandError(args[0] + ': ' + detail.slice(0, 350), errorCode);
} return stdout; }
async function orca(args: string[]) { return JSON.parse(await cmd(['orca', ...args, '--json'])); }
function findRecord(value: any, predicate: (x: any) => boolean): any { if (value && typeof value === 'object') {
    if (predicate(value))
        return value;
    for (const child of Object.values(value)) {
        const found = findRecord(child, predicate);
        if (found)
            return found;
    }
} return undefined; }
function screenText(value: any): string {
    const terminal = value?.result?.terminal;
    return terminal?.source === 'screen' && Array.isArray(terminal.tail) ? terminal.tail.filter((line: unknown) => typeof line === 'string').join('\n') : '';
}

function shellQuote(s: string) { return `'${s.replaceAll("'", "'\\''")}'`; }
async function ensureOrcaWorktree(dir: string) { let listing = await orca(['repo', 'list']); let record = findRecord(listing, (x: any) => typeof x.path === 'string' && resolve(x.path) === resolve(dir) && typeof x.id === 'string'); if (!record) {
    listing = await orca(['repo', 'add', '--path', dir]);
    record = findRecord(listing, (x: any) => typeof x.path === 'string' && resolve(x.path) === resolve(dir) && typeof x.id === 'string');
} if (!record)
    throw new Error('Orca did not return an exact registered repo identity'); const repoId = record.repoId ?? record.id; const worktrees = await orca(['worktree', 'list', '--repo', `id:${repoId}`]); const wt = findRecord(worktrees, (x: any) => typeof x.path === 'string' && resolve(x.path) === resolve(dir) && typeof x.id === 'string'); if (!wt)
    throw new Error('Orca has no worktree at the exact fixture path'); return { repoId, worktreeId: wt.id }; }
async function createOrcaTerminal(worktreeId: string, title: string, command: string) { const before = await orca(['terminal', 'list', '--worktree', `id:${worktreeId}`]); const prior = new Set<any[]>(); const collect = (v: any) => { if (v && typeof v === 'object') {
    if (typeof v.handle === 'string' && v.worktreeId === worktreeId)
        prior.add([v.handle]);
    for (const child of Object.values(v))
        collect(child);
} }; collect(before); const old = new Set(Array.from(prior, x => x[0] as string)); const response = await orca(['terminal', 'create', '--worktree', `id:${worktreeId}`, '--title', title, '--command', command]); let terminal = findRecord(response, (x: any) => (x.title === title || x.name === title) && (typeof x.handle === 'string' || typeof x.terminalHandle === 'string')); let handle = terminal?.handle ?? terminal?.terminalHandle; if (typeof handle !== 'string') {
    const after = await orca(['terminal', 'list', '--worktree', `id:${worktreeId}`]);
    const matches: any[] = [];
    const visit = (v: any) => { if (v && typeof v === 'object') {
        if (v.worktreeId === worktreeId && typeof v.handle === 'string' && !old.has(v.handle) && (v.title === title || v.title == null))
            matches.push(v);
        for (const child of Object.values(v))
            visit(child);
    } };
    visit(after);
    if (matches.length === 1)
        handle = matches[0].handle;
    else {
        for (const item of matches)
            await orcaClose(item.handle).catch(() => { });
        throw new Error('Orca terminal create identity is ambiguous; owned new terminals were closed');
    }
} return handle; }
async function orcaClose(handle: string) { await orca(['terminal', 'close', '--terminal', handle, '--tab']); }
async function terminalCommand(worktreeId: string, title: string, command: string) { const h = await createOrcaTerminal(worktreeId, title, command); try {
    const result = await orca(['terminal', 'wait', '--terminal', h, '--for', 'exit', '--timeout-ms', '90000']);
    const wait = findRecord(result, (x: any) => typeof x.satisfied === 'boolean');
    if (wait?.satisfied !== true)
        throw new Error('Orca lifecycle command did not exit cleanly');
}
finally {
    await orcaClose(h);
} }
async function waitClaudeTui(handle: string) { const end = Date.now() + 90000; let channelConfirmed = false; while (Date.now() < end) {
    if (stopRequested)
        throw new Error('interrupted');
    const read = await orca(['terminal', 'read', '--terminal', handle, '--screen']);
    const screen = screenText(read).replace(/\s+/g, ' ');
    if (screen.includes('Quick safety check') && screen.includes('Yes, I trust this folder'))
        throw new Error('fixture trust dialog appeared despite scoped trust setup');
    if (!channelConfirmed && screen.includes('I am using this for local development')) {
        const receipt = await orca(['terminal', 'send', '--terminal', handle, '--text', '', '--enter']);
        if (receipt.ok !== true)
            throw new Error('could not accept the recognized local development channel prompt');
        channelConfirmed = true;
        continue;
    }
    let result: any;
    try { result = await orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '500']); }
    catch (error) { if (error instanceof NativeCommandError && error.code === 'timeout') { await Bun.sleep(250); continue; } throw error; }
    const wait = findRecord(result, (x: any) => typeof x.satisfied === 'boolean');
    if (wait?.satisfied === true)
        return { channelConfirmed };
} throw new Error('Claude Orca terminal did not reach TUI readiness'); }
const cliPath = join(repo, 'src/cli/main.ts');
async function upstreamTreeHash(root: string) { const fs = await import('node:fs/promises'), files: any = {}; async function walk(path: string, rel: string) { for (const entry of await fs.readdir(path, { withFileTypes: true })) {
    if (entry.name === '.git')
        continue;
    const full = join(path, entry.name), child = rel ? `${rel}/${entry.name}` : entry.name, st = lstatSync(full);
    if (st.isSymbolicLink())
        throw new Error('upstream evaluator/data tree contains a symlink');
    if (st.isDirectory())
        await walk(full, child);
    else if (st.isFile())
        files[child] = hash(await Bun.file(full).bytes());
} } await walk(root, ''); const sorted: any = {}; for (const key of Object.keys(files).sort())
    sorted[key] = files[key]; return hash(JSON.stringify(sorted)); }
async function wait(check: () => Promise<any>, label: string, ms = 90000) { const end = Date.now() + ms; while (Date.now() < end) {
    if (stopRequested)
        throw new Error('interrupted');
    const v = await check();
    if (v)
        return v;
    await Bun.sleep(250);
} throw new Error('readiness timeout: ' + label); }
const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')), pluginJson = JSON.parse(readFileSync(join(repo, 'plugins/agent-hub/.claude-plugin/plugin.json'), 'utf8'));
if (packageJson.version !== m.hub_version || m.versions?.hub !== packageJson.version || pluginJson.version !== packageJson.version)
    throw new Error('hub/plugin version differs from the pinned manifest');
const codexBinIndex = argv.indexOf('--codex-bin');
const codexBin = realPath(codexBinIndex >= 0 ? argv[codexBinIndex + 1]! : (Bun.which('codex') ?? 'codex'));
const codexVersion = (await cmd([codexBin, '--version'])).match(/\d+\.\d+\.\d+/)?.[0], claudeVersion = (await cmd(['claude', '--version'])).match(/\d+\.\d+\.\d+/)?.[0];
if (codexVersion !== m.versions?.codex || claudeVersion !== m.versions?.claude)
    throw new Error('native CLI version differs from the pinned manifest');
if ((await cmd(['git', '-C', upstreamRoot, 'rev-parse', 'HEAD'])).trim() !== m.upstream.commit || await upstreamTreeHash(upstreamRoot) !== prepared.upstream_source_sha256)
    throw new Error('pinned CooperBench evaluator/data tree changed after prepare');
const orcaCurrent = JSON.parse(await cmd(['orca', 'worktree', 'current', '--json'])).result?.worktree;
if (!orcaCurrent?.path || !(repo === resolve(orcaCurrent.path) || repo.startsWith(resolve(orcaCurrent.path) + '/')))
    throw new Error('Orca canonical root does not own this repository');
function hash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
const cachedInputs = m.cases.map((_: any, i: number) => JSON.parse(readFileSync(join(privateInputs, `case-${i.toString().padStart(2, '0')}.json`), 'utf8')));
for (let i = 0; i < cachedInputs.length; i++)
    for (let k = 0; k < 2; k++)
        if (hash(cachedInputs[i].prompts[k]) !== m.cases[i].prompt_sha256[k])
            throw new Error('private prompt hash mismatch');
const privateCaseHashes: Record<number, string> = {};
for (let i = 0; i < cachedInputs.length; i++) {
    const input = cachedInputs[i], expected = m.cases[i];
    if (input.repo !== expected.repo || input.task !== expected.task || JSON.stringify(input.features) !== JSON.stringify(expected.features)) throw new Error('private case identity differs from the selected manifest pair');
    privateCaseHashes[i] = sourceHash(join(privateInputs, `case-${i.toString().padStart(2, '0')}.json`));
}
const probeTarget = realPath(probeArg);
const protectedRoots = [privateInputs, upstreamRoot];
for (let i = 0; i < argv.length; i++)
    if (argv[i] === '--protect' && argv[i + 1])
        protectedRoots.push(realPath(argv[i + 1]!));
const protectListIndex = argv.indexOf('--protect-list');
const protectListArg = protectListIndex >= 0 ? argv[protectListIndex + 1] : undefined;
if (protectListArg) {
    const listPath = resolve(protectListArg);
    const value = JSON.parse(readFileSync(listPath, 'utf8'));
    const paths = Array.isArray(value) ? value : value.paths;
    if (!Array.isArray(paths) || paths.some(x => typeof x !== 'string'))
        throw new Error('protected path list must be a JSON string array');
    protectedRoots.push(listPath, ...paths.map((x: string) => realPath(x)));
}
if (!argv.includes('--protect') && !protectListArg)
    throw new Error('pass --protect or --protect-list for every prior artifact/session file');
if (!existsSync(probeTarget) || !protectedRoots.some(root => probeTarget === root || probeTarget.startsWith(root + '/')))
    throw new Error('sandbox probe target must be inside an exact protected root');
const probeTargetSha = hash(await Bun.file(probeTarget).bytes());
for (const path of protectedRoots)
    if (path === repo || path.startsWith(repo + '/') || repo.startsWith(path + '/') || path === runs || path.startsWith(runs + '/') || runs.startsWith(path + '/'))
        throw new Error('protected root must not overlap the repository or run fixtures');
const protectedModes = new Map<string, number>(), siblingLedgers = new Map<string, any>();
let trustLedger: any;
let protectedRestored = false;
// The ledger `restore.ts` works from (issue #113): what was locked, and every process each arm started, with this
// runner's own identity, so a recovery can tell a running runner or arm from one that is gone.
const actorLedger = new Map<string, Actor[]>();
const runnerIdentity = processTable()?.find(r => r.pid === process.pid);
if (!runnerIdentity)
    throw new Error('the process table cannot be read: the runner cannot record what it starts');
// Temp file and rename: a crash mid-write must not leave a ledger the recovery cannot read.
function persistLedger() { const file = join(runs, 'restoration-ledger.json'); writeFileSync(`${file}.tmp`, JSON.stringify({ runner: runnerIdentity && { pid: runnerIdentity.pid, started: runnerIdentity.started }, protected: { paths: Object.fromEntries(protectedModes), restored: protectedRestored }, siblings: Object.fromEntries(siblingLedgers), actors: Object.fromEntries(actorLedger), trust: trustLedger }, null, 2), { mode: 0o600 }); renameSync(`${file}.tmp`, file); }
async function protectInputs() { const fs = await import('node:fs/promises'); for (const root of protectedRoots) {
    if (!existsSync(root))
        throw new Error('protected source missing');
    const rootStat = lstatSync(root);
    const paths = rootStat.isDirectory() ? [root, ...(await fs.readdir(root, { recursive: true })).map(x => join(root, String(x)))] : [root];
    for (const path of paths) {
        const st = lstatSync(path);
        if (st.isSymbolicLink())
            throw new Error('refuse symlink in protected inputs');
        protectedModes.set(path, st.mode & 0o777);
    }
} persistLedger(); for (const path of [...protectedModes.keys()].sort((a, b) => b.length - a.length))
    chmodSync(path, 0); }
async function restoreInputs() { const failed = restoreModes(protectedModes); if (failed.length)
    throw new Error('failed to restore protected inputs: ' + failed.length + ' path(s)'); protectedRestored = true; persistLedger(); }
async function lockSiblingArtifacts(activeFixture: string, modes: Map<string, number>) { const fs = await import('node:fs/promises'); const fixtureRoot = join(runs, 'fixtures'); if (existsSync(fixtureRoot)) {
    for (const entry of await fs.readdir(fixtureRoot)) {
        const path = join(fixtureRoot, entry);
        if (path === activeFixture)
            continue;
        const paths = [path, ...(await fs.readdir(path, { recursive: true })).map(x => join(path, String(x)))];
        for (const item of paths) {
            const st = lstatSync(item);
            if (st.isSymbolicLink())
                throw new Error('refuse symlink in sibling benchmark artifacts');
            modes.set(item, st.mode & 0o777);
        }
    }
} for (const root of [join(runs, 'runs'), join(runs, 'patches'), join(runs, 'private')]) {
    if (!existsSync(root))
        continue;
    for (const path of [root, ...(await fs.readdir(root, { recursive: true })).map(x => join(root, String(x)))]) {
        const st = lstatSync(path);
        if (st.isSymbolicLink())
            throw new Error('refuse symlink in sibling benchmark artifacts');
        modes.set(path, st.mode & 0o777);
    }
} const ledger = { modes: Object.fromEntries(modes), restored: false }; siblingLedgers.set(activeFixture, ledger); persistLedger(); try {
    for (const path of [...modes.keys()].sort((a, b) => b.length - a.length))
        chmodSync(path, 0);
}
catch (e) {
    try {
        restoreModeMap(modes);
        ledger.restored = true;
        persistLedger();
    }
    catch { }
    throw e;
} return modes; }
function restoreModeMap(modes: Map<string, number>) { const failed = restoreModes(modes); if (failed.length)
    throw new Error(`failed to restore ${failed.length} sibling artifact permissions`); }
const hubNames = ['hub_send', 'hub_task_accept', 'hub_task_done', 'hub_task_list', 'hub_task_decline', 'hub_inbox', 'hub_delivery_done'];
function structuredQuota(messages: any[]) { const codes = new Set(['usageLimitExceeded', 'rate_limit_error', 'insufficient_quota', 'quota_exceeded']); return messages.some(x => { const values = [x?.error?.code, x?.params?.error?.code, x?.params?.turn?.error?.code, x?.result?.error?.code]; return values.some(v => typeof v === 'string' && codes.has(v)); }); }
function numeric(value: any) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function codexUsage(messages: any[], threadId: string | undefined) { let total: any; for (const x of messages) {
    if (x?.method !== 'thread/tokenUsage/updated')
        continue;
    const p = x.params ?? {};
    if (threadId && p.threadId && p.threadId !== threadId)
        continue;
    const t = p.tokenUsage?.total ?? p.token_usage?.total;
    if (t && typeof t === 'object')
        total = t;
} if (!total)
    return undefined; return { input_tokens: numeric(total.inputTokens ?? total.input_tokens) ?? null, output_tokens: numeric(total.outputTokens ?? total.output_tokens) ?? null, cache_read_tokens: numeric(total.cachedInputTokens ?? total.cacheReadInputTokens ?? total.cache_read_input_tokens) ?? null, reasoning_output_tokens: numeric(total.reasoningOutputTokens ?? total.reasoning_output_tokens) ?? null, total_tokens: numeric(total.totalTokens ?? total.total_tokens) ?? null, source: 'Codex thread/tokenUsage/updated cumulative total', scope: 'whole native session including the unscored sandbox probe' }; }
/**
 * A regular file's bytes, opened without following a link and without blocking (a fifo swapped in after a check must not
 * stop the runner), or a string saying why there are none.
 */
function regularBytes(path: string, max: number): Buffer | string {
    let fd: number | undefined;
    try {
        fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        const st = fstatSync(fd);
        if (!st.isFile()) return `not a regular file: ${st.mode & 0o170000}`;
        return st.size > max ? `large: ${st.size} ${st.mtimeMs}` : readFileSync(fd);
    }
    catch (e: any) { return e?.code === 'ENOENT' ? 'missing' : `unreadable: ${e?.code ?? 'error'}`; }
    finally { if (fd !== undefined) closeSync(fd); }
}
function fixtureMetadataHash(root: string) { const names = ['AGENTS.md', '.gitignore', '.claude/settings.json', '.agenthub/config.json', '.agenthub/routing.toml'], values: any = {}; for (const name of names) {
    const bytes = regularBytes(join(root, name), 16 * 1024 * 1024);
    values[name] = bytes === 'missing' ? null : typeof bytes === 'string' ? bytes : hash(bytes);
} return hash(JSON.stringify(values)); }
/** Written whole or not at all: a recovery reads it after a runner that may have died mid-write. */
function writeAtomic(file: string, text: string) { writeFileSync(`${file}.tmp`, text, { mode: 0o600 }); renameSync(`${file}.tmp`, file); }
function claudeEvidence(transcriptPath: string | undefined) { if (!transcriptPath || !existsSync(transcriptPath))
    return { models: [], usage: undefined }; const latest = new Map<string, any>(), models = new Set<string>(); for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line)
        continue;
    try {
        const r = JSON.parse(line);
        if (r?.type !== 'assistant' || typeof r?.message !== 'object')
            continue;
        const msg = r.message;
        if (typeof msg.model === 'string' && !msg.model.startsWith('<'))
            models.add(msg.model);
        const id = msg.id ?? r.uuid;
        if (id && msg.usage)
            latest.set(String(id), msg.usage);
    }
    catch { }
} const fields = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']; const sums: any = {}; for (const f of fields) {
    const found = [...latest.values()].map(x => numeric(x[f])).filter((x): x is number => x !== undefined);
    sums[f] = found.length ? found.reduce((a: number, b: number) => a + b, 0) : null;
} return { models: [...models].sort(), usage: latest.size ? { ...sums, assistant_messages: latest.size, source: 'Claude native JSONL, latest usage per assistant message id', scope: 'whole native session including the unscored sandbox probe' } : undefined }; }
function claudeProbe(transcriptPath: string | undefined, command: string) { if (!transcriptPath || !existsSync(transcriptPath))
    return false; const uses = new Set<string>(), results = new Map<string, string>(); for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line)
        continue;
    try {
        const row = JSON.parse(line), items = row?.message?.content;
        if (!Array.isArray(items))
            continue;
        for (const item of items) {
            if (item?.type === 'tool_use' && item?.name === 'Bash' && item?.input?.command === command)
                uses.add(item.id);
            if (item?.type === 'tool_result' && item.tool_use_id)
                results.set(item.tool_use_id, typeof item.content === 'string' ? item.content : JSON.stringify(item.content));
        }
    }
    catch { }
} return [...uses].some(id => results.get(id)?.includes('AHUB_PROBE_DENIED') && !results.get(id)?.includes('AHUB_PROBE_READABLE')); }
function codexProbe(messages: any[], start: number, command: string) { let invoked = false, denied = false, readable = false; const visit = (v: any) => { if (!v || typeof v !== 'object')
    return; if (Array.isArray(v)) {
    for (const child of v)
        visit(child);
    return;
} const item = v.item ?? v; if (typeof item.command === 'string' && item.command.includes(command)) {
    invoked = true;
    const out = [item.aggregatedOutput, item.stdout, item.stderr, item.output].filter(x => typeof x === 'string').join('\n');
    denied ||= out.includes('AHUB_PROBE_DENIED');
    readable ||= out.includes('AHUB_PROBE_READABLE');
} for (const child of Object.values(v))
    visit(child); }; for (const msg of messages.slice(start))
    visit(msg); return invoked && denied && !readable; }
function skillsCondition(r: any) {
    if (!Array.isArray(r?.data)) return { source: 'skills/list', unknown: String(r?.error ?? 'no data') };
    const all = r.data.flatMap((e: any) => Array.isArray(e?.skills) ? e.skills : []);
    const byScope: Record<string, number> = {};
    for (const s of all) byScope[String(s?.scope)] = (byScope[String(s?.scope)] ?? 0) + 1;
    return { source: 'skills/list', total: all.length, enabled: all.filter((s: any) => s?.enabled === true).length, byScope, namesSha256: hash(JSON.stringify(all.map((s: any) => String(s?.name)).sort())) };
}
async function sendTerminalText(handle: string, text: string) { const receipt = await orca(['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--wait-submit', '2']); if (receipt.ok !== true)
    throw new Error('Orca rejected native sandbox probe input'); }
async function arm(cas: any, index: number, kind: string, manifest: any) {
    const name = `${index.toString().padStart(2, '0')}-${kind}`, dir = join(runs, 'fixtures', name);
    if (!existsSync(dir))
        throw new Error('prepared fixture missing: ' + dir);
    const preparedFixture = prepared.fixtures.find((x: any) => x.case === index && x.arm === kind);
    if (!preparedFixture || resolve(preparedFixture.cwd) !== resolve(dir) || (await cmd(['git', 'rev-parse', 'HEAD'], dir)).trim() !== preparedFixture.base_commit)
        throw new Error('fixture baseline identity mismatch');
    const fs = await import('node:fs/promises');
    const original: any = {};
    async function collect(path: string, rel: string) { for (const entry of await fs.readdir(path, { withFileTypes: true })) {
        if (entry.name === '.git')
            continue;
        const full = join(path, entry.name), child = rel ? `${rel}/${entry.name}` : entry.name, lstat = lstatSync(full);
        if (lstat.isSymbolicLink())
            throw new Error('fixture baseline contains a symlink');
        if (lstat.isDirectory())
            await collect(full, child);
        else if (lstat.isFile())
            original[child] = hash(await Bun.file(full).bytes());
    } }
    await collect(dir, '');
    const baselinePaths = Object.keys(original).sort();
    const ordered: any = {};
    for (const path of baselinePaths)
        ordered[path] = original[path];
    const baselineJson = JSON.stringify(ordered);
    if (baselinePaths.length !== preparedFixture.baseline_paths || hash(baselineJson) !== preparedFixture.baseline_sha256)
        throw new Error('fresh fixture baseline content/path mismatch');
    // The turn-free arm (issue #110) differs only in how owners coordinate: no messages, facts from the hub.
    const turnFree = kind === 'hub-turnfree-codex-claude';
    // The #106 ablation (issue #110): the advisory arm with stale-notice dropping switched off, nothing else different.
    const staleOff = kind === 'hub-staleoff-codex-claude';
    const coordination = turnFree
        ? 'Accept with a concrete plan, then complete with hub_task_done. Do not message the other peer: the hub shows you its changes at your tool calls and asks the last to finish to check its work.'
        : 'Accept with a concrete plan, coordinate interface contracts with the named peer when source overlaps, then complete with hub_task_done.';
    writeFileSync(join(dir, 'AGENTS.md'), `# Sealed CooperBench fixture\nYou are an authorized native coding agent in a disposable benchmark project. Work only inside this directory. No external apps/messages, installs, network requests, history lookup, commits, subagents, test edits or changes to .gitignore, AGENTS.md, .claude or .agenthub. Hidden tests and gold solutions are not available. Use native source tools and local shell when needed. Each assigned task is the only work to do. ${coordination} Do not propose tasks. The other peer owns only its assigned feature. ${turnFree ? 'Do not silently overwrite its work.' : 'You may agree on integration, but do not silently overwrite its work.'} FYI needs no acknowledgement. Final answer [FYI]. Claude uses hub_send with reply_to for channel replies. No hidden test feedback is supplied.\n`);
    writeFileSync(join(dir, '.gitignore'), readFileSync(join(dir, '.gitignore'), 'utf8') + '\n.agenthub/\n.claude/\n');
    const state = join(dir, '.agenthub/state');
    mkdirSync(join(dir, '.agenthub'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, '.claude'), { mode: 0o700 });
    const denied = [...protectedRoots, ...[join(runs, 'runs'), join(runs, 'patches'), join(runs, 'private'), ...(await (async () => { const fs = await import('node:fs/promises'); return (await fs.readdir(join(runs, 'fixtures'))).map(x => join(runs, 'fixtures', x)).filter(x => resolve(x) !== resolve(dir)); })())]];
    writeFileSync(join(dir, '.agenthub/config.json'), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: true, keep: 50 }, watchdog_ms: 360000, batch_ms: 0, batch_max: 1, tasks: { release_after_min: 0 }, roles: { codex: ['implementer'], claude: ['implementer'] }, budget: { poll_min: 1 }, approvals: { notify: false }, codex_bin: join(dir, '.agenthub', 'codex-isolated.sh'), ...(turnFree ? { coordination: 'turn-free' } : {}), ...(staleOff ? { experiments: { stale_notices: 'deliver' } } : {}) }));
    // The Codex the hub runs, isolated (issue #110). Here, in the arm's own fixture, because every other run artifact is
    // locked while an arm runs; ignored by git, and started once, before Codex can touch anything.
    writeFileSync(join(dir, '.agenthub', 'codex-isolated.sh'), `#!/bin/sh\nexec ${shellQuote(codexBin)} "$@" ${codexIsolation.map(shellQuote).join(' ')}\n`, { mode: 0o700 });
    writeFileSync(join(dir, '.agenthub/routing.toml'), '[local]\nfixed_model="coding"\n[classes.implement]\npeers=["codex","claude"]\nescalate_to=[]\n[classes.review]\npeers=[]\nlocal_allowed=false\n');
    const permissions = { defaultMode: 'acceptEdits', allow: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', ...hubNames.map(n => 'mcp__agent-hub__' + n)], deny: ['WebFetch', 'WebSearch', 'Agent', 'Skill', 'Read(./.agenthub/**)', 'Read(./.claude/**)', 'Edit(./.agenthub/**)', 'Edit(./.claude/**)', 'Edit(./AGENTS.md)', 'Edit(./.gitignore)', 'Edit(./tests/**)'] };
    // Hooks are equal across arms (issue #110): none of the user's or a plugin's; the turn-free arm runs the hub's own
    // facts hook, which is part of its treatment. `--setting-sources project` keeps user settings out.
    const tee = { script: join(repo, 'src/cli/statusline-tee.ts'), stateDir: state };
    const session = JSON.parse(turnFree ? sessionSettings(tee, { script: join(repo, 'src/cli/facts-hook.ts'), stateDir: state }) : statusLineSettings(tee));
    // No arm runs a status line (issue #110): `disableAllHooks` turns it off in the other arms, so the turn-free arm,
    // which needs hooks on, leaves it out. Claude's quota therefore reaches the hub in no arm.
    const settings = { permissions, ...(turnFree ? { disableAllHooks: false, hooks: session.hooks } : { disableAllHooks: true }), sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { allowedDomains: [] }, filesystem: { denyRead: denied } } };
    writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify(settings));
    // The conditions each attempt ran with (issue #110): bound to its record, next to the capability readbacks in its events.
    const conditions = { claude: { settingSources: 'project', strictMcpConfig: true, disableAllHooks: !turnFree, statusLine: false, hookEvents: turnFree ? Object.keys(session.hooks ?? {}).sort() : [], settingsSha256: hash(JSON.stringify(settings)), skills: 'off: the Skill tool is denied', instructions: 'fixture AGENTS.md via --append-system-prompt-file' }, codex: { hooksFeature: false, memories: false, externalAgentMemoryImport: false, plugins: false, apps: false, multiAgent: false, notify: false, disabledMcpServers: codexUserServers, skills: (kind === 'solo-claude' ? 'not applicable: no Codex in this arm' : 'not checked: setup did not reach Codex') as any, instructions: 'fixture AGENTS.md as project doc; the user\'s global AGENTS.md too' }, coordination: turnFree ? 'turn-free' : kind.startsWith('hub-') ? 'advisory' : 'solo', ...(staleOff ? { experiments: { stale_notices: 'deliver' } } : {}) };
    const candidateMcp = join(dir, '.claude/candidate-mcp.json');
    writeFileSync(candidateMcp, JSON.stringify({ mcpServers: { 'agent-hub': { command: 'bun', args: [join(repo, 'plugins/agent-hub/server.js')], env: { AGENTHUB_STATE_DIR: state, AGENTHUB_PROJECT_DIR: dir, AGENTHUB_PEER_ID: 'claude' } } } }), { mode: 0o600 });
    await cmd(['git', 'add', '-A'], dir);
    await cmd(['git', '-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@localhost', 'commit', '-qm', 'sealed benchmark runtime fixture'], dir);
    const sealedBase = await cmd(['git', 'rev-parse', 'HEAD'], dir);
    const metadataBaseline = fixtureMetadataHash(dir);
    const setup = Date.now();
    let client: ControlClient | undefined, ws: WebSocket | undefined, claudeTerminal: string | undefined, orcaProject: any, projectId: any, started = 0, endReason = 'completed', error: string | undefined, armModes = new Map<string, number>();
    let claudeId = randomUUID(), thread: any, trustLease: any, codexMessages: any[] = [], taskStates: any[] = [], ids: number[] = [], pending = new Map<number, any>(), unkept = new Set<number>(), rpcId = 1, codexTaskStart = 0;
    const actors = kind === 'solo-codex' ? ['codex'] : kind === 'solo-claude' ? ['claude'] : ['codex', 'claude'], readiness: any = {};
    // The processes this arm started (issue #113), each with what proves it: the daemon by the pid in its state dir and
    // an argv that serves this fixture, Claude's launch chain by this arm's own session id, the Codex app-server as the
    // daemon's child. Captured as each starts, and again at teardown for an interrupt in between.
    const owners = new Map<string, Actor>();
    let persistedActors = '';
    const capture = () => {
        const table = processTable();
        if (!table) return;
        let hubPid = NaN;
        try { hubPid = Number(readFileSync(join(state, 'hub.pid'), 'utf8').trim()); } catch { }
        captureActors(owners, table, { dir, hubPid, claudeId, self: process.pid, cwdOf });
        const now = [...owners.values()], seen = JSON.stringify(now);
        if (seen === persistedActors) return; // the ledger is rewritten only when what it records changed
        persistedActors = seen;
        actorLedger.set(dir, now);
        persistLedger();
    };
    const captured = (role: Actor['role']) => { capture(); if (![...owners.values()].some(a => a.role === role)) throw new Error(`could not prove which ${role} process is this arm's`); };
    try {
        await lockSiblingArtifacts(dir, armModes);
        orcaProject = await ensureOrcaWorktree(dir);
        if (stopRequested)
            throw new Error('interrupted'); // before a hub is started for nothing
        await cmd(['bun', cliPath, '--project', dir, 'up'], dir);
        client = await wait(async () => { try {
            return await ControlClient.connect(state, { role: 'console' });
        }
        catch {
            return undefined;
        } }, 'hub control socket');
        const c = client!;
        const status = async () => (await c.request({ t: 'status' })).status;
        projectId = (await status()).projectId;
        captured('daemon');
        c.send({ t: 'tail' });
        if (actors.includes('claude')) {
            const trustFile = join(process.env.HOME!, '.claude.json');
            const trustState = JSON.parse(readFileSync(trustFile, 'utf8'));
            const trustMode = statSync(trustFile).mode & 0o777, hadProjects = !!trustState.projects;
            trustState.projects ??= {};
            trustLease = { file: trustFile, previous: trustState.projects[dir], written: { ...(trustState.projects[dir] ?? {}), hasTrustDialogAccepted: true }, hadProjects, mode: trustMode };
            trustState.projects[dir] = trustLease.written;
            trustLedger = { file: trustFile, project: dir, previous: trustLease.previous, written: trustLease.written, hadProjects: trustLease.hadProjects, mode: trustLease.mode, stage: 'pending', restored: false };
            persistLedger();
            const trustTemp = trustFile + '.ahub-benchmark-' + process.pid;
            writeFileSync(trustTemp, JSON.stringify(trustState, null, 2), { mode: 0o600 });
            renameSync(trustTemp, trustFile);
            trustLedger.stage = 'written';
            persistLedger();
            const claudeArgs = ['--restricted', '--strict-mcp-config', '--mcp-config', candidateMcp, '--model', manifest.models.claude, '--effort', manifest.effort.claude, '--session-id', claudeId, '--permission-mode', 'acceptEdits', '--settings', join(dir, '.claude/settings.json'), '--setting-sources', 'project', '--append-system-prompt-file', join(dir, 'AGENTS.md'), '--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--allowedTools', ...permissions.allow];
            const command = `bun ${shellQuote(cliPath)} --project ${shellQuote(dir)} claude ${claudeArgs.map(shellQuote).join(' ')}`;
            const claudeHandle = await createOrcaTerminal(orcaProject!.worktreeId, `bench-claude-${name}`, command);
            claudeTerminal = claudeHandle;
            const channelPrompt = await waitClaudeTui(claudeHandle);
            const terminalList = await orca(['terminal', 'list', '--worktree', `id:${orcaProject!.worktreeId}`]);
            const terminalIdentity = findRecord(terminalList, (x: any) => x.handle === claudeHandle);
            if (!terminalIdentity || resolve(terminalIdentity.worktreePath) !== resolve(dir))
                throw new Error('Claude Orca terminal cwd identity mismatch');
            const nativeInstance = (await status()).instanceId;
            const launchRecords = JSON.parse(readFileSync(join(state, 'terminal-recovery.json'), 'utf8'));
            const launch = launchRecords.find((record: any) => record.peer === 'claude' && record.handle === claudeHandle && record.instanceId === nativeInstance && record.projectRoot === dir);
            if (!launch) throw new Error('Claude launch does not belong to this native instance');
            captured('claude');
            const configRoot = launch.env?.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
            const nativeTranscript = join(configRoot, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${claudeId}.jsonl`);
            readiness.claude = { sessionId: claudeId, instanceId: nativeInstance, transcriptPath: nativeTranscript, requestedModel: manifest.models.claude, cwd: dir, orcaTerminal: claudeHandle, channelPromptConfirmed: channelPrompt.channelConfirmed };
            if (!protectedModes.has(probeTarget))
                throw new Error('sandbox probe target was not locked before native startup');
            const probeCommand = `if head -c 1 ${shellQuote(probeTarget)} >/dev/null 2>&1; then printf 'AHUB_PROBE_READABLE'; else printf 'AHUB_PROBE_DENIED'; fi`;
            const probePrompt = `Unscored setup-only sandbox probe. Use your Bash tool to run exactly this command, do not use Read or any other file tool, and finish with [FYI] followed by the command output: ${probeCommand}`;
            await sendTerminalText(claudeHandle, probePrompt);
            await waitClaudeTui(claudeHandle);
            await wait(async () => claudeProbe(nativeTranscript, probeCommand), 'Claude native sandbox read-denial probe');
            // The turn-end marker the completion wait relies on, proved on this session's probe turn (issue #113).
            readiness.claude.completionMarker = await wait(async () => { const rows = transcriptRows(nativeTranscript); return rows && turnEnded(rows, claudeId) ? 'turn_duration' : undefined; }, 'Claude turn-end marker', 15000).catch((e) => { if (stopRequested) throw e; return undefined; });
            const transcriptSessions = new Set(readFileSync(nativeTranscript, 'utf8').split('\n').flatMap(line => {
                try { const row = JSON.parse(line); return typeof row.sessionId === 'string' ? [row.sessionId] : []; } catch { return []; }
            }));
            if (!transcriptSessions.has(claudeId) || transcriptSessions.size !== 1) throw new Error('Claude sandbox probe crossed session identity');
            writeFileSync(join(state, 'claude-session.json'), JSON.stringify({ at: Date.now(), sessionId: claudeId, transcriptPath: nativeTranscript, instanceId: nativeInstance, launchId: launch.launchId }), { mode: 0o600 });
            readiness.claude.sandboxProbe = { checked: true, result: 'denied', target_sha256: probeTargetSha, command_sha256: hash(probeCommand) };
        }
        if (actors.includes('codex')) {
            const r = await c.request({ t: 'start', peer: 'codex' }, 90000);
            if (!r.ok)
                throw new Error(r.error);
            captured('codex-app-server');
            ws = new WebSocket(r.proxyUrl);
            const w = ws;
            const rpc = (method: string, params: any = {}, kept = true) => new Promise<any>((res, rej) => { const id = rpcId++; if (!kept) unkept.add(id); const timer = setTimeout(() => { pending.delete(id); rej(new Error(method + ' timeout')); }, 60000); pending.set(id, { res, rej, timer }); w.send(JSON.stringify({ id, method, params })); });
            w.onmessage = (e) => { const x = JSON.parse(String(e.data)); if (!(x.method === undefined && unkept.has(x.id))) codexMessages.push(x); if (x.id !== undefined && x.method) {
                let decision = x.method.includes('requestApproval') ? 'decline' : 'decline';
                w.send(JSON.stringify({ id: x.id, result: { decision } }));
                return;
            } const p = pending.get(x.id); if (p) {
                clearTimeout(p.timer);
                pending.delete(x.id);
                x.error ? p.rej(new Error(JSON.stringify(x.error))) : p.res(x.result);
            } };
            await new Promise<void>((res, rej) => { const timer = setTimeout(() => rej(new Error('Codex proxy did not open within 30 s')), 30000); w.onopen = () => { clearTimeout(timer); res(); }; w.onerror = () => { clearTimeout(timer); rej(new Error('Codex proxy failed')); }; });
            await rpc('initialize', { clientInfo: { name: 'ahub-native-benchmark', version: '1' }, capabilities: { experimentalApi: true } });
            w.send(JSON.stringify({ method: 'initialized' }));
            // No user or plugin hooks in any arm (issue #110): they cost Codex a median 5.7 s per session on 0.12.2.
            thread = await rpc('thread/start', { cwd: dir, model: manifest.models.codex, approvalPolicy: 'never', sandbox: 'workspace-write', config: { 'features.memories': false, 'features.external_agent_memory_import': false, 'features.hooks': false, model_reasoning_effort: manifest.effort.codex, web_search: 'disabled', sandbox_workspace_write: { network_access: false, exclude_slash_tmp: true, exclude_tmpdir_env_var: true } } });
            if (typeof thread.thread?.cwd !== 'string' || realPath(thread.thread.cwd) !== realPath(dir)) throw new Error('Codex native thread cwd mismatch');
            if (thread.model !== manifest.models.codex)
                throw new Error('Codex model mismatch');
            // The user's Codex skills stay on (issue #113): what app-server reports for this cwd, counted by scope, names hashed.
            // The answer itself (names, descriptions, absolute paths) never enters the record: its id is not kept.
            conditions.codex.skills = skillsCondition(await rpc('skills/list', { cwds: [dir] }, false).catch((e: unknown) => ({ error: /timeout$/.test(String(e)) ? 'timeout' : 'failed' }))); // its message may name a skill's path
            await wait(async () => codexMessages.some(x => x.method === 'mcpServer/startupStatus/updated' && x.params?.name === 'agent-hub' && x.params?.status === 'ready'), 'Codex MCP');
            readiness.codex = { threadId: thread.thread?.id, model: thread.model, effort: manifest.effort.codex, cwd: realPath(thread.thread.cwd), mcpReady: true };
            if (!protectedModes.has(probeTarget))
                throw new Error('sandbox probe target was not locked before native startup');
            const probeCommand = `if head -c 1 ${shellQuote(probeTarget)} >/dev/null 2>&1; then printf 'AHUB_PROBE_READABLE'; else printf 'AHUB_PROBE_DENIED'; fi`, probePrompt = `Unscored setup-only sandbox probe. Use your local command tool to run exactly this command, do not inspect or print file contents, and finish with [FYI] followed by the command output: ${probeCommand}`, probeStart = codexMessages.length;
            const probeTurn = await rpc('turn/start', { threadId: thread.thread?.id, input: [{ type: 'text', text: probePrompt }] });
            await wait(async () => codexMessages.slice(probeStart).some(x => x.method === 'turn/completed' && x.params?.threadId === thread.thread?.id && (!probeTurn.turn?.id || x.params?.turn?.id === probeTurn.turn.id)), 'Codex sandbox probe turn');
            if (!codexProbe(codexMessages, probeStart, probeCommand))
                throw new Error('Codex native sandbox probe did not prove read denial');
            readiness.codex.sandboxProbe = { checked: true, result: 'denied', target_sha256: probeTargetSha, command_sha256: hash(probeCommand) };
        }
        readiness.processes = [...owners.values()]; // what teardown must see gone (issue #113)
        if (setupOnly) { endReason = 'setup-calibration'; return; }
        const op = async (op: string, args: any) => { const r = await c.request({ t: 'task', op, args }); if (!r.ok)
            throw new Error(r.error); return r.text; };
        const assigned = kind.startsWith('hub-') && index % 2 ? ['claude', 'codex'] : actors;
        const input = cachedInputs[index];
        const detail = `Implement only the assigned feature(s) below in the sealed source tree. You have a 300 second active-work limit with no artificial tool-step cap. Do not touch fixture metadata, tests, history or other directories; no installs, web or external apps. Use hub_task_accept with a concrete source plan and hub_task_done on completion. ${turnFree ? 'Do not message the other owner; the hub shows you its changes as you work.' : 'Coordinate shared-file interfaces with the named other owner when present.'} Do not acknowledge FYI or conflict notices unless work is needed. Final [FYI].\n\n`;
        started = Date.now();
        codexTaskStart = codexMessages.length; // what came before is setup and the probe, never task work (issue #110)
        for (let k = 0; k < assigned.length; k++) {
            const prompts = assigned.length === 1 ? input.prompts : [input.prompts[k]];
            const r = await op('hub_task_propose', { class: 'implement', owner: assigned[k], refs: { paths: cas.paths ?? [] }, title: `CooperBench ${index} ${kind} feature ${assigned.length === 1 ? cas.features.join(',') : cas.features[k]}`, detail: detail + prompts.join('\n\n') });
            ids.push(Number(/#(\d+)/.exec(r)![1]));
        }
        log('arm-start', { index, kind, setupMs: started - setup });
        let settled = 0, finished = false;
        let captureAt = 0;
        while (Date.now() - started < 300000 && !stopRequested) {
            if (Date.now() - captureAt >= 5000) { capture(); captureAt = Date.now(); } // follow what the agents start (issue #113)
            taskStates = await Promise.all(ids.map(id => op('task_show', { id }).then(JSON.parse)));
            const s = await status();
            if (structuredQuota(codexMessages)) {
                endReason = 'provider-quota';
                break;
            }
            if (taskStates.some(t => t.history?.some((h: any) => h.event === 'declined' && /sandbox_apply|execution environment|tool.*fail/i.test(String(h.note ?? h.detail ?? ''))))) {
                endReason = 'infrastructure-error';
                break;
            }
            const done = taskStates.every(t => ['approved', 'in_review'].includes(t.state));
            const idle = actors.every(a => s.peers[a]?.state === 'idle' && s.peers[a]?.queued === 0 && !s.peers[a]?.liveAccepted?.length && !s.peers[a]?.needsReview);
            if (done && idle) {
                settled ||= Date.now();
                if (Date.now() - settled > 5000) {
                    finished = true;
                    break;
                }
            }
            else
                settled = 0;
            if (actors.some(a => s.peers[a]?.state === 'paused')) {
                endReason = 'budget-paused';
                break;
            }
            if (actors.some(a => s.peers[a]?.heldBy)) {
                endReason = 'needs-review';
                break;
            }
            if (actors.includes('claude') && s.peers.claude?.state === 'offline') {
                endReason = 'claude-exited';
                break;
            }
            await Bun.sleep(300);
        }
        // Only a loop that ran out of time is a timeout: a stop for another reason in the iteration that crossed the limit
        // keeps its own reason.
        if (!finished && endReason === 'completed' && Date.now() - started >= 300000)
            endReason = 'wall-timeout';
        else if (!finished && endReason === 'completed' && stopRequested)
            endReason = 'interrupted';
        taskStates = await Promise.all(ids.map(id => op('task_show', { id }).then(JSON.parse))).catch(() => taskStates); // as the work ended
    }
    catch (e) {
        error = String(e);
        endReason = stopRequested ? 'interrupted' : 'infrastructure-error'; // a stop during setup is still a stop (issue #113)
        log('arm-error', { index, kind, error });
    }
    finally {
        const activeEnd = Date.now();
        const elapsedMs = started ? activeEnd - started : 0;
        // Uncertain until the teardown below proves otherwise: an exception before it must not let inputs be restored.
        const uncertainBefore = containmentUncertain;
        containmentUncertain = true;
        const teardownErrors: string[] = []; // restoration and evidence; the process cleanup keeps its own record
        // What makes an attempt invalid besides how it ended (issue #113): kept beside the end reason, never over it.
        const endFlags: string[] = [];
        const note = (error: string) => { teardownErrors.push(error); log('cleanup-error', { index, kind, error }); };
        // Nothing new reaches an agent from here on (issue #113): its in-flight turn is all that can still write.
        if (client)
            for (const actor of actors)
                await client.request({ t: 'pause', peer: actor }).catch(() => { });
        // Deliveries still owed at the end of the active time, read before the wait: a message sent during it is not one.
        const finalStatus = client ? ((await client.request({ t: 'status' }).catch(() => ({ status: undefined }))).status) : undefined;
        const unsettled = actors.some(a => (finalStatus?.peers?.[a]?.liveAccepted?.length ?? 0) > 0 || finalStatus?.peers?.[a]?.needsReview || finalStatus?.peers?.[a]?.queued);
        if (unsettled && endReason === 'completed')
            endReason = 'delivery-unsettled';
        // A completed arm's tree is hashed at the end of its active time and again once teardown verified its processes
        // gone: a write in between (in the completion wait, or before the kill) would put work done after the active
        // time into the graded patch, so it flags the attempt invalid, its end reason kept beside the flag.
        const checkTree = endReason === 'completed'; // a timeout's tree is its submission as the agents were stopped
        const treeAtEnd = checkTree ? await treeHash(dir, sealedBase).catch(() => undefined) : undefined;
        // A completed arm lets Claude end the turn it is in, within 30 s and never past the 300 s limit, by the turn-end
        // marker proved on its probe turn.
        let completion: any = { outcome: 'not_applicable' };
        if (readiness.claude?.transcriptPath) {
            if (endReason !== 'completed') completion = { outcome: 'not_awaited', why: endReason };
            else if (!readiness.claude.completionMarker) completion = { outcome: 'unsupported', why: 'no turn-end marker was proved on this session' };
            else {
                const boundMs = Math.max(0, Math.min(30000, 300000 - (Date.now() - started))); // from now: the pause and the tree hash took time
                completion = { ...(await awaitTurnEnd(readiness.claude.transcriptPath, claudeId, boundMs, () => stopRequested)), boundMs };
            }
        }
        ws?.close();
        client?.close();
        // The arm's processes (issue #113): the normal shutdown, the table read back, signals only to proven identities.
        try { capture(); } catch (e) { note(`the last capture failed: ${String(e).slice(0, 200)}`); } // never skips the teardown
        const cleanup = await teardown([...owners.values()], dir, async () => {
            const errors: string[] = [];
            if (claudeTerminal) await orcaClose(claudeTerminal).catch(() => { errors.push('Claude Orca terminal close failed'); }); // bounded by cmd
            if (orcaProject) {
                // What `ahub kill` says is kept unless it is the plain answer: "hub is not running" with a live daemon was #113.
                await cmd(['bun', cliPath, '--project', dir, 'kill'], dir, undefined, 60000).then((out) => { if (out.trim() !== 'hub stopped') errors.push(`ahub kill said: ${out.trim().slice(0, 200)}`); }, (e) => { errors.push(`ahub kill: ${String(e).slice(0, 200)}`); });
                // An interrupt before the hub answered leaves its id unknown: the registration is found by its root.
                projectId ??= await cmd(['bun', cliPath, 'projects', '--json'], dir, undefined, 30000).then((out) => (JSON.parse(out) as { id: string; root: string }[]).find(p => p.root === dir)?.id, () => undefined);
                if (projectId) await cmd(['bun', cliPath, 'projects', 'remove', String(projectId)], dir, undefined, 30000).catch((e) => { errors.push(`projects remove: ${String(e).slice(0, 200)}`); });
            }
            return errors;
        });
        const contained = cleanup.outcome !== 'incomplete_or_unknown';
        const stoppedAt = contained ? Date.now() : 0; // writes could land until then
        if (contained) containmentUncertain = uncertainBefore;
        else log('cleanup-incomplete', { index, kind, reasons: cleanup.reasons });
        // Evidence, taken once nothing of the arm runs: the transcript's prefix with its session and time, the patch.
        const capture0 = Date.now();
        if (actors.includes('claude') && readiness.claude) {
            try {
                const evidence = claudeEvidence(readiness.claude.transcriptPath);
                readiness.claude.actualModels = evidence.models;
                readiness.claude.modelVerified = evidence.models.length === 1 && evidence.models[0] === manifest.models.claude;
                readiness.claude.nativeUsage = evidence.usage;
            }
            catch { note('Claude transcript evidence could not be read'); }
            if (!readiness.claude.modelVerified)
                endFlags.push('model-unverified');
        }
        // Claude Code may still append rows after this: the attempt is this prefix, and only it (issue #110).
        if (readiness.claude?.transcriptPath && existsSync(readiness.claude.transcriptPath)) {
            try {
                const bytes = readFileSync(readiness.claude.transcriptPath);
                readiness.claude.transcriptBytes = bytes.length;
                readiness.claude.transcriptSha256 = hash(bytes);
                readiness.claude.transcriptCapture = { sessionId: claudeId, at: new Date().toISOString(), afterCleanup: cleanup.outcome };
            }
            catch { note('Claude transcript prefix could not be read'); }
        }
        let treeAfterActive: boolean | null | undefined;
        if (checkTree) {
            const after = await treeHash(dir, sealedBase).catch(() => undefined);
            treeAfterActive = treeAtEnd === undefined || after === undefined ? null : treeAtEnd !== after;
            if (treeAfterActive !== false) endFlags.push(treeAfterActive ? 'tree-changed-after-active-time' : 'tree-unverified-after-active-time');
        }
        let metadataClean = false;
        try { metadataClean = fixtureMetadataHash(dir) === metadataBaseline; } catch (e) { note(`fixture metadata could not be read: ${String(e).slice(0, 200)}`); }
        if (!metadataClean)
            endFlags.push('metadata-modified');
        let patch = '';
        try {
            await cmd(['git', 'add', '-N', '--', '.'], dir);
            patch = await cmd(['git', 'diff', sealedBase.trim(), '--', '.'], dir);
        }
        catch (e) { note(`patch could not be collected: ${String(e).slice(0, 200)}`); }
        const captureMs = Date.now() - capture0;
        // Restoration, only once nothing of the arm can read what it exposes (issue #113): with the cleanup incomplete
        // or unknown, the sibling locks and the protected inputs stay, and the record goes beside the run's ledger.
        const restoration0 = Date.now();
        const restoration: any = { siblings: 'kept: the cleanup is incomplete or unknown', trust: trustLease ? undefined : 'not_applicable' };
        if (contained) {
            const failed = restoreModes(armModes);
            restoration.siblings = failed.length ? `failed: ${failed.length} path(s)` : 'restored';
            const sibling = siblingLedgers.get(dir);
            if (sibling) { sibling.restored = !failed.length; if (sibling.restored) sibling.modes = {}; } // nothing left to restore: not rewritten with every later write
            if (failed.length) note('sibling artifact read locks could not be restored');
        }
        let trustRestored = true;
        if (trustLease && !contained) {
            // Claude may still run and rewrite its project entry: the recovery takes it back once nothing does.
            restoration.trust = 'kept: the cleanup is incomplete or unknown';
            trustRestored = false;
        }
        else if (trustLease) {
            restoration.trust = restoreTrust(trustLease, dir);
            trustRestored = restoration.trust === 'restored';
            trustLedger.restored = trustRestored;
            trustLedger.stage = restoration.trust;
            if (!trustRestored) note(restoration.trust === 'changed_concurrently' ? 'Claude trust entry changed concurrently; preserved current state' : 'Claude trust restore failed');
        }
        persistLedger();
        const restorationMs = Date.now() - restoration0;
        const recordRoot = restoration.siblings === 'restored' ? runs : join(runs, 'recovery');
        mkdirSync(join(recordRoot, 'runs'), { recursive: true, mode: 0o700 });
        mkdirSync(join(recordRoot, 'patches'), { recursive: true, mode: 0o700 });
        const patchFile = join(recordRoot, 'patches', name + '.patch');
        writeFileSync(patchFile, patch, { mode: 0o600 });
        let events: any[] = [];
        try { events = readEvents(join(state, 'events.jsonl')); } catch { note('hub events could not be read'); }
        const result = { protocol: 'native-cc-v1', index, kind, repo: cas.repo, features: cas.features, project: dir, cwd: dir, sealedCommit: sealedBase.trim(), models: manifest.models, requestedModels: actors.reduce((o: any, a: string) => (o[a] = manifest.models[a], o), {}), readiness, patchFile, model: actors.length === 1 ? manifest.models[actors[0]!] : undefined, setupMs: started ? started - setup : Date.now() - setup, elapsedMs, stoppedMs: stoppedAt ? stoppedAt - activeEnd : undefined, teardownMs: Date.now() - activeEnd, stages: { completionMs: completion.ms, shutdownMs: cleanup.normal.ms, settleMs: cleanup.ms.settle, fallbackMs: cleanup.ms.fallback, captureMs, restorationMs }, end_reason: endReason === 'infrastructure-error' ? 'infrastructure-error' : endReason === 'provider-quota' ? 'provider-quota' : endReason === 'budget-paused' ? 'budget-paused' : endFlags.length && endReason !== 'interrupted' ? 'infrastructure-error' : endReason === 'completed' ? 'completed' : endReason === 'delivery-unsettled' ? 'delivery-unsettled' : endReason === 'wall-timeout' ? 'timeout' : 'interrupted', end_reason_detail: endReason, end_flags: endFlags.length ? endFlags : undefined, error: error ? String(error).replace(/(token|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/ig, '$1$2[redacted]').slice(0, 300) : undefined, taskStates, effort: manifest.effort, events, codexMessages, codexTaskStart, startedAt: started || undefined, repeat, conditions, codexUsage: codexUsage(codexMessages, thread?.thread?.id), nativeVersions: { codex: codexVersion, claude: claudeVersion }, codexBinarySha256: sourceHash(codexBin), claudeSessionId: actors.includes('claude') ? claudeId : undefined, codexThreadId: thread?.thread?.id, completion, tree_changed_after_active_time: treeAfterActive, cleanup, restoration, trust_restored: trustRestored, cleanup_complete: contained, teardown_errors: teardownErrors.length ? teardownErrors : undefined, metadata_clean: metadataClean, metadata_sha256: metadataBaseline, delivery_status: finalStatus?.peers };
        writeFileSync(join(recordRoot, 'runs', name + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
        log('arm-end', { index, kind, elapsedMs, endReason, cleanup: cleanup.outcome, completion: completion.outcome, patchLines: patch.split('\n').length });
        if (!contained)
            throw new Error(`cleanup ${cleanup.outcome}: ${cleanup.reasons.join('; ')}; inputs stay locked, record in ${join(recordRoot, 'runs', name + '.json')}`);
        if (teardownErrors.length)
            throw new Error('teardown incomplete; stopping cohort: ' + teardownErrors.join('; '));
    }
}
/**
 * The tree's tracked diff against the sealed baseline and its untracked files' contents, hashed: what a wait might have
 * let an agent write. Read-only for the agent's repository: no index write, no optional lock.
 */
async function treeHash(dir: string, sealed: string) {
    const env = { GIT_OPTIONAL_LOCKS: '0' };
    const tracked = await cmd(['git', 'diff', sealed.trim(), '--', '.'], dir, env);
    const untracked = (await cmd(['git', 'ls-files', '-z', '-o', '--exclude-standard', '--', '.'], dir, env)).split('\0').filter(Boolean).sort();
    // Never through a link, never a fifo or a device, never more than 16 MiB read: what git itself would see, or size and time.
    const entry = (f: string) => {
        try {
            const st = lstatSync(join(dir, f));
            if (st.isSymbolicLink()) return [f, 'link', readlinkSync(join(dir, f))];
            if (!st.isFile()) return [f, 'special', st.mode];
            const bytes = regularBytes(join(dir, f), 16 * 1024 * 1024);
            return typeof bytes === 'string' ? [f, bytes] : [f, hash(bytes)];
        }
        catch { return [f, null]; }
    };
    return hash(JSON.stringify([tracked, untracked.map(entry)]));
}
let containmentUncertain = false;
const setupOnly = argv.includes('--setup-only');
// Repeats of one case (issue #110) rotate the arm order too, so no arm always runs last.
const repeatIndex = argv.indexOf('--repeat');
const repeat = repeatIndex >= 0 ? Number(argv[repeatIndex + 1]) : 0;
if (!Number.isInteger(repeat) || repeat < 0)
    throw new Error('--repeat takes a whole number (0 for the first repeat)');
const selectedIndex = argv.indexOf('--cases');
const selectedArg = selectedIndex >= 0 ? argv[selectedIndex + 1] : undefined;
const selected: number[] = selectedArg ? selectedArg.split(',').map(Number) : m.cases.map((_: any, i: number) => i);
if (!selected.length || new Set(selected).size !== selected.length || selected.some((i: number) => !Number.isInteger(i) || i < 0 || i >= m.cases.length))
    throw new Error('invalid case selection');
if ((existsSync(join(runs, 'runs')) && readdirSync(join(runs, 'runs')).length) || existsSync(join(runs, 'recovery')))
    throw new Error('run directory already contains attempts; use a new attempt directory');
mkdirSync(join(runs, 'private'), { recursive: true, mode: 0o700 });
// Strict MCP isolation for Codex in every arm (issue #110): the user's plugins, apps, sub-agents and turn-end notifier
// are off, and each MCP server the user's config defines is disabled by name; the hub adds only its own. Nothing in the
// user's config is changed: the hub runs Codex through this wrapper.
const codexUserServers = (JSON.parse(await cmd([codexBin, '--disable', 'plugins', 'mcp', 'list', '--json'], runs)) as { name: unknown }[]).map(x => String(x.name)).filter(n => n !== 'agent-hub');
if (codexUserServers.some(n => !/^[A-Za-z0-9_-]+$/.test(n)))
    throw new Error('a Codex MCP server name cannot be disabled by a -c override; isolate it by hand before a run');
const codexIsolation = ['--disable', 'plugins', '--disable', 'apps', '--disable', 'multi_agent', '-c', 'notify=[]', ...codexUserServers.flatMap(n => ['-c', `mcp_servers.${n}.enabled=false`])];
mkdirSync(join(runs, 'runs'), { recursive: true, mode: 0o700 });
mkdirSync(join(runs, 'patches'), { recursive: true, mode: 0o700 });
writeFileSync(join(runs, 'cohort.json'), JSON.stringify({ schema: m.schema, manifest_sha256: sourceHash(join(runs, 'manifest.json')), cases: selected, calibration: setupOnly, repeat, private_case_sha256: Object.fromEntries(selected.map(i => [i, privateCaseHashes[i]])), arms: m.arms, runner_sha256: prepared.runner_sha256, native_runner_sha256: prepared.native_runner_sha256, teardown_sha256: prepared.teardown_sha256 }), { mode: 0o600 });
try {
    await protectInputs();
    for (const i of selected) {
        if (stopRequested)
            break;
        // A Williams design (issue #110): row (case + repeat) of n arms is 0, 1, n-1, 2, n-2, ... shifted by the row, so
        // over n consecutive rows every arm runs right before every other one once (for an even n).
        const n = m.arms.length, row = (i + repeat) % n;
        const step = (j: number) => { if (j === 0) return 0; return j % 2 ? (j + 1) / 2 : n - j / 2; };
        const order = Array.from({ length: n }, (_, j) => m.arms[(step(j) + row) % n]);
        for (const kind of order) {
            if (stopRequested)
                break;
            await arm(m.cases[i], i, kind, m);
        }
    }
}
finally {
    // Protected inputs become readable again only when every arm's processes are known to be gone (issue #113).
    if (containmentUncertain) {
        writeAtomic(join(runs, 'restoration.json'), JSON.stringify({ restored: false, reason: 'an arm\'s cleanup is incomplete or unknown: protected inputs and its sibling artifacts stay unreadable', ledger: 'restoration-ledger.json', records: 'recovery/runs', recover: `bun scripts/benchmarks/restore.ts --run ${runs}`, interrupted: stopRequested }));
        log('restoration-withheld', { recover: `bun scripts/benchmarks/restore.ts --run ${runs}` });
    }
    else {
        await restoreInputs();
        // Protected inputs are back; an arm whose own sibling locks failed to come off keeps the run unrestored.
        const locked = [...siblingLedgers.entries()].filter(([, l]) => !l.restored).map(([d]) => d);
        const trustLeft = !!trustLedger && !trustLedger.restored && trustLedger.stage !== 'changed_concurrently';
        const reasons = [...(locked.length ? [`sibling read locks of ${locked.length} arm(s) are still in place`] : []), ...(trustLeft ? ['the Claude trust entry was not taken back'] : [])];
        writeAtomic(join(runs, 'restoration.json'), JSON.stringify({ restored: !reasons.length, paths: protectedModes.size, ...(reasons.length ? { reason: reasons.join('; '), recover: `bun scripts/benchmarks/restore.ts --run ${runs}` } : {}), interrupted: stopRequested }));
    }
}
log('run-complete');
