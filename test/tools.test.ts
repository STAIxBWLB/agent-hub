import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { profile, proxyEnv, sandboxAvailable, sandboxedExec } from "../src/local/sandbox.ts";
import { startEgressProxy } from "../src/local/proxy.ts";
import { createServer } from "node:net";
import { guardPath, isDenied, runTool, type ToolContext } from "../src/local/tools.ts";

function project(permit = true) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-proj-")));
  writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(cwd, ".env.local"), "SECRET=1\n");
  mkdirSync(join(cwd, ".maru", "secrets"), { recursive: true });
  writeFileSync(join(cwd, ".maru", "secrets", "token"), "t0ken");
  mkdirSync(join(cwd, ".agenthub", "state"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub", "state", "control-token"), "c0ntrol");
  mkdirSync(join(cwd, ".agenthub", "archive", "state-20261009T000000Z"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub", "archive", "state-20261009T000000Z", "hub.db"), "arch1ved");
  const asked: string[] = [];
  const ctx: ToolContext = { cwd, deny: ["private/"], sandboxProfile: profile(cwd, false, [], ["private/"]), permit: async (t) => (asked.push(t), permit), send: (t, to) => `sent ${t} to ${to ?? "*"}` };
  return { cwd, ctx, asked };
}
const call = (ctx: ToolContext, name: string, args: unknown) => runTool(name, JSON.stringify(args), ctx);

test("paths: traversal, absolute outside paths, symlink escapes and denylisted names are refused", () => {
  const { cwd, ctx } = project();
  const outside = mkdtempSync(join(tmpdir(), "agenthub-out-"));
  writeFileSync(join(outside, "x"), "x");
  symlinkSync(outside, join(cwd, "link"));
  expect(guardPath(ctx, "a.txt", "read")).toBe(join(cwd, "a.txt"));
  expect(guardPath(ctx, "new/dir/file.ts", "write")).toBe(join(cwd, "new/dir/file.ts"));
  for (const p of ["../x", "/etc/passwd", "link/x", "link/new-file", join(homedir(), ".ssh/id_rsa")]) {
    expect(() => guardPath(ctx, p, "read")).toThrow(/outside the project/);
  }
  for (const p of [".env.local", ".maru/secrets/token", ".agenthub/state/control-token", ".agenthub/archive/state-20261009T000000Z/hub.db", "certs/server.pem", "deploy.key", "keys/id_ed25519.pub", "private/notes.md"]) {
    expect(() => guardPath(ctx, p, "read")).toThrow(/denylist/);
  }
  for (const p of [".git/hooks/pre-commit", ".agenthub/routing.toml"]) expect(() => guardPath(ctx, p, "write")).toThrow(/not writable/);
  expect(guardPath(ctx, ".agenthub/routing.toml", "read")).toContain("routing.toml");
  expect(isDenied("src/environment.ts")).toBe(false);
});

test("a dangling symlink cannot smuggle a write out of the project or into .git/hooks", async () => {
  const { cwd, ctx } = project();
  mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
  symlinkSync(join(cwd, ".git", "hooks", "pre-commit"), join(cwd, "hook"));
  symlinkSync(join(homedir(), `.agenthub-dangling-${process.pid}`), join(cwd, "out"));
  for (const p of ["hook", "out", "out/nested"]) expect(() => guardPath(ctx, p, "write")).toThrow(/dangling symlink|outside|not writable/);
  expect(await call(ctx, "write", { path: "hook", content: "echo pwned" })).toMatch(/^error: /);
  expect(() => readFileSync(join(cwd, ".git", "hooks", "pre-commit"))).toThrow();
});

test.skipIf(!sandboxAvailable())("git arguments: nothing absolute, nothing with .., nothing denylisted, and local.deny reaches the sandbox too", async () => {
  const { cwd, ctx, asked } = project();
  Bun.spawnSync(["git", "init", "-q"], { cwd });
  mkdirSync(join(cwd, "private"));
  writeFileSync(join(cwd, "private", "customers.csv"), "name,card\n");
  for (const args of [
    ["diff", "--no-index", "/dev/null", join(homedir(), ".cargo/credentials.toml")],
    ["diff", "--", "/etc/passwd"],
    ["show", "HEAD:.env.local"],
    ["show", "HEAD:private/customers.csv"],
    ["log", "-p", "--", "../other"],
    ["diff", "--output=/tmp/x"],
  ]) {
    expect(await call(ctx, "git", { args })).toMatch(/^error: git /);
  }
  expect(asked).toHaveLength(0);
  const out = await call(ctx, "bash", { command: "(cat private/customers.csv 2>/dev/null | grep -q card) && echo READ-CUSTOM-DENY || echo blocked-custom-deny" });
  expect(out).toContain("blocked-custom-deny");
  expect(isDenied("home/.cargo/credentials.toml")).toBe(true);
});

test("read is free; write and edit ask first and do nothing when refused", async () => {
  const { cwd, ctx, asked } = project();
  expect(await call(ctx, "read", { path: "a.txt", offset: 2, limit: 1 })).toBe("2\ttwo");
  expect(asked).toHaveLength(0);
  expect(await call(ctx, "edit", { path: "a.txt", old: "two", new: "2" })).toBe("edited a.txt");
  expect(await call(ctx, "edit", { path: "a.txt", old: "e", new: "E" })).toMatch(/matched 3 times/);
  expect(await call(ctx, "write", { path: "sub/b.txt", content: "hi" })).toBe("wrote sub/b.txt");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n2\nthree\n");
  expect(asked).toEqual(["edit a.txt:\n- two\n+ 2", "write sub/b.txt (2 chars):\nhi"]); // the approver sees what is written

  const denied = project(false);
  expect(await call(denied.ctx, "write", { path: "c.txt", content: "x" })).toMatch(/did not approve/);
  expect(await call(denied.ctx, "bash", { command: "touch c.txt" })).toMatch(/did not approve/);
  expect(() => readFileSync(join(denied.cwd, "c.txt"))).toThrow();
});

test("failures are text for the model, never exceptions", async () => {
  const { ctx } = project();
  expect(await runTool("read", "{not json", ctx)).toMatch(/not valid JSON/);
  expect(await call(ctx, "read", { path: ".env.local" })).toMatch(/^error: .*denylist/);
  expect(await call(ctx, "read", { path: "missing.txt" })).toMatch(/^error: /);
  expect(await call(ctx, "git", { args: ["push", "origin", "main"] })).toMatch(/not available/);
  expect(await call(ctx, "git", { args: ["-c", "core.pager=sh", "log"] })).toMatch(/not available/);
  expect(await call(ctx, "nope", {})).toMatch(/unknown tool/);
  expect(await call(ctx, "hub_send", { text: "[IMPORTANT] done", to: ["claude"] })).toBe("sent [IMPORTANT] done to claude");
});

test.skipIf(!sandboxAvailable())("sandbox: writes stay in the project, credential stores and denylisted files are unreadable, no network, clean env", async () => {
  const { cwd, ctx, asked } = project();
  Bun.spawnSync(["git", "init", "-q"], { cwd }); // so .git/hooks exists and the hook write is a real attempt
  process.env.OMNIROUTE_API_KEY = "sk-must-not-leak";
  const outside = join(homedir(), `.agenthub-sandbox-probe-${process.pid}`);
  const out = await call(ctx, "bash", {
    command: [
      "echo inside > made-by-bash.txt && echo wrote-inside",
      `(echo x > ${outside}) 2>/dev/null && echo WROTE-OUTSIDE || echo blocked-outside`,
      "(ls ~/.ssh >/dev/null 2>&1) && echo READ-SSH || echo blocked-ssh",
      "(cat ~/.claude.json >/dev/null 2>&1) && echo READ-HOME || echo blocked-home",
      "(ls ~/Documents >/dev/null 2>&1) && echo LISTED-HOME || echo blocked-home-listing",
      "(bun --version >/dev/null 2>&1 && git --version >/dev/null 2>&1 && cat a.txt >/dev/null) && echo toolchains-ok || echo TOOLCHAINS-BROKEN",
      "(cat .env.local 2>/dev/null | grep -q SECRET) && echo READ-ENV || echo blocked-env",
      "(cat .agenthub/state/control-token 2>/dev/null | grep -q c0ntrol) && echo READ-TOKEN || echo blocked-token",
      "(cat .agenthub/archive/state-20261009T000000Z/hub.db 2>/dev/null | grep -q arch1ved) && echo READ-ARCHIVE || echo blocked-archive",
      "(echo 'echo pwned' > .git/hooks/pre-commit) 2>/dev/null && echo WROTE-HOOK || echo blocked-hook",
      "(curl -s -m 3 http://example.com >/dev/null 2>&1) && echo NETWORK || echo blocked-network",
      'echo "key=[$OMNIROUTE_API_KEY]"',
    ].join("; "),
  });
  delete process.env.OMNIROUTE_API_KEY;
  for (const expected of ["wrote-inside", "blocked-outside", "blocked-ssh", "blocked-home", "blocked-home-listing", "toolchains-ok", "blocked-env", "blocked-token", "blocked-archive", "blocked-hook", "blocked-network", "key=[]", "(exit 0)"]) {
    expect(out).toContain(expected);
  }
  expect(readFileSync(join(cwd, "made-by-bash.txt"), "utf8")).toBe("inside\n");
  expect(asked[0]).toStartWith("bash: echo inside");
});

test.skipIf(!sandboxAvailable())("a local.deny entry with a quote or a backslash, or a project root with a quote, still makes a profile that denies exactly those paths (issue #23)", async () => {
  const cwd = join(realpathSync(mkdtempSync(join(tmpdir(), "agenthub-quote-"))), 'we"ird');
  const entries = ['q"uoted/', "back\\slash/"];
  mkdirSync(cwd);
  for (const e of entries) {
    mkdirSync(join(cwd, e));
    writeFileSync(join(cwd, e, "secret.txt"), "hidden");
  }
  writeFileSync(join(cwd, "open.txt"), "visible");
  const { output } = await sandboxedExec(["/bin/sh", "-c", `cat open.txt; cat 'q"uoted/secret.txt' 2>/dev/null || echo blocked-quote; cat 'back\\slash/secret.txt' 2>/dev/null || echo blocked-backslash`], { cwd, profile: profile(cwd, false, [], entries) });
  expect(output).toContain("visible");
  expect(output).toContain("blocked-quote");
  expect(output).toContain("blocked-backslash");
  expect(output).not.toContain("hidden");
});

test("guardPath in a project whose path has a backslash: inside reads pass, escapes are still refused (issue #26)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-bs-")));
  const cwd = join(base, "back\\slash");
  mkdirSync(join(cwd, "sub"), { recursive: true });
  writeFileSync(join(cwd, "a.txt"), "x");
  symlinkSync(base, join(cwd, "out\\link"));
  symlinkSync(join(cwd, "sub"), join(cwd, "in\\link"));
  symlinkSync(join(cwd, "gone"), join(cwd, "dang\\ling"));
  const ctx = { cwd, deny: [] };
  expect(guardPath(ctx, "a.txt", "read")).toBe(join(cwd, "a.txt"));
  expect(guardPath(ctx, "in\\link/new.txt", "write")).toBe(join(cwd, "sub", "new.txt"));
  expect(() => guardPath(ctx, "../x", "read")).toThrow(/outside the project/);
  expect(() => guardPath(ctx, "out\\link/x", "read")).toThrow(/outside the project/);
  expect(() => guardPath(ctx, "dang\\ling", "write")).toThrow(/dangling symlink/);
  // Names are checked as stored on disk: another spelling the file system opens as .git/config or .env is refused too.
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".git", "config"), "x");
  writeFileSync(join(cwd, ".env"), "x");
  writeFileSync(join(cwd, "id_rsa"), "x");
  for (const [asked, mode] of [[".GIT/config", "write"], [".ENV", "read"], ["id_rſa" /* long s, U+017F */, "read"]] as const) {
    if (existsSync(join(cwd, asked))) expect(() => guardPath(ctx, asked, mode)).toThrow(/denylist|not writable/);
  }
});

test.skipIf(!sandboxAvailable())("the local worker's sandbox builds and works in a project whose path has a backslash (issue #26)", async () => {
  const cwd = join(realpathSync(mkdtempSync(join(tmpdir(), "agenthub-bs-"))), "back\\slash");
  mkdirSync(join(cwd, "private"), { recursive: true });
  writeFileSync(join(cwd, "open.txt"), "visible");
  writeFileSync(join(cwd, "private", "secret.txt"), "hidden");
  const { output } = await sandboxedExec(["/bin/sh", "-c", "cat open.txt; cat private/secret.txt 2>/dev/null || echo blocked-deny; echo made > new.txt && echo wrote-inside"], { cwd, profile: profile(cwd, false, [], ["private/"]) });
  expect(output).toContain("visible");
  expect(output).toContain("blocked-deny");
  expect(output).toContain("wrote-inside");
  expect(output).not.toContain("hidden");
});

test.skipIf(!sandboxAvailable())("git: read-only subcommands run without asking, mutating ones ask, timeouts kill", async () => {
  const { cwd, ctx, asked } = project();
  Bun.spawnSync(["git", "init", "-q"], { cwd });
  expect(await call(ctx, "git", { args: ["status", "--short"] })).toContain("a.txt");
  expect(asked).toHaveLength(0);
  expect(await call(ctx, "git", { args: ["add", "a.txt"] })).toContain("(exit 0)");
  expect(asked).toEqual(["git add a.txt"]);
  const slow = await sandboxedExec(["/bin/sleep", "5"], { cwd, profile: ctx.sandboxProfile, timeoutMs: 200 });
  expect(slow.output).toContain("killed");
  // grandchildren holding the pipe must not keep the call waiting past its timeout
  const t0 = Date.now();
  const tree = await sandboxedExec(["/bin/bash", "-c", "(sleep 30 &) ; sleep 30"], { cwd, profile: ctx.sandboxProfile, timeoutMs: 300 });
  expect(tree.output).toContain("killed");
  expect(Date.now() - t0).toBeLessThan(5000);
});

test.skipIf(!sandboxAvailable())("elapsed cancellation kills an active sandboxed command", async () => {
  const { cwd, ctx } = project();
  const controller = new AbortController();
  const started = Date.now();
  const running = sandboxedExec(["/bin/sleep", "30"], { cwd, profile: ctx.sandboxProfile, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await running;
  expect(result.output).toContain("killed");
  expect(Date.now() - started).toBeLessThan(5000);
});

// issue #39: the deny-default profile still runs the toolchains; outside the listed dirs nothing is readable.
test.skipIf(!sandboxAvailable())("deny-default: bun, node and git work; outside the system, toolchain and project dirs nothing is readable", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-denydefault-")));
  writeFileSync(join(cwd, "a.test.ts"), 'import { expect, test } from "bun:test";\ntest("t", () => expect(1).toBe(1));\n');
  Bun.spawnSync(["git", "init", "-q"], { cwd }); // outside: init writes .git/hooks, which the sandbox denies
  // A node installed elsewhere in home (the CI runner's tool cache) is outside the listed toolchain dirs: that is what
  // local.read_allow is for. Its install prefix goes there, as a user would put it.
  const node = realpathSync(Bun.which("node")!);
  const readAllow = node.startsWith(`${homedir()}/`) ? [dirname(dirname(node))] : [];
  const run = (command: string) => sandboxedExec(["/bin/sh", "-c", command], { cwd, profile: profile(cwd, false, readAllow, []) });
  const tools = await run([
    "node -e 'console.log(\"node-ok\")'",
    "bun -e 'console.log(\"bun-ok\")'",
    "bun test a.test.ts >/dev/null 2>&1 && echo bun-test-ok",
    "git add a.test.ts && git -c user.name=t -c user.email=t@localhost -c commit.gpgsign=false commit -q -m x && git log --oneline | wc -l | tr -d ' ' && echo git-ok",
  ].join("; "));
  for (const expected of ["node-ok", "bun-ok", "bun-test-ok", "git-ok"]) expect(tools.output).toContain(expected);
  const probe = "(ls /private/var/log >/dev/null 2>&1) && echo READ-VAR-LOG || echo blocked-var-log";
  expect(Bun.spawnSync(["/bin/sh", "-c", probe]).stdout.toString()).toContain("READ-VAR-LOG"); // readable outside, so the block is the profile's
  expect((await run(probe)).output).toContain("blocked-var-log");
});

test("no mach broker that acts outside the sandbox: LaunchServices (open starts apps), SecurityServer (Keychain)", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-brokers-")));
  for (const network of [false, true]) {
    const p = profile(cwd, network);
    for (const broker of ["coreservicesd", "launchservicesd", "SecurityServer"]) expect(p).not.toContain(broker);
  }
});

test.skipIf(!sandboxAvailable())("network on: the public CA bundle is readable despite the .pem deny, a key in the project is not", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-cabundle-")));
  writeFileSync(join(cwd, "id.pem"), "-----BEGIN PRIVATE KEY-----\n");
  const read = async (path: string, network: boolean) => (await sandboxedExec(["/bin/sh", "-c", `head -c 5 '${path}' >/dev/null 2>&1 && echo READ || echo blocked`], { cwd, profile: profile(cwd, network) })).output.trim();
  expect(await read("/etc/ssl/cert.pem", true)).toBe("READ"); // TLS for curl, git and python3 needs it
  expect(await read("/etc/ssl/cert.pem", false)).toBe("blocked");
  expect(await read(join(cwd, "id.pem"), true)).toBe("blocked");
});

test.skipIf(!sandboxAvailable())("the selected developer dir is in the profile, so the /usr/bin shims can run what it holds", () => {
  const selected = Bun.spawnSync(["xcode-select", "-p"], { stdout: "pipe" }).stdout.toString().trim();
  const dev = selected && existsSync(selected) ? realpathSync(selected) : "";
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-devdir-")));
  // for an Xcode app, its whole Contents: the tools load SharedFrameworks next to Developer
  const app = /^(.*\.app\/Contents)\/Developer\/?$/.exec(dev)?.[1];
  if (dev) expect(profile(cwd, false)).toContain(`(subpath "${app ?? dev}")`);
});

// Apple's python3 is an xcrun shim: with a full Xcode selected it loads Xcode's SharedFrameworks (issue #63, macOS CI).
// Its first run can take seconds, hence a test of its own with room for that.
test.skipIf(!sandboxAvailable() || Bun.spawnSync(["/usr/bin/python3", "-c", "pass"]).exitCode !== 0)("deny-default: Apple's python3 runs and takes the command's own temp dir", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-python3-")));
  const py = (await sandboxedExec(["/bin/sh", "-c", `echo "own=$TMPDIR"; /usr/bin/python3 -c 'import tempfile; print("py=" + tempfile.gettempdir())'`], { cwd, profile: profile(cwd, false) })).output;
  expect(py).toContain(`py=${py.match(/own=(\S+)/)![1]!.replace(/\/$/, "")}`);
}, 30_000);

// issue #64: Python's own CA bundle (certifi, also vendored by pip) is readable with network on, like the system's.
test.skipIf(!sandboxAvailable())("network on: a certifi cacert.pem is readable, other .pem files are not", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-certifi-")));
  const bundle = join(cwd, ".venv", "lib", "python3.12", "site-packages", "certifi");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "cacert.pem"), "-----BEGIN CERTIFICATE-----\n");
  writeFileSync(join(bundle, "key.pem"), "-----BEGIN PRIVATE KEY-----\n");
  const read = async (path: string, network: boolean) => (await sandboxedExec(["/bin/sh", "-c", `head -c 5 '${path}' >/dev/null 2>&1 && echo READ || echo blocked`], { cwd, profile: profile(cwd, network) })).output.trim();
  expect(await read(join(bundle, "cacert.pem"), true)).toBe("READ");
  expect(await read(join(bundle, "cacert.pem"), false)).toBe("blocked");
  expect(await read(join(bundle, "key.pem"), true)).toBe("blocked");
  // a certifi/cacert.pem inside a denied place stays denied: the allow overrides only the .pem name rule
  const state = join(cwd, ".agenthub", "state", "certifi");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "cacert.pem"), "secret\n");
  expect(await read(join(state, "cacert.pem"), true)).toBe("blocked");
});

// issue #63: each command gets a temp dir of its own; the shared ones are closed under deny-default.
test.skipIf(!sandboxAvailable())("a command cannot read what other processes left in the shared temp dirs, and its own temp dir goes when it ends", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-owntmp-")));
  const shared = join(tmpdir(), `agenthub-left-${process.pid}.txt`);
  const tmp = `/private/tmp/agenthub-left-${process.pid}.txt`;
  writeFileSync(shared, "LEFT_BY_ANOTHER_TOOL");
  writeFileSync(tmp, "LEFT_IN_PRIVATE_TMP");
  try {
    const run = (command: string, timeoutMs?: number) => sandboxedExec(["/bin/sh", "-c", command], { cwd, profile: profile(cwd, false), ...(timeoutMs ? { timeoutMs } : {}) });
    const out = (await run(`cat '${shared}' '${tmp}' 2>&1; echo "own=$TMPDIR"; echo hi > "$TMPDIR/x" && cat "$TMPDIR/x"`)).output;
    expect(out).not.toContain("LEFT_BY_ANOTHER_TOOL");
    expect(out).not.toContain("LEFT_IN_PRIVATE_TMP");
    expect(out).toContain("hi"); // its own temp dir works
    const own = out.match(/own=(\S+)/)![1]!;
    expect(own).not.toBe(`${realpathSync(tmpdir())}/`);
    expect(existsSync(own)).toBe(false); // removed when the command ended
    const slow = (await run(`echo "own=$TMPDIR"; sleep 5`, 300)).output;
    expect(existsSync(slow.match(/own=(\S+)/)![1]!)).toBe(false); // also after a timeout
    const locked = (await run(`echo "own=$TMPDIR"; touch "$TMPDIR/locked" && chflags uchg "$TMPDIR/locked" && echo LOCKED`)).output;
    expect(locked).toContain("LOCKED"); // the command could make a file the plain remove cannot delete
    expect(existsSync(locked.match(/own=(\S+)/)![1]!)).toBe(false); // and the command still ended, its temp dir gone
  } finally {
    rmSync(shared, { force: true });
    rmSync(tmp, { force: true });
  }
});

// issue #65: with network on, the only way out is the hub's egress proxy; a direct connection, or one to another
// loopback port (where claude-mem and the Codex app-server listen), is denied by the profile.
test.skipIf(!sandboxAvailable())("network through the proxy: an allowed target only via the proxy; direct and other loopback ports denied", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-egress-")));
  const listen = () => new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = createServer((c) => c.on("data", (d) => c.write(d)));
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }));
  });
  const [target, other] = [await listen(), await listen()];
  const proxy = await startEgressProxy({ allow: [`127.0.0.1:${target.port}`], log: () => {} });
  try {
    const network = { proxyPort: proxy.port };
    const run = async (command: string) => (await sandboxedExec(["/bin/sh", "-c", command], { cwd, profile: profile(cwd, network), env: proxyEnv(network) })).output.trim();
    // macOS nc quits when its stdin ends, so stdin stays open for the echo to come back
    expect(await run(`(printf ping; sleep 1) | /usr/bin/nc -w 2 -X connect -x 127.0.0.1:${proxy.port} 127.0.0.1 ${target.port}`)).toBe("ping");
    expect(await run(`printf ping | /usr/bin/nc -w 2 127.0.0.1 ${target.port} 2>/dev/null; echo "exit=$?"`)).toBe("exit=1");
    expect(await run(`printf ping | /usr/bin/nc -w 2 127.0.0.1 ${other.port} 2>/dev/null; echo "exit=$?"`)).toBe("exit=1");
    expect(await run(`echo "$HTTPS_PROXY $NO_PROXY."`)).toBe(`${proxy.url} .`);
  } finally {
    await proxy.close();
    target.close();
    other.close();
  }
});


test("an edit awaiting approval preserves another peer's unrelated edit", async () => {
  const { cwd, ctx } = project();
  let release!: (allowed: boolean) => void;
  ctx.permit = () => new Promise<boolean>((resolve) => release = resolve);
  const pending = call(ctx, "edit", { path: "a.txt", old: "two", new: "2" });
  writeFileSync(join(cwd, "a.txt"), "ONE\ntwo\nthree\n");
  release(true);
  expect(await pending).toBe("edited a.txt");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("ONE\n2\nthree\n");
});

test("an edit awaiting approval refuses a fragment another peer already changed", async () => {
  const { cwd, ctx } = project();
  ctx.permit = async () => { writeFileSync(join(cwd, "a.txt"), "one\nOTHER\nthree\n"); return true; };
  expect(await call(ctx, "edit", { path: "a.txt", old: "two", new: "2" })).toContain("file changed during approval");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\nOTHER\nthree\n");
});

for (const tool of ["write", "edit"]) test(`${tool} rechecks a path replaced with an escaping symlink during approval`, async () => {
  const { cwd, ctx } = project();
  const outside = mkdtempSync(join(tmpdir(), "agenthub-approval-outside-"));
  const target = join(outside, "outside.txt"); writeFileSync(target, "OUTSIDE\n");
  ctx.permit = async () => { unlinkSync(join(cwd, "a.txt")); symlinkSync(target, join(cwd, "a.txt")); return true; };
  expect(await call(ctx, tool, { path: "a.txt", content: "overwrite", old: "two", new: "2" })).toMatch(/^error: .*outside the project/);
  expect(readFileSync(target, "utf8")).toBe("OUTSIDE\n");
});

for (const tool of ["write", "edit"]) test(`${tool} refuses a canonical target retargeted into native agent config after approval`, async () => {
  const { cwd, ctx } = project();
  const ordinary = join(cwd, "ordinary"), protectedDir = join(cwd, ".claude"), alias = join(cwd, "editable-alias");
  mkdirSync(ordinary); mkdirSync(protectedDir);
  const original = join(ordinary, "policy.json"), protectedFile = join(protectedDir, "policy.json");
  writeFileSync(original, "before"); writeFileSync(protectedFile, "before"); symlinkSync(ordinary, alias);
  ctx.permit = async (_title, name, _signal, target) => {
    expect(name).toBe(tool); expect(target).toBe(guardPath(ctx, "ordinary/policy.json", "write"));
    unlinkSync(alias); symlinkSync(protectedDir, alias); return true;
  };
  expect(await call(ctx, tool, { path: "editable-alias/policy.json", content: "after", old: "before", new: "after" })).toContain("path target changed during approval");
  expect(readFileSync(original, "utf8")).toBe("before"); expect(readFileSync(protectedFile, "utf8")).toBe("before");
});
