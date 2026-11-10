// #1387 T0: ahub is held to docs/contracts/companion-cli-v1.json, the only thing the companion repositories may assume about it.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Registry } from "../src/hub/registry.ts";
import { shellQuote } from "../src/cli/shell-quote.ts";
import { needs } from "../src/ui/needs.ts";

const ROOT = join(import.meta.dir, "..");
type Rule = { type: string; presence: string; values?: string[]; prefixes?: string[] };
const contract = JSON.parse(readFileSync(join(ROOT, "docs/contracts/companion-cli-v1.json"), "utf8")) as {
  noHub: { exitCode: number; stderrPrefix: string }; status: Record<string, Rule>; projects: Record<string, Rule>; shellQuote: { in: string; out: string }[];
};

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
function check(rule: Rule, value: unknown): boolean {
  switch (rule.type) {
    case "semver": return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(value);
    case "string": return typeof value === "string" && value.length > 0;
    case "absolute-path": return typeof value === "string" && value.startsWith("/");
    case "count": return count(value);
    case "count-map": return plain(value) && Object.entries(value).every(([k, n]) => rule.values!.includes(k) && count(n));
    case "enum": return typeof value === "string" && rule.values!.includes(value);
    case "true": return value === true;
    case "false": return value === false;
    case "prefixed": return typeof value === "string" && (rule.values!.includes(value) || rule.prefixes!.some(p => value.startsWith(p)));
    case "object": return plain(value);
    default: throw new Error(`unknown contract type ${rule.type}`);
  }
}
/** Every listed path that is present has its listed type; every "always" path is present. `<id>` and `[]` expand over the rows. */
function conform(rules: Record<string, Rule>, doc: unknown): string[] {
  const bad: string[] = [];
  for (const [path, rule] of Object.entries(rules)) {
    let nodes: { at: string; value: unknown; present: boolean }[] = [{ at: "", value: doc, present: true }];
    for (const part of path.split(".")) {
      nodes = nodes.flatMap(n => {
        if (!n.present) return [n];
        if (part === "[]") return Array.isArray(n.value) ? n.value.map((v, i) => ({ at: `${n.at}[${i}]`, value: v, present: true })) : [{ ...n, present: false }];
        if (!plain(n.value)) return [{ at: `${n.at}.${part}`, value: undefined, present: false }];
        if (part === "<id>") return Object.entries(n.value).map(([k, v]) => ({ at: `${n.at}.${k}`, value: v, present: true }));
        return [{ at: `${n.at}.${part}`, value: n.value[part], present: Object.hasOwn(n.value, part) }];
      });
    }
    for (const n of nodes) {
      if (!n.present) { if (rule.presence === "always") bad.push(`${path}: missing at ${n.at}`); continue; }
      if (!check(rule, n.value)) bad.push(`${path}: ${JSON.stringify(n.value)} is not ${rule.type} at ${n.at}`);
    }
  }
  return bad;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-companion-contract-")), cwd = join(root, "repo"), home = join(root, "hub");
  mkdirSync(cwd); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const vars = { HOME: join(root, "person"), AGENTHUB_HOME: home, CLAUDE_CONFIG_DIR: join(root, "claude"), AMEM_HOME: join(root, "memory") };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]])); Object.assign(process.env, vars);
  cleanups.push(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  mkdirSync(join(cwd, ".agenthub"));
  expect(hubGitSync(["init", "-q"], { cwd, encoding: "utf8", timeout: 1000 }).status).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, research: { enabled: false }, pi: { auto_start: false } }));
  // A declared channel instance nobody attached: the detached peer row.
  writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ instances: { "claude-2": { kind: "claude", roles: ["reviewer"] } } }));
  const registry = new Registry(join(home, "registry.db")), project = registry.register(cwd); cleanups.push(() => registry.close());
  const daemon = await startDaemon({ cwd: project.root, stateDir: project.stateDir, projectId: project.id, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, config: loadConfig(cwd) });
  let stopped = false; const stop = async () => { if (!stopped) { stopped = true; await daemon.stop(); } }; cleanups.push(stop);
  class Busy extends BasePeer { async deliver() {} async start() { this.setState("busy"); } async stop() { this.setState("offline"); } }
  const busy = new Busy("local"); daemon.bus.add(busy); await busy.start();
  daemon.bus.publish(newEnvelope(HUB, "contract fixture", { to: ["local"], priority: "status" }));
  const person = await ControlClient.connect(project.stateDir, { role: "console" }); cleanups.push(() => person.close());
  return { home, project, person, stop };
}

async function cli(home: string, cwd: string, args: string[]) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "QWEN_CODE", "QWEN_CODE_SESSION_ID", "KIMI_CODE"].includes(key)) delete env[key];
  env.AGENTHUB_HOME = home;
  const child = Bun.spawn([process.execPath, join(ROOT, "src/cli/main.ts"), ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("status reply and ahub status/projects --json carry every contract path with its type", async () => {
  const f = await fixture();
  const reply = (await f.person.request({ t: "status", specs: true })).status;
  expect(conform(contract.status, reply)).toEqual([]);
  // The fixture exercises the presence rules the readers rely on: detached, attached, queued.
  expect(reply.peers["claude-2"].attached).toBe(false);
  expect(Object.hasOwn(reply.peers.local, "attached")).toBe(false);
  expect(reply.peers.local.queued).toBe(1);
  expect(Object.hasOwn(reply.peers.local, "needsReview")).toBe(false);

  for (const args of [["status", "--json"], ["--project", f.project.root, "status", "--json"], ["--project", f.project.id, "status", "--json"]]) {
    const out = await cli(f.home, f.project.root, args);
    expect(out.code, `${args.join(" ")}: ${out.stderr}`).toBe(0);
    const status = JSON.parse(out.stdout);
    expect(conform(contract.status, status)).toEqual([]);
    expect(status.projectId).toBe(f.project.id);
    expect(status.cwd).toBe(f.project.root);
  }
  const projects = await cli(f.home, f.project.root, ["projects", "--json"]);
  expect(projects.code, projects.stderr).toBe(0);
  const rows = JSON.parse(projects.stdout);
  expect(rows.length).toBeGreaterThan(0);
  expect(conform(contract.projects, rows)).toEqual([]);
  expect(rows.find((r: { id: string }) => r.id === f.project.id)).toMatchObject({ root: f.project.root, state: "running" });

  await f.stop();
  const none = await cli(f.home, f.project.root, ["status", "--json"]);
  expect(none.code).toBe(contract.noHub.exitCode);
  expect(none.stderr.startsWith(contract.noHub.stderrPrefix)).toBe(true);
  const stopped = JSON.parse((await cli(f.home, f.project.root, ["projects", "--json"])).stdout);
  expect(conform(contract.projects, stopped)).toEqual([]);
  expect(stopped.find((r: { id: string }) => r.id === f.project.id)?.state).toBe("stopped");
}, 60_000);

test("src/cli/shell-quote.ts matches the contract's shellQuote vectors", () => {
  expect(contract.shellQuote.length).toBe(11);
  for (const v of contract.shellQuote) expect(shellQuote(v.in)).toBe(v.out);
});

// Moved from test/claude-code-companion-attention.test.ts: they test ahub's producer, not a companion.
test("current needs producer exposes one unexpired approval first, not a permission inventory", () => {
  const value = needs({ approvals: [{ id: "perm-1", peer: "claude", expiresAt: 2000 }, { id: "perm-2", expiresAt: 3000 }], peers: { codex: { needsReview: 1 } } }, 1000);
  expect(value.items[0]).toEqual({ kind: "approval", level: "act", peer: "claude", id: "perm-1", until: 2000 });
  expect(needs({ approvals: [{ id: "expired", expiresAt: 999 }] }, 1000).items).toEqual([]);
});
test("offline need is broader than in_progress and cannot supply the required assigned-state proof", () => {
  for (const state of ["proposed", "in_progress", "changes_requested"]) {
    expect(needs({ peers: { codex: { state: "offline" } }, tasks: [{ id: 1, state, owner: "codex" }] }, 1000).items[0]?.kind).toBe("offline");
  }
});

test("ahub runtime, scripts, plugins and package never name a companion repository, plugin id or integrations/", () => {
  const terms = ["STAIxBWLB/ahub-", "agent-hub-companion", "integrations/"];
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "node_modules" ? [] : files(path)) : [path];
  });
  const hits: string[] = [];
  for (const file of [...["src", "scripts", "plugins"].flatMap(d => files(join(ROOT, d))), join(ROOT, "package.json")]) {
    const text = readFileSync(file, "utf8");
    for (const term of terms) if (text.includes(term)) hits.push(`${file.slice(ROOT.length + 1)}: ${term}`);
  }
  expect(hits).toEqual([]);
  const marketplace = join(ROOT, ".claude-plugin/marketplace.json");
  expect(existsSync(marketplace)).toBe(true);
  expect(JSON.parse(readFileSync(marketplace, "utf8")).plugins.map((p: { name: string }) => p.name)).toEqual(["agent-hub"]);
});
