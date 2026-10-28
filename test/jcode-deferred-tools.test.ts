import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpPeer } from "../src/adapters/acp.ts";
import { JcodePeer, jcodePreamble } from "../src/adapters/jcode.ts";
import { configureJcodeMcp, JCODE_MCP_NAME } from "../src/cli/jcode-mcp.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { HUB_MESSAGE_INSTRUCTION, JCODE_DEFERRED_TOOLS_INSTRUCTION, newEnvelope, renderDigest, STANDING_INSTRUCTION } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { profileTaskTools } from "../src/hub/hub-tools.ts";

// agent-hub #912 (hub task #543): Jcode defers MCP tools, so its session instruction says to load the hub tools before deciding they are missing.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = () => { const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-jcode-deferred-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const until = async (condition: () => boolean, what = "condition") => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(10); expect(condition(), what).toBe(true); };
const fake = [process.execPath, join(import.meta.dir, "fakes/jcode-agent.ts")];
const prompts = (record: string): string[] => readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.kind === "rpc" && row.method === "session/prompt").map(row => String(row.params.prompt[0].text));
const home = (dir: string) => { const h = join(dir, "home"); mkdirSync(h); writeFileSync(join(h, "mcp.json"), "{}"); return h; };

test("the guidance names the server and the tools, says to search and load before concluding a tool is missing, and forbids reporting the hub unavailable unsearched", () => {
  const text = JCODE_DEFERRED_TOOLS_INSTRUCTION;
  expect(text).toContain(JCODE_MCP_NAME); // the server name of the project's .jcode/mcp.json entry: one source, pinned here
  expect(text).toContain("deferred MCP tools");
  for (const name of ["hub_send", "hub_task_accept", "hub_task_done", "hub_review"]) expect(text).toContain(name);
  expect(text).toMatch(/search for it by name/);
  expect(text).toContain("Never report the hub as unavailable without having searched");
  // every hub tool it names exists, so the instruction cannot name a tool the server does not offer
  const offered = new Set([...profileTaskTools("dev").map(tool => tool.name), "hub_send", "hub_inbox"]);
  for (const name of text.match(/hub_[a-z_]+/g)!) expect(offered.has(name), name).toBe(true);
});

test("a Jcode peer sends the guidance once, with its first prompt, ahead of the role contract and the delivered items", async () => {
  const dir = root(), record = join(dir, "record");
  const peer = new JcodePeer({ command: [...fake, "--record", record], cwd: dir, home: home(dir), preamble: "ROLE_CONTRACT_MARKER" });
  cleanups.push(() => peer.stop());
  await peer.start();
  await peer.deliver([newEnvelope("user", "FIRST_ITEM", { to: ["jcode"] })]);
  await until(() => peer.state === "idle", "first turn");
  await peer.deliver([newEnvelope("user", "SECOND_ITEM", { to: ["jcode"] })]);
  await until(() => prompts(record).length === 2 && peer.state === "idle", "second turn");
  const [first, second] = prompts(record) as [string, string];
  expect(first.indexOf(JCODE_DEFERRED_TOOLS_INSTRUCTION)).toBe(0);
  expect(first.indexOf("ROLE_CONTRACT_MARKER")).toBeGreaterThan(JCODE_DEFERRED_TOOLS_INSTRUCTION.length - 1);
  expect(first.indexOf("ROLE_CONTRACT_MARKER")).toBeLessThan(first.indexOf("FIRST_ITEM"));
  expect(first).toContain(STANDING_INSTRUCTION); // the ordinary first-prompt framing is still there
  expect(second).toContain("SECOND_ITEM");
  expect(second).not.toContain(JCODE_DEFERRED_TOOLS_INSTRUCTION); // once per session, not per turn
  expect(second).not.toContain("ROLE_CONTRACT_MARKER");
});

test("a Jcode peer with no role contract still carries the guidance, so no start path can lack it", async () => {
  expect(jcodePreamble()).toBe(JCODE_DEFERRED_TOOLS_INSTRUCTION);
  expect(jcodePreamble("ROLE")).toBe(`${JCODE_DEFERRED_TOOLS_INSTRUCTION}\n\nROLE`);
  const dir = root(), record = join(dir, "record");
  const peer = new JcodePeer({ command: [...fake, "--record", record], cwd: dir, home: home(dir) });
  cleanups.push(() => peer.stop());
  await peer.start();
  await peer.deliver([newEnvelope("user", "ONLY_ITEM", { to: ["jcode"] })]);
  await until(() => peer.state === "idle", "turn");
  expect(prompts(record)[0]!.startsWith(JCODE_DEFERRED_TOOLS_INSTRUCTION)).toBe(true);
});

test("an extra Jcode instance gets it too", async () => {
  const dir = root(), record = join(dir, "record");
  const peer = new JcodePeer({ peer: "jcode-extra", command: [...fake, "--record", record], cwd: dir, home: home(dir) });
  cleanups.push(() => peer.stop());
  await peer.start();
  await peer.deliver([newEnvelope("user", "X", { to: ["jcode-extra"] })]);
  await until(() => peer.state === "idle", "turn");
  expect(prompts(record)[0]).toContain(JCODE_DEFERRED_TOOLS_INSTRUCTION);
});

test("other peers' instructions do not change: an ACP peer, and the standing instruction every other peer gets, carry no Jcode guidance", async () => {
  expect(STANDING_INSTRUCTION).not.toContain("deferred");
  expect(STANDING_INSTRUCTION).not.toContain(JCODE_MCP_NAME);
  expect(HUB_MESSAGE_INSTRUCTION).not.toContain("deferred");
  expect(renderDigest([newEnvelope("user", "x")], false)).not.toContain("deferred MCP tools");
  expect(renderDigest([newEnvelope("user", "x")], true)).not.toContain("deferred MCP tools");
  const dir = root(), record = join(dir, "acp-record");
  const kimi = new AcpPeer("kimi", { cwd: dir, cmd: [process.execPath, join(import.meta.dir, "fakes/role-acp.ts"), record], preamble: "KIMI_ROLE" });
  cleanups.push(() => kimi.stop());
  await kimi.start();
  await kimi.deliver([newEnvelope("user", "hello", { to: ["kimi"] })]);
  await until(() => kimi.state === "idle", "kimi turn");
  const sent = readFileSync(record, "utf8");
  expect(sent).toContain("KIMI_ROLE");
  expect(sent).not.toContain("deferred MCP tools");
  expect(sent).not.toContain(JCODE_MCP_NAME);
});

test("the hub's own role contract path reaches a daemon-started Jcode with the guidance first and the role contract after it", async () => {
  const dir = root(), stateDir = join(dir, "state"), h = home(dir), record = join(dir, "native.jsonl");
  configureJcodeMcp(dir, stateDir, join(import.meta.dir, "../plugins/agent-hub/server.js"));
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, jcode_cmd: [...fake, "--record", record], jcode_home: h, roster: { jcode: true }, roles: { ...DEFAULT_CONFIG.roles, jcode: ["implementer"] }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
  expect((await client.request({ t: "start", peer: "jcode", args: { mode: "headless" } })).ok).toBe(true);
  daemon.bus.publish(newEnvelope("user", "DAEMON_ITEM", { to: ["jcode"], priority: "important" }));
  await until(() => { try { return prompts(record).length > 0; } catch { return false; } }, "the first prompt");
  const first = prompts(record)[0]!;
  expect(first.startsWith(JCODE_DEFERRED_TOOLS_INSTRUCTION)).toBe(true);
  expect(first).toContain("implementer"); // the hub's role contract follows
  expect(first.indexOf("implementer")).toBeGreaterThan(JCODE_DEFERRED_TOOLS_INSTRUCTION.length);
  expect(first).toContain("DAEMON_ITEM");
});

test("the rendered AGENTS blocks stay consistent and carry no copy of the guidance: one place, the session instruction", () => {
  const block = readFileSync(join(import.meta.dir, "../templates/AGENTS.block.md"), "utf8");
  const jcodeLine = (text: string) => text.split("\n").filter(line => line.includes("Qwen and Jcode"));
  expect(jcodeLine(block)).toHaveLength(1);
  const needle = /deferred MCP|tool search|agent-hub-jcode/i;
  expect(block).not.toMatch(needle);
  for (const name of ["general", "research", "writing"]) {
    const agents = JSON.parse(readFileSync(join(import.meta.dir, `../templates/profiles/${name}.json`), "utf8")).agents as string;
    expect(agents, name).not.toMatch(needle);
    expect(jcodeLine(agents), name).toEqual(jcodeLine(block)); // the Jcode bullet is the same text in every template
  }
  // the repository's own managed block is the template, so it holds no copy either
  expect(readFileSync(join(import.meta.dir, "../AGENTS.md"), "utf8")).not.toContain(JCODE_DEFERRED_TOOLS_INSTRUCTION);
});
