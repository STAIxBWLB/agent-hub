import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
    /** Alive when teardown began, with what was found below them: what has to be gone. */
    owned: Actor[];
    fallback: { pid: number; role: Role; signal: 'SIGTERM' | 'SIGKILL'; group: boolean; result: 'sent' | 'failed' }[];
    remaining: Actor[];
    /** Running and naming the fixture, not proved to be the arm's: left alone, and the cleanup is not complete. */
    unresolved: { pid: number; started: string; command: string }[];
    ms: { settle: number; fallback: number; total: number };
}
export interface Deps {
    table: () => ProcRow[] | undefined;
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    /** The runner itself: it and its children (a `bun ... kill` naming the fixture) are not the arm's. */
    self: number;
}
export const realDeps: Deps = { table: processTable, signal: (pid, signal) => process.kill(pid, signal), sleep: (ms) => Bun.sleep(ms), now: () => Date.now(), self: process.pid };

export const same = (rows: ProcRow[], a: { pid: number; started: string }) => rows.find((r) => r.pid === a.pid && r.started === a.started);

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
    const key = (a: { pid: number; started: string }) => `${a.pid}@${a.started}`;
    const owned = new Map<string, Actor>();
    // What runs below an owned process, and in the group of an owned leader still alive, is the arm's too.
    const grow = (rows: ProcRow[]) => {
        for (const a of [...owned.values()]) {
            if (!same(rows, a)) continue;
            for (const r of descendantsOf(rows, a.pid)) if (!owned.has(key(r))) owned.set(key(r), { role: 'below', pid: r.pid, started: r.started, pgid: r.pgid, via: `below ${a.role} ${a.pid}` });
            if (a.pgid !== a.pid) continue;
            for (const r of rows) if (r.pgid === a.pid && !owned.has(key(r))) owned.set(key(r), { role: 'below', pid: r.pid, started: r.started, pgid: r.pgid, via: `group of ${a.role} ${a.pid}` });
        }
    };
    const alive = (rows: ProcRow[]) => [...owned.values()].filter((a) => same(rows, a));
    const first = deps.table();
    if (first) {
        for (const a of actors) if (same(first, a)) owned.set(key(a), a);
        grow(first);
    } else reasons.push('the process table could not be read before the shutdown: what the arm left is unknown');

    const n0 = deps.now();
    let errors: string[];
    try { errors = await shutdown(); } catch (e) { errors = [String(e)]; }
    const normal = { errors, ms: deps.now() - n0 };

    // Exiting takes a moment after `ahub kill` returns: wait for it before calling anything a leftover.
    const s0 = deps.now();
    let rows = deps.table();
    while (rows) {
        grow(rows);
        if (!alive(rows).length || deps.now() - s0 >= bounds.settleMs) break;
        await deps.sleep(250);
        rows = deps.table();
    }
    const settle = deps.now() - s0;
    const fallback: Cleanup['fallback'] = [];
    const f0 = deps.now();
    if (rows && alive(rows).length) {
        for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
            const now = deps.table(); // identity read again right before any signal
            if (!now) break;
            grow(now);
            const left = alive(now);
            if (!left.length) break;
            for (const a of left) {
                const group = a.pgid === a.pid;
                if (!group && left.some((l) => l.pid === a.pgid && l.pgid === l.pid)) continue; // its leader's signal reaches it
                try { deps.signal(group ? -a.pid : a.pid, signal); fallback.push({ pid: a.pid, role: a.role, signal, group, result: 'sent' }); }
                catch { fallback.push({ pid: a.pid, role: a.role, signal, group, result: 'failed' }); }
            }
            const end = deps.now() + bounds.fallbackMs / 2;
            for (let r = deps.table(); deps.now() < end && !(r && !alive(r).length); r = deps.table()) await deps.sleep(250);
        }
    }
    const last = deps.table();
    if (last) grow(last);
    else reasons.push('the process table could not be read after the shutdown: whether the arm stopped is unknown');
    const remaining = last ? alive(last) : [...owned.values()];
    if (last && remaining.length) reasons.push(`still running: ${remaining.map((a) => `${a.role} ${a.pid}`).join(', ')}`);
    const mine = new Set(last ? [deps.self, ...descendantsOf(last, deps.self).map((r) => r.pid)] : []);
    const unresolved = last ? namingFixture(last, dir).filter((r) => !owned.has(key(r)) && !mine.has(r.pid)).map((r) => ({ pid: r.pid, started: r.started, command: r.command.slice(0, 200) })) : [];
    if (unresolved.length) reasons.push(`running and naming the fixture, but not proved to be this arm's (left alone): ${unresolved.map((u) => u.pid).join(', ')}`);
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
 * last row of every turn (126 of 126 turns in the 0.12.4 runs), so a turn has ended once one follows the session's last
 * assistant or user row. A final answer alone does not end it: the row comes after.
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

/** Puts each path's mode back, parents first; returns the paths it could not restore. */
export function restoreModes(modes: Iterable<[string, number]>): string[] {
    const failed: string[] = [];
    for (const [path, mode] of [...modes].sort((a, b) => a[0].length - b[0].length)) {
        try {
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
