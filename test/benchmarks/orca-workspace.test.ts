import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lookupOrcaWorktree } from "../../scripts/benchmarks/orca-workspace.ts";

const fixture = "/private/tmp/ahub-case/fixture";

test("lookup helper hash is pinned by the native runner source", () => {
    const helper = readFileSync(join(import.meta.dir, "../../scripts/benchmarks/orca-workspace.ts"));
    const runner = readFileSync(join(import.meta.dir, "../../scripts/benchmarks/native.ts"), "utf8");
    const pinned = runner.match(/const orcaWorkspaceSourceSha256 = '([a-f0-9]{64})'/)?.[1];
    const actual = createHash("sha256").update(helper).digest("hex");
    expect(pinned).toBe(actual);
});

test("lookup returns exact existing repo/worktree identities using read-only Orca calls", async () => {
    const calls: string[][] = [];
    const readOrca = async (args: string[]) => {
        calls.push(args);
        if (args[0] === "repo") return { repositories: [
            { id: "other", path: "/private/tmp/elsewhere" },
            { id: "repo-1", repoId: "stable-repo-1", path: fixture },
        ] };
        return { worktrees: [
            { id: "wrong-path", path: "/private/tmp/elsewhere" },
            { id: "wt-1", repoId: "stable-repo-1", path: fixture },
        ] };
    };

    await expect(lookupOrcaWorktree(fixture, readOrca)).resolves.toEqual({
        repoId: "stable-repo-1",
        worktreeId: "wt-1",
    });
    expect(calls).toEqual([
        ["repo", "list"],
        ["worktree", "list", "--repo", "id:stable-repo-1"],
    ]);
    expect(calls.some(args => args.includes("add"))).toBe(false);
});

test("missing repo fails with a manual registration instruction and does not continue lookup", async () => {
    const calls: string[][] = [];
    const readOrca = async (args: string[]) => {
        calls.push(args);
        return { repositories: [{ id: "other", path: "/private/tmp/elsewhere" }] };
    };

    await expect(lookupOrcaWorktree(fixture, readOrca)).rejects.toThrow(
        "Automatic Orca registration is disabled; a benchmark request is not authorization",
    );
    expect(calls).toEqual([["repo", "list"]]);
});

test("ambiguous exact repo identities fail closed before worktree lookup", async () => {
    const calls: string[][] = [];
    const readOrca = async (args: string[]) => {
        calls.push(args);
        return { repositories: [
            { id: "repo-1", path: fixture },
            { id: "repo-2", path: fixture },
        ] };
    };
    await expect(lookupOrcaWorktree(fixture, readOrca)).rejects.toThrow(
        "multiple exact repository identities",
    );
    expect(calls).toEqual([["repo", "list"]]);
});

test("missing or mismatched exact worktree fails without any mutating call", async () => {
    for (const worktrees of [
        [{ id: "wrong", path: "/private/tmp/elsewhere", repoId: "repo-1" }],
        [{ path: fixture, repoId: "repo-1" }],
        [{ id: "wrong-repo", path: fixture, repoId: "other" }],
    ]) {
        const calls: string[][] = [];
        const readOrca = async (args: string[]) => {
            calls.push(args);
            return args[0] === "repo"
                ? { repositories: [{ id: "repo-1", path: fixture }] }
                : { worktrees };
        };
        await expect(lookupOrcaWorktree(fixture, readOrca)).rejects.toThrow(
            "no exact registered worktree",
        );
        expect(calls).toEqual([
            ["repo", "list"],
            ["worktree", "list", "--repo", "id:repo-1"],
        ]);
        expect(calls.some(args => args.includes("add"))).toBe(false);
    }
});
