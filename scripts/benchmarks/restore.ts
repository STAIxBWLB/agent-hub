import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { descendantsOf, processTable, type ProcRow } from '../../src/hub/child-process.ts';
import { namingFixture, processCwds, restoreModes, restoreTrust, same } from './teardown.ts';

/**
 * Recovery after a run that left inputs unreadable (issue #113): an arm's cleanup was incomplete or unknown, or the
 * runner itself did not finish. Nothing is restored while the runner runs, while any process an arm was recorded to
 * have started runs, or while anything has a fixture in its argv or as its working directory. Then the read modes come
 * back from the run's ledger, and the records kept in `recovery/` move to `runs/`, where grading and the ledger read
 * them; the Claude trust entry the runner set is taken back unless the user changed it meanwhile. Usage:
 * bun scripts/benchmarks/restore.ts --run RUN_DIR [--runner-exited] (for a ledger written before runner identities:
 * the operator states the runner is gone).
 */
export function recover(run: string, table: ProcRow[] | undefined, cwds: Map<number, string> | undefined, self = process.pid, runnerExited = false): { restored: boolean; blockers: string[]; failed: string[] } {
    const status = existsSync(join(run, 'restoration.json')) ? JSON.parse(readFileSync(join(run, 'restoration.json'), 'utf8')) : undefined;
    if (status?.restored === true) return { restored: true, blockers: [], failed: [] };
    if (!table) return { restored: false, blockers: ['the process table cannot be read'], failed: [] };
    if (!cwds) return { restored: false, blockers: ['working directories cannot be read'], failed: [] };
    const ledgerFile = join(run, 'restoration-ledger.json');
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    const blockers: string[] = [];
    if (!ledger.runner && !runnerExited) blockers.push('the ledger does not name the runner: it may still be running (pass --runner-exited once it is gone)');
    else if (ledger.runner && same(table, ledger.runner)) blockers.push(`the runner ${ledger.runner.pid} is still running`);
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
            if (!mine.has(r.pid) && cwd !== undefined && (cwd === dir || cwd.startsWith(`${dir}/`))) blockers.push(`${r.pid} works in ${dir}`);
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
    if (!ledger.protected?.restored) {
        const lost = restoreModes(Object.entries<number>(ledger.protected?.paths ?? {}));
        ledger.protected.restored = !lost.length;
        failed.push(...lost);
    }
    const trust = ledger.trust;
    if (trust && !trust.restored) {
        const outcome = restoreTrust({ file: trust.file, previous: trust.previous, hadProjects: trust.hadProjects, mode: trust.mode }, trust.project);
        if (outcome === 'failed') failed.push(trust.file);
        else Object.assign(trust, { restored: true, stage: outcome });
    }
    writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    if (failed.length) return { restored: false, blockers: [], failed };
    // The kept records join the run's own, so grading and the ledger see these attempts (as unavailable).
    mkdirSync(join(run, 'runs'), { recursive: true, mode: 0o700 });
    mkdirSync(join(run, 'patches'), { recursive: true, mode: 0o700 });
    for (const { file, record } of recorded) {
        const patch = join(run, 'patches', file.replace(/\.json$/, '.patch'));
        if (typeof record.patchFile === 'string' && existsSync(record.patchFile)) renameSync(record.patchFile, patch);
        writeFileSync(join(run, 'runs', file), JSON.stringify({ ...record, patchFile: patch, recovered: true }, null, 2), { mode: 0o600 });
        rmSync(join(run, 'recovery', 'runs', file));
    }
    writeFileSync(join(run, 'restoration.json'), JSON.stringify({ restored: true, recovered: true, at: new Date().toISOString() }), { mode: 0o600 });
    return { restored: true, blockers: [], failed: [] };
}

if (import.meta.main) {
    const argv = process.argv.slice(2), at = argv.indexOf('--run'), run = at >= 0 ? argv[at + 1] : undefined;
    if (!run) throw new Error('usage: bun scripts/benchmarks/restore.ts --run RUN_DIR [--runner-exited]');
    const result = recover(run, processTable(), processCwds(), process.pid, argv.includes('--runner-exited'));
    console.log(JSON.stringify(result, null, 2));
    if (!result.restored) process.exit(1);
}
