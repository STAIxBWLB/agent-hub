import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync, statSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { ControlClient } from '../../src/hub/control-client.ts';
import { realPath } from '../../src/hub/project.ts';
import { sessionSettings, statusLineSettings } from '../../src/cli/launch.ts';
import { readEvents } from '../../src/hub/events.ts';
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
if (prepared.runner_sha256 !== sourceHash(join(import.meta.dir, 'runner.py')) || prepared.native_runner_sha256 !== sourceHash(join(import.meta.dir, 'native.ts')) || prepared.evaluator_sha256 !== sourceHash(join(import.meta.dir, 'evaluate.py')) || resolve(prepared.upstream_root ?? '') !== upstreamRoot)
    throw new Error('benchmark runner changed after preparation');
class NativeCommandError extends Error { constructor(message: string, readonly code?: string) { super(message); } }
const log = (event: string, data: any = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
let stopRequested = false;
process.on('SIGINT', () => { stopRequested = true; });
process.on('SIGTERM', () => { stopRequested = true; });
async function cmd(args: string[], cwd?: string) { const p = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' }); const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (code) {
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
function persistLedger() { writeFileSync(join(runs, 'restoration-ledger.json'), JSON.stringify({ protected: { paths: Object.fromEntries(protectedModes), restored: protectedRestored }, siblings: Object.fromEntries(siblingLedgers), trust: trustLedger }, null, 2), { mode: 0o600 }); }
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
async function restoreInputs() { const errors: string[] = []; for (const [path, mode] of [...protectedModes.entries()].sort((a, b) => a[0].length - b[0].length)) {
    try {
        chmodSync(path, mode);
        if ((statSync(path).mode & 0o777) !== mode)
            errors.push(path);
    }
    catch {
        errors.push(path);
    }
} if (errors.length)
    throw new Error('failed to restore protected inputs: ' + errors.length + ' path(s)'); protectedRestored = true; persistLedger(); }
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
function restoreModeMap(modes: Map<string, number>) { const errors: string[] = []; for (const [path, mode] of [...modes.entries()].sort((a, b) => a[0].length - b[0].length)) {
    try {
        chmodSync(path, mode);
        if ((statSync(path).mode & 0o777) !== mode)
            errors.push(path);
    }
    catch {
        errors.push(path);
    }
} if (errors.length)
    throw new Error(`failed to restore ${errors.length} sibling artifact permissions`); }
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
function fixtureMetadataHash(root: string) { const names = ['AGENTS.md', '.gitignore', '.claude/settings.json', '.agenthub/config.json', '.agenthub/routing.toml'], values: any = {}; for (const name of names) {
    const path = join(root, name);
    values[name] = existsSync(path) ? hash(readFileSync(path)) : null;
} return hash(JSON.stringify(values)); }
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
    const conditions = { claude: { settingSources: 'project', strictMcpConfig: true, disableAllHooks: !turnFree, statusLine: false, hookEvents: turnFree ? Object.keys(session.hooks ?? {}).sort() : [], settingsSha256: hash(JSON.stringify(settings)), instructions: 'fixture AGENTS.md via --append-system-prompt-file' }, codex: { hooksFeature: false, memories: false, externalAgentMemoryImport: false, plugins: false, apps: false, multiAgent: false, notify: false, disabledMcpServers: codexUserServers, instructions: 'fixture AGENTS.md as project doc; the user\'s global AGENTS.md too' }, coordination: turnFree ? 'turn-free' : kind.startsWith('hub-') ? 'advisory' : 'solo', ...(staleOff ? { experiments: { stale_notices: 'deliver' } } : {}) };
    const candidateMcp = join(dir, '.claude/candidate-mcp.json');
    writeFileSync(candidateMcp, JSON.stringify({ mcpServers: { 'agent-hub': { command: 'bun', args: [join(repo, 'plugins/agent-hub/server.js')], env: { AGENTHUB_STATE_DIR: state, AGENTHUB_PROJECT_DIR: dir, AGENTHUB_PEER_ID: 'claude' } } } }), { mode: 0o600 });
    await cmd(['git', 'add', '-A'], dir);
    await cmd(['git', '-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@localhost', 'commit', '-qm', 'sealed benchmark runtime fixture'], dir);
    const sealedBase = await cmd(['git', 'rev-parse', 'HEAD'], dir);
    const metadataBaseline = fixtureMetadataHash(dir);
    const setup = Date.now();
    let client: ControlClient | undefined, ws: WebSocket | undefined, claudeTerminal: string | undefined, managerTerminal: string | undefined, orcaProject: any, projectId: any, started = 0, endReason = 'completed', error: string | undefined, armModes = new Map<string, number>();
    let claudeId = randomUUID(), thread: any, trustLease: any, codexMessages: any[] = [], taskStates: any[] = [], ids: number[] = [], pending = new Map<number, any>(), rpcId = 1, codexTaskStart = 0;
    const actors = kind === 'solo-codex' ? ['codex'] : kind === 'solo-claude' ? ['claude'] : ['codex', 'claude'], readiness: any = {};
    try {
        await lockSiblingArtifacts(dir, armModes);
        orcaProject = await ensureOrcaWorktree(dir);
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
            ws = new WebSocket(r.proxyUrl);
            const w = ws;
            const rpc = (method: string, params: any = {}) => new Promise<any>((res, rej) => { const id = rpcId++; const timer = setTimeout(() => { pending.delete(id); rej(new Error(method + ' timeout')); }, 60000); pending.set(id, { res, rej, timer }); w.send(JSON.stringify({ id, method, params })); });
            w.onmessage = (e) => { const x = JSON.parse(String(e.data)); codexMessages.push(x); if (x.id !== undefined && x.method) {
                let decision = x.method.includes('requestApproval') ? 'decline' : 'decline';
                w.send(JSON.stringify({ id: x.id, result: { decision } }));
                return;
            } const p = pending.get(x.id); if (p) {
                clearTimeout(p.timer);
                pending.delete(x.id);
                x.error ? p.rej(new Error(JSON.stringify(x.error))) : p.res(x.result);
            } };
            await new Promise<void>((res, rej) => { w.onopen = () => res(); w.onerror = () => rej(new Error('Codex proxy failed')); });
            await rpc('initialize', { clientInfo: { name: 'ahub-native-benchmark', version: '1' }, capabilities: { experimentalApi: true } });
            w.send(JSON.stringify({ method: 'initialized' }));
            // No user or plugin hooks in any arm (issue #110): they cost Codex a median 5.7 s per session on 0.12.2.
            thread = await rpc('thread/start', { cwd: dir, model: manifest.models.codex, approvalPolicy: 'never', sandbox: 'workspace-write', config: { 'features.memories': false, 'features.external_agent_memory_import': false, 'features.hooks': false, model_reasoning_effort: manifest.effort.codex, web_search: 'disabled', sandbox_workspace_write: { network_access: false, exclude_slash_tmp: true, exclude_tmpdir_env_var: true } } });
            if (typeof thread.thread?.cwd !== 'string' || realPath(thread.thread.cwd) !== realPath(dir)) throw new Error('Codex native thread cwd mismatch');
            if (thread.model !== manifest.models.codex)
                throw new Error('Codex model mismatch');
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
        while (Date.now() - started < 300000 && !stopRequested) {
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
        endReason = 'infrastructure-error';
        log('arm-error', { index, kind, error });
    }
    finally {
        const activeEnd = Date.now();
        const elapsedMs = started ? activeEnd - started : 0;
        let stoppedAt = 0; // when every actor this attempt started was stopped: writes can land until then
        if (client) {
            for (const actor of actors)
                await client.request({ t: 'pause', peer: actor }).catch(() => { });
        }
        const finalStatus = client ? ((await client.request({ t: 'status' }).catch(() => ({ status: undefined }))).status) : undefined;
        let cleanupFailed = false;
        if (claudeTerminal) {
            try {
                await orcaClose(claudeTerminal);
            }
            catch {
                cleanupFailed = true;
                log('cleanup-error', { index, kind, error: 'Claude Orca terminal close failed' });
            }
        }
        const unsettled = actors.some(a => (finalStatus?.peers?.[a]?.liveAccepted?.length ?? 0) > 0 || finalStatus?.peers?.[a]?.needsReview || finalStatus?.peers?.[a]?.queued); 
        if (unsettled && endReason === 'completed')
            endReason = 'delivery-unsettled';
        ws?.close();
        client?.close();
        if (actors.includes('claude') && readiness.claude) {
            const evidence = claudeEvidence(readiness.claude.transcriptPath);
            readiness.claude.actualModels = evidence.models;
            readiness.claude.modelVerified = evidence.models.length === 1 && evidence.models[0] === manifest.models.claude;
            readiness.claude.nativeUsage = evidence.usage;
            if (!readiness.claude.modelVerified)
                endReason = 'model-unverified';
        }
        if (orcaProject) {
            try {
                await cmd(['bun', cliPath, '--project', dir, 'kill'], dir);
                stoppedAt = Date.now();
                if (projectId) await cmd(['bun', cliPath, 'projects', 'remove', String(projectId)], dir);
            }
            catch {
                cleanupFailed = true;
                log('cleanup-error', { index, kind, error: 'owned hub shutdown or registration cleanup failed' });
            }
        }
        if (managerTerminal) {
            try {
                await orcaClose(managerTerminal);
            }
            catch {
                cleanupFailed = true;
                log('cleanup-error', { index, kind, error: 'owned hub terminal close failed' });
            }
        }
        try {
            restoreModeMap(armModes);
            const sibling = siblingLedgers.get(dir);
            if (sibling)
                sibling.restored = true;
            persistLedger();
        }
        catch {
            cleanupFailed = true;
            log('cleanup-error', { index, kind, error: 'sibling artifact read locks could not be restored' });
        }
        let trustRestored = true;
        if (trustLease) {
            try {
                const fresh = JSON.parse(readFileSync(trustLease.file, 'utf8'));
                if (fresh.projects?.[dir]?.hasTrustDialogAccepted === true) {
                    if (trustLease.previous === undefined)
                        delete fresh.projects[dir];
                    else
                        { const current = { ...fresh.projects[dir] }; if (Object.hasOwn(trustLease.previous, 'hasTrustDialogAccepted')) current.hasTrustDialogAccepted = trustLease.previous.hasTrustDialogAccepted; else delete current.hasTrustDialogAccepted; fresh.projects[dir] = current; }
                    if (!trustLease.hadProjects && !Object.keys(fresh.projects).length)
                        delete fresh.projects;
                    const temp = trustLease.file + '.ahub-benchmark-restore-' + process.pid;
                    writeFileSync(temp, JSON.stringify(fresh, null, 2), { mode: trustLease.mode });
                    chmodSync(temp, trustLease.mode);
                    renameSync(temp, trustLease.file);
                    trustLedger.restored = true;
                    trustLedger.stage = 'restored';
                    persistLedger();
                }
                else {
                    trustRestored = false;
                    cleanupFailed = true;
                    log('cleanup-error', { index, kind, error: 'Claude trust entry changed concurrently; preserved current state' });
                }
            }
            catch {
                trustRestored = false;
                cleanupFailed = true;
                log('cleanup-error', { index, kind, error: 'Claude trust restore failed' });
            }
        }
        // The transcript as the attempt left it (issue #110): validity is read from it later, and a changed one is unknown.
        if (readiness.claude?.transcriptPath && existsSync(readiness.claude.transcriptPath)) readiness.claude.transcriptSha256 = sourceHash(readiness.claude.transcriptPath);
        const metadataClean = fixtureMetadataHash(dir) === metadataBaseline;
        if (!metadataClean)
            endReason = 'metadata-modified';
        await cmd(['git', 'add', '-N', '--', '.'], dir);
        const patch = await cmd(['git', 'diff', sealedBase.trim(), '--', '.'], dir);
        const patchFile = join(runs, 'patches', name + '.patch');
        writeFileSync(patchFile, patch, { mode: 0o600 });
        const events = readEvents(join(state, 'events.jsonl'));
        const result = { protocol: 'native-cc-v1', index, kind, repo: cas.repo, features: cas.features, project: dir, cwd: dir, sealedCommit: sealedBase.trim(), models: manifest.models, requestedModels: actors.reduce((o: any, a: string) => (o[a] = manifest.models[a], o), {}), readiness, patchFile, model: actors.length === 1 ? manifest.models[actors[0]!] : undefined, setupMs: started ? started - setup : Date.now() - setup, elapsedMs, stoppedMs: stoppedAt ? stoppedAt - activeEnd : undefined, teardownMs: Date.now() - activeEnd, end_reason: cleanupFailed ? 'infrastructure-error' : endReason === 'infrastructure-error' ? 'infrastructure-error' : endReason === 'provider-quota' ? 'provider-quota' : endReason === 'budget-paused' ? 'budget-paused' : endReason === 'model-unverified' || endReason === 'metadata-modified' ? 'infrastructure-error' : endReason === 'completed' ? 'completed' : endReason === 'delivery-unsettled' ? 'delivery-unsettled' : endReason === 'wall-timeout' ? 'timeout' : 'interrupted', end_reason_detail: endReason, error: error ? String(error).replace(/(token|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/ig, '$1$2[redacted]').slice(0, 300) : undefined, taskStates, effort: manifest.effort, events, codexMessages, codexTaskStart, startedAt: started || undefined, repeat, conditions, codexUsage: codexUsage(codexMessages, thread?.thread?.id), nativeVersions: { codex: codexVersion, claude: claudeVersion }, codexBinarySha256: sourceHash(codexBin), claudeSessionId: actors.includes('claude') ? claudeId : undefined, codexThreadId: thread?.thread?.id, trust_restored: trustRestored, cleanup_complete: !cleanupFailed, metadata_clean: metadataClean, metadata_sha256: metadataBaseline, delivery_status: finalStatus?.peers };
        writeFileSync(join(runs, 'runs', name + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
        log('arm-end', { index, kind, elapsedMs, endReason, patchLines: patch.split('\n').length });
        if (cleanupFailed)
            throw new Error('cleanup incomplete; stopping cohort to avoid unmanaged actors');
    }
}
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
if (existsSync(join(runs, 'runs')) && readdirSync(join(runs, 'runs')).length)
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
writeFileSync(join(runs, 'cohort.json'), JSON.stringify({ schema: m.schema, manifest_sha256: sourceHash(join(runs, 'manifest.json')), cases: selected, calibration: setupOnly, repeat, private_case_sha256: Object.fromEntries(selected.map(i => [i, privateCaseHashes[i]])), arms: m.arms, runner_sha256: prepared.runner_sha256, native_runner_sha256: prepared.native_runner_sha256 }), { mode: 0o600 });
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
    await restoreInputs();
    writeFileSync(join(runs, 'restoration.json'), JSON.stringify({ restored: true, paths: protectedModes.size, interrupted: stopRequested }), { mode: 0o600 });
}
log('run-complete');
