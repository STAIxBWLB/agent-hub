import { chmodSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { descendantsOf, processTable, type ProcRow } from '../../src/hub/child-process.ts';

/**
 * Teardown of one benchmark arm (issue #113). An actor is a process the arm started, recorded with the evidence that
 * proves it is the arm's; its identity is the pid with its start time, never a name in its argv (Codex's need not name
 * the fixture, and a reused pid or a replacement hub may). Teardown asks for the normal shutdown, reads the process
 * table back, falls back to signals only for processes whose identity still matches, and says which of `clean`,
 * `clean_with_fallback` or `incomplete_or_unknown` it got. A process it cannot prove is the arm's is never signalled.
 */

export type Role = 'daemon' | 'codex-app-server' | 'claude' | 'below';
export interface Actor { role: Role; pid: number; started: string; pgid: number; via: string }
export interface Cleanup {
    outcome: 'clean' | 'clean_with_fallback' | 'incomplete_or_unknown';
    /** Why it is not clean; empty otherwise. */
    reasons: string[];
    /** The normal shutdown's own failures (a lost acknowledgement, a failed close), kept whatever the outcome. */
    normal: { errors: string[]; ms: number };
    /** Every recorded actor (some may have exited before teardown) and what was found below them: what has to be gone. */
    owned: Actor[];
    fallback: { pid: number; role: Role; signal: 'SIGTERM' | 'SIGSTOP' | 'SIGKILL'; group: boolean; result: 'sent' | 'failed' }[];
    remaining: Actor[];
    /** Running with the fixture in its argv or as its working directory, not proved to be the arm's: left alone, and the cleanup is not complete. */
    unresolved: { pid: number; started: string; command: string; cwd?: string }[];
    ms: { settle: number; fallback: number; total: number };
}
export interface Deps {
    table: () => ProcRow[] | undefined;
    /** Each process's working directory, or undefined when they cannot be read. */
    cwds: () => Map<number, string> | undefined;
    signal: (pid: number, signal: 'SIGTERM' | 'SIGSTOP' | 'SIGKILL') => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    /** The runner itself: it and its children (a `bun ... kill` naming the fixture) are not the arm's. */
    self: number;
}
export const realDeps: Deps = { table: processTable, cwds: processCwds, signal: (pid, signal) => process.kill(pid, signal), sleep: (ms) => Bun.sleep(ms), now: () => Date.now(), self: process.pid };

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
        const alive = !!same(rows, a);
        if (alive) for (const r of descendantsOf(rows, a.pid)) if (!owned.has(key(r))) owned.set(key(r), { role: 'below', pid: r.pid, started: r.started, pgid: r.pgid, via: `below ${a.role} ${a.pid}` });
        if (a.pgid !== a.pid) continue;
        const known = alive || rows.some((r) => r.pgid === a.pid && r.pid !== a.pid && owned.has(key(r)));
        if (known) for (const r of rows) if (r.pgid === a.pid && !owned.has(key(r))) owned.set(key(r), { role: 'below', pid: r.pid, started: r.started, pgid: r.pgid, via: `group of ${a.role} ${a.pid}` });
    }
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
    // Signals go only to identities read again just before; a group leader is signalled with its group, and a member
    // whose leader is signalled with it is skipped.
    const send = (left: Actor[], signal: 'SIGTERM' | 'SIGSTOP' | 'SIGKILL') => {
        for (const a of left) {
            const group = a.pgid === a.pid;
            if (!group && left.some((l) => l.pid === a.pgid && l.pgid === l.pid)) continue;
            try { deps.signal(group ? -a.pid : a.pid, signal); fallback.push({ pid: a.pid, role: a.role, signal, group, result: 'sent' }); }
            catch { fallback.push({ pid: a.pid, role: a.role, signal, group, result: 'failed' }); }
        }
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
            send(alive(now), 'SIGTERM');
            await settleFor(bounds.fallbackMs / 2);
        }
        // Freeze, enumerate, kill: a stopped process starts nothing, so the read after the freeze sees all of it.
        const before = deps.table();
        if (before && (grow(before), alive(before).length)) {
            send(alive(before), 'SIGSTOP');
            const frozen = deps.table() ?? before;
            grow(frozen);
            send(alive(frozen), 'SIGKILL');
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
        .map((r) => ({ pid: r.pid, started: r.started, command: r.command.slice(0, 200), ...(inside(cwds?.get(r.pid), dir) ? { cwd: cwds!.get(r.pid)! } : {}) }));
    if (unresolved.length) reasons.push(`running with the fixture in its argv or as its working directory, not proved to be this arm's (left alone): ${unresolved.map((u) => u.pid).join(', ')}`);
    return {
        outcome: reasons.length ? 'incomplete_or_unknown' : fallback.length ? 'clean_with_fallback' : 'clean',
        reasons, normal, owned: [...owned.values()], fallback, remaining, unresolved,
        ms: { settle, fallback: deps.now() - f0, total: deps.now() - t0 },
    };
}

/** The transcript's whole rows, or undefined when it cannot be read. */
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
    const failed: string[] = [];
    for (const [path, mode] of [...modes].sort((a, b) => a[0].length - b[0].length)) {
        try {
            if (lstatSync(path).isSymbolicLink()) { failed.push(path); continue; } // replaced since it was locked: refuse
            chmodSync(path, mode);
            if ((statSync(path).mode & 0o777) !== mode) failed.push(path);
        } catch {
            failed.push(path);
        }
    }
    return failed;
}

export interface TrustLease { file: string; previous: any; hadProjects: boolean; mode: number }

/**
 * Takes back the trust flag the benchmark set for `dir` in Claude's user state, unless someone changed it meanwhile:
 * then the current state is kept and that is reported.
 */
export function restoreTrust(lease: TrustLease, dir: string): 'restored' | 'changed_concurrently' | 'failed' {
    try {
        const fresh = JSON.parse(readFileSync(lease.file, 'utf8'));
        if (fresh.projects?.[dir]?.hasTrustDialogAccepted !== true) return 'changed_concurrently';
        if (lease.previous === undefined) delete fresh.projects[dir];
        else {
            const current = { ...fresh.projects[dir] };
            if (Object.hasOwn(lease.previous, 'hasTrustDialogAccepted')) current.hasTrustDialogAccepted = lease.previous.hasTrustDialogAccepted;
            else delete current.hasTrustDialogAccepted;
            fresh.projects[dir] = current;
        }
        if (!lease.hadProjects && !Object.keys(fresh.projects).length) delete fresh.projects;
        const temp = `${lease.file}.ahub-benchmark-restore-${process.pid}`;
        writeFileSync(temp, JSON.stringify(fresh, null, 2), { mode: lease.mode });
        chmodSync(temp, lease.mode);
        renameSync(temp, lease.file);
        return 'restored';
    } catch {
        return 'failed';
    }
}
