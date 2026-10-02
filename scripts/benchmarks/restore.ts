import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { descendantsOf, processTable, type ProcRow } from '../../src/hub/child-process.ts';
import { namingFixture, restoreModes, same } from './teardown.ts';

/**
 * Recovery after an arm whose cleanup was incomplete or unknown (issue #113): the runner left the protected inputs and
 * the sibling artifacts unreadable. Once nothing that arm started is running, and nothing names its fixture, this puts
 * their read modes back from the run's ledger. Usage: bun scripts/benchmarks/restore.ts --run RUN_DIR
 */
export function recover(run: string, table: ProcRow[] | undefined, self = process.pid): { restored: boolean; blockers: string[]; failed: string[] } {
    if (!table) return { restored: false, blockers: ['the process table cannot be read'], failed: [] };
    const mine = new Set([self, ...descendantsOf(table, self).map((r) => r.pid)]);
    const blockers: string[] = [];
    let records: string[] = [];
    try { records = readdirSync(join(run, 'recovery', 'runs')).filter((f) => f.endsWith('.json')); } catch { }
    for (const file of records) {
        const record = JSON.parse(readFileSync(join(run, 'recovery', 'runs', file), 'utf8'));
        for (const p of [...(record.cleanup?.owned ?? []), ...(record.cleanup?.unresolved ?? [])])
            if (same(table, p)) blockers.push(`${file}: ${p.role ?? 'unresolved'} ${p.pid} is still running`);
        if (typeof record.cwd === 'string')
            for (const r of namingFixture(table, record.cwd)) if (!mine.has(r.pid)) blockers.push(`${file}: ${r.pid} names the fixture`);
    }
    if (blockers.length) return { restored: false, blockers: [...new Set(blockers)], failed: [] };
    const ledgerFile = join(run, 'restoration-ledger.json');
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
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
    writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    if (!failed.length) writeFileSync(join(run, 'restoration.json'), JSON.stringify({ restored: true, recovered: true, at: new Date().toISOString() }), { mode: 0o600 });
    return { restored: !failed.length, blockers: [], failed };
}

if (import.meta.main) {
    const argv = process.argv.slice(2), run = argv[argv.indexOf('--run') + 1];
    if (!run || argv.indexOf('--run') < 0) throw new Error('usage: bun scripts/benchmarks/restore.ts --run RUN_DIR');
    const result = recover(run, processTable());
    console.log(JSON.stringify(result, null, 2));
    if (!result.restored) process.exit(1);
}
