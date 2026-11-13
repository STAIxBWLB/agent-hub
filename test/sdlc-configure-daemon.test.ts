import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { configBackups } from "../src/hub/config-edit.ts";
import { readEvents } from "../src/hub/events.ts";
import { conductorPeer } from "../src/hub/conductor.ts";
import { Board } from "../src/hub/board.ts";
import { realPath } from "../src/hub/project.ts";
import { gitProject } from "./fakes/git-project.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(mode = "off", multiple = false, created?: (root: string) => void) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-configure-daemon-"))), stateDir = join(root, "state"), file = join(root, ".agenthub/sdlc.toml");
  cleanup.push(() => rmSync(root, { recursive: true, force: true })); gitProject(root); mkdirSync(join(root, ".agenthub")); mkdirSync(stateDir);
  writeFileSync(file, `mode = "${mode}"\nrequired_checks = ["unit"]\n`);
  created?.(root);
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "configure-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, roles: { claude: ["conductor"], codex: multiple ? ["conductor"] : ["implementer"] },
      roster: { ...DEFAULT_CONFIG.roster, claude: true, codex: true, kimi: false, qwen: false, jcode: false, pi: false, local: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const connect = async (peer?: string) => { const client = await ControlClient.connect(stateDir, peer ? { role: "tools", peer, projectRoot: root } : { role: "console", projectRoot: root }); cleanup.push(() => client.close()); return client; };
  const person = await connect(), lead = await connect("claude"), other = await connect("codex");
  const configure = (client: ControlClient, values: Record<string, unknown>) => client.request({ t: "sdlc", op: "configure", instructionClaim: true, ...values });
  const events = () => readEvents(join(stateDir, "events.jsonl")).filter(row => row.type === "config_edit" || row.type === "sdlc_config_instruction");
  return { root, stateDir, file, daemon, person, lead, other, configure, events, read: () => readFileSync(file, "utf8") };
}

test("authenticated unique conductor configures advise with ordered intent/result audit; generic settings stay person-only", async () => {
  const f = await fixture(), before = f.read();
  expect((await f.configure(f.other, { mode: "advise" })).ok).toBe(false);
  expect((await f.configure(f.lead, { mode: "advise", instructionClaim: false })).ok).toBe(false);
  const revisions = (await f.person.request({ t: "config_edit_get" })).revisions;
  const generic = await f.lead.request({ t: "config_edit_apply", edit: { file: "sdlc.toml", revision: revisions["sdlc.toml"], set: [{ path: ["mode"], value: "advise" }] } });
  expect(generic.ok).toBe(false); expect(f.read()).toBe(before); expect(f.events()).toEqual([]);
  const done = await f.configure(f.lead, { mode: "advise", required_checks: ["CHECK_AUDIT_CANARY", "lint"] });
  expect(done).toMatchObject({ ok: true, saved: true, by: "claude", instructionClaim: "person_direct_instruction" });
  expect(f.read()).toContain('mode = "advise"'); expect(configBackups(f.stateDir)).toHaveLength(1);
  const events = f.events(); expect(events.map(row => row.type)).toEqual(["sdlc_config_instruction", "config_edit"]);
  expect(events[0]).toMatchObject({ by: "claude", instructionClaim: "person_direct_instruction", paths: ["sdlc.mode", "sdlc.required_checks"] });
  expect(events[1]).toMatchObject({ by: "claude", source: "conductor", instructionClaim: "person_direct_instruction" });
  expect(JSON.stringify(events)).not.toContain("CHECK_AUDIT_CANARY");
});

test("real control refuses protected fields, ambiguous conductor and loader errors before file or backup changes", async () => {
  const f = await fixture(), before = f.read();
  for (const values of [{ mode: "enforce" }, { mode: "advise", security: {} }, { mode: "advise", eval_check: "x" }, { mode: "advise", config_paths: [] }, { mode: "advise", stages: [] }])
    expect((await f.configure(f.lead, values)).ok).toBe(false);
  const invalid = await f.configure(f.lead, { required_checks: [""] }); expect(invalid.ok).toBe(false); expect(invalid.field).toBe("sdlc.required_checks");
  expect(f.read()).toBe(before); expect(configBackups(f.stateDir)).toEqual([]); expect(f.events()).toEqual([]);
  let ambiguousRoot: string | undefined;
  await expect(fixture("off", true, root => { ambiguousRoot = root; })).rejects.toThrow("at most one conductor");
  expect(configBackups(join(ambiguousRoot!, "state"))).toEqual([]);
  expect(readFileSync(join(ambiguousRoot!, ".agenthub/sdlc.toml"), "utf8")).toBe('mode = "off"\nrequired_checks = ["unit"]\n');
});

test("fresh file enforce and retained running enforce each block the narrow command", async () => {
  for (const side of ["file", "running"]) {
    const f = await fixture(side === "running" ? "enforce" : "off");
    writeFileSync(f.file, `mode = "${side === "file" ? "enforce" : "off"}"\nrequired_checks = ["unit"]\n`);
    const before = f.read(), refused = await f.configure(f.lead, { required_checks: ["lint"] });
    expect(refused.ok).toBe(false); expect(String(refused.error)).toContain("enforce");
    expect(f.read()).toBe(before); expect(configBackups(f.stateDir)).toEqual([]); expect(f.events()).toEqual([]);
  }
});

test("PII task context and recovery hold refuse conductor writes while person remains a separate actor", async () => {
  const f = await fixture(), before = f.read(), board = new Board(join(f.stateDir, "hub.db")); cleanup.push(() => board.close());
  const task = board.propose("user", { title: "PRIVATE_TASK_CANARY", class: "test", signals: ["pii"] });
  board.update(task.id, "user", "accepted", { owner: "claude", state: "in_progress" });
  const privateReply = await f.configure(f.lead, { mode: "advise" }); expect(privateReply.ok).toBe(false); expect(JSON.stringify(privateReply)).not.toContain("PRIVATE_TASK_CANARY");
  expect(f.read()).toBe(before); expect(configBackups(f.stateDir)).toEqual([]);
  board.update(task.id, "user", "approved", { state: "approved" });
  f.daemon.bus.setRecoveryHold(true);
  expect((await f.configure(f.lead, { mode: "advise" })).ok).toBe(false); expect(f.read()).toBe(before);
  f.daemon.bus.setRecoveryHold(false);
  expect((await f.configure(f.person, { mode: "advise" })).ok).toBe(true);
  expect(f.events().at(-1)).toMatchObject({ by: "user", source: "terminal" });
});

test("actual configure control closure rejects child, private, observer and stale external/session contexts before host writes", async () => {
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8"), section = source.indexOf('      case "sdlc": {'), begin = source.indexOf('        if (msg.op === "configure") {', section), end = source.indexOf('        if (msg.op === "authorize-release") {', begin);
  expect(section).toBeGreaterThan(0); expect(begin).toBeGreaterThan(section); expect(end).toBeGreaterThan(begin);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`(function(){${source.slice(begin, end)}})()`);
  for (const variant of ["child", "private-turn", "pii-context", "observer-held", "observer-input", "external-root", "session", "stopping", "recovery"] as const) {
    const c = { role: "tools", peer: "claude", ...(variant === "child" ? { toolsOwner: {} } : {}), ...(variant === "external-root" ? { externalOwner: {} } : {}) };
    const replies: Record<string, unknown>[] = []; let writes = 0;
    const context = { msg: { t: "sdlc", op: "configure", mode: "advise", instructionClaim: true }, c, USER: "user", sock: { data: c, readyState: 1 }, WebSocket: { OPEN: 1 },
      config: { roles: { claude: ["conductor"] } }, conductorPeer, turns: new Map(variant === "private-turn" ? [["claude", { private: true }]] : []),
      contextPii: () => variant === "pii-context", operationalCurrent: () => () => { if (variant === "session") throw new Error("session changed"); }, currentExternalTools: () => variant !== "external-root",
      reviewObserverHeld: () => variant === "observer-held", reviewObserverInput: () => variant === "observer-input", stopping: variant === "stopping", recoveryActive: () => variant === "recovery", bus: { isRecoveryHeld: false }, taskOpsInFlight: 0,
      configEditor: { configureSdlc: async () => { writes++; return { ok: true }; } }, reply: (row: Record<string, unknown>) => { replies.push(row); } };
    runInNewContext(code, context); await Promise.resolve();
    expect(writes, variant).toBe(0); expect(replies[0]?.ok, variant).toBe(false);
  }
});
