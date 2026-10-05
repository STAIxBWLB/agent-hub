import { chmodSync, openSync, fstatSync, closeSync, constants as fsConstants, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { descendantsOf, processTable, type ProcRow } from '../../src/hub/child-process.ts';
import { realPath } from '../../src/hub/project.ts';

/**
 * Teardown of one benchmark arm (issue #113). An actor is a process the arm started, recorded with the evidence that
 * proves it is the arm's; its identity is the pid with its start time, never a name in its argv (Codex's need not name
 * the fixture, and a reused pid or a replacement hub may). Teardown asks for the normal shutdown, reads the process
 * table back, falls back to signals only for processes whose identity still matches, and says which of `clean`,
 * `clean_with_fallback` or `incomplete_or_unknown` it got. A process it cannot prove is the arm's is never signalled.
 */

export type Role = 'daemon' | 'codex-app-server' | 'claude' | 'native-peer' | 'below';
export interface Actor { role: Role; pid: number; started: string; pgid: number; via: string }
export interface Cleanup {
    outcome: 'clean' | 'clean_with_fallback' | 'incomplete_or_unknown';
    /** Why it is not clean; empty otherwise. */
    reasons: string[];
    /** The normal shutdown's own failures (a lost acknowledgement, a failed close), kept whatever the outcome. */
    normal: { errors: string[]; ms: number };
    /** Every recorded actor (some may have exited before teardown) and what was found below them: what has to be gone. */
    owned: Actor[];
    fallback: { pid: number; role: Role; signal: 'SIGTERM' | 'SIGSTOP' | 'SIGKILL' | 'SIGCONT'; group: boolean; result: 'sent' | 'failed' }[];
    remaining: Actor[];
    /** Running with the fixture in its argv or as its working directory, not proved to be the arm's: left alone, and the cleanup is not complete. */
    unresolved: { pid: number; started: string; program?: string; cwd?: string }[];
    ms: { settle: number; fallback: number; total: number };
}
export interface Deps {
    table: () => ProcRow[] | undefined;
    /** Each process's working directory, or undefined when they cannot be read. */
    cwds: () => Map<number, string> | undefined;
    signal: (pid: number, signal: 'SIGTERM' | 'SIGSTOP' | 'SIGKILL' | 'SIGCONT') => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    /** The runner itself: it and its children (a `bun ... kill` naming the fixture) are not the arm's. */
    self: number;
    /** The name of the executable process `pid` started at `started` runs, or undefined: what an unresolved process is recorded by. */
    comm?: (pid: number, started: string) => string | undefined;
}
export const realDeps: Deps = { table: processTable, cwds: processCwds, signal: (pid, signal) => process.kill(pid, signal), sleep: (ms) => Bun.sleep(ms), now: () => Date.now(), self: process.pid, comm: commOf };

/**
 * The name of the executable a process runs, as the kernel recorded it at exec (`ps -o ucomm=`, at most 16 characters),
 * for the process `pid` started at `started` only (a reused pid is someone else). Never `comm`: on macOS that is the
 * process's current argv[0], which a process that sets its own title (Node's `process.title`, perl's `$0`) fills with
 * its arguments. The runner runs on macOS only, where nothing but an exec sets `ucomm`. Bounded like every `ps` it runs.
 */
export function commOf(pid: number, started: string): string | undefined {
    try {
        const r = Bun.spawnSync(['ps', '-o', 'lstart=,ucomm=', '-p', String(pid)], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, detached: true, timeout: 5_000 });
        const m = r.exitCode === 0 ? /^\s*(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.+?)\s*$/.exec(r.stdout.toString()) : null;
        return m && m[1] === started ? m[2] : undefined;
    } catch { return undefined; }
}

/** The temp file a trust write goes through (`~/.claude.json.ahub-benchmark-<pid>`): a full copy of the user's state. */
export const trustTemp = (file: string, pid: number) => `${file}.ahub-benchmark-${pid}`;
/** The temp file a trust restore goes through, the same copy. */
export const restoreTemp = (file: string, pid: number) => `${file}.ahub-benchmark-restore-${pid}`;

export const same = (rows: ProcRow[], a: { pid: number; started: string }) => rows.find((r) => r.pid === a.pid && r.started === a.started);

/** Every process's working directory: `lsof` on macOS, `/proc` elsewhere; undefined when it cannot be read. */
export function processCwds(): Map<number, string> | undefined {
    const out = new Map<number, string>();
    if (process.platform === 'linux') {
        try {
            for (const entry of readdirSync('/proc')) {
                if (!/^\d+$/.test(entry)) continue;
                try { out.set(Number(entry), readlinkSync(`/proc/${entry}/cwd`)); } catch { /* another user's, or gone */ }
            }
            return out;
        } catch { return undefined; }
    }
    try {
        const r = Bun.spawnSync(['lsof', '-a', '-d', 'cwd', '-F', 'pn'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' }, detached: true, timeout: 20_000 });
        if (r.exitCode === null) return undefined; // timed out (a stale mount): unknown, never empty
        let pid = 0;
        for (const line of r.stdout.toString().split('\n')) {
            if (line.startsWith('p')) pid = Number(line.slice(1));
            else if (line.startsWith('n') && pid) out.set(pid, line.slice(1));
        }
        return out.size ? out : undefined;
    } catch { return undefined; }
}

/** One process's working directory, or undefined. */
export function cwdOf(pid: number): string | undefined {
    if (process.platform === 'linux') { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return undefined; } }
    try {
        const r = Bun.spawnSync(['lsof', '-a', '-d', 'cwd', '-p', String(pid), '-F', 'n'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' }, detached: true, timeout: 10_000 });
        return r.stdout.toString().split('\n').find((l) => l.startsWith('n'))?.slice(1);
    } catch { return undefined; }
}

/** Whether `path` is `dir` or inside it. */
export const inside = (path: string | undefined, dir: string) => path !== undefined && (path === dir || path.startsWith(`${dir}/`));

export const key = (a: { pid: number; started: string }) => `${a.pid}@${a.started}`;

/**
 * Adds to `owned` what the table shows below an owned process, and what is in the group an owned process leads while
 * that group is known to be the same one: its leader alive, or an owned member still in it (a group id is not reused
 * while any member lives). A group that may have emptied is not followed: its id can belong to someone else now.
 */
export function extend(owned: Map<string, Actor>, rows: ProcRow[]): void {
    for (const a of [...owned.values()]) {
        const row = same(rows, a), alive = !!row;
        // The group it is in now, by the current row: a process may lead a group of its own after it was recorded.
        if (row && row.pgid !== a.pgid) owned.set(key(a), { ...a, pgid: row.pgid });
        if (alive) for (const r of descendantsOf(rows, a.pid)) if (!owned.has(key(r))) owned.set(key(r), { role: 'below', pid: r.pid, started: r.started, pgid: r.pgid, via: `below ${a.role} ${a.pid}` });
        if ((row ?? a).pgid !== a.pid) continue;
        const known = alive || rows.some((r) => r.pgid === a.pid && r.pid !== a.pid && owned.has(key(r)));
        if (known) for (const r of rows) if (r.pgid === a.pid && !owned.has(key(r))) owned.set(key(r), { role: 'below', pid: r.pid, started: r.started, pgid: r.pgid, via: `group of ${a.role} ${a.pid}` });
    }
}

/** Written whole or not at all: a recovery reads it after a runner that may have died mid-write. */
export function writeAtomic(file: string, text: string): void { writeFileSync(`${file}.tmp`, text, { mode: 0o600 }); renameSync(`${file}.tmp`, file); }

/**
 * Why a prepared benchmark fixture root cannot be used, or undefined when it is the directory preparation made
 * (issue #119). A root replaced after preparation by a symlink to an equivalent outside tree passes the lexical
 * resolve() comparison and the baseline content checks, and redirects setup and agent writes there. The check is
 * read-only (lstat and the real path, never a follow, never a write), so a substitution is rejected without touching
 * its target. The real path is compared against the canonical parent joined with the root's own name: a root reached
 * under a different name than the one on disk (a case-insensitive filesystem opens both) is a substitution too.
 */
export interface FixtureRootIdentity { dev: number; ino: number }

export function fixtureRootProblem(dir: string, expected?: FixtureRootIdentity): string | undefined {
    let st;
    try { st = lstatSync(dir); } catch { return 'missing'; }
    if (st.isSymbolicLink()) return 'a symlink, not the prepared directory';
    if (!st.isDirectory()) return 'not a directory';
    if (realPath(dir) !== join(realPath(dirname(dir)), basename(dir))) return 'its real path differs from its prepared name';
    if (expected && (st.dev !== expected.dev || st.ino !== expected.ino)) return 'its directory identity changed';
    return undefined;
}

/** Capture the no-follow identity for later mutation/launch checks across async setup work. */
export function captureFixtureRoot(dir: string): FixtureRootIdentity {
    const { dev, ino } = lstatSync(dir);
    const identity = { dev, ino };
    withFixtureRoot(dir, identity, () => {});
    return identity;
}

/**
 * Recheck immediately before a synchronous mutation batch. This detects substitutions during preceding awaits;
 * it is not a directory-fd pin and cannot exclude an external rename between this check and a filesystem syscall.
 * ponytail: boundary checks require stable roots; descriptor-rooted writes and launch APIs would close that race.
 */
export function withFixtureRoot(dir: string, expected: FixtureRootIdentity, mutate: () => void): void {
    const problem = fixtureRootProblem(dir, expected);
    if (problem) throw new Error(`prepared fixture root was replaced after preparation (${problem}): ${dir}`);
    mutate();
}

/**
 * How a record states an attempt's end. A quota error or a budget pause is the provider's or the hub's doing and stays
 * itself; a flag beside any other end but an interruption (an unverified model, modified metadata, a tree changed after
 * the active time) makes it an infrastructure error, the original kept as end_reason_detail. A terminal peer failure
 * (#160) keeps its own class beside timeout: its preserved partial submission is graded under the same gates.
 */
export function endReasonOf(detail: string, flags: string[]): string {
    if (['infrastructure-error', 'provider-quota', 'budget-paused'].includes(detail)) return detail;
    if (flags.length && detail !== 'interrupted') return 'infrastructure-error';
    if (detail === 'completed' || detail === 'delivery-unsettled') return detail;
    if (detail === 'peer-failure') return 'peer-failure';
    return detail === 'wall-timeout' ? 'timeout' : 'interrupted';
}

/** The live process `pid` as an actor of `role`, with how it was found. */
export function actorOf(rows: ProcRow[], pid: number, role: Role, via: string): Actor | undefined {
    const row = rows.find((r) => r.pid === pid);
    return row && { role, pid, started: row.started, pgid: row.pgid, via };
}

/** The project root a hub daemon's argv names (`bun .../src/cli/main.ts --project <root> daemon`), if it is one. */
export function daemonRoot(command: string): string | undefined {
    return /^(?:\S*\/)?bun\s+\S*\/src\/cli\/main\.(?:ts|js)\s+--project\s+(.+?)\s+daemon(?:\s|$)/.exec(command)?.[1];
}

/** Processes whose argv names `dir` itself or a path inside it. */
export function namingFixture(rows: ProcRow[], dir: string): ProcRow[] {
    const re = new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/"'\\s]|$)`);
    return rows.filter((r) => re.test(r.command));
}

/**
 * Records in `owners` the processes an arm started (issue #113), each with what proves it: the daemon by the pid in its
 * state dir and an argv that serves this fixture (once one is recorded, another is a replacement, never adopted),
 * Claude's launch chain by this arm's own session id and the terminal shell that runs it in this fixture, the Codex
 * app-server as the recorded daemon's child, and what runs below or in the group of any of them. The runner and what
 * it runs itself are never recorded.
 */
export function captureActors(owners: Map<string, Actor>, rows: ProcRow[], arm: { dir: string; hubPid: number; claudeId: string; self: number; cwdOf: (pid: number) => string | undefined }): void {
    const mine = new Set([arm.self, ...descendantsOf(rows, arm.self).map((r) => r.pid)]);
    const add = (a: Actor | undefined) => { if (a && !mine.has(a.pid)) owners.set(key(a), a); };
    if (![...owners.values()].some((a) => a.role === 'daemon') && rows.some((r) => r.pid === arm.hubPid && daemonRoot(r.command) === arm.dir)) add(actorOf(rows, arm.hubPid, 'daemon', 'the pid in its state dir; its argv serves this fixture'));
    const launchedAs = new RegExp(`--session-id'?\\s+'?${arm.claudeId}(?=['\\s]|$)`); // the launcher's argv, or the terminal shell's quoted one
    for (const r of rows.filter((x) => launchedAs.test(x.command))) {
        add(actorOf(rows, r.pid, 'claude', `this arm's session id as its --session-id`));
        // The Orca terminal's shell that runs that launcher: its parent, working in this fixture, outlives the close briefly.
        const parent = rows.find((x) => x.pid === r.ppid);
        if (parent && parent.pid > 1 && !launchedAs.test(parent.command) && !owners.has(key(parent)) && inside(arm.cwdOf(parent.pid), arm.dir))
            add(actorOf(rows, parent.pid, 'claude', `the terminal shell running this arm's Claude launcher, in this fixture`));
    }
    for (const d of [...owners.values()].filter((a) => a.role === 'daemon' && same(rows, a)))
        for (const r of rows) if (r.ppid === d.pid && / app-server /.test(r.command)) add(actorOf(rows, r.pid, 'codex-app-server', `child of the arm's daemon ${d.pid}`));
    // What runs below them now, a tool command's background job included, before its parent can exit.
    extend(owners, rows);
    for (const [k, a] of owners) if (mine.has(a.pid)) owners.delete(k);
}

export async function teardown(actors: Actor[], dir: string, shutdown: () => Promise<string[]>, deps: Deps = realDeps, bounds = { settleMs: 10_000, fallbackMs: 4_000 }): Promise<Cleanup> {
    const t0 = deps.now();
    const reasons: string[] = [];
    // Every recorded actor counts, whatever the first read says; what is found below them is added as reads come.
    const owned = new Map<string, Actor>(actors.map((a) => [key(a), a]));
    const grow = (rows: ProcRow[]) => extend(owned, rows);
    const alive = (rows: ProcRow[]) => [...owned.values()].filter((a) => same(rows, a));
    const first = deps.table();
    if (first) grow(first);
    else reasons.push('the process table could not be read before the shutdown: what ran below the recorded actors is unknown');

    const n0 = deps.now();
    let errors: string[];
    try { errors = await shutdown(); } catch (e) { errors = [String(e)]; }
    const normal = { errors, ms: deps.now() - n0 };

    // Exiting takes a moment after `ahub kill` returns: wait for it before calling anything a leftover.
    const s0 = deps.now();
    let rows = deps.table();
    for (;;) {
        if (rows) grow(rows);
        if ((rows && !alive(rows).length) || deps.now() - s0 >= bounds.settleMs) break;
        await deps.sleep(250);
        rows = deps.table() ?? rows; // an unreadable read is tried again; a fallback never acts on it
    }
    const settle = deps.now() - s0;
    const fallback: Cleanup['fallback'] = [];
    const f0 = deps.now();
    // Signals go only to identities read again just before, by their group as the table shows it now: a group leader is
    // signalled with its group, and a member whose leader is signalled with it is skipped.
    const send = (rows: ProcRow[], signal: 'SIGTERM' | 'SIGSTOP' | 'SIGKILL' | 'SIGCONT', only?: Actor[]) => {
        const left = (only ?? alive(rows)).flatMap((a) => { const row = same(rows, a); return row ? [{ a, row }] : []; });
        const sent: Actor[] = [];
        for (const { a, row } of left) {
            const group = row.pgid === row.pid;
            if (!group && left.some((l) => l.row.pid === row.pgid && l.row.pgid === l.row.pid)) continue;
            try { deps.signal(group ? -row.pid : row.pid, signal); fallback.push({ pid: a.pid, role: a.role, signal, group, result: 'sent' }); sent.push(a); }
            catch { fallback.push({ pid: a.pid, role: a.role, signal, group, result: 'failed' }); }
        }
        return sent;
    };
    // Waits, recording what the processes start meanwhile while their parents still run.
    const settleFor = async (ms: number) => {
        for (const end = deps.now() + ms; deps.now() < end; ) {
            const r = deps.table();
            if (r) {
                grow(r);
                if (!alive(r).length) return;
            }
            await deps.sleep(250);
        }
    };
    if (rows && alive(rows).length) {
        const now = deps.table();
        if (now) {
            grow(now);
            send(now, 'SIGTERM');
            await settleFor(bounds.fallbackMs / 2);
        }
        // Freeze, enumerate, kill: a stopped process starts nothing, so the read after the freeze sees all of it. What
        // was stopped and is not killed is continued, never left frozen.
        const before = deps.table();
        if (before && (grow(before), alive(before).length)) {
            // What a read after the freeze shows for the first time (started between the read and the STOPs) is frozen
            // too, and read again, before anything is killed.
            const stopped = send(before, 'SIGSTOP');
            let after = deps.table(), seen = after ?? before;
            for (let round = 0; after && round < 4; round++) {
                grow(after);
                const fresh = alive(after).filter((a) => !stopped.some((s) => key(s) === key(a)));
                if (!fresh.length) break;
                stopped.push(...send(after, 'SIGSTOP', fresh));
                after = deps.table();
                if (after) seen = after;
            }
            if (after) grow(after);
            // Without a read after the last freeze, only what a STOP reached is killed, by the last read that showed
            // it: a stopped process keeps its pid.
            const killed = after ? send(after, 'SIGKILL') : send(seen, 'SIGKILL', stopped);
            const rest = stopped.filter((a) => !killed.some((k) => key(k) === key(a)));
            if (rest.length) send(deps.table() ?? seen, 'SIGCONT', rest); // a stopped process keeps its pid: never left frozen
            await settleFor(bounds.fallbackMs / 2);
        }
    }
    const last = deps.table();
    if (last) grow(last);
    else reasons.push('the process table could not be read after the shutdown: whether the arm stopped is unknown');
    const remaining = last ? alive(last) : [...owned.values()];
    if (last && remaining.length) reasons.push(`still running: ${remaining.map((a) => `${a.role} ${a.pid}`).join(', ')}`);
    const mine = new Set(last ? [deps.self, ...descendantsOf(last, deps.self).map((r) => r.pid)] : []);
    // A process with the fixture in its argv or as its working directory that is not proved the arm's: a job an agent
    // left in the background, or someone else's. Never signalled; the cleanup is not complete while it runs.
    const cwds = last ? deps.cwds() : undefined;
    if (last && !cwds) reasons.push('working directories could not be read: whether anything else runs in the fixture is unknown');
    const named = new Set(last ? namingFixture(last, dir).map((r) => r.pid) : []);
    const unresolved = (last ?? []).filter((r) => (named.has(r.pid) || inside(cwds?.get(r.pid), dir)) && !owned.has(key(r)) && !mine.has(r.pid))
        // Not the arm's: its arguments are someone else's, so only the program is kept.
        .map((r) => {
            const program = deps.comm?.(r.pid, r.started); // the executable's name, or nothing: never a guess from the argv
            return { pid: r.pid, started: r.started, ...(program ? { program } : {}), ...(inside(cwds?.get(r.pid), dir) ? { cwd: cwds!.get(r.pid)! } : {}) };
        });
    if (unresolved.length) reasons.push(`running with the fixture in its argv or as its working directory, not proved to be this arm's (left alone): ${unresolved.map((u) => u.pid).join(', ')}`);
    return {
        outcome: reasons.length ? 'incomplete_or_unknown' : fallback.length ? 'clean_with_fallback' : 'clean',
        reasons, normal, owned: [...owned.values()], fallback, remaining, unresolved,
        ms: { settle, fallback: deps.now() - f0, total: deps.now() - t0 },
    };
}

/**
 * The transcript's whole rows, or undefined when it cannot be read. Rows are Claude Code's own JSON, read only for the
 * fields used here: typed `any` on purpose.
 */
export function transcriptRows(path: string): any[] | undefined {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { return undefined; }
    return text.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

/**
 * Whether `sessionId`'s last turn has ended: Claude Code writes a `system` `turn_duration` row of the session after the
 * last row of a turn (in the 0.12.4 runs, after all 126 turns that ended with an answer), so a turn has ended once one
 * follows the session's last assistant or user row. A final answer alone does not end it: the row comes after.
 */
export function turnEnded(rows: any[], sessionId: string): boolean {
    let activity = -1, end = -1;
    rows.forEach((r, i) => {
        if (r?.sessionId !== sessionId) return;
        if (r.type === 'assistant' || r.type === 'user') activity = i;
        else if (r.type === 'system' && r.subtype === 'turn_duration') end = i;
    });
    return end > activity;
}

/** Waits, within `boundMs`, for Claude's turn to end in its transcript. */
export async function awaitTurnEnd(path: string, sessionId: string, boundMs: number, stopped: () => boolean, deps: Pick<Deps, 'sleep' | 'now'> = realDeps): Promise<{ outcome: 'ended' | 'timeout' | 'interrupted' | 'unreadable'; ms: number }> {
    const t0 = deps.now();
    for (;;) {
        const rows = transcriptRows(path);
        const ms = deps.now() - t0;
        if (!rows) return { outcome: 'unreadable', ms };
        if (turnEnded(rows, sessionId)) return { outcome: 'ended', ms };
        if (stopped()) return { outcome: 'interrupted', ms };
        if (ms >= boundMs) return { outcome: 'timeout', ms };
        await deps.sleep(250);
    }
}

/** Puts each path's mode back, parents first; returns the paths it could not restore. A link is never followed. */
export function restoreModes(modes: Iterable<[string, number]>): string[] {
    const failed: string[] = [], refused: string[] = [];
    for (const [path, mode] of [...modes].sort((a, b) => a[0].length - b[0].length)) {
        try {
            // Replaced by a link since it was locked: refused, and so is everything below it, which chmod would reach through it.
            if (refused.some((p) => path.startsWith(`${p}/`)) || lstatSync(path).isSymbolicLink()) { failed.push(path); refused.push(path); continue; }
            chmodSync(path, mode);
            if ((statSync(path).mode & 0o777) !== mode) failed.push(path);
        } catch {
            failed.push(path);
        }
    }
    return failed;
}

/**
 * `previous` is the user's own project entry in `~/.claude.json`, kept as it was: its shape is Claude Code's. `written` is
 * the entry the runner's write puts there: every restoration ledger since 0.12.3 records it, though the recovery passed it
 * on only from 0.12.6.
 */
export interface TrustLease { file: string; previous: any; written?: any; hadProjects: boolean; mode: number }

/**
 * Takes back the trust flag the benchmark set for `dir` in Claude's user state, unless someone changed it meanwhile:
 * then the current state is kept and that is reported. `pending`: a dead runner's write may not have landed (it stopped
 * between recording the lease and the rename, before Claude was started), so only an entry that is exactly what it would
 * have written is taken back; anything else means it was never written, and the entry is someone else's. The temp file is
 * named by `tempPid`, which a recovery sets to the runner's so that a later recovery finds and removes what it left.
 */
export function restoreTrust(lease: TrustLease, dir: string, pending = false, tempPid = process.pid): 'restored' | 'changed_concurrently' | 'not_written' | 'failed' {
    try {
        const fresh = JSON.parse(readFileSync(lease.file, 'utf8'));
        if (fresh.projects?.[dir]?.hasTrustDialogAccepted !== true) return pending ? 'not_written' : 'changed_concurrently';
        if (pending && lease.written !== undefined && !isDeepStrictEqual(fresh.projects[dir], lease.written)) return 'not_written';
        if (lease.previous === undefined) delete fresh.projects[dir];
        else {
            const current = { ...fresh.projects[dir] };
            if (Object.hasOwn(lease.previous, 'hasTrustDialogAccepted')) current.hasTrustDialogAccepted = lease.previous.hasTrustDialogAccepted;
            else delete current.hasTrustDialogAccepted;
            fresh.projects[dir] = current;
        }
        if (!lease.hadProjects && !Object.keys(fresh.projects).length) delete fresh.projects;
        const temp = restoreTemp(lease.file, tempPid);
        try {
            writeFileSync(temp, JSON.stringify(fresh, null, 2), { mode: lease.mode });
            chmodSync(temp, lease.mode);
            renameSync(temp, lease.file);
        } catch (error) { rmSync(temp, { force: true }); throw error; } // a copy of the user's state is not left behind by a failed write
        return 'restored';
    } catch {
        return 'failed';
    }
}

/**
 * What a restoration ledger still holds unrestored (#120): empty when everything it locked is back and its trust entry is
 * settled: restored, the user's (`changed_concurrently`), or never written with its temp file gone (`not_written`, restored);
 * a `not_written` whose temp file is left still holds a copy of ~/.claude.json. A run directory whose ledger is missing holds
 * nothing: the runner persists the ledger before it locks anything. `ledger` is the parsed restoration-ledger.json (`any`:
 * its shape is native.ts's persistLedger, read back from disk).
 */
export function unrestored(ledger: any): string[] {
    const left: string[] = [];
    if (ledger?.protected && !ledger.protected.restored && Object.keys(ledger.protected.paths ?? {}).length) left.push('protected inputs');
    const siblings = Object.values<any>(ledger?.siblings ?? {}).filter((s) => !s?.restored).length;
    if (siblings) left.push(`sibling read locks of ${siblings} arm(s)`);
    const trust = ledger?.trust;
    if (trust && !trust.restored && trust.stage !== 'changed_concurrently') left.push(trust.stage === 'not_written' ? "the trust write's temp file (a copy of ~/.claude.json)" : 'the Claude trust entry');
    return left;
}

/**
 * The part of a ledger still owed (#120). A ledger without a runner identity was written before 0.12.5, and those versions
 * left a concurrently changed trust entry at `written`, unrecorded. Under their `restored: true`, or under a later runner's
 * marker (that runner passed the reuse check, so the old run was restored, and it died before it wrote a ledger of its
 * own), that trust entry is left as it was then: taking it back could remove the user's. Its locks are owed as any other.
 * `status` is the parsed restoration.json.
 */
export function owed(ledger: any, status: any): any {
    const accepted = status?.restored === true || !!status?.runner?.pid;
    return accepted && ledger && !ledger.runner ? { ...ledger, trust: undefined } : ledger;
}

/**
 * Why a run directory may not be used again (#120), or undefined when it may: an earlier run there that is not restored
 * (its `restoration.json` missing a `restored: true`, or its ledger holding something unrestored) would have its locked
 * modes recorded as the originals. `status` and `ledger` are the files' text, undefined when a file is absent.
 */
export function reuseProblem(status: string | undefined, ledger: string | undefined): string | undefined {
    const parse = (text: string) => { try { return JSON.parse(text); } catch { return undefined; } };
    if (status !== undefined && parse(status)?.restored !== true) return 'an earlier run here is not restored (restoration.json)';
    if (ledger === undefined) return undefined;
    const parsed = parse(ledger);
    if (parsed === undefined) return 'the restoration ledger cannot be read';
    const left = unrestored(owed(parsed, status === undefined ? undefined : parse(status)));
    return left.length ? `an earlier run here left unrestored: ${left.join(', ')}` : undefined;
}

/**
 * How the runner settles an arm's trust lease at the arm's end (#115; the rule is in docs/agent-notes/benchmarks.md): the outcome its record
 * says, and the restoration ledger's stage and `restored`. `pending` in the runner's own process: the write or its rename
 * threw, before Claude was started, so nothing landed and no entry is touched, now or by the recovery; its temp file is
 * removed here (`removeTemp` says whether it was), or by the recovery when it cannot be. Not contained: Claude may still
 * run and rewrite its entry, so the recovery takes it back once nothing does.
 */
export function settleTrust(stage: string, contained: boolean, removeTemp: () => boolean, restore: () => string): { outcome: string; stage: string; restored: boolean } {
    if (stage === 'pending') {
        const removed = removeTemp();
        return { outcome: removed ? 'not_written' : 'kept: the trust write\'s temp file could not be removed', stage: 'not_written', restored: removed };
    }
    if (!contained) return { outcome: 'kept: the cleanup is incomplete or unknown', stage, restored: false };
    const outcome = restore();
    return { outcome, stage: outcome, restored: outcome === 'restored' };
}

/**
 * A regular file's bytes, opened without following a link and without blocking (a fifo swapped in after a check must not
 * stop the runner), or a string saying why there are none.
 */
export function regularBytes(path: string, max: number): Buffer | string {
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
/**
 * Claude's quota window from the status-line tee's file (#134). Each reading carries the file's own `at`; a window
 * whose `resets_at` has already passed says nothing and is marked `stale`, not trusted. Missing or unreadable file
 * records explicit unknown and never fails the run.
 *
 * The native runner disables status lines for all arms (#110), so the file is not guaranteed to be written during
 * an attempt. A missing file therefore records `unknown`, and the docs say this does not guarantee live quota.
 */
export type ClaudeUsageReading =
    | { at: number; rate_limits: { five_hour?: any; seven_day?: any }; stale?: boolean }
    | { status: 'unknown'; why: string; at?: number; stale?: boolean };

export function claudeUsageReading(stateDir: string): ClaudeUsageReading {
    const file = join(stateDir, 'claude-usage.json');
    const bytes = regularBytes(file, 256 * 1024);
    if (typeof bytes === 'string') return { status: 'unknown', why: bytes };
    let data: any;
    try {
        data = JSON.parse(bytes.toString('utf8'));
    } catch {
        return { status: 'unknown', why: 'unreadable: invalid JSON' };
    }
    if (typeof data !== 'object' || data === null)
        return { status: 'unknown', why: 'malformed: not an object' };
    if (typeof data.at !== 'number' || !Number.isFinite(data.at))
        return { status: 'unknown', why: 'malformed: at is not a finite number' };
    const limits = data.rate_limits;
    if (!limits || typeof limits !== 'object')
        return { status: 'unknown', why: 'no rate_limits', at: data.at };
    // Same seconds/millis disambiguation as claudeWindows in budget.ts.
    const now = Date.now();
    const mark = (w: any): any | undefined => {
        if (!w || typeof w !== 'object') return undefined;
        if (typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return undefined;
        const resets = typeof w.resets_at === 'number' ? w.resets_at : undefined;
        const resetsMs = resets !== undefined && Number.isFinite(resets) && resets > 0 ? (resets < 1e12 ? resets * 1000 : resets) : undefined;
        // No valid reset: cannot prove the window is live, mark stale (never trusted fresh).
        const stale = resetsMs === undefined || resetsMs < now;
        return { ...w, ...(stale ? { stale: true } : {}) };
    };
    const five = mark(limits.five_hour);
    const week = mark(limits.seven_day);
    if (!five && !week)
        return { status: 'unknown', why: 'no usable windows', at: data.at };
    // All present windows expired: the reading says nothing. Preserve at and mark stale.
    const windows = [five, week].filter(Boolean);
    if (windows.every((w: any) => w.stale))
        return { status: 'unknown', why: 'all windows expired', at: data.at, stale: true };
    const stale = [five, week].some((w: any) => w?.stale === true);
    return {
        at: data.at,
        rate_limits: { ...(five ? { five_hour: five } : {}), ...(week ? { seven_day: week } : {}) },
        ...(stale ? { stale: true } : {}),
    };
}

/** A bounded, fail-open wait for a status-line write after a settled quota boundary. */
export async function claudeUsageSnapshot(stateDir: string, notBefore: number | undefined, boundMs = 1500, stopped: () => boolean = () => false): Promise<ClaudeUsageReading> {
    if (notBefore === undefined) return { status: 'unknown', why: 'quota boundary is not settled' };
    const deadline = performance.now() + boundMs;
    while (true) {
        const reading = claudeUsageReading(stateDir);
        if (stopped()) return { status: 'unknown', why: 'quota observation interrupted' };
        if (reading.at !== undefined && reading.at >= notBefore) return reading;
        const remaining = deadline - performance.now();
        if (remaining <= 0) return { status: 'unknown', why: 'no fresh quota write after the settled boundary', ...(reading.at !== undefined ? { at: reading.at } : {}) };
        await Bun.sleep(Math.min(25, remaining));
    }
}

/**
 * Benchmark Claude settings (#134, PR136 P1): every Claude arm runs an isolated status-line tee so the hub's
 * `claude-usage.json` can be written during the attempt. `--restricted` ignores user/project/local settings;
 * explicit `--settings` supplies our session hooks (turn-free only) and status line. Managed policy still applies.
 */
export function benchmarkClaudeSettings(session: { statusLine: unknown; hooks?: unknown }, turnFree: boolean, permissions: unknown, sandbox: unknown) {
    return {
        permissions,
        sandbox,
        disableAllHooks: false,
        statusLine: session.statusLine,
        hooks: turnFree ? (session.hooks ?? {}) : {},
    };
}
