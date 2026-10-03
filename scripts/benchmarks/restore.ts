import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { descendantsOf, processTable, type ProcRow } from '../../src/hub/child-process.ts';
import { inside, namingFixture, processCwds, restoreModes, restoreTrust, same, restoreTemp, trustTemp, unrestored, writeAtomic } from './teardown.ts';

/**
 * Recovery after a run that left inputs unreadable (issue #113): an arm's cleanup was incomplete or unknown, or the
 * runner itself did not finish. Nothing is restored while the runner runs, while any process an arm was recorded to
 * have started runs, or while anything has a fixture in its argv or as its working directory. Then the read modes come
 * back from the run's ledger, and the records kept in `recovery/` move to `runs/`, where grading and the ledger read
 * them; the Claude trust entry the runner set is taken back unless the user changed it meanwhile. `restored: true` is
 * trusted only when the ledger agrees (#120), and a runner named by either file holds the recovery while it runs. Usage:
 * bun scripts/benchmarks/restore.ts --run RUN_DIR [--runner-exited] (for a ledger written before runner identities:
 * the operator states the runner is gone).
 */
export function recover(run: string, table: ProcRow[] | undefined, cwds: Map<number, string> | undefined, self = process.pid, runnerExited = false): { restored: boolean; blockers: string[]; failed: string[] } {
    let status: any; // a file cut by a runner that died mid-write says nothing: recover
    try { status = JSON.parse(readFileSync(join(run, 'restoration.json'), 'utf8')); } catch { status = undefined; }
    // No ledger: the runner persists it before it locks anything, so there is nothing to restore (#120).
    const ledgerFile = join(run, 'restoration-ledger.json'), hasLedger = existsSync(ledgerFile);
    let ledger: any = {};
    if (hasLedger) {
        try { ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')); }
        catch { return { restored: false, blockers: ['the restoration ledger cannot be read'], failed: [] }; }
    }
    // Neither file: no runner got as far as its marker here, so it locked nothing and there is nothing to recover (#120).
    if (!hasLedger && !existsSync(join(run, 'restoration.json'))) return { restored: true, blockers: [], failed: [] };
    // A re-run that died after an earlier run's `restored: true` leaves locks that file does not know about (#120).
    if (status?.restored === true && !unrestored(ledger).length) return { restored: true, blockers: [], failed: [] };
    if (!table) return { restored: false, blockers: ['the process table cannot be read'], failed: [] };
    if (!cwds) return { restored: false, blockers: ['working directories cannot be read'], failed: [] };
    const blockers: string[] = [];
    // The ledger's runner, and the one restoration.json names while a runner works or after it died (#120).
    const runners = [ledger.runner, status?.runner].filter((r) => r?.pid);
    if (!runners.length && !runnerExited) blockers.push('the ledger does not name the runner: it may still be running (pass --runner-exited once it is gone)');
    for (const r of runners) if (same(table, r)) blockers.push(`the runner ${r.pid} is still running`);
    const mine = new Set([self, ...descendantsOf(table, self).map((r) => r.pid)]);
    const records = existsSync(join(run, 'recovery', 'runs')) ? readdirSync(join(run, 'recovery', 'runs')).filter((f) => f.endsWith('.json')) : [];
    const recorded = records.map((f) => ({ file: f, record: JSON.parse(readFileSync(join(run, 'recovery', 'runs', f), 'utf8')) }));
    const actors: { pid: number; started: string; role?: string; where: string }[] = [
        ...Object.entries<any[]>(ledger.actors ?? {}).flatMap(([dir, list]) => list.map((a) => ({ ...a, where: dir }))),
        ...recorded.flatMap(({ file, record }) => [...(record.cleanup?.owned ?? []), ...(record.cleanup?.unresolved ?? [])].map((a: any) => ({ ...a, where: file }))),
    ];
    for (const a of actors) if (same(table, a)) blockers.push(`${a.where}: ${a.role ?? 'unresolved'} ${a.pid} is still running`);
    const fixtures = new Set<string>([...Object.keys(ledger.actors ?? {}), ...Object.keys(ledger.siblings ?? {}), ...recorded.map(({ record }) => record.cwd).filter((d): d is string => typeof d === 'string')]);
    for (const dir of fixtures) {
        for (const r of namingFixture(table, dir)) if (!mine.has(r.pid)) blockers.push(`${r.pid} names ${dir}`);
        for (const r of table) {
            const cwd = cwds.get(r.pid);
            if (!mine.has(r.pid) && inside(cwd, dir)) blockers.push(`${r.pid} works in ${dir}`);
        }
    }
    if (blockers.length) return { restored: false, blockers: [...new Set(blockers)], failed: [] };
    const failed: string[] = [];
    for (const sibling of Object.values<any>(ledger.siblings ?? {})) {
        if (sibling.restored) continue;
        const lost = restoreModes(Object.entries<number>(sibling.modes ?? {}));
        sibling.restored = !lost.length;
        failed.push(...lost);
    }
    if (ledger.protected && !ledger.protected.restored) {
        const lost = restoreModes(Object.entries<number>(ledger.protected?.paths ?? {}));
        ledger.protected.restored = !lost.length;
        failed.push(...lost);
    }
    const trust = ledger.trust;
    // `changed_concurrently`: the user changed the entry meanwhile, and it is theirs; the runner settled it.
    if (trust && !trust.restored && trust.stage !== 'changed_concurrently') {
        // A runner that died between the lease and the rename or in its own restore, or that could not remove its temp file,
        // may have left one: a copy of ~/.claude.json. One that cannot be removed keeps the trust entry unrestored, so the
        // next recovery tries again. `not_written`: the runner knew its write never landed, so no entry is touched.
        const pid = ledger.runner?.pid;
        // A dead runner's `pending` with its temp file still there: the rename never happened, so nothing landed.
        const unrenamed = !!pid && trust.stage === 'pending' && existsSync(trustTemp(trust.file, pid));
        const temps = pid ? [restoreTemp(trust.file, pid)] : [];
        if (pid && (trust.stage === 'pending' || trust.stage === 'not_written')) temps.push(trustTemp(trust.file, pid));
        const stuck = temps.filter((temp) => { try { rmSync(temp, { force: true }); return false; } catch { return true; } });
        const lease = { file: trust.file, previous: trust.previous, written: trust.written, hadProjects: trust.hadProjects, mode: trust.mode };
        const settle = () => trust.stage === 'not_written' || unrenamed ? 'not_written' : restoreTrust(lease, trust.project, trust.stage === 'pending', pid ?? process.pid);
        const outcome = stuck.length ? 'failed' : settle();
        if (stuck.length) failed.push(...stuck);
        else if (outcome === 'failed') failed.push(trust.file);
        else Object.assign(trust, { restored: true, stage: outcome });
    }
    if (hasLedger) writeAtomic(ledgerFile, JSON.stringify(ledger, null, 2)); // a crash mid-write must not leave a ledger the next recovery cannot read
    if (failed.length) return { restored: false, blockers: [], failed };
    // The kept records join the run's own, so grading and the ledger see these attempts (as unavailable).
    mkdirSync(join(run, 'runs'), { recursive: true, mode: 0o700 });
    mkdirSync(join(run, 'patches'), { recursive: true, mode: 0o700 });
    for (const { file, record } of recorded) {
        const patch = join(run, 'patches', file.replace(/\.json$/, '.patch'));
        if (typeof record.patchFile === 'string' && existsSync(record.patchFile)) renameSync(record.patchFile, patch);
        writeAtomic(join(run, 'runs', file), JSON.stringify({ ...record, patchFile: patch, recovered: true }, null, 2));
        rmSync(join(run, 'recovery', 'runs', file));
    }
    writeAtomic(join(run, 'restoration.json'), JSON.stringify({ restored: true, recovered: true, at: new Date().toISOString() }));
    return { restored: true, blockers: [], failed: [] };
}

if (import.meta.main) {
    const argv = process.argv.slice(2), at = argv.indexOf('--run'), run = at >= 0 ? argv[at + 1] : undefined;
    if (!run) throw new Error('usage: bun scripts/benchmarks/restore.ts --run RUN_DIR [--runner-exited]');
    const result = recover(run, processTable(), processCwds(), process.pid, argv.includes('--runner-exited'));
    console.log(JSON.stringify(result, null, 2));
    if (!result.restored) process.exit(1);
}
