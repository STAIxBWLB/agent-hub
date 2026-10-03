import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
            { id: "repo-1", repoId: "", path: fixture },
            { id: "repo-2", repoId: "", path: fixture },
        ] };
    };
    await expect(lookupOrcaWorktree(fixture, readOrca)).rejects.toThrow(
        "multiple exact repository identities",
    );
    expect(calls).toEqual([["repo", "list"]]);
});

test("an empty optional repoId falls back to the validated repo id for a single exact repo", async () => {
    const calls: string[][] = [];
    const readOrca = async (args: string[]) => {
        calls.push(args);
        return args[0] === "repo"
            ? { repositories: [{ id: "repo-fallback", repoId: "", path: fixture }] }
            : { worktrees: [{ id: "wt-fallback", path: fixture, repoId: "repo-fallback" }] };
    };
    await expect(lookupOrcaWorktree(fixture, readOrca)).resolves.toEqual({
        repoId: "repo-fallback",
        worktreeId: "wt-fallback",
    });
    expect(calls).toEqual([
        ["repo", "list"],
        ["worktree", "list", "--repo", "id:repo-fallback"],
    ]);
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

test("native runner rejects a changed helper before importing it or invoking native commands", () => {
    const root = mkdtempSync(join(tmpdir(), "ahub-orca-pin-"));
    try {
        const fakeRepo = join(root, "repo");
        const benchmarkDir = join(fakeRepo, "scripts/benchmarks");
        const fakeBin = join(root, "bin");
        const runDir = join(root, "run");
        const privateInputs = join(root, "private-inputs");
        const upstream = join(root, "upstream");
        const sentinel = join(root, "helper-imported");
        const commandLog = join(root, "native-command.log");
        mkdirSync(benchmarkDir, { recursive: true });
        mkdirSync(fakeBin);
        mkdirSync(runDir);
        mkdirSync(privateInputs);
        mkdirSync(upstream);
        symlinkSync(join(import.meta.dir, "../../src"), join(fakeRepo, "src"), "dir");

        for (const name of ["runner.py", "teardown.ts", "evaluate.py"])
            symlinkSync(join(import.meta.dir, `../../scripts/benchmarks/${name}`), join(benchmarkDir, name));
        const nativeSource = join(import.meta.dir, "../../scripts/benchmarks/native.ts");
        const nativeCopy = join(benchmarkDir, "native.ts");
        copyFileSync(nativeSource, nativeCopy);
        const alteredHelper = join(benchmarkDir, "orca-workspace.ts");
        writeFileSync(alteredHelper,
            `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "imported");\nexport async function lookupOrcaWorktree() { throw new Error("unexpected lookup"); }\n`,
        );

        const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
        const runnerPath = join(benchmarkDir, "runner.py");
        const teardownPath = join(benchmarkDir, "teardown.ts");
        const evaluatorPath = join(benchmarkDir, "evaluate.py");
        writeFileSync(join(runDir, "manifest.json"), JSON.stringify({}));
        writeFileSync(join(runDir, "prepared.json"), JSON.stringify({
            runner_sha256: hash(runnerPath),
            native_runner_sha256: hash(nativeCopy),
            teardown_sha256: hash(teardownPath),
            process_table_sha256: hash(join(fakeRepo, "src/hub/child-process.ts")),
            evaluator_sha256: hash(evaluatorPath),
            upstream_root: upstream,
        }));
        chmodSync(runDir, 0o700);
        writeFileSync(join(upstream, "probe.txt"), "probe");

        for (const name of ["orca", "ahub", "claude", "codex"]) {
            const command = join(fakeBin, name);
            writeFileSync(command, "#!/bin/sh\nprintf '%s\\n' \"$0\" >> \"$COMMAND_LOG\"\nexit 99\n");
            chmodSync(command, 0o700);
        }
        const result = spawnSync(process.execPath, [nativeCopy,
            "--run", runDir,
            "--private-inputs", privateInputs,
            "--upstream-root", upstream,
            "--probe-target", join(upstream, "probe.txt"),
        ], {
            cwd: fakeRepo,
            env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, COMMAND_LOG: commandLog },
            encoding: "utf8",
            timeout: 15_000,
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Orca workspace lookup helper changed after benchmark preparation");
        expect(existsSync(sentinel)).toBe(false);
        expect(existsSync(commandLog)).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
