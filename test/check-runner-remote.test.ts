import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { processTable } from "../src/hub/child-process.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { RemoteRunner, remoteRunnerConfig, remoteDockerArgs, type ContainerCommand, type RunnerOptions } from "../src/hub/check-runner.ts";
const remote = { host: "fixture@runner.reserved.invalid", image: "registry.reserved.invalid/check@sha256:" + "a".repeat(64), root: "/reserved/check-root" };
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: Partial<RunnerOptions> = {}, failure?: string) {
  const root = await mkdtemp(join(tmpdir(), "ahub-remote-fixture-")), project = join(root, "project"), calls: string[][] = [];
  await mkdir(project); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => { const result = hubGitSync(["-C", project, ...args], { encoding: "utf8" }); if (result.status !== 0) throw Error("fixture git failed"); return result.stdout.trim(); };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await mkdir(join(project, "test/nested"), { recursive: true });
  await writeFile(join(project, "test/nested/example.test.ts"), "test('exact commit',()=>{});\n");
  await writeFile(join(project, "bun.lock"), "committed-lock\n"); await writeFile(join(project, "denied.txt"), "withheld");
  await writeFile(join(project, "executable.sh"), "#!/bin/sh\nexit 0\n"); await chmod(join(project, "executable.sh"), 0o755);
  git("add", "."); git("commit", "-qm", "test: synthetic source");
  await mkdir(join(project, "node_modules")); await writeFile(join(project, "node_modules/mac-only.bin"), "DO_NOT_COPY_MAC_DEPS");
  let archive = Buffer.alloc(0), active = "";
  const command: ContainerCommand = async (args, opt) => {
    calls.push(args);
    if (failure === "ssh") throw Error(`${remote.host} ${remote.root} private SSH failure`);
    if (args[0] === "version") return { code: failure === "docker" ? 1 : 0, stdout: JSON.stringify({ Version: "27.4.1", Os: "linux", Arch: "arm64" }) };
    if (args[0] === "image") return { code: 0, stdout: JSON.stringify({ digests: failure === "image" ? [] : [remote.image], arch: "amd64", os: "linux" }) };
    if (args[0] === "run" && !args.includes("--detach")) return { code: failure === "probe" ? 1 : 0, stdout: JSON.stringify({ marker: "AHUB_REMOTE_READY", arch: failure === "arch" ? "arm64" : "x64", platform: "linux" }) };
    if (args[0] === "run") active = args[args.indexOf("--name") + 1]!;
    if (args[0] === "cp") archive = Buffer.from(await new Response(opt!.input).arrayBuffer());
    if (args[0] === "rm" && failure !== "cleanup" && args[1] === active) active = "";
    if (args[0] === "ps") return { code: 0, stdout: active ? JSON.stringify({ Names: active, Labels: "agenthub.project=fixture" }) : "" };
    if (args[0] === "exec") { opt?.output?.(Buffer.from(`public output ${remote.host} ${remote.root} split ${remote.host.split("@").join(" ")}\n`)); return { code: 0, stdout: "" }; }
    return { code: 0, stdout: "" };
  };
  const runner = new RemoteRunner({ projectDir: project, stateDir: join(root, "state"), storageDir: join(root, "storage"), projectKey: "fixture", enabled: true, remote, isDenied: path => path === "denied.txt", signature: () => "fixture-signature", command, ...options });
  cleanup.push(() => runner.stopAll());
  return { root, project, git, runner, calls, command, archive: () => archive, request: { task: 1, owner: "pi", generation: 2, updated: 3, ref: "HEAD", check: "test" as const, files: ["test/nested/example.test.ts"] } };
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
    const listing = spawnSync("tar", ["-tvf", "-"], { input: archive, encoding: "utf8" });
    expect(listing.status).toBe(0); expect(listing.stdout).toMatch(/-rw-r--r--.*example\.test\.ts/); expect(listing.stdout).toMatch(/-rwxr-xr-x.*executable\.sh/);
    for (const line of listing.stdout.split("\n").filter(line => line.startsWith("d"))) expect(line.slice(0, 10)).toBe("drwxr-xr-x");
    expect(archive.includes(Buffer.from("exact commit"))).toBe(true); expect(archive.includes(Buffer.from("dirty-working-tree"))).toBe(false);
    expect(listing.stdout).not.toContain("node_modules"); expect(archive.includes(Buffer.from("DO_NOT_COPY_MAC_DEPS"))).toBe(false); expect(listing.stdout).not.toContain("denied.txt");
    expect(f.calls.find(args => args[0] === "cp")?.slice(0, 2)).toEqual(["cp", "-"]);
    expect(JSON.stringify(result)).not.toContain(remote.host); expect(JSON.stringify(result)).not.toContain(remote.root); expect(result.tail).toContain("public output"); for (const part of remote.host.split("@")) expect(result.tail).not.toContain(part); expect(result.output_withheld).toBe(true);
    const output = await readFile(join(f.root, "storage/fixture", result.run, "output.log"), "utf8"); expect(output).not.toContain(remote.host); expect(output).not.toContain(remote.root);
    expect(f.calls.some(args => args.includes("install"))).toBe(false);
  } finally { process.umask(previous); }
});

test("remote run carries hardened fixed Docker arguments and only a read-only named dependency placeholder", async () => {
  const f = await fixture(); await f.runner.start(f.request).done;
  const args = f.calls.find(args => args[0] === "run" && args.includes("--detach"))!;
  for (const [flag, value] of [["--network", "none"], ["--user", "65532:65532"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"], ["--cpus", "4"], ["--memory", "4g"], ["--pids-limit", "64"]]) expect(args[args.indexOf(flag!) + 1]).toBe(value!);
  expect(args).toContain("--read-only"); expect(args).toContain(remote.image);
  expect(args.filter((_, index) => args[index - 1] === "--tmpfs")).toEqual(expect.arrayContaining([expect.stringContaining("/work:"), expect.stringContaining("/home/check:"), expect.stringContaining("/tmp:")]));
  expect(args[args.indexOf("--mount") + 1]).toBe("type=volume,src=agenthub-check-deps-unprepared-fixture,dst=/work/node_modules,readonly");
  expect(args.some(arg => arg.startsWith("type=bind") || arg.includes(remote.root) || arg.includes(f.project))).toBe(false);
  expect(f.calls.find(args => args[0] === "exec")?.slice(-3)).toEqual(["bun", "test", "test/nested/example.test.ts"]);
});

for (const failure of ["ssh", "docker", "image", "probe", "arch"]) test(`remote readiness ${failure} failure is generic and never falls back`, async () => {
  const f = await fixture({}, failure);
  expect(await f.runner.available()).toMatchObject({ available: false, reason: "remote runner unavailable" });
  expect((await f.runner.start(f.request).done).error).toBe("remote runner unavailable");
  expect(f.calls.some(args => args[0] === "--version" || args[0] === "system" || args.includes("--detach"))).toBe(false);
});

test("remote cleanup uncertainty retains the common heavy lease and refuses a passing receipt", async () => {
  const f = await fixture({}, "cleanup"), result = await f.runner.start(f.request).done;
  expect(result.exit).toBeNull(); expect(result.error).toContain("cleanup unconfirmed");
  expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock/owner")).exists()).toBe(true);
  expect(f.calls.some(args => args[0] === "ps" && args.includes("--all"))).toBe(true);
});

test("remote SSH arguments quote shell metacharacters and reject unsafe machine-local config tokens", () => {
  const word = "test/a'file;echo BAD.test.ts", argv = remoteDockerArgs(remote.host, ["exec", "container", "bun", "test", word]);
  expect(argv.slice(0, 8)).toEqual(["-T", "-a", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", remote.host]);
  const roundtrip = spawnSync("sh", ["-c", `set -- ${argv.at(-1)!.replace(/ 2>&1$/, "")}; printf '%s\\n' "$@"`], { encoding: "utf8" });
  expect(roundtrip.status).toBe(0); expect(roundtrip.stdout.trim().split("\n")).toEqual(["docker", "exec", "container", "bun", "test", word]);
  for (const update of [{ host: "-oProxyCommand=bad" }, { host: "host;bad" }, { root: "/tmp/../bad" }, { root: "/tmp/$(bad)" }, { image: "mutable:latest" }, { extra: "bad" }]) expect(() => remoteRunnerConfig({ ...remote, ...update })).toThrow("invalid remote runner configuration");
});

test("real SSH transport boundary with a fake executable drops exit-255 output and all SSH stderr", async () => {
  const f = await fixture(), bin = join(f.root, "fake-bin"); await mkdir(bin);
  const agentSocket = join(f.root, "synthetic-agent.sock"), proof = join(f.root, "ssh-proof"), keys = join(f.root, "ssh-env-keys");
  const script = `#!/bin/sh
printf '%s\\n' "$1 $2" >> '${proof}'
if [ "$SSH_AUTH_SOCK" = '${agentSocket}' ]; then printf '%s\\n' 'auth-retained' >> '${proof}'; else printf '%s\\n' 'auth-missing' >> '${proof}'; fi
/usr/bin/env | while IFS='=' read -r key value; do printf '%s\\n' "$key"; done >> '${keys}'
last=''
for arg in "$@"; do last="$arg"; done
case "$last" in
  "docker 'version' "*) printf '%s\\n' '{"Version":"27.4.1-private-host","Os":"linux","Arch":"arm64"}' ;;
  "docker 'image' "*) printf '%s\\n' '{"digests":["${remote.image}"],"arch":"amd64","os":"linux"}' ;;
  "docker 'run' '--rm' "*) printf '%s\\n' '{"marker":"AHUB_REMOTE_READY","arch":"x64","platform":"linux"}' ;;
  "docker 'cp' "*) /bin/cat >/dev/null ;;
  "docker 'exec' "*) printf '%s\\n' '${remote.host} ${remote.root} transport stdout'; printf '%s\\n' 'SSH_PRIVATE_DIAGNOSTIC' >&2; exit 255 ;;
esac
`;
  await writeFile(join(bin, "ssh"), script, { mode: 0o755 });
  const before = process.env.PATH, previousSocket = process.env.SSH_AUTH_SOCK, previousPeer = process.env.AHUB_REMOTE_PEER_ONLY;
  process.env.PATH = `${bin}:${before ?? "/usr/bin:/bin"}`; process.env.SSH_AUTH_SOCK = agentSocket; process.env.AHUB_REMOTE_PEER_ONLY = "fixture-peer-only";
  cleanup.push(() => {
    if (before === undefined) delete process.env.PATH; else process.env.PATH = before;
    if (previousSocket === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = previousSocket;
    if (previousPeer === undefined) delete process.env.AHUB_REMOTE_PEER_ONLY; else process.env.AHUB_REMOTE_PEER_ONLY = previousPeer;
  });
  const runner = new RemoteRunner({ projectDir: f.project, stateDir: join(f.root, "ssh-state"), storageDir: join(f.root, "ssh-storage"), projectKey: "fixture", enabled: true, remote, isDenied: () => false, signature: () => "fixture-signature" });
  cleanup.push(() => runner.stopAll());
  expect(await runner.available()).toMatchObject({ available: true, platform: "linux/amd64 (remote docker 27.4.1)" });
  const result = await runner.start(f.request).done;
  expect(result).toMatchObject({ exit: null, error: "remote runner unavailable", output_bytes: 0, tail: "" });
  const text = JSON.stringify(result) + await readFile(join(f.root, "ssh-storage/fixture", result.run, "output.log"), "utf8");
  for (const hidden of [remote.host, remote.root, "SSH_PRIVATE_DIAGNOSTIC", "private-host", "transport stdout"]) expect(text).not.toContain(hidden);
  const observations = (await readFile(proof, "utf8")).trim().split("\n");
  expect(observations.length).toBeGreaterThan(0); expect(new Set(observations)).toEqual(new Set(["-T -a", "auth-retained"]));
  const environmentKeys = new Set((await readFile(keys, "utf8")).trim().split("\n"));
  expect(environmentKeys.has("SSH_AUTH_SOCK")).toBe(true); expect(environmentKeys.has("AHUB_REMOTE_PEER_ONLY")).toBe(false);
  for (const key of environmentKeys) expect(["PATH", "HOME", "TMPDIR", "SSH_AUTH_SOCK", "PWD", "SHLVL", "_"]).toContain(key);
});

test("remote cancellation reaps the tar producer and confirms Docker cleanup before releasing its lease", async () => {
  const f = await fixture(); let enter!: () => void; const copying = new Promise<void>(resolve => { enter = resolve; });
  const command: ContainerCommand = async (args, opt) => {
    if (args[0] === "cp") {
      enter(); await new Promise<void>(resolve => { if (opt?.signal?.aborted) resolve(); else opt?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { code: 0, stdout: "late transfer success" };
    }
    return f.command(args, opt);
  };
  const runner = new RemoteRunner({ projectDir: f.project, stateDir: join(f.root, "cancel-state"), storageDir: join(f.root, "cancel-storage"), projectKey: "fixture", remote, enabled: true, isDenied: () => false, signature: () => "fixture", command }); cleanup.push(() => runner.stopAll());
  const handle = runner.start(f.request); await copying; await runner.cancel(handle.run);
  const result = await handle.done;
  expect(result).toMatchObject({ cancelled: true, exit: null, error: "check stopped" });
  expect(f.calls.some(args => args[0] === "exec")).toBe(false);
  expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock")).exists()).toBe(false);
  const rows = processTable(); expect(rows).toBeDefined(); expect(rows!.some(row => row.command.includes(f.root) && /\btar\b/.test(row.command))).toBe(false);
}, 5000);

test("cancelled remote readiness still performs independent bounded probe cleanup", async () => {
  const f = await fixture(); let enter!: () => void; const probing = new Promise<void>(resolve => { enter = resolve; });
  const cleanupSignals: unknown[] = [];
  const command: ContainerCommand = async (args, opt) => {
    if (args[0] === "run" && !args.includes("--detach")) {
      enter(); await new Promise<void>(resolve => { if (opt?.signal?.aborted) resolve(); else opt?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { code: 0, stdout: "late probe success" };
    }
    if (["kill", "rm", "ps"].includes(args[0]!)) cleanupSignals.push(opt?.signal);
    return f.command(args, opt);
  };
  const runner = new RemoteRunner({ projectDir: f.project, stateDir: join(f.root, "probe-state"), storageDir: join(f.root, "probe-storage"), projectKey: "fixture", remote, enabled: true, isDenied: () => false, signature: () => "fixture", command }); cleanup.push(() => runner.stopAll());
  const abort = new AbortController(), state = runner.available(abort.signal); await probing; abort.abort();
  expect((await state).available).toBe(false); expect(cleanupSignals).toEqual([undefined, undefined, undefined]);
});
