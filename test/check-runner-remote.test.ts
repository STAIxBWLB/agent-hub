import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { processTable } from "../src/hub/child-process.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { ContainerRunner, RemoteRunner, remoteRunnerTransport, remoteRunnerConfig, remoteDockerArgs, remoteArchiveArgs, type ContainerCommand, type RunnerOptions } from "../src/hub/check-runner.ts";
const remote = { host: "fixture@runner.reserved.invalid", image: "registry.reserved.invalid/check@sha256:" + "a".repeat(64), root: "/reserved/check-root" };
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: Partial<RunnerOptions> = {}, failure?: string) {
  const root = realPath(await mkdtemp(join(tmpdir(), "ahub-remote-fixture-"))), project = join(root, "project"), calls: string[][] = [];
  await mkdir(project); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => { const result = hubGitSync(["-C", project, ...args], { encoding: "utf8" }); if (result.status !== 0) throw Error("fixture git failed"); return result.stdout.trim(); };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await mkdir(join(project, "test/nested"), { recursive: true });
  await writeFile(join(project, "test/nested/example.test.ts"), "test('exact commit',()=>{});\n");
  await writeFile(join(project, "bun.lock"), "committed-lock\n"); await writeFile(join(project, "denied.txt"), "withheld");
  await writeFile(join(project, "executable.sh"), "#!/bin/sh\nexit 0\n"); await chmod(join(project, "executable.sh"), 0o755);
  git("add", "."); git("commit", "-qm", "test: synthetic source");
  await mkdir(join(project, "node_modules")); await writeFile(join(project, "node_modules/mac-only.bin"), "DO_NOT_COPY_MAC_DEPS");
  const archives: { container: string; data: Buffer }[] = [];
  const active = new Map<string, Record<string, string>>();
  const command: ContainerCommand = async (args, opt) => {
    calls.push(args);
    if (failure === "ssh") throw Error(`${remote.host} ${remote.root} private SSH failure`);
    if (args[0] === "version") return { code: failure === "docker" ? 1 : 0, stdout: JSON.stringify({ Version: "27.4.1", Os: "linux", Arch: "arm64" }) };
    if (args[0] === "image") return { code: 0, stdout: JSON.stringify({ digests: failure === "image" ? [] : [remote.image], arch: "amd64", os: "linux" }) };
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1]!, labels: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) if (args[i] === "--label") { const value = args[i + 1]!, at = value.indexOf("="); labels[value.slice(0, at)] = value.slice(at + 1); }
      active.set(name, labels);
    }
    if (args[0] === "exec" && opt?.input) {
      const container = args[args.indexOf("65532:65532") + 1]!;
      archives.push({ container, data: Buffer.from(await new Response(opt.input).arrayBuffer()) });
    } else if (args[0] === "exec" && args.at(-1)?.includes("AHUB_REMOTE_READY")) return { code: failure === "probe" ? 1 : 0, stdout: JSON.stringify({ marker: "AHUB_REMOTE_READY", arch: failure === "arch" ? "arm64" : "x64", platform: "linux" }) };
    else if (args[0] === "exec") { opt?.output?.(Buffer.from(`public output ${remote.host} ${remote.root} split ${remote.host.split("@").join(" ")}\n`)); return { code: 0, stdout: "" }; }
    if (args[0] === "rm" && (failure !== "cleanup" || args[1]!.startsWith("agenthub-check-probe-"))) active.delete(args[1]!);
    if (args[0] === "ps") {
      const nameFilter = args.find(value => value.startsWith("name=^/"))?.slice("name=^/".length, -1);
      const projectFilter = args.find(value => value.startsWith("label=agenthub.project="))?.slice("label=agenthub.project=".length);
      return { code: 0, stdout: [...active].filter(([name, labels]) => (!nameFilter || name === nameFilter) && (!projectFilter || labels["agenthub.project"] === projectFilter)).map(([name, labels]) => JSON.stringify({ id: name, project: labels["agenthub.project"] ?? "", hub: labels["agenthub.hub"] ?? "", run: labels["agenthub.run"] ?? "", probe: labels["agenthub.probe"] ?? "" })).join("\n") };
    }
    return { code: 0, stdout: "" };
  };
  const settings: RunnerOptions = { projectDir: project, stateDir: join(root, "state"), storageDir: join(root, "storage"), projectKey: "fixture", enabled: true, remote, isDenied: path => path === "denied.txt", signature: () => "fixture-signature", command, ...options };
  // Transport-only component: this intentionally does not grant production RemoteRunner dependency readiness.
  const runner = new ContainerRunner(settings, remoteRunnerTransport(settings));
  cleanup.push(() => runner.stopAll());
  return { root, project, git, runner, calls, command, settings, archives, archive: () => archives.findLast(entry => !entry.container.startsWith("agenthub-check-probe-"))?.data ?? Buffer.alloc(0), request: { task: 1, owner: "pi", generation: 2, updated: 3, ref: "HEAD", check: "test" as const, files: ["test/nested/example.test.ts"] } };
}

test("remote checks stream exact Git source with readable non-root modes and no Mac dependencies", async () => {
  const previous = process.umask(0o077);
  try {
    const f = await fixture(), head = f.git("rev-parse", "HEAD");
    await writeFile(join(f.project, "test/nested/example.test.ts"), "dirty-working-tree");
    await writeFile(join(f.project, "bun.lock"), "different-host-lock");
    const result = await f.runner.start(f.request).done;
    expect(result).toMatchObject({ sha: head, runner: "remote", image: "sha256:" + "a".repeat(64), dependency_files: 0, excluded: 1, exit: 0, platform: "linux/amd64 (remote docker 27.4.1)" });
    const archive = f.archive(); expect(archive.length).toBeGreaterThan(0);
    // Fixed first GNU header only, not an archive parser: normalized ownership cannot leak the Mac account.
    expect(Number.parseInt(archive.subarray(108, 116).toString().replaceAll(String.fromCharCode(0), "").trim(), 8)).toBe(65532);
    expect(Number.parseInt(archive.subarray(116, 124).toString().replaceAll(String.fromCharCode(0), "").trim(), 8)).toBe(65532);
    for (const name of [archive.subarray(265, 297).toString(), archive.subarray(297, 329).toString()]) expect(["", "check", "65532"]).toContain(name.replaceAll(String.fromCharCode(0), ""));
    for (const metadata of ["LIBARCHIVE.xattr", "SCHILY.xattr", "com.apple.", "._source-proof"]) expect(archive.includes(Buffer.from(metadata))).toBe(false);
    const listing = spawnSync("tar", ["-tvf", "-"], { input: archive, encoding: "utf8" });
    expect(listing.status).toBe(0); expect(listing.stdout).toMatch(/-rw-r--r--.*example\.test\.ts/); expect(listing.stdout).toMatch(/-rwxr-xr-x.*executable\.sh/);
    for (const line of listing.stdout.split("\n").filter(line => line.startsWith("d"))) expect(line.slice(0, 10)).toBe("drwxr-xr-x");
    expect(archive.includes(Buffer.from("exact commit"))).toBe(true); expect(archive.includes(Buffer.from("dirty-working-tree"))).toBe(false);
    expect(listing.stdout).not.toContain("node_modules"); expect(archive.includes(Buffer.from("DO_NOT_COPY_MAC_DEPS"))).toBe(false); expect(listing.stdout).not.toContain("denied.txt");
    const transfer = f.calls.find(args => args[0] === "exec" && args.includes("tar") && !args.some(value => value.startsWith("agenthub-check-probe-")))!;
    expect(transfer.slice(0, 4)).toEqual(["exec", "-i", "--user", "65532:65532"]); expect(transfer.slice(-6)).toEqual(["tar", "--no-same-owner", "-xf", "-", "-C", "/work"]);
    expect(f.calls.some(args => args[0] === "cp")).toBe(false);
    expect(JSON.stringify(result)).not.toContain(remote.host); expect(JSON.stringify(result)).not.toContain(remote.root); expect(result.tail).toContain("public output"); for (const part of remote.host.split("@")) expect(result.tail).not.toContain(part); expect(result.output_withheld).toBe(true);
    const output = await readFile(join(f.root, "storage/fixture", result.run, "output.log"), "utf8"); expect(output).not.toContain(remote.host); expect(output).not.toContain(remote.root);
    expect(f.calls.some(args => args.includes("install"))).toBe(false);
  } finally { process.umask(previous); }
});

test("remote run carries hardened fixed Docker arguments and only a read-only named dependency placeholder", async () => {
  const f = await fixture(); await f.runner.start(f.request).done;
  const args = f.calls.find(args => args[0] === "run" && !args.some(value => value.startsWith("agenthub-check-probe-")))!;
  for (const [flag, value] of [["--network", "none"], ["--user", "65532:65532"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"], ["--cpus", "4"], ["--memory", "4g"], ["--pids-limit", "64"]]) expect(args[args.indexOf(flag!) + 1]).toBe(value!);
  expect(args).toContain("--read-only"); expect(args).toContain(remote.image);
  expect(args.filter((_, index) => args[index - 1] === "--tmpfs")).toEqual(expect.arrayContaining([expect.stringContaining("/work:"), expect.stringContaining("/home/check:"), expect.stringContaining("/tmp:")]));
  expect(args[args.indexOf("--mount") + 1]).toBe("type=volume,src=agenthub-check-deps-unprepared-fixture,dst=/work/node_modules,readonly");
  expect(args.some(arg => arg.startsWith("type=bind") || arg.includes(remote.root) || arg.includes(f.project))).toBe(false);
  expect(f.calls.find(args => args[0] === "exec" && args.includes("test"))?.slice(-3)).toEqual(["bun", "test", "test/nested/example.test.ts"]);
});

for (const failure of ["ssh", "docker", "image", "probe", "arch"]) test(`remote readiness ${failure} failure is generic and never falls back`, async () => {
  const f = await fixture({}, failure);
  expect(await f.runner.available()).toMatchObject({ available: false, reason: "remote runner unavailable" });
  expect((await f.runner.start(f.request).done).error).toBe("remote runner unavailable");
  expect(f.calls.some(args => args[0] === "--version" || args[0] === "system" || args[0] === "run" && !args.some(value => value.startsWith("agenthub-check-probe-")))).toBe(false);
});

test("remote cleanup uncertainty retains the common heavy lease and refuses a passing receipt", async () => {
  const f = await fixture({}, "cleanup"), result = await f.runner.start(f.request).done;
  expect(result.exit).toBeNull(); expect(result.error).toContain("cleanup unconfirmed");
  expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock/owner")).exists()).toBe(true);
  expect(f.calls.some(args => args[0] === "ps" && args.includes("--all"))).toBe(true);
});

test("remote SSH arguments quote shell metacharacters and reject unsafe machine-local config tokens", () => {
  const word = "test/a'file;echo BAD.test.ts", argv = remoteDockerArgs(remote.host, ["exec", "container", "bun", "test", word]);
  expect(argv.slice(0, 13)).toEqual(["-T", "-a", "-x", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", remote.host]);
  const roundtrip = spawnSync("sh", ["-c", `set -- ${argv.at(-1)!.replace(/ 2>&1$/, "")}; printf '%s\\n' "$@"`], { encoding: "utf8" });
  expect(roundtrip.status).toBe(0); expect(roundtrip.stdout.trim().split("\n")).toEqual(["docker", "exec", "container", "bun", "test", word]);
  for (const update of [{ host: "-oProxyCommand=bad" }, { host: "host;bad" }, { root: "/tmp/../bad" }, { root: "/tmp/$(bad)" }, { image: "mutable:latest" }, { extra: "bad" }]) expect(() => remoteRunnerConfig({ ...remote, ...update })).toThrow("invalid remote runner configuration");
});

async function fakeSshFixture(f: Awaited<ReturnType<typeof fixture>>, mode: "failure" | "stderr" = "failure") {
  const bin = join(f.root, "fake-bin"); await mkdir(bin);
  const agentSocket = join(f.root, "synthetic-agent.sock"), proof = join(f.root, "ssh-proof"), keys = join(f.root, "ssh-env-keys");
  const active = join(f.root, "ssh-active");
  const script = `#!/bin/sh
if [ "$1 $2 $3 $5 $7" = '-T -a -x ClearAllForwardings=yes PermitLocalCommand=no' ]; then printf '%s\\n' 'flags-protected' >> '${proof}'; else printf '%s\\n' 'flags-wrong' >> '${proof}'; fi
if [ "$SSH_AUTH_SOCK" = '${agentSocket}' ]; then printf '%s\\n' 'auth-retained' >> '${proof}'; else printf '%s\\n' 'auth-missing' >> '${proof}'; fi
/usr/bin/env | while IFS='=' read -r key value; do printf '%s\\n' "$key"; done >> '${keys}'
last=''
for arg in "$@"; do last="$arg"; done
# The fake executes only 'set --' on production-quoted Docker words, never Docker or SSH.
eval "set -- $last"
shift
if [ 'AHUB_FAKE_MODE' = 'stderr' ] && [ "$1" = exec ]; then
  case "$last" in
    *"'tar' "*) ;;
    *AHUB_REMOTE_READY*)
      case "$last" in *" 2>&1") printf '%s\\n' 'BENIGN_PROBE_WARNING' ;; *) printf '%s\\n' 'BENIGN_PROBE_WARNING' >&2 ;; esac
      printf '%s\\n' '{"marker":"AHUB_REMOTE_READY","arch":"x64","platform":"linux"}'; exit 0 ;;
    *)
      printf '%s\\n' 'PUBLIC_CHECK_OUTPUT'
      case "$last" in *" 2>&1") printf '%s\\n' 'CHECK_STDERR' ;; *) printf '%s\\n' 'CHECK_STDERR' >&2 ;; esac
      exit 0 ;;
  esac
fi
case "$1" in
  version) printf '%s\\n' '{"Version":"27.4.1-private-host","Os":"linux","Arch":"arm64"}' ;;
  image) printf '%s\\n' '{"digests":["${remote.image}"],"arch":"amd64","os":"linux"}' ;;
  run) while [ "$#" -gt 0 ]; do if [ "$1" = '--name' ]; then printf '%s' "$2" > '${active}'; fi; shift; done ;;
  exec)
    case "$last" in
      *"'tar' "*) /bin/cat >/dev/null ;;
      *AHUB_REMOTE_READY*) printf '%s\\n' '{"marker":"AHUB_REMOTE_READY","arch":"x64","platform":"linux"}' ;;
      *) printf '%s\\n' '${remote.host} ${remote.root} transport stdout'; printf '%s\\n' 'SSH_PRIVATE_DIAGNOSTIC' >&2; exit 255 ;;
    esac ;;
  rm) : > '${active}' ;;
  ps)
    name=''; if [ -f '${active}' ]; then name=$(/bin/cat '${active}'); fi
    if [ -n "$name" ]; then
      probe=''; run="$name"
      case "$name" in agenthub-check-probe-*) probe="$name"; run='' ;; esac
      printf '{"id":"%s","project":"fixture","hub":"fixture","run":"%s","probe":"%s"}\\n' "$name" "$run" "$probe"
    fi ;;
esac
`;
  await writeFile(join(bin, "ssh"), script.replaceAll("AHUB_FAKE_MODE", mode), { mode: 0o755 });
  const before = process.env.PATH, previousSocket = process.env.SSH_AUTH_SOCK, previousPeer = process.env.AHUB_REMOTE_PEER_ONLY;
  process.env.PATH = `${bin}:${before ?? "/usr/bin:/bin"}`; process.env.SSH_AUTH_SOCK = agentSocket; process.env.AHUB_REMOTE_PEER_ONLY = "fixture-peer-only";
  cleanup.push(() => {
    if (before === undefined) delete process.env.PATH; else process.env.PATH = before;
    if (previousSocket === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = previousSocket;
    if (previousPeer === undefined) delete process.env.AHUB_REMOTE_PEER_ONLY; else process.env.AHUB_REMOTE_PEER_ONLY = previousPeer;
  });
  const settings: RunnerOptions = { projectDir: f.project, stateDir: join(f.root, "ssh-state"), storageDir: join(f.root, "ssh-storage"), projectKey: "fixture", enabled: true, remote, isDenied: () => false, signature: () => "fixture-signature" };
  return { settings, proof, keys };
}

test("real SSH transport boundary with a fake executable drops exit-255 output and all SSH stderr", async () => {
  const f = await fixture(), { settings, proof, keys } = await fakeSshFixture(f);
  const runner = new ContainerRunner(settings, remoteRunnerTransport(settings));
  cleanup.push(() => runner.stopAll());
  expect(await runner.available()).toMatchObject({ available: true, platform: "linux/amd64 (remote docker 27.4.1)" });
  const result = await runner.start(f.request).done;
  expect(result).toMatchObject({ exit: null, error: "remote runner unavailable", output_bytes: 0, tail: "" });
  const text = JSON.stringify(result) + await readFile(join(f.root, "ssh-storage/fixture", result.run, "output.log"), "utf8");
  for (const hidden of [remote.host, remote.root, "SSH_PRIVATE_DIAGNOSTIC", "private-host", "transport stdout"]) expect(text).not.toContain(hidden);
  const observations = (await readFile(proof, "utf8")).trim().split("\n");
  expect(observations.length).toBeGreaterThan(0); expect(new Set(observations)).toEqual(new Set(["flags-protected", "auth-retained"]));
  const environmentKeys = new Set((await readFile(keys, "utf8")).trim().split("\n"));
  expect(environmentKeys.has("SSH_AUTH_SOCK")).toBe(true); expect(environmentKeys.has("AHUB_REMOTE_PEER_ONLY")).toBe(false);
  for (const key of environmentKeys) expect(["PATH", "HOME", "TMPDIR", "SSH_AUTH_SOCK", "PWD", "SHLVL", "_"]).toContain(key);
});

test("remote cancellation reaps the tar producer and confirms Docker cleanup before releasing its lease", async () => {
  const f = await fixture(); let enter!: () => void; const copying = new Promise<void>(resolve => { enter = resolve; });
  const command: ContainerCommand = async (args, opt) => {
    if (args[0] === "exec" && opt?.input && !args.some(value => value.startsWith("agenthub-check-probe-"))) {
      enter(); await new Promise<void>(resolve => { if (opt?.signal?.aborted) resolve(); else opt?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { code: 0, stdout: "late transfer success" };
    }
    return f.command(args, opt);
  };
  const settings: RunnerOptions = { projectDir: f.project, stateDir: join(f.root, "cancel-state"), storageDir: join(f.root, "cancel-storage"), projectKey: "fixture", remote, enabled: true, isDenied: () => false, signature: () => "fixture", command };
  const runner = new ContainerRunner(settings, remoteRunnerTransport(settings)); cleanup.push(() => runner.stopAll());
  const handle = runner.start(f.request); await copying; await runner.cancel(handle.run);
  const result = await handle.done;
  expect(result).toMatchObject({ cancelled: true, exit: null, error: "check stopped" });
  expect(f.calls.some(args => args[0] === "exec" && args.includes("test"))).toBe(false);
  expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock")).exists()).toBe(false);
  const rows = processTable(); expect(rows).toBeDefined(); expect(rows!.some(row => row.command.includes(f.root) && /\btar\b/.test(row.command))).toBe(false);
}, 5000);

test("cancelled remote readiness still performs independent bounded probe cleanup", async () => {
  const f = await fixture(); let enter!: () => void; const probing = new Promise<void>(resolve => { enter = resolve; });
  const cleanupSignals: unknown[] = [];
  const command: ContainerCommand = async (args, opt) => {
    if (args[0] === "run" && args.some(value => value.startsWith("agenthub-check-probe-"))) {
      await f.command(args, opt);
      enter(); await new Promise<void>(resolve => { if (opt?.signal?.aborted) resolve(); else opt?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { code: 0, stdout: "late probe success" };
    }
    if (["kill", "rm", "ps"].includes(args[0]!)) cleanupSignals.push(opt?.signal);
    return f.command(args, opt);
  };
  const runner = new RemoteRunner({ projectDir: f.project, stateDir: join(f.root, "probe-state"), storageDir: join(f.root, "probe-storage"), projectKey: "fixture", remote, enabled: true, isDenied: () => false, signature: () => "fixture", command }); cleanup.push(() => runner.stopAll());
  const abort = new AbortController(), state = runner.available(abort.signal); await probing; abort.abort();
  expect((await state).available).toBe(false); expect(cleanupSignals).toEqual([undefined, undefined, undefined, undefined]);
  const inventories = f.calls.filter(args => args[0] === "ps");
  expect(inventories).toHaveLength(2); expect(inventories[0]).toContain("label=agenthub.project=fixture");
  for (const args of inventories) expect(args.some(value => value.startsWith("name=^/agenthub-check-probe-"))).toBe(true);
});

test("production RemoteRunner never grants tests while prepared dependencies remain unavailable", async () => {
  const f = await fixture(), runner = new RemoteRunner(f.settings); cleanup.push(() => runner.stopAll());
  expect(await runner.available()).toMatchObject({ available: false, reason: "remote dependencies unprepared", platform: "linux/amd64 (remote docker 27.4.1)" });
  expect((await runner.start(f.request).done).error).toContain("remote dependencies unprepared");
  expect(f.calls.some(args => args[0] === "run" && !args.some(value => value.startsWith("agenthub-check-probe-")))).toBe(false);
});

test("snapshot refusals retain their source reason instead of being rewritten as SSH failures", async () => {
  const f = await fixture();
  await symlink("executable.sh", join(f.project, "linked")); f.git("add", "linked");
  // A real symlink tree entry is enough; no traversal or remote check command can happen.
  f.git("commit", "-qm", "test: symlink snapshot refusal");
  const result = await f.runner.start(f.request).done;
  expect(result.error).toBe("source has a symlink or submodule");
  expect(f.calls.some(args => args[0] === "run" && !args.some(value => value.startsWith("agenthub-check-probe-")))).toBe(false);
});

test("cached transport readiness plus a disappearing host executable still finalizes the receipt and retains unknown cleanup lease", async () => {
  const f = await fixture(), { settings } = await fakeSshFixture(f), transport = remoteRunnerTransport(settings);
  const execute = transport.command, stablePath = process.env.PATH;
  let revoke = false;
  transport.command = async (args, opts) => {
    if (revoke && args[0] === "run" && !args.some(value => value.startsWith("agenthub-check-probe-"))) process.env.PATH = join(f.root, "missing-host-tools");
    return execute(args, opts);
  };
  const runner = new ContainerRunner(settings, transport); cleanup.push(() => runner.stopAll());
  try {
    expect((await runner.available()).available).toBe(true); revoke = true;
    const handle = runner.start(f.request), result = await handle.done;
    expect(result).toMatchObject({ status: "finished", exit: null, error: "container cleanup unconfirmed; heavy slot retained" });
    expect(runner.activeRun).toBeUndefined(); expect((await runner.result(handle.run))?.status).toBe("finished");
    expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock/owner")).exists()).toBe(true);
  } finally { if (stablePath === undefined) delete process.env.PATH; else process.env.PATH = stablePath; }
}, 5000);

test("remote Docker inventories are project-scoped structured labels, so comma label values are preserved", async () => {
  const f = await fixture(), transport = remoteRunnerTransport(f.settings);
  expect(transport.listArgs).toContain("label=agenthub.project=fixture"); expect(transport.listArgs).toContain("--no-trunc");
  const format = transport.listArgs.at(-1)!;
  expect(format).toContain('.Label "agenthub.project"'); expect(format).toContain('.Label "agenthub.hub"'); expect(format).not.toContain(".Labels");
  const hub = "123:signature,unrelated=value";
  expect(transport.list(JSON.stringify({ id: "fixture", project: "fixture", hub, run: "run", probe: "" }))).toEqual([{ id: "fixture", labels: { "agenthub.project": "fixture", "agenthub.hub": hub, "agenthub.run": "run", "agenthub.probe": "" } }]);
});

test("remote component start failure after cached readiness stays generic and finalizes after scoped cleanup", async () => {
  const f = await fixture(); let failedStarts = 0;
  const settings: RunnerOptions = { ...f.settings, command: async (args, opt) => {
    if (args[0] === "run" && !args.some(value => value.startsWith("agenthub-check-probe-"))) {
      failedStarts++; return { code: 125, stdout: `${remote.host} ${remote.root} private daemon failure` };
    }
    return f.command(args, opt);
  } };
  const runner = new ContainerRunner(settings, remoteRunnerTransport(settings)); cleanup.push(() => runner.stopAll());
  expect((await runner.available()).available).toBe(true);
  const result = await runner.start(f.request).done;
  expect(failedStarts).toBe(1); expect(result).toMatchObject({ status: "finished", exit: null, error: "remote runner unavailable", tail: "" });
  expect(f.calls.some(args => args[0] === "exec" && args.includes("test"))).toBe(false);
  expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock/owner")).exists()).toBe(false);
  for (const hidden of [remote.host, remote.root, "private daemon failure", "container start failed"]) expect(JSON.stringify(result)).not.toContain(hidden);
});

test("Darwin archive selection ignores a GNU tar ahead on PATH while Linux keeps the host tool guard", async () => {
  const f = await fixture(), bin = join(f.root, "gnu-first"); await mkdir(bin);
  await writeFile(join(bin, "tar"), "#!/bin/sh\nexit 64\n", { mode: 0o755 });
  const previous = process.env.PATH;
  try {
    process.env.PATH = bin + ":" + (previous ?? "/usr/bin:/bin");
    const darwin = remoteArchiveArgs(f.project, f.project, "darwin");
    expect(darwin[0]).toBe("/usr/bin/tar"); expect(darwin).toContain("--disable-copyfile");
    expect(remoteArchiveArgs(f.project, f.project, "linux")[0]).toBe(join(bin, "tar"));
    if (process.platform === "darwin") expect((await f.runner.start(f.request).done).exit).toBe(0);
    const peerBin = join(f.project, "bin"); await mkdir(peerBin);
    await writeFile(join(peerBin, "tar"), "#!/bin/sh\nexit 64\n", { mode: 0o755 });
    process.env.PATH = peerBin + ":" + bin;
    expect(() => remoteArchiveArgs(f.project, f.project, "linux")).toThrow("tar unavailable");
    expect(remoteArchiveArgs(f.project, f.project, "darwin")[0]).toBe("/usr/bin/tar");
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test("probe stderr stays out of JSON while actual check stderr reaches screened output", async () => {
  const f = await fixture(), { settings } = await fakeSshFixture(f, "stderr");
  const runner = new ContainerRunner(settings, remoteRunnerTransport(settings)); cleanup.push(() => runner.stopAll());
  expect((await runner.available()).available).toBe(true);
  const result = await runner.start(f.request).done;
  expect(result.exit).toBe(0); expect(result.tail).toContain("PUBLIC_CHECK_OUTPUT"); expect(result.tail).toContain("CHECK_STDERR");
  expect(JSON.stringify(result)).not.toContain("BENIGN_PROBE_WARNING");
  const exec = ["exec", "container", "bun", "-e", "probe"];
  expect(remoteDockerArgs(remote.host, exec).at(-1)).not.toEndWith(" 2>&1");
  expect(remoteDockerArgs(remote.host, exec, true).at(-1)).toEndWith(" 2>&1");
});

test("sweep leaves exact bounded probes to expire but still reports malformed and unknown run owners", async () => {
  const f = await fixture(), probe = "11111111-1111-4111-8111-111111111111", calls: string[][] = [];
  const rows = [
    { id: "agenthub-check-probe-" + probe, project: "fixture", probe, hub: "", run: "" },
    { id: "agenthub-check-probe-bad", project: "fixture", probe: "bad", hub: "", run: "" },
    { id: "agenthub-check-probe-22222222-2222-4222-8222-222222222222", project: "fixture", probe, hub: "", run: "" },
    { id: "agenthub-check-probe-33333333-3333-4333-8333-333333333333", project: "fixture", probe: "33333333-3333-4333-8333-333333333333", hub: "", run: probe },
    { id: "agenthub-check-" + probe, project: "fixture", probe: "", hub: "", run: probe },
  ];
  let current = rows[0]!;
  const settings: RunnerOptions = { ...f.settings, command: async (args, opts) => {
    calls.push(args);
    if (args[0] === "ps") return { code: 0, stdout: JSON.stringify(current) };
    return f.command(args, opts);
  } };
  const runner = new ContainerRunner(settings, remoteRunnerTransport(settings)); cleanup.push(() => runner.stopAll());
  for (const row of rows) {
    current = row;
    const unknown = await runner.sweep();
    expect(unknown).toHaveLength(row === rows[0] ? 0 : 1);
    if (!row.probe) expect(unknown[0]).toContain("agenthub-check-" + probe);
  }
  expect(calls.some(args => args[0] === "kill" || args[0] === "rm")).toBe(false);
});
