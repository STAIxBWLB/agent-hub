import { afterEach, expect, spyOn, test } from "bun:test";
import { createServer, request } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHostShellWrapper, type ShellGrant } from "../src/hub/claude-shell-wrapper.ts";
import { parseSimpleShell } from "../src/hub/read-only-shell.ts";
import { readProcessTable } from "../src/hub/child-process.ts";
import { realPath } from "../src/hub/project.ts";
import { shellQuote } from "../src/cli/shell-quote.ts";
import { profile, sandboxAvailable, sandboxedExec } from "../src/local/sandbox.ts";
import { proveReadOnlyShell } from "../src/hub/read-only-shell-proof.ts";
import { hostShellEnvironment } from "../src/local/shell-environment.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-shell-test-"))), wrapper = await createHostShellWrapper();
  cleanup.push(() => rmSync(root, { recursive: true, force: true })); cleanup.push(() => wrapper.close());
  const grant = (code = 'process.stdout.write("ok")', fields: Partial<ShellGrant> = {}): ShellGrant => ({
    peer: "claude-impl", task: 513, generation: "1:fixture", root, branch: "feat/wrapper", executable: process.execPath,
    argv: ["-e", code], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, LANG: "C", TERM: "dumb", LC_ALL: "C", TZ: "UTC" },
    signal: new AbortController().signal, timeoutMs: 5000, current: () => true, ...fields,
  });
  return { root, wrapper, grant };
}
function address(command: string) { const words = parseSimpleShell(command)!.words; return { socket: words.at(-2)!, ticket: words.at(-1)! }; }
function invoke(command: string, extra: Record<string, string> = {}, cwd?: string) {
  return Bun.spawn(["/bin/sh", "-c", command], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}
async function collect(child: ReturnType<typeof invoke>) {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]);
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}
async function raw(command: string, headers: Record<string, string> = {}, extra: object = {}, path = "/execute", method = "POST") {
  const { socket, ticket } = address(command), body = JSON.stringify({ ticket, ...extra });
  return new Promise<{ status: number; text: string }>((resolveReply, reject) => {
    const call = request({ socketPath: socket, path, method, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close", ...headers } }, response => {
      let text = ""; response.on("data", chunk => { text += String(chunk); }); response.once("end", () => resolveReply({ status: response.statusCode!, text }));
    });
    call.once("error", reject); call.end(body);
  });
}
async function until(condition: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 4000;
  while (!await condition() && Date.now() < end) await Bun.sleep(10);
  expect(await condition(), label).toBe(true);
}

test("wrapper preserves exact fd bytes and target status; command contains no grant payload", async () => {
  const f = await fixture(), secret = "fixture-secret-never-in-command";
  const issued = f.wrapper.issue(f.grant('process.stdout.write(Buffer.from([0,255,10]));process.stderr.write("err\\n");process.exit(23)', { env: { ...f.grant().env, VALUE: secret } }))!;
  expect(issued.command).not.toContain(secret); expect(issued.command).not.toContain("process.stdout"); expect(issued.command).not.toContain(f.root);
  const { socket } = address(issued.command);
  expect(statSync(dirname(socket)).mode & 0o777).toBe(0o700); expect(statSync(socket).mode & 0o777).toBe(0o600);
  const result = await collect(invoke(issued.command));
  expect(result.code).toBe(23); expect(result.stdout).toEqual(Buffer.from([0, 255, 10])); expect(result.stderr.toString()).toBe("err\n");
}, 10_000);

test("output larger than individual frames remains complete on both file descriptors", async () => {
  const f = await fixture(), issued = f.wrapper.issue(f.grant('process.stdout.write("o".repeat(300000));process.stderr.write("e".repeat(200000));'))!;
  const result = await collect(invoke(issued.command));
  expect(result.code).toBe(0); expect(result.stdout).toEqual(Buffer.alloc(300000, "o")); expect(result.stderr).toEqual(Buffer.alloc(200000, "e"));
}, 10_000);

test("host supervisor neither injects nor filters PWD SHLVL or underscore from the supplied target env", async () => {
  const f = await fixture();
  const variants: Record<string, string>[] = [{}, { PWD: "supplied-pwd", SHLVL: "17", _: "supplied-underscore" }];
  for (const extra of variants) {
    const env = { ...f.grant().env, ...extra }, issued = f.wrapper.issue(f.grant("", { executable: "/usr/bin/env", argv: [], env }))!;
    const result = await collect(invoke(issued.command));
    expect(result.code).toBe(0); expect(result.stderr.length).toBe(0);
    const actual = Object.fromEntries(result.stdout.toString().trim().split("\n").map(line => { const equal = line.indexOf("="); return [line.slice(0, equal), line.slice(equal + 1)]; }));
    expect(actual.TMPDIR).toBeDefined();
    expect(actual).toEqual({ ...env, TMPDIR: actual.TMPDIR! });
    for (const key of ["PWD", "SHLVL", "_"]) expect(Object.hasOwn(actual, key)).toBe(Object.hasOwn(env, key));
  }
}, 10_000);

test("helper startup ignores malicious native cwd and home Bun config and dotenv files", async () => {
  const f = await fixture(), native = join(f.root, "native"), home = join(f.root, "native-home"), marker = join(f.root, "native-preload");
  mkdirSync(native); mkdirSync(home);
  const preload = join(native, "preload.ts"); writeFileSync(preload, `await Bun.write(${JSON.stringify(marker)},"must-not-load");throw new Error("native-preload");`);
  const config = `preload = [${JSON.stringify(preload)}]\n`;
  writeFileSync(join(native, "bunfig.toml"), config); writeFileSync(join(home, ".bunfig.toml"), config);
  writeFileSync(join(native, ".env"), "NATIVE_DOTENV=must-not-load\n");
  const issued = f.wrapper.issue(f.grant('process.stdout.write(process.env.NATIVE_DOTENV??"ok")'))!;
  const result = await collect(invoke(issued.command, { HOME: home }, native));
  expect(result.code).toBe(0); expect(result.stdout.toString()).toBe("ok"); expect(result.stderr.length).toBe(0); expect(existsSync(marker)).toBe(false);
}, 10_000);

test("target uses host cwd and frozen env, preserves supplied Bun guard and owns private TMPDIR", async () => {
  const f = await fixture(), root = join(f.root, "space and ' quote");
  mkdirSync(root);
  const guard = join(f.root, "guard.ts"); writeFileSync(guard, 'process.env.FIXTURE_GUARD="loaded";');
  const issued = f.wrapper.issue(f.grant('process.stdout.write(JSON.stringify({cwd:process.cwd(),rg:process.env.RIPGREP_CONFIG_PATH,git:process.env.GIT_DIR,guard:process.env.FIXTURE_GUARD,tmp:process.env.TMPDIR}))', {
    root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.root, TMPDIR: "/native-poison", BUN_OPTIONS: `--preload=${guard}` },
  }))!;
  const result = await collect(invoke(issued.command, { RIPGREP_CONFIG_PATH: "/native-config", GIT_DIR: "/native-git", TMPDIR: "/native-poison", BUN_OPTIONS: "--preload=/native-poison.ts" }));
  expect(result.code).toBe(0); expect(result.stderr.length).toBe(0);
  const value = JSON.parse(result.stdout.toString());
  expect(value.cwd).toBe(realPath(root)); expect(value.rg).toBeUndefined(); expect(value.git).toBeUndefined(); expect(value.guard).toBe("loaded");
  expect(value.tmp).not.toBe("/native-poison"); expect(value.tmp.endsWith("/")).toBe(true); expect(existsSync(value.tmp)).toBe(false);
}, 10_000);

test("tickets are single-use under concurrent redemption and unavailable after expiry/current refusal", async () => {
  const f = await fixture(), issued = f.wrapper.issue(f.grant('process.stdout.write("once")'))!;
  const replies = await Promise.all([collect(invoke(issued.command)), collect(invoke(issued.command))]);
  expect(replies.map(r => r.code).sort((a, b) => a - b)).toEqual([0, 125]);
  expect(replies.map(r => r.stdout.toString()).sort()).toEqual(["", "once"]);
  let current = true; const stale = f.wrapper.issue(f.grant('process.stdout.write("must-not-run")', { current: () => current }))!;
  current = false; expect((await raw(stale.command)).status).toBe(403);
  current = true; expect((await raw(stale.command)).status).toBe(403);
  const clock = spyOn(Date, "now");
  try {
    clock.mockReturnValue(1000); const expired = f.wrapper.issue(f.grant())!;
    clock.mockReturnValue(31_001); expect((await raw(expired.command)).status).toBe(403);
  } finally { clock.mockRestore(); }
}, 10_000);

test("mutation of issued root, branch, argv, env or executable refuses without echo or effects", async () => {
  const f = await fixture(), marker = join(f.root, "effect");
  for (const field of ["root", "branch", "argv", "env", "executable", "task", "generation"] as const) {
    const grant = f.grant(`await Bun.write(${JSON.stringify(marker)},"effect")`), issued = f.wrapper.issue(grant)!;
    if (field === "root") grant.root = dirname(f.root);
    if (field === "branch") grant.branch = "other";
    if (field === "argv") (grant.argv as string[])[1] = 'process.stdout.write("mutated-secret")';
    if (field === "env") grant.env = { ...grant.env, PRIVATE: "mutated-secret" };
    if (field === "executable") grant.executable = "/invalid/mutated-secret";
    if (field === "task") grant.task = 999;
    if (field === "generation") grant.generation = "other:child";
    const answer = await raw(issued.command);
    expect(answer.status, field).toBe(403); expect(answer.text, field).toBe("host shell execution refused\n"); expect(existsSync(marker), field).toBe(false);
  }
  expect(f.wrapper.issue(f.grant("", { root: "/" }))).toBeUndefined();
  expect(f.wrapper.issue(f.grant("", { root: resolve(import.meta.dir, "..") }))).toBeUndefined();
  expect(f.wrapper.issue(f.grant("", { executable: "/not-present" }))).toBeUndefined();
}, 10_000);

test("replacement of the granted root directory at the same spelling refuses before execution", async () => {
  const f = await fixture(), moved = `${f.root}-moved`, marker = join(f.root, "must-not-exist");
  const issued = f.wrapper.issue(f.grant(`await Bun.write(${JSON.stringify(marker)},"effect")`))!;
  renameSync(f.root, moved); mkdirSync(f.root); cleanup.push(() => rmSync(moved, { recursive: true, force: true }));
  const answer = await raw(issued.command);
  expect(answer.status).toBe(403); expect(answer.text).toBe("host shell execution refused\n");
  expect(existsSync(marker)).toBe(false); expect(existsSync(join(moved, "must-not-exist"))).toBe(false);
});

test("changed executable metadata and closed request schema cannot start a target", async () => {
  const f = await fixture(), executable = join(f.root, "program"); writeFileSync(executable, "#!/bin/sh\nprintf old"); chmodSync(executable, 0o700);
  const issued = f.wrapper.issue(f.grant("", { executable, argv: [] }))!;
  writeFileSync(executable, "#!/bin/sh\nprintf changed-program");
  expect((await raw(issued.command)).status).toBe(403);
  for (const [headers, extra, path, method] of [[{ origin: "" }, {}, "/execute", "POST"], [{}, {}, "/other", "POST"], [{}, {}, "/execute?extra=1", "POST"], [{}, {}, "/execute", "GET"], [{}, { command: "ignored-secret" }, "/execute", "POST"]] as const) {
    const command = f.wrapper.issue(f.grant('process.stdout.write("must-not-run")'))!;
    const answer = await raw(command.command, headers, extra, path, method);
    expect(answer.status).toBe(403); expect(answer.text).toBe("host shell execution refused\n");
  }
});

test("ticket quotas bound global and per-peer outstanding capabilities", async () => {
  const f = await fixture();
  for (let peer = 0; peer < 8; peer++) {
    for (let ticket = 0; ticket < 8; ticket++) expect(f.wrapper.issue(f.grant("", { peer: `peer-${peer}` }))).toBeDefined();
    expect(f.wrapper.issue(f.grant("", { peer: `peer-${peer}` }))).toBeUndefined();
  }
  expect(f.wrapper.issue(f.grant("", { peer: "extra-peer" }))).toBeUndefined();
});

test("abort and wrapper shutdown stop owned commands while silent output still heartbeats", async () => {
  for (const operation of ["abort", "close"] as const) {
    const f = await fixture(), controller = new AbortController(), marker = join(f.root, "pid"); let beats = 0;
    const issued = f.wrapper.issue(f.grant(`await Bun.write(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`, { signal: controller.signal, activity: () => beats++ }))!;
    const child = invoke(issued.command), result = collect(child);
    await until(() => existsSync(marker) && beats >= 2, "target started and periodic activity observed");
    const pid = Number(readFileSync(marker, "utf8"));
    const before = await readProcessTable(); expect(before).toBeDefined(); const birth = before!.find(row => row.pid === pid); expect(birth).toBeDefined();
    if (operation === "abort") controller.abort(); else await f.wrapper.close();
    expect((await result).code).not.toBe(0);
    await until(async () => { const rows = await readProcessTable(); return !!rows && !rows.some(row => row.pid === birth!.pid && row.started === birth!.started); }, "owned target disappeared");
  }
}, 20_000);

test("leader exit with a background pipe holder settles and reaps the original owned group", async () => {
  const f = await fixture(), marker = join(f.root, "background"); let refusals = 0;
  const script = `/bin/sleep 30 & child=$!; printf '%s\\n' "$child" > ${shellQuote(marker)}; /bin/ps -p "$child" -o lstart= >> ${shellQuote(marker)}; exit 0`;
  const issued = f.wrapper.issue(f.grant("", { executable: "/bin/sh", argv: ["-c", script], timeoutMs: 3000, onRefused: () => { refusals++; } }))!;
  const result = await collect(invoke(issued.command));
  expect(result.code).not.toBe(0); expect(result.stderr.toString()).toContain("host shell execution refused");
  expect(refusals).toBe(0);
  const [pidText, started] = readFileSync(marker, "utf8").trim().split("\n"), pid = Number(pidText);
  const rows = await readProcessTable(); expect(rows).toBeDefined(); expect(rows!.some(row => row.pid === pid && row.started === started!.trim())).toBe(false);
}, 10_000);

test("caller disconnection stops the owned target without requiring service shutdown", async () => {
  const f = await fixture(), marker = join(f.root, "disconnect-pid");
  const issued = f.wrapper.issue(f.grant(`await Bun.write(${JSON.stringify(marker)},String(process.pid));process.stdout.write("ready");setInterval(()=>{},1000)`))!;
  const { socket, ticket } = address(issued.command), body = JSON.stringify({ ticket });
  const response = new Promise<import("node:http").IncomingMessage>((resolveResponse, reject) => {
    const call = request({ socketPath: socket, path: "/execute", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" } }, incoming => { incoming.on("error", () => {}); incoming.pause(); resolveResponse(incoming); });
    call.on("error", reject); call.end(body);
  });
  const incoming = await response;
  await until(() => existsSync(marker), "target started before caller disconnect");
  const pid = Number(readFileSync(marker, "utf8")), rows = await readProcessTable(); expect(rows).toBeDefined();
  const birth = rows!.find(row => row.pid === pid); expect(birth).toBeDefined();
  incoming.destroy();
  await until(async () => { const now = await readProcessTable(); return !!now && !now.some(row => row.pid === birth!.pid && row.started === birth!.started); }, "disconnect reaped target before close");
}, 10_000);

test("target deadline remains active through settlement", async () => {
  const f = await fixture(), marker = join(f.root, "timeout-started"); let refusals = 0;
  const issued = f.wrapper.issue(f.grant(`await Bun.write(${JSON.stringify(marker)},"ready");setInterval(()=>{},1000)`, { timeoutMs: 1000, onRefused: () => { refusals++; } }))!;
  const result = await collect(invoke(issued.command));
  expect(existsSync(marker)).toBe(true); expect(result.code).not.toBe(0); expect(result.stderr.toString()).toContain("host shell execution refused");
  expect(refusals).toBe(0);
}, 10_000);

test("CLI rejects malformed response frames and missing connections with a fixed error", async () => {
  const f = await fixture(), issued = f.wrapper.issue(f.grant())!, words = [...parseSimpleShell(issued.command)!.words];
  for (const payload of ['{"type":"stdout","data":"%%%"}\n', '{"type":"stdout","data":"","secret":"never-echo"}\n', 'x'.repeat(25 * 1024), '{"type":"exit","code":0}\n{"type":"exit","code":0}\n']) {
    const socket = join(dirname(address(issued.command).socket), "invalid"), server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/x-ndjson", connection: "close" }); response.end(payload); });
    await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(socket, resolveListen); });
    try {
      words[words.length - 2] = socket;
      const result = await collect(invoke(words.map(shellQuote).join(" ")));
      expect(result.code).toBe(125); expect(result.stdout.length).toBe(0); expect(result.stderr.toString()).toBe("host shell execution refused\n");
    } finally { await new Promise<void>(resolveClose => server.close(() => resolveClose())); rmSync(socket, { force: true }); }
  }
  words[words.length - 2] = join(f.root, "absent-socket");
  const result = await collect(invoke(words.map(shellQuote).join(" ")));
  expect(result.code).toBe(125); expect(result.stderr.toString()).toBe("host shell execution refused\n");
}, 20_000);

test.skipIf(sandboxAvailable())("sandbox grants refuse without an available Darwin sandbox and never fall back", async () => {
  const f = await fixture(), marker = join(f.root, "must-not-run");
  const issued = f.wrapper.issue(f.grant(`await Bun.write(${JSON.stringify(marker)},"effect")`, { sandbox: { profile: "(version 1)\n(deny default)", readOnlyData: false } }));
  expect(issued).toBeUndefined(); expect(existsSync(marker)).toBe(false);
});

test.skipIf(!sandboxAvailable())("Seatbelt protects recursive secret descendants of an admitted grep directory operand", async () => {
  const f = await fixture(), marker = "fixture-private-marker", env = hostShellEnvironment({ ...f.grant().env, PATH: "/usr/bin:/bin" });
  writeFileSync(join(f.root, ".env"), `${marker}\n`);
  const proof = proveReadOnlyShell({ command: `grep -r ${marker} .` }, { root: f.root, projectRoot: f.root, deny: [], env }, () => true);
  expect(proof).toBeDefined();
  const fields = { executable: proof!.executable, argv: proof!.argv, env };
  const control = f.wrapper.issue(f.grant("", fields))!;
  expect((await collect(invoke(control.command))).stdout.toString()).toContain(marker);
  const confined = f.wrapper.issue(f.grant("", { ...fields, sandbox: { profile: profile(f.root, false, [], [], []), readOnlyData: false } }))!;
  expect(confined).toBeDefined();
  const result = await collect(invoke(confined.command));
  expect(result.stdout.toString()).not.toContain(marker); expect(result.stderr.toString()).not.toContain(marker);
}, 20_000);

test.skipIf(!sandboxAvailable())("sandbox profile and read-only-data mutations refuse and broad data-write profiles are never issued", async () => {
  const f = await fixture(), initial = profile(f.root, false, [], [], []);
  expect(f.wrapper.issue(f.grant("", { executable: "/bin/ls", argv: ["."], sandbox: { profile: initial, readOnlyData: true } }))).toBeUndefined();
  for (const field of ["profile", "readOnlyData", "removed"] as const) {
    const sandbox = { profile: initial, readOnlyData: false }, source = f.grant("", { executable: "/bin/ls", argv: ["."], sandbox });
    const issued = f.wrapper.issue(source)!; expect(issued).toBeDefined();
    if (field === "profile") sandbox.profile += "\n(allow network*)";
    if (field === "readOnlyData") sandbox.readOnlyData = true;
    if (field === "removed") source.sandbox = undefined;
    const answer = await raw(issued.command); expect(answer.status).toBe(403); expect(answer.text).toBe("host shell execution refused\n");
  }
});

test.skipIf(!sandboxAvailable())("wrapper target environment equals the existing #816 executor baseline", async () => {
  const f = await fixture(), kernel = profile(f.root, false, [], [], []);
  const extra = { AGENTHUB_PEER_ID: "claude-impl", HTTPS_PROXY: "http://127.0.0.1:1" };
  const reference = await sandboxedExec(["/usr/bin/env"], { cwd: f.root, profile: kernel, env: extra, timeoutMs: 5000 });
  expect(reference.code).toBe(0);
  const issued = f.wrapper.issue(f.grant("", { executable: "/usr/bin/env", argv: [], env: hostShellEnvironment(extra), sandbox: { profile: kernel, readOnlyData: false } }))!;
  expect(issued).toBeDefined();
  const actual = await collect(invoke(issued.command)); expect(actual.code).toBe(0); expect(actual.stderr.length).toBe(0);
  const parse = (value: string) => Object.fromEntries(value.trimEnd().split("\n").map(line => { const at = line.indexOf("="); expect(at).toBeGreaterThan(0); return [line.slice(0, at), line.slice(at + 1)]; }));
  const wanted = parse(reference.output), observed = parse(actual.stdout.toString());
  expect(wanted.TMPDIR).toBeDefined(); expect(observed.TMPDIR).toBeDefined();
  expect(existsSync(wanted.TMPDIR!)).toBe(false); expect(existsSync(observed.TMPDIR!)).toBe(false);
  delete wanted.TMPDIR; delete observed.TMPDIR;
  expect(observed).toEqual(wanted);
}, 20_000);

test("only matched ticket refusals notify the original host observer with no payload", async () => {
  const f = await fixture(), marker = join(f.root, "must-not-run");
  for (const reason of ["current", "stamp", "schema", "expiry"] as const) {
    const observed: unknown[][] = []; let current = true;
    const executable = join(f.root, `observer-${reason}`);
    writeFileSync(executable, "#!/bin/sh\nprintf must-not-run"); chmodSync(executable, 0o700);
    const grant = f.grant(`await Bun.write(${JSON.stringify(marker)},"effect")`, {
      current: () => current, onRefused: (...args: unknown[]) => { observed.push(args); },
      ...(reason === "stamp" ? { executable, argv: [] } : {}),
    });
    const issued = f.wrapper.issue(grant)!; expect(issued).toBeDefined();
    if (reason === "current") current = false;
    if (reason === "stamp") writeFileSync(executable, "#!/bin/sh\nprintf changed-executable");
    const later = Date.now() + 31_000;
    const clock = reason === "expiry" ? spyOn(Date, "now") : undefined;
    try {
      if (clock) clock.mockReturnValue(later);
      const reply = await raw(issued.command, {}, reason === "schema" ? { extra: "withheld" } : {});
      expect(reply).toEqual({ status: 403, text: "host shell execution refused\n" });
      expect(observed, reason).toEqual([[]]); expect(existsSync(marker)).toBe(false);
      expect((await raw(issued.command)).status).toBe(403);
      expect(observed, "a consumed ticket has no owner attribution").toEqual([[]]);
    } finally { clock?.mockRestore(); }
  }
});

test("a throwing refusal observer cannot alter the fixed refusal or execute a target", async () => {
  const f = await fixture(), marker = join(f.root, "must-not-run"); let current = true, calls = 0;
  const issued = f.wrapper.issue(f.grant(`await Bun.write(${JSON.stringify(marker)},"effect")`, {
    current: () => current, onRefused: () => { calls++; throw new Error("observer-private-detail"); },
  }))!;
  current = false;
  expect(await raw(issued.command)).toEqual({ status: 403, text: "host shell execution refused\n" });
  expect(calls).toBe(1); expect(existsSync(marker)).toBe(false);
});

test("unissued, malformed and forgotten tickets and an ordinary target exit never notify refusal", async () => {
  const f = await fixture(); let calls = 0;
  const onRefused = () => { calls++; };
  expect(f.wrapper.issue(f.grant("", { current: () => false, onRefused }))).toBeUndefined();
  const controller = new AbortController();
  const forgotten = f.wrapper.issue(f.grant("", { signal: controller.signal, onRefused }))!; controller.abort();
  expect((await raw(forgotten.command)).status).toBe(403);
  const issued = f.wrapper.issue(f.grant("process.exit(23)", { onRefused }))!;
  expect((await raw(issued.command, {}, { ticket: "0".repeat(64) })).status).toBe(403);
  expect((await raw(issued.command, {}, { ticket: "malformed" })).status).toBe(403);
  expect((await collect(invoke(issued.command))).code).toBe(23);
  expect(calls).toBe(0);
}, 10_000);

test("changing an issued refusal callback fences execution and never invokes the replacement", async () => {
  const f = await fixture(), marker = join(f.root, "must-not-run"); let original = 0, replacement = 0;
  const grant = f.grant(`await Bun.write(${JSON.stringify(marker)},"effect")`, { onRefused: () => { original++; } });
  const issued = f.wrapper.issue(grant)!;
  grant.onRefused = () => { replacement++; };
  expect(await raw(issued.command)).toEqual({ status: 403, text: "host shell execution refused\n" });
  expect(original).toBe(1); expect(replacement).toBe(0); expect(existsSync(marker)).toBe(false);
});
