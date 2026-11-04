import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { parseBacklogReturn } from "../src/cli/backlog-return-args.ts";
import { HELP } from "../src/cli/help.ts";
import { gitProject } from "./fakes/git-project.ts";

// #1177: `ahub backlog return <task> <revision> <reason...> [--reserved <peer> | --unreserve]` forwards fields.reserved to hub_backlog_return_untouched.
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("the parser reads --reserved and --unreserve anywhere among the reason's words, strips them from the reason, and with neither sends exactly the old arguments", () => {
  expect(parseBacklogReturn(["park", "it"])).toEqual({ ok: true, value: { reason: "park it" } });                                   // no flag: today's arguments, no fields key at all
  expect(parseBacklogReturn(["park", "it", "--reserved", "kimi"])).toEqual({ ok: true, value: { reason: "park it", fields: { reserved: "kimi" } } });
  expect(parseBacklogReturn(["--reserved=kimi", "park", "it"])).toEqual({ ok: true, value: { reason: "park it", fields: { reserved: "kimi" } } });
  expect(parseBacklogReturn(["park", "--reserved", "kimi", "it"])).toEqual({ ok: true, value: { reason: "park it", fields: { reserved: "kimi" } } });
  expect(parseBacklogReturn(["park", "it", "--unreserve"])).toEqual({ ok: true, value: { reason: "park it", fields: { reserved: null } } });  // null clears it
  expect(parseBacklogReturn(["a", "reason", "with", "--not-a-flag"])).toEqual({ ok: true, value: { reason: "a reason with --not-a-flag" } }); // only the two exact tokens are flags
  for (const bad of [["why", "--reserved"], ["why", "--reserved", ""], ["why", "--reserved=", "x"], ["why", "--reserved", "Not A Peer"], ["why", "--reserved", "--unreserve"],
    ["why", "--reserved", "kimi", "--unreserve"], ["why", "--unreserve", "--unreserve"], ["why", "--reserved", "kimi", "--reserved", "codex"], ["--unreserve"], ["--reserved", "kimi"], []]) {
    const parsed = parseBacklogReturn(bad);
    expect(parsed.ok, JSON.stringify(bad)).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("usage: ahub backlog return");
  }
});

test("ahub help documents both flags on the return line", () => {
  const line = HELP.find(item => item.usage.includes("backlog groom | return"));
  expect(line?.usage).toContain("[--reserved <peer> | --unreserve]");
});

async function rig() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-return-1177-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  gitProject(cwd);
  const stateDir = join(cwd, ".agenthub/state"); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub/config.local.json"), '{"instances":{}}\n');
  const daemon = await startDaemon({ cwd, stateDir, projectId: "return-1177", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, roles: { claude: ["planner"], codex: ["implementer"], kimi: ["implementer"] }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
      tasks: { ...DEFAULT_CONFIG.tasks, auto_pull: false } } });
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  cleanup.push(async () => { person.close(); await daemon.stop(); });
  const task = (op: string, args: Record<string, unknown> = {}) => person.request({ t: "task", op, args });
  const show = async (id: number) => JSON.parse((await task("task_show", { id })).text);
  let serial = 0;
  /** An accepted-but-untouched card reserved for codex, the state `return` applies to. */
  const card = async () => {
    expect((await task("hub_task_propose", { title: `return fixture ${++serial}`, class: "implement", backlog: true })).ok).toBe(true);
    const id = Math.max(...JSON.parse((await task("hub_backlog_list")).text).map((row: { id: number }) => row.id));
    expect((await task("hub_backlog_plan", { id, revision: 0, fields: { reserved: "codex" }, reason: "reserve" })).ok).toBe(true);
    expect((await task("backlog_pull", { id })).ok).toBe(true);
    return show(id);
  };
  // the CLI as a person runs it: no agent markers, this project's state
  const cli = async (args: string[]) => {
    const wrapper = join(cwd, `cli-${crypto.randomUUID()}.ts`), entry = join(import.meta.dir, "../src/cli/main.ts");
    const markers = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED"];
    writeFileSync(wrapper, `for(const key of ${JSON.stringify(markers)})delete process.env[key];Object.assign(process.env,${JSON.stringify({ AGENTHUB_HOME: join(cwd, "home") })});process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); rmSync(wrapper, { force: true }); }
  };
  return { card, show, cli };
}

test("the real CLI: --reserved moves the reservation as the card goes back, --unreserve clears it, and with neither the reservation is kept", async () => {
  const f = await rig();
  // --reserved <peer>
  const a = await f.card(); expect(a.reserved).toBe("codex");
  const moved = await f.cli(["backlog", "return", String(a.id), String(a.planningRevision ?? 0), "hand", "to", "kimi", "--reserved", "kimi"]);
  expect(moved.code, moved.stderr).toBe(0);
  expect(await f.show(a.id)).toMatchObject({ state: "backlog", owner: null, reserved: "kimi" });
  expect((await f.show(a.id)).history.at(-1).note).toBe("hand to kimi");                          // the flag is not part of the reason
  // --reserved=<peer>, flag first
  const b = await f.card();
  const eq = await f.cli(["backlog", "return", String(b.id), String(b.planningRevision ?? 0), "--reserved=kimi", "same", "thing"]);
  expect(eq.code, eq.stderr).toBe(0);
  expect(await f.show(b.id)).toMatchObject({ state: "backlog", reserved: "kimi" });
  // --unreserve
  const c = await f.card();
  const cleared = await f.cli(["backlog", "return", String(c.id), String(c.planningRevision ?? 0), "no", "one", "yet", "--unreserve"]);
  expect(cleared.code, cleared.stderr).toBe(0);
  expect(await f.show(c.id)).toMatchObject({ state: "backlog", owner: null, reserved: null });
  // neither flag: today's behaviour, the reservation stays
  const d = await f.card();
  const plain = await f.cli(["backlog", "return", String(d.id), String(d.planningRevision ?? 0), "just", "park", "it"]);
  expect(plain.code, plain.stderr).toBe(0);
  expect(await f.show(d.id)).toMatchObject({ state: "backlog", owner: null, reserved: "codex" });
}, 60_000);

test("the real CLI refuses a malformed or combined flag before anything is sent, and the card is untouched", async () => {
  const f = await rig();
  const a = await f.card(), before = await f.show(a.id);
  for (const flags of [["--reserved"], ["--reserved", "Not A Peer"], ["--reserved", "kimi", "--unreserve"], ["--unreserve", "--unreserve"]]) {
    const refused = await f.cli(["backlog", "return", String(a.id), String(a.planningRevision ?? 0), "why", ...flags]);
    expect(refused.code, flags.join(" ")).toBe(1);
    expect(refused.stderr, flags.join(" ")).toContain("usage: ahub backlog return");
    expect(await f.show(a.id), flags.join(" ")).toEqual(before);
  }
}, 60_000);
