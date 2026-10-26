import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPi } from "../src/adapters/definitions/native-factories.ts";
import type { CreateContext } from "../src/adapters/registry-types.ts";
import { piVersionAsync, type PiOptions } from "../src/adapters/pi.ts";
import { trustFile, writeTrust } from "../src/adapters/compat.ts";
import { COMPAT, configuredCommands, type CompatId } from "../src/adapters/compat.ts";
import { agentVersions } from "../src/cli/agents.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { parseSource } from "../scripts/lib/ts-ast.ts";
import ts from "typescript";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(version: string, mode: "headless" | "tui" = "tui") {
  const dir = mkdtempSync(join(tmpdir(), "ahub-pi-compat-")), script = join(dir, "pi.ts"), trace = join(dir, "trace");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(script, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2))+"\\n");
if(process.argv.includes("--version")){console.log(${JSON.stringify(version)});process.exit(0);}
await import(${JSON.stringify(join(import.meta.dir, "fakes/pi-rpc.ts"))});`);
  const opts: PiOptions = { cwd: dir, stateDir: join(dir, "state"), cmd: [process.execPath, script, "--prefix"], mode, backend: "dgx",
    relay: { url: "http://127.0.0.1:9/v1", token: "fixture", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "fixture" };
  const peer = createPi({ instance: "pi", permission: "ask", daemon: { pi: opts } } as CreateContext);
  cleanup.push(() => peer.stop());
  return { dir, opts, peer, trace };
}

for (const mode of ["headless", "tui"] as const) test(`production Pi ${mode} launch refuses unverified versions before bridge or process start`, async () => {
  const f = fixture("9.9.9", mode);
  await expect(f.peer.start()).rejects.toThrow("ahub agents trust pi 9.9.9");
  expect(readFileSync(f.trace, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([["--prefix", "--version"]]);
  expect(existsSync(f.opts.stateDir)).toBe(false);
});

test("verified and person-trusted Pi versions launch through the same production preflight", async () => {
  const verified = fixture("1.4.0", "headless");
  await verified.peer.start();
  expect(verified.peer.state).toBe("idle");
  await verified.peer.stop();
  const trusted = fixture("9.9.9"), file = trustFile();
  const previous = existsSync(file) ? readFileSync(file) : undefined;
  cleanup.push(() => { if (previous) writeFileSync(file, previous); else rmSync(file, { force: true }); });
  writeTrust("pi", "9.9.9", false);
  await trusted.peer.start();
  expect(readFileSync(trusted.trace, "utf8")).toContain("--version");
});

test("Pi probe refuses unknown and oversized output and remains asynchronous at its deadline", async () => {
  const f = fixture("invalid");
  expect(await piVersionAsync(f.opts.cmd!, f.dir)).toMatchObject({ ok: false, state: "unknown" });
  writeFileSync(join(f.dir, "pi.ts"), 'process.stdout.write("x".repeat(70000));setInterval(()=>{},1000);');
  expect(await piVersionAsync(f.opts.cmd!, f.dir)).toMatchObject({ ok: false, state: "unknown" });
  writeFileSync(join(f.dir, "pi.ts"), 'setInterval(()=>{},1000);');
  let ticks = 0; const clock = setInterval(() => ticks++, 5);
  try { expect(await piVersionAsync(f.opts.cmd!, f.dir, 100)).toMatchObject({ ok: false, state: "unknown" }); }
  finally { clearInterval(clock); }
  expect(ticks).toBeGreaterThan(0);
});

test("ahub agents lists Pi using its configured wrapper command", () => {
  const f = fixture("1.4.0");
  const commands = Object.fromEntries(Object.keys(COMPAT).map(id => [id, [join(f.dir, "not-installed")]])) as Record<CompatId, string[]>;
  const configured = configuredCommands({ ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, cmd: f.opts.cmd! } });
  expect(configured.pi).toEqual(f.opts.cmd!);
  commands.pi = [...configured.pi!];
  expect(agentVersions(commands).find(row => row.id === "pi")?.verdict).toEqual({ ok: true, state: "verified", version: "1.4.0" });
});

for (const path of ["headless", "tui", "daemon", "auto"] as const) test(`Pi ${path} start routes through the production factory gate`, async () => {
  const f = fixture("9.9.9"), stateDir = join(f.dir, "hub");
  const daemon = await startDaemon({ cwd: f.dir, stateDir, projectId: "pi-compat", instanceId: `compat-${path}`,
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, snapshotClock: () => 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: path === "auto", cmd: f.opts.cmd! },
      peers: { ...DEFAULT_CONFIG.peers, pi: { ...DEFAULT_CONFIG.peers.pi, start_mode: "headless" } } } });
  cleanup.push(() => daemon.stop());
  if (path === "auto") {
    const deadline = Date.now() + 5000;
    while (!readFileSync(join(stateDir, "hub.log"), "utf8").includes("ahub agents trust pi 9.9.9") && Date.now() < deadline) await Bun.sleep(10);
    expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain("ahub agents trust pi 9.9.9");
  } else {
    const client = await ControlClient.connect(stateDir, { role: "console" });
    cleanup.push(() => client.close());
    const reply = await client.request(path === "daemon" ? { t: "peer_start", peer: "pi" } : { t: "start", peer: "pi", args: { mode: path } });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("ahub agents trust pi 9.9.9");
  }
  expect(existsSync(f.trace)).toBe(true);
  expect(readFileSync(f.trace, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([["--prefix", "--version"]]);
  expect(daemon.bus.stateOf("pi")).toBe("offline");
});

test("Pi read-only mode still refuses before probing a native command", () => {
  const f = fixture("1.4.0");
  expect(() => createPi({ instance: "pi", permission: "read-only", daemon: { pi: f.opts } } as CreateContext)).toThrow("no verified read-only permission mapping");
  expect(existsSync(f.trace)).toBe(false);
});

test("native RPC error text cannot impersonate a safe host version refusal", async () => {
  const f = fixture("1.4.0"), stateDir = join(f.dir, "hub");
  writeFileSync(join(f.dir, "pi.ts"), `import {createInterface} from "node:readline";
if(process.argv.includes("--version")){console.log("1.4.0");process.exit(0);}
createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,success:false,error:"Version not verified: PRIVATE_NATIVE_ERROR"}));});`);
  const daemon = await startDaemon({ cwd: f.dir, stateDir, projectId: "pi-error", instanceId: "pi-error",
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, snapshotClock: () => 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: f.opts.cmd! },
      peers: { ...DEFAULT_CONFIG.peers, pi: { ...DEFAULT_CONFIG.peers.pi, start_mode: "headless" } } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  const reply = await client.request({ t: "peer_start", peer: "pi" });
  expect(reply.ok).toBe(false);
  expect(reply.error).toBe("peer start failed; inspect ahub status and hub.log");
  expect(JSON.stringify(reply)).not.toContain("PRIVATE_NATIVE_ERROR");
});

test("production Pi construction stays confined to its gated registry factory", () => {
  expect(definitionOf("pi")?.start.create).toBe(createPi);
  const root = join(import.meta.dir, ".."), sites: string[] = [];
  for (const file of new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })) {
    const source = parseSource(file, readFileSync(join(root, file), "utf8")), names = new Set(["PiPeer"]);
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && /(?:^|\/)pi\.ts$/.test(statement.moduleSpecifier.text)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if ((item.propertyName ?? item.name).text === "PiPeer") names.add(item.name.text);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && (ts.isIdentifier(node.expression) && names.has(node.expression.text)
        || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "PiPeer")) sites.push(file);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(sites).toEqual(["src/adapters/definitions/native-factories.ts"]);
});
