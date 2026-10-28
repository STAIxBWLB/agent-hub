import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { policyPaths, matchesPolicy } from "../src/hub/path-policy.ts";
import { realPath } from "../src/hub/project.ts";
import { guardPath, runTool, type ToolContext } from "../src/local/tools.ts";
import { profile, sandboxedExec } from "../src/local/sandbox.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting, assign } from "../src/hub/routing.ts";
import { MemoryClient } from "../src/memory/client.ts";
import { loadConfig } from "../src/hub/daemon.ts";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const root = () => { const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-data-policy-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
class CountingMemory extends MemoryClient { saved: unknown[] = []; override async save(input: Parameters<MemoryClient["save"]>[0]) { this.saved.push(input); return undefined; } }
class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }
test("bounded data path config defaults absent, merges locally and matches symlink/case aliases (#259)", () => {
  const dir = root(); mkdirSync(join(dir, ".agenthub")); mkdirSync(join(dir, "data/raw"), { recursive: true }); symlinkSync("data/raw", join(dir, "alias"));
  expect(loadConfig(dir).pii).toBeUndefined(); expect(loadConfig(dir).data).toBeUndefined();
  for (const raw of [null, "private", ["/outside"], ["../outside"], ["a/../b"], Array(65).fill("raw"), ["bad\npath"], ["data/[raw]"]]) expect(() => policyPaths(raw, "pii.paths")).toThrow();
  expect(policyPaths(["data/raw/", "data/raw"], "pii.paths")).toEqual(["data/raw"]);
  for (const path of ["data/raw/input.json", "alias/input.json", "DATA/RAW/new.json"]) expect(matchesPolicy(dir, path, ["data/raw"])).toBe(true);
  expect(matchesPolicy(dir, "data/raw-other/input.json", ["data/raw"])).toBe(false); expect(matchesPolicy(dir, ".", ["data/raw"], true)).toBe(true);
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ pii: { paths: ["data/raw"] }, data: { readonly: ["data/raw"] } }));
  writeFileSync(join(dir, ".agenthub/config.local.json"), JSON.stringify({ data: { readonly: [] } }));
  expect(loadConfig(dir)).toMatchObject({ pii: { paths: ["data/raw"] }, data: { readonly: [] } });
});
test("private declared paths force local-only before triage even with pattern constraint off (#259)", async () => {
  const dir = root(), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanup.push(() => board.close());
  for (const id of ["claude", "codex", "kimi", "local"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const routing = loadRouting(dir); routing.constraints.pii = "off"; routing.classes.implement = { ...routing.classes.implement, peers: ["codex", "local"] }; let triaged = 0; const memory = new CountingMemory();
  const tasks = new Tasks({ wipLimit: () => 3, board, bus, cwd: dir, project: "fixture", profile: "research", piiPaths: ["data/private"], memory, routing: () => routing, notify: line => notices.push(line),
    triage: { onCampus: async () => false, classify: async () => { triaged++; return "implement"; } } });
  const task = await tasks.propose("local", { title: "PATH_PRIVATE_TASK_MARKER", owner: "local", plan: { paths: ["data/private/input.csv"] } });
  expect(task.signals).toContain("pii_path"); expect(tasks.isPii(task)).toBe(true); expect(task.owner).toBe("local"); expect(triaged).toBe(0);
  expect(JSON.stringify(tasks.publicView(task))).not.toContain("PATH_PRIVATE_TASK_MARKER"); expect(notices.join("\n")).not.toContain("PATH_PRIVATE_TASK_MARKER");
  const choice = assign(task, { claude: "idle", codex: "idle", kimi: "idle", local: "idle" }, routing); expect(choice.owner).toBe("local"); expect(assign(task, { claude: "idle", codex: "idle", kimi: "idle", local: "idle" }, routing, { namedOwner: "codex", candidates: ["codex"] }).owner).toBeUndefined(); await tasks.done("local", task.id, "PRIVATE_RESULT_MARKER"); expect(memory.saved).toEqual([]);
  for (const path of ["data", "."]) { const parent = await tasks.propose("local", { title: "PRIVATE_PARENT_SCOPE", class: "draft", owner: "local", refs: { paths: [path] } }); expect(tasks.isPii(parent)).toBe(true); }
  const publicTask = await tasks.propose("codex", { title: "Public", class: "draft", owner: "codex" });
  expect(() => tasks.accept("codex", publicTask.id, { sections: ["data/private/report.md#results"] })).toThrow("PII");
});
test("read-only managed writes refuse before/after approval, permit reads and refuse hardlink aliases (#259)", async () => {
  const dir = root(); mkdirSync(join(dir, "data/raw"), { recursive: true }); writeFileSync(join(dir, "data/raw/input.json"), "original"); symlinkSync("data/raw", join(dir, "alias"));
  let approvals = 0;
  const ctx: ToolContext = { cwd: dir, deny: [], readOnly: ["data/raw"], sandboxProfile: "", permit: async () => { approvals++; return true; }, send: () => "sent" };
  expect(guardPath(ctx, "data/raw/input.json", "read")).toBe(join(dir, "data/raw/input.json"));
  for (const path of ["data/raw/input.json", "alias/input.json", "data/raw/new.json"]) {
    expect(await runTool("write", JSON.stringify({ path, content: "mutated" }), ctx)).toContain("data.readonly");
  }
  expect(approvals).toBe(0); expect(readFileSync(join(dir, "data/raw/input.json"), "utf8")).toBe("original");
  linkSync(join(dir, "data/raw/input.json"), join(dir, "hardlink.json"));
  expect(() => guardPath(ctx, "hardlink.json", "write")).toThrow("hardlinked");
  // Bun's realpath may name either link of a hardlinked file (#541), so the permitted path is judged by the file it names, not its spelling.
  expect(statSync(guardPath({ cwd: dir, deny: [] }, "hardlink.json", "write")).ino).toBe(statSync(join(dir, "hardlink.json")).ino);
  writeFileSync(join(dir, "output.json"), "output");
  const swapped = { ...ctx, permit: async () => { rmSync(join(dir, "output.json")); symlinkSync("data/raw/input.json", join(dir, "output.json")); return true as const; } };
  expect(await runTool("write", JSON.stringify({ path: "output.json", content: "mutated" }), swapped)).toContain("data.readonly");
  expect(readFileSync(join(dir, "data/raw/input.json"), "utf8")).toBe("original");
});
test.skipIf(process.platform !== "darwin")("kernel read-only policy preserves inputs across shell write, parent rename and hardlinks (#259)", async () => {
  const dir = root(); mkdirSync(join(dir, "data/raw"), { recursive: true }); writeFileSync(join(dir, "data/raw/input"), "original"); linkSync(join(dir, "data/raw/input"), join(dir, "alias"));
  const policy = profile(dir, false, [], [], ["data/raw"]);
  for (const command of ["printf mutated > data/raw/input", "mv data data-moved", "printf mutated > alias", "ln data/raw/input linked; printf mutated > linked", 'ln data/raw/input "$TMPDIR/linked"; printf mutated > "$TMPDIR/linked"']) {
    const result = await sandboxedExec(["/bin/bash", "-c", command], { cwd: dir, profile: policy, readOnlyData: true });
    expect(result.code, command).not.toBe(0); expect(readFileSync(join(dir, "data/raw/input"), "utf8")).toBe("original");
  }
  expect((await sandboxedExec(["/bin/cat", "data/raw/input"], { cwd: dir, profile: policy, readOnlyData: true })).output).toContain("original");
});
test("read-only command profiles contain no project/temp write grant and reject mismatched runner policy (#259)", async () => {
  const dir = root(), readOnly = profile(dir, false, [], [], ["data/raw"]);
  expect(readOnly).not.toContain("(allow file-write* (subpath");
  expect(profile(dir, false, [], [], [])).toBe(profile(dir, false));
  const refused = await sandboxedExec(["/bin/echo", "no effect"], { cwd: dir, profile: profile(dir, false), readOnlyData: true });
  expect(refused.code).toBeNull(); expect(refused.output).toContain("broad write grant");
});
test("daemon local adapter propagates read-only policy to managed tool calls (#259)", async () => {
  const dir = root(); mkdirSync(join(dir, "data/raw"), { recursive: true }); writeFileSync(join(dir, "data/raw/input"), "original");
  const { startDaemon, DEFAULT_CONFIG } = await import("../src/hub/daemon.ts"), { ControlClient } = await import("../src/hub/control-client.ts");
  const { startFakeModelServer, toolCall } = await import("./fakes/model-server.ts"), { newEnvelope } = await import("../src/hub/envelope.ts");
  const prior = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "fixture-key"; cleanup.push(() => { if (prior === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = prior; });
  const model = startFakeModelServer({ key: "fixture-key", script: (_body, call) => call === 1 ? { tool_calls: [toolCall("write", { path: "data/raw/input", content: "mutated" })] } : { content: "observed refusal" } }); cleanup.push(model.stop);
  const stateDir = join(dir, ".agenthub/state"), daemon = await startDaemon({ cwd: dir, stateDir, unattended: true, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, data: { readonly: ["data/raw"] }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { urls: [model.url], access_hosts: [] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } }); cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  expect((await client.request({ t: "start", peer: "local", args: { model: "m" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("local"); expect(peer).toBeDefined(); await peer!.deliver([newEnvelope("user", "fixture write")]);
  for (let i = 0; i < 300 && peer!.state !== "idle"; i++) await Bun.sleep(5);
  expect(peer!.state).toBe("idle"); expect(model.requests).toHaveLength(2); expect(model.requests[0]!.body.messages[0].content).toContain("Managed bash/git are filesystem read-only"); expect(model.requests[1]!.body.messages.some((m: { role: string; content?: string }) => m.role === "tool" && m.content?.includes("data.readonly"))).toBe(true);
  expect(readFileSync(join(dir, "data/raw/input"), "utf8")).toBe("original");
});
test("owned Pi bridge keeps read-only data protected even under never-ask (#259)", async () => {
  const dir = root(); mkdirSync(join(dir, "data/raw"), { recursive: true }); writeFileSync(join(dir, "data/raw/input"), "original");
  const { startDaemon, DEFAULT_CONFIG } = await import("../src/hub/daemon.ts"), { ControlClient } = await import("../src/hub/control-client.ts"), { PiPeer } = await import("../src/adapters/pi.ts");
  const stateDir = join(dir, ".agenthub/state");
  const daemon = await startDaemon({ cwd: dir, stateDir, unattended: true, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, data: { readonly: ["data/raw"] }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-data-policy.ts")] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } }); cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  expect((await client.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "dgx" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("pi") as InstanceType<typeof PiPeer>; expect(peer).toBeDefined(); const launch = peer.tuiLaunch!;
  const call = async (name: string, args: unknown, toolCallId: string) => (await (await fetch(launch.env.AGENTHUB_PI_BRIDGE_URL + "/tool", { method: "POST",
    headers: { authorization: "Bearer " + launch.env.AGENTHUB_PI_BRIDGE_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ name, args, toolCallId, sessionId: peer.recoveryMetadata().sessionId, generation: (peer as unknown as { budgetGeneration: number }).budgetGeneration }) })).json()) as { text: string; failed?: boolean };
  expect((await call("read", { path: "data/raw/input" }, "read1")).text).toContain("original");
  const refused = await call("write", { path: "data/raw/input", content: "mutated" }, "write1"); expect(refused.text).toContain("data.readonly"); expect(refused.failed).toBe(true);
  expect(readFileSync(join(dir, "data/raw/input"), "utf8")).toBe("original");
});
test.skipIf(process.platform !== "darwin")("managed command runner refuses temp writes when data is read-only (#259)", async () => {
  const dir = root(), ctx: ToolContext = { cwd: dir, deny: [], readOnly: ["data/raw"], sandboxProfile: profile(dir, false, [], [], ["data/raw"]), permit: async () => true, send: () => "sent" };
  const result = await runTool("bash", JSON.stringify({ command: 'printf scratch > "$TMPDIR/probe"' }), ctx);
  expect(result).toContain("(exit 1)");
});
test("private files never reach automatic facts, including unrelated directory scopes (#259)", async () => {
  const dir = root(); mkdirSync(join(dir, "data/private"), { recursive: true }); writeFileSync(join(dir, "data/public.txt"), "public"); writeFileSync(join(dir, "data/private/PRIVATE_FILE_MARKER.txt"), "PRIVATE_CONTENT_MARKER");
  const { Facts } = await import("../src/hub/facts.ts"), { hubGitSync } = await import("../src/hub/git.ts");
  expect(hubGitSync(["init", "--quiet"], { cwd: dir, encoding: "utf8" }).status).toBe(0);
  const facts = new Facts({ root: dir, tmp: join(dir, ".facts"), instance: "fixture", scope: () => ({ paths: ["data"], plans: [] }), peers: () => ["claude", "codex"], nameable: () => true,
    privatePath: path => matchesPolicy(dir, path, ["data/private"]) });
  const first = facts.due("claude"); expect(first).toBeDefined(); expect(first!.text).toContain("public.txt"); expect(JSON.stringify(first)).not.toContain("PRIVATE_FILE_MARKER"); expect(JSON.stringify(first)).not.toContain("PRIVATE_CONTENT_MARKER"); if (first) facts.ack("claude", first.id);
  writeFileSync(join(dir, "data/private/PRIVATE_FILE_MARKER.txt"), "PRIVATE_CHANGED_MARKER");
  facts.codexItem("codex", { type: "fileChange", status: "completed", changes: [{ path: join(dir, "data/private/PRIVATE_FILE_MARKER.txt"), kind: { type: "update" }, diff: "+PRIVATE_CHANGED_MARKER" }] });
  const after = facts.due("claude"); expect(JSON.stringify(after) ?? "").not.toContain("PRIVATE_CHANGED_MARKER"); expect(JSON.stringify(after) ?? "").not.toContain("PRIVATE_FILE_MARKER");
});

test("read-only hardlink identity refusal is stable for the protected original and its ordinary alias (#259)", () => {
  const dir = root(); mkdirSync(join(dir, "data/raw"), { recursive: true }); writeFileSync(join(dir, "data/raw/input.json"), "original"); linkSync(join(dir, "data/raw/input.json"), join(dir, "alias.json"));
  for (const path of ["data/raw/input.json", "alias.json"]) {
    expect(() => guardPath({ cwd: dir, deny: [], readOnly: ["data/raw"] }, path, "write")).toThrow("hardlinked");
    expect(guardPath({ cwd: dir, deny: [], readOnly: ["data/raw"] }, path, "read")).toBeDefined();
  }
  expect(readFileSync(join(dir, "data/raw/input.json"), "utf8")).toBe("original");
});
test("glob policies match decomposed, compatibility and long-s spellings of protected names", async () => {
  const dir = root(), nfd = "학생자료".normalize("NFD"), accented = "données".normalize("NFD");
  mkdirSync(join(dir, nfd)); writeFileSync(join(dir, nfd, "a.csv"), "original");
  mkdirSync(join(dir, accented)); writeFileSync(join(dir, accented, "b.csv"), "original");
  mkdirSync(join(dir, "data/ſecret"), { recursive: true });
  expect(matchesPolicy(dir, nfd + "/a.csv", ["학생자료/**"])).toBe(true);
  expect(matchesPolicy(dir, nfd + "/new.csv", ["학생자료/*.csv"])).toBe(true);
  expect(matchesPolicy(dir, accented + "/b.csv", ["données/*.csv"])).toBe(true);
  expect(matchesPolicy(dir, "data/ſecret/x", ["data/sec*"])).toBe(true);
  expect(matchesPolicy(dir, "other/a.csv", ["학생자료/**"])).toBe(false);
  mkdirSync(join(dir, "single")); for (const name of ["ß.txt", "ﬁ.txt"]) writeFileSync(join(dir, "single", name), "x");
  for (const name of ["ß.txt", "ﬁ.txt"]) expect(matchesPolicy(dir, "single/" + name, ["single/?.txt"])).toBe(true); // a fold that expands keeps ? matching
  // an exact entry keeps matching every spelling it matched before folding (U+0130 then a combining mark reorders)
  expect(matchesPolicy(dir, "i\u0307\u0338/new.csv", ["\u0130\u0338"])).toBe(true);
  expect(matchesPolicy(dir, "\u0130\u0338/new.csv", ["i\u0307\u0338"])).toBe(true);
  // a directory matching the pattern by its folded spelling is still searched for a matching alias below it
  mkdirSync(join(dir, "other")); mkdirSync(join(dir, "ss")); symlinkSync("../other", join(dir, "ss/ß")); mkdirSync(join(dir, "x")); symlinkSync("../other", join(dir, "x/x"));
  expect(matchesPolicy(dir, "other/f.csv", ["**/ß"])).toBe(true);
  expect(matchesPolicy(dir, "other/f.csv", ["**/x"])).toBe(true);
  // a trailing ** does not walk its whole matched subtree for a path outside it: a cycle there leaves other paths public
  mkdirSync(join(dir, "bulk")); symlinkSync(".", join(dir, "bulk/loop"));
  expect(matchesPolicy(dir, "other/f.csv", ["bulk/**"])).toBe(false);
  const ctx: ToolContext = { cwd: dir, deny: [], readOnly: ["학생자료/**"], sandboxProfile: "", permit: async () => true, send: () => "sent" };
  expect(await runTool("write", JSON.stringify({ path: nfd + "/a.csv", content: "mutated" }), ctx)).toContain("data.readonly");
  expect(readFileSync(join(dir, nfd, "a.csv"), "utf8")).toBe("original");
  // A future alias target outside the configured tree needs beneath's lowercase leg, not a glob-prefix fallback.
  const aliasDir = root(); mkdirSync(join(aliasDir, "alias-root")); symlinkSync("../İ̸", join(aliasDir, "alias-root/link"));
  for (const policy of ["alias-root", "alias-root/**"]) expect(matchesPolicy(aliasDir, "i̸̇/new.csv", [policy])).toBe(true);
});

// #541: Bun's realpath sometimes names ANOTHER link of a hardlinked file (about 1 call in 100 on macOS APFS; the system realpath never does).
// guardPath judges the name the caller typed as well, so a denied name is refused and a hub-owned name is not writable whichever link realpath picks.
// Each leg runs enough iterations that an unfixed guard fails with overwhelming probability (1 percent per call: 5000 calls miss it with probability e^-50).
const ITERATIONS = 5000;
function hardlinkLoop(layout: (dir: string) => { original: string; link: string }, attempt: (dir: string, link: string) => void): void {
  const base = root();
  for (let i = 0; i < ITERATIONS; i++) {
    const dir = join(base, `d${i}`); mkdirSync(join(dir, "data/raw"), { recursive: true }); mkdirSync(join(dir, "secrets"), { recursive: true });
    const { original, link } = layout(dir);
    writeFileSync(join(dir, original), "k=v"); linkSync(join(dir, original), join(dir, link));
    attempt(dir, link);
  }
}
test("a denied name that is a hardlink of an innocent file is refused on every call, whichever link realpath names (#541)", () => {
  let permitted = 0;
  for (const [original, link] of [["data/raw/input.json", ".env"], ["data/raw/input.json", "secrets/.env"], ["notes.txt", "secrets/id_rsa"]] as const) {
    hardlinkLoop(() => ({ original, link }), (dir, name) => { try { guardPath({ cwd: dir, deny: [] }, name, "read"); permitted++; } catch { /* refused, as required */ } });
  }
  expect(permitted).toBe(0);
}, 20_000);
test("the denied original of an innocent alias is refused by its own name on every call (#541)", () => {
  // The reverse layout: the denied file was created first and the innocent name is the later link. The alias itself carries no denied name, so no guard that
  // sees one name can refuse it reliably (it is refused whenever realpath names the original: fail closed, never required); the denied name itself must never pass.
  let permitted = 0;
  hardlinkLoop(() => ({ original: "secrets/.env", link: "notes.txt" }), (dir) => { try { guardPath({ cwd: dir, deny: [] }, "secrets/.env", "read"); permitted++; } catch { /* refused, as required */ } });
  expect(permitted).toBe(0);
}, 20_000);
test("a hub-owned name that is the later hardlink of an innocent file stays unwritable on every call (#541)", () => {
  // The hub-owned name must be the LATER link: Bun's realpath flips from the later link to the earlier one, so a typed `.agenthub/...` can resolve to an innocent name.
  let permitted = 0;
  hardlinkLoop(() => ({ original: "data/raw/input.json", link: "data/raw/hardlink.json" }), (dir) => {
    mkdirSync(join(dir, ".agenthub"), { recursive: true }); linkSync(join(dir, "data/raw/input.json"), join(dir, ".agenthub/hub.json"));
    try { guardPath({ cwd: dir, deny: [] }, ".agenthub/hub.json", "write"); permitted++; } catch { /* refused, as required */ }
  });
  expect(permitted).toBe(0);
}, 20_000);
test("the write-side hardlink refusal and the permitted write of an ordinary file are unchanged on every call (#541)", () => {
  hardlinkLoop(() => ({ original: "data/raw/input.json", link: "data/raw/hardlink.json" }), (dir, name) => {
    expect(() => guardPath({ cwd: dir, deny: [], readOnly: ["data/raw"] }, name, "write")).toThrow("hardlinked");
    expect(statSync(guardPath({ cwd: dir, deny: [] }, name, "write")).ino).toBe(statSync(join(dir, name)).ino);
  });
}, 20_000);
test("a symlink to a denied file is refused by the name it resolves to, and a hub-owned symlink target is not writable (#541)", () => {
  // The resolved name still counts: the typed name alone would pass these.
  const dir = root(); mkdirSync(join(dir, "secrets"), { recursive: true }); mkdirSync(join(dir, ".agenthub"), { recursive: true });
  writeFileSync(join(dir, "secrets/.env"), "k=v"); symlinkSync("secrets/.env", join(dir, "notes.txt"));
  writeFileSync(join(dir, ".agenthub/hub.json"), "{}"); symlinkSync(".agenthub/hub.json", join(dir, "plain.json"));
  expect(() => guardPath({ cwd: dir, deny: [] }, "notes.txt", "read")).toThrow("denylist");
  expect(() => guardPath({ cwd: dir, deny: [] }, "plain.json", "write")).toThrow("not writable");
});
test("the typed name is judged relative to the project, so a project under a denied-looking parent still works (#541)", () => {
  const dir = join(root(), ".agenthub/archive/project"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "ok.txt"), "fine");
  expect(guardPath({ cwd: dir, deny: [] }, "ok.txt", "read")).toBe(join(realPath(dir), "ok.txt"));
  expect(guardPath({ cwd: dir, deny: [] }, "ok.txt", "write")).toBe(join(realPath(dir), "ok.txt"));
});

// #555: the typed-name checks of guardPath judge only names INSIDE the project (insideRoot, #944), as Facts.rel and the deliverable vetting do. A typed name outside it
// that resolves to an ordinary file inside is accepted; an inside typed name that is denied or hub-owned is still refused although it resolves to an innocent file.
test("guardPath: a typed name outside the project that resolves to an ordinary file inside it is accepted, in read and write mode", () => {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-guard-outside-"))); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "p"), elsewhere = join(base, "o");
  mkdirSync(join(dir, "docs"), { recursive: true }); mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(dir, "docs/ok.txt"), "ok");
  symlinkSync(join(dir, "docs/ok.txt"), join(elsewhere, ".env")); symlinkSync(join(dir, "docs/ok.txt"), join(elsewhere, "config")); mkdirSync(join(elsewhere, ".git"));
  symlinkSync(join(dir, "docs/ok.txt"), join(elsewhere, ".git/config"));
  const ctx = { cwd: dir, deny: [".env", "**/.env"] };
  for (const mode of ["read", "write"] as const) {
    expect(guardPath(ctx, join(elsewhere, ".env"), mode)).toBe(join(dir, "docs/ok.txt")); // typed `../o/.env`: denied by name if it were inside, but it is not
    expect(guardPath(ctx, join(elsewhere, ".git/config"), mode)).toBe(join(dir, "docs/ok.txt")); // typed `../o/.git/config`: hub-owned by name if it were inside
  }
  expect(() => guardPath(ctx, "../o-not-a-link/x", "read")).toThrow("outside the project directory"); // containment stays on the resolved path
});

test("guardPath: an inside typed name that is denied or hub-owned is refused even when the file is an innocent one", () => {
  const dir = root(); mkdirSync(join(dir, "docs"), { recursive: true }); mkdirSync(join(dir, ".agenthub"), { recursive: true });
  writeFileSync(join(dir, "docs/ok.txt"), "ok");
  linkSync(join(dir, "docs/ok.txt"), join(dir, ".env")); linkSync(join(dir, "docs/ok.txt"), join(dir, ".agenthub/state.json"));
  const ctx = { cwd: dir, deny: [".env", "**/.env"] };
  expect(() => guardPath(ctx, ".env", "read")).toThrow("secrets denylist");
  expect(() => guardPath(ctx, ".env", "write")).toThrow("secrets denylist");
  expect(() => guardPath(ctx, ".agenthub/state.json", "write")).toThrow("not writable by the local worker");
  expect(guardPath(ctx, "docs/ok.txt", "write")).toBe(join(dir, "docs/ok.txt"));
});
