import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realPath } from "../../src/hub/project.ts";
import { lookupOrcaWorktree, preflightOrcaWorktrees } from "../../scripts/benchmarks/orca-workspace.ts";

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

test("all selected fixtures preflight before writes and can retry after operator registration", async () => {
    const fixtures = [fixture, `${fixture}-second`];
    const registered = new Set([fixture]); // test state models explicit operator setup between attempts
    const calls: string[][] = [];
    const readOrca = async (args: string[]) => {
        calls.push(args);
        if (args[0] === "repo") {
            return { repositories: [...registered].map((path, index) => ({
                id: `repo-${index + 1}`,
                repoId: `repo-${index + 1}`,
                path,
            })) };
        }
        const repoId = args.at(-1)?.replace("id:", "");
        const index = Number(repoId?.replace("repo-", "")) - 1;
        const path = [...registered][index];
        return { worktrees: path ? [{ id: `wt-${index + 1}`, repoId, path }] : [] };
    };

    await expect(preflightOrcaWorktrees(fixtures, readOrca)).rejects.toThrow(
        "Automatic Orca registration is disabled",
    );
    expect(calls.some(args => args.includes("add"))).toBe(false);

    registered.add(fixtures[1]!); // represents explicit operator registration before retry
    const identities = await preflightOrcaWorktrees(fixtures, readOrca);
    expect(identities.get(resolve(fixtures[0]!))).toEqual({ repoId: "repo-1", worktreeId: "wt-1" });
    expect(identities.get(resolve(fixtures[1]!))).toEqual({ repoId: "repo-2", worktreeId: "wt-2" });
    expect(calls.some(args => args.includes("add"))).toBe(false);
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
            upstream_root: realPath(upstream),
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

test("native missing-registration preflight leaves the prepared run and fixture retryable", () => {
    const root = mkdtempSync(join(tmpdir(), "ahub-orca-preflight-"));
    try {
        const repo = join(root, "repo");
        const benchmarkDir = join(repo, "scripts/benchmarks");
        const fakeBin = join(root, "bin");
        const runDir = join(root, "prepared-run");
        const fixtureDir = join(runDir, "fixtures/00-solo-codex");
        const privateInputs = join(root, "private-inputs");
        const upstream = join(root, "upstream");
        const commandLog = join(root, "native-commands.log");
        mkdirSync(benchmarkDir, { recursive: true });
        mkdirSync(fakeBin);
        mkdirSync(fixtureDir, { recursive: true });
        mkdirSync(privateInputs);
        mkdirSync(upstream);
        symlinkSync(join(import.meta.dir, "../../src"), join(repo, "src"), "dir");
        symlinkSync(join(import.meta.dir, "../../plugins"), join(repo, "plugins"), "dir");
        symlinkSync(join(import.meta.dir, "../../package.json"), join(repo, "package.json"));

        for (const name of ["runner.py", "teardown.ts", "evaluate.py", "orca-workspace.ts"])
            symlinkSync(join(import.meta.dir, `../../scripts/benchmarks/${name}`), join(benchmarkDir, name));
        const nativeSource = join(import.meta.dir, "../../scripts/benchmarks/native.ts");
        const nativeCopy = join(benchmarkDir, "native.ts");
        copyFileSync(nativeSource, nativeCopy);
        writeFileSync(join(fixtureDir, "marker.txt"), "prepared fixture bytes");
        writeFileSync(join(upstream, "probe.txt"), "protected probe");

        const runChecked = (name: string, args: string[], cwd: string) => {
            const result = spawnSync(name, args, { cwd, encoding: "utf8" });
            if (result.status !== 0) throw new Error(result.stderr || `${name} failed`);
            return result.stdout.trim();
        };
        runChecked("git", ["init", "-q"], upstream);
        runChecked("git", ["config", "user.name", "Test"], upstream);
        runChecked("git", ["config", "user.email", "test@example.invalid"], upstream);
        runChecked("git", ["add", "probe.txt"], upstream);
        runChecked("git", ["commit", "-qm", "test upstream"], upstream);
        const upstreamCommit = runChecked("git", ["rev-parse", "HEAD"], upstream);
        const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
        const upstreamTree = sha(JSON.stringify({ "probe.txt": sha(readFileSync(join(upstream, "probe.txt"))) }));
        const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"));
        const pinned = JSON.parse(readFileSync(join(import.meta.dir, "../../scripts/benchmarks/manifest-v1.json"), "utf8"));
        const prompts = ["prompt one", "prompt two"];
        const caseData = { repo: "example/repo", task: "task-1", features: ["feature-1"], prompts };
        writeFileSync(join(privateInputs, "case-00.json"), JSON.stringify(caseData));
        const manifest = {
            schema: "agent-hub.cooperbench-run/v1",
            hub_version: pkg.version,
            versions: { ...pinned.versions, hub: pkg.version },
            upstream: { ...pinned.upstream, commit: upstreamCommit },
            arms: ["solo-codex"],
            cases: [{
                repo: caseData.repo,
                task: caseData.task,
                features: caseData.features,
                prompt_sha256: prompts.map(sha),
            }],
        };
        writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest));
        const hashFile = (path: string) => sha(readFileSync(path));
        writeFileSync(join(runDir, "prepared.json"), JSON.stringify({
            runner_sha256: hashFile(join(benchmarkDir, "runner.py")),
            native_runner_sha256: hashFile(nativeCopy),
            teardown_sha256: hashFile(join(benchmarkDir, "teardown.ts")),
            process_table_sha256: hashFile(join(repo, "src/hub/child-process.ts")),
            evaluator_sha256: hashFile(join(benchmarkDir, "evaluate.py")),
            upstream_root: realPath(upstream),
            upstream_source_sha256: upstreamTree,
            fixtures: [],
        }));
        chmodSync(runDir, 0o700);

        const fakeOrca = join(fakeBin, "orca");
        writeFileSync(fakeOrca, `#!/bin/sh
printf 'orca %s\\n' "$*" >> "$COMMAND_LOG"
if [ "$1:$2" = "worktree:current" ]; then
  printf '{"result":{"worktree":{"path":"%s"}}}\\n' "$FAKE_REPO"
elif [ "$1:$2" = "repo:list" ]; then
  printf '{"repositories":[]}\\n'
else
  printf '{}\\n'
fi
`);
        chmodSync(fakeOrca, 0o700);
        for (const name of ["codex", "claude", "bun", "ahub"]) {
            const command = join(fakeBin, name);
            const version = name === "codex" ? `codex ${pinned.versions.codex}`
                : name === "claude" ? `Claude Code ${pinned.versions.claude}` : "unexpected command";
            writeFileSync(command, `#!/bin/sh
printf '${name} %s\\n' "$*" >> "$COMMAND_LOG"
if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; else exit 99; fi
`);
            chmodSync(command, 0o700);
        }

        const fixtureBytes = readFileSync(join(fixtureDir, "marker.txt"));
        const manifestBytes = readFileSync(join(runDir, "manifest.json"));
        const preparedBytes = readFileSync(join(runDir, "prepared.json"));
        const result = spawnSync(process.execPath, [nativeCopy,
            "--run", runDir,
            "--private-inputs", privateInputs,
            "--upstream-root", upstream,
            "--probe-target", join(upstream, "probe.txt"),
            "--codex-bin", join(fakeBin, "codex"),
            "--protect", upstream,
        ], {
            cwd: repo,
            env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, COMMAND_LOG: commandLog, FAKE_REPO: realPath(repo) },
            encoding: "utf8",
            timeout: 20_000,
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Automatic Orca registration is disabled");
        expect(readFileSync(join(fixtureDir, "marker.txt"))).toEqual(fixtureBytes);
        expect(readFileSync(join(runDir, "manifest.json"))).toEqual(manifestBytes);
        expect(readFileSync(join(runDir, "prepared.json"))).toEqual(preparedBytes);
        for (const name of ["private", "runs", "patches", "cohort.json", "restoration-ledger.json", "restoration.json"])
            expect(existsSync(join(runDir, name))).toBe(false);
        const calls = readFileSync(commandLog, "utf8");
        expect(calls).toContain("repo list --json");
        expect(calls).not.toContain("repo add");
        expect(calls).not.toContain("worktree list");
        expect(calls).not.toContain("bun ");
        expect(calls).not.toContain("ahub ");
        expect(calls).toContain("claude --version");
        expect(calls.split("\n").filter(line => line.startsWith("claude "))).toEqual(["claude --version"]);
        expect(calls).not.toContain("mcp list");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
