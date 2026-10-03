import { resolve } from "node:path";

export type OrcaRead = (args: string[]) => Promise<unknown>;

export interface OrcaWorkspaceIdentity {
    repoId: string;
    worktreeId: string;
}

function findRecords(
    value: unknown,
    predicate: (record: Record<string, unknown>) => boolean,
    identity: (record: Record<string, unknown>) => string,
    matches: Map<string, Record<string, unknown>>,
): void {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (predicate(record)) matches.set(identity(record), record);
    for (const child of Object.values(record)) {
        findRecords(child, predicate, identity, matches);
    }
}

function findUniqueRecord(
    value: unknown,
    predicate: (record: Record<string, unknown>) => boolean,
    identity: (record: Record<string, unknown>) => string,
    label: string,
): Record<string, unknown> | undefined {
    const matches = new Map<string, Record<string, unknown>>();
    findRecords(value, predicate, identity, matches);
    if (matches.size > 1) throw new Error(`Orca returned multiple exact ${label} identities`);
    return matches.values().next().value;
}

/** Look up an exact user-registered Orca repository and worktree. This boundary is read-only. */
export async function lookupOrcaWorktree(dir: string, readOrca: OrcaRead): Promise<OrcaWorkspaceIdentity> {
    const canonicalDir = resolve(dir);
    const repositories = await readOrca(["repo", "list"]);
    const repository = findUniqueRecord(
        repositories,
        record => typeof record.path === "string"
            && resolve(record.path) === canonicalDir
            && typeof record.id === "string"
            && record.id.length > 0,
        record => String(record.repoId ?? record.id),
        "repository",
    );
    if (!repository) {
        throw new Error(
            `Orca has no registered repository at the exact fixture path ${canonicalDir}. `
            + "Automatic Orca registration is disabled; a benchmark request is not authorization to add it. "
            + "An operator must register this exact path only after explicit user authorization. "
            + "Benchmark and agent workflows must not register it themselves.",
        );
    }

    const repoId = typeof repository.repoId === "string" && repository.repoId.length > 0
        ? repository.repoId
        : String(repository.id);
    const worktrees = await readOrca(["worktree", "list", "--repo", `id:${repoId}`]);
    const worktree = findUniqueRecord(
        worktrees,
        record => {
            if (typeof record.path !== "string" || resolve(record.path) !== canonicalDir
                || typeof record.id !== "string" || record.id.length === 0) return false;
            if (typeof record.repoId === "string" && record.repoId !== repoId) return false;
            const nestedRepoId = (record.repo as Record<string, unknown> | undefined)?.id;
            return typeof nestedRepoId !== "string" || nestedRepoId === repoId;
        },
        record => String(record.id),
        "worktree",
    );
    if (!worktree) {
        throw new Error(
            `Orca has no exact registered worktree at ${canonicalDir} under repository ${repoId}. `
            + "Automatic worktree setup is disabled. A benchmark request is not registration authorization; "
            + "an operator must arrange this exact worktree only after explicit user authorization. "
            + "Benchmark and agent workflows must not create it themselves.",
        );
    }
    return { repoId, worktreeId: String(worktree.id) };
}
