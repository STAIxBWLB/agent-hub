import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessVersion, COMPAT, readTrust, trustFile, VERSION_REFUSAL, writeTrust, type CompatId } from "../src/adapters/compat.ts";
import { agyVersionGate } from "../src/adapters/agy/entry.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "ahub-compat-")), "agent-compat.json");

test("a verified version passes, a contract gate admits its line as untested, anything else is refused with versions and the trust command (#691)", () => {
  expect(assessVersion("codex-review", "0.146.0", [])).toEqual({ ok: true, state: "verified", version: "0.146.0" });
  const refused = assessVersion("codex-review", "0.165.0", []);
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.reason.startsWith(VERSION_REFUSAL)).toBe(true);
    expect(refused.reason).toContain("0.165.0");
    expect(refused.reason).toContain("verified 0.146.0, 0.163.0, 0.164.0, 0.166.0");
    expect(refused.reason).toContain("ahub agents trust codex-review 0.165.0");
  }
  // An isolation gate has no line: a newer minor is refused, not assumed compatible.
  expect(assessVersion("kimi-review", "2.4.0", []).ok).toBe(false);
  const line = assessVersion("agy", "1.4.4", []);
  expect(line).toMatchObject({ ok: true, state: "in-line", version: "1.4.4" });
  for (const v of ["1.5.0", "1.3.9", "1.4.3-beta", "agy 1.4.2", "", undefined, 142]) expect(assessVersion("agy", v, []).ok).toBe(false);
  expect(assessVersion("agy", undefined, [])).toMatchObject({ ok: false, state: "unknown" });
});

test("the person's trust admits exactly that version of that kind, and nothing else (#691)", () => {
  const trusted = [{ id: "codex-review" as const, version: "0.165.0", at: 1 }];
  expect(assessVersion("codex-review", "0.165.0", trusted)).toMatchObject({ ok: true, state: "trusted" });
  expect(assessVersion("codex-review", "0.165.1", trusted).ok).toBe(false);
  expect(assessVersion("kimi-review", "0.165.0", trusted).ok).toBe(false);
});

test("trust is written atomically, revocable, and an invalid record trusts nothing (#691)", () => {
  const path = file();
  expect(readTrust(path)).toEqual([]);
  expect(writeTrust("agy", "1.5.0", false, path, 5)).toEqual([{ id: "agy", version: "1.5.0", at: 5 }]);
  expect(writeTrust("agy", "1.5.0", false, path, 6)).toEqual([{ id: "agy", version: "1.5.0", at: 6 }]);
  expect(readTrust(path)).toEqual([{ id: "agy", version: "1.5.0", at: 6 }]);
  expect(writeTrust("agy", "1.5.0", true, path)).toEqual([]);
  expect(() => writeTrust("agy", "v1.5", false, path)).toThrow("exact version");
  for (const bad of ["not json", JSON.stringify({ schemaVersion: 2, trusted: [] }), JSON.stringify({ schemaVersion: 1, trusted: [{ id: "agy", version: "1.5.0", at: 1 }, { id: "nope", version: "1.0.0", at: 1 }] })]) {
    writeFileSync(path, bad);
    expect(readTrust(path)).toEqual([]);
  }
  expect(JSON.parse(readFileSync(path, "utf8")).trusted.length).toBe(2);
  expect(trustFile("/h")).toBe("/h/agent-compat.json");
});

test("every gated kind declares its verified set; contract lines are well-formed (#691)", () => {
  for (const [id, policy] of Object.entries(COMPAT)) {
    expect(policy.verified.length).toBeGreaterThan(0);
    for (const v of policy.verified) expect(assessVersion(id as keyof typeof COMPAT, v, [])).toMatchObject({ ok: true, state: "verified" });
    if ("line" in policy) expect(policy.gate).toBe("contract");
  }
  expect(COMPAT["codex-review"].parse("codex-cli 0.165.0\n")).toBe("0.165.0");
  expect(COMPAT.jcode.parse('{"semver":"0.99.0"}')).toBe("0.99.0");
  expect(COMPAT.jcode.parse("garbage")).toBeUndefined();
});

test("the agy launcher reports the compat verdict (#691)", () => {
  expect(agyVersionGate("1.4.2\n")).toEqual({ ok: true });
  const off = agyVersionGate("1.5.0\n");
  expect(off.ok).toBe(false);
  expect(off.message).toContain("ahub agents trust agy 1.5.0");
});

test("reading agent versions is allowed for agents; trusting one is the person's (#691)", () => {
  expect(classifyPeerCommand("agents", [])).toBe("allowed");
  expect(classifyPeerCommand("agents", ["--json"])).toBe("allowed");
  expect(classifyPeerCommand("agents", ["trust", "codex-review", "0.165.0"])).toBe("console");
  expect(classifyPeerCommand("agents", ["trust", "codex-review", "0.165.0", "--revoke"])).toBe("console");
});

test("a live-test delegation never reaches trust or revoke; reading stays allowed (#691)", async () => {
  const { liveTestRefusal } = await import("../src/cli/identity.ts");
  expect(liveTestRefusal("agents", ["trust", "agy", "1.5.0"])).toBe(true);
  expect(liveTestRefusal("agents", ["trust", "agy", "1.5.0", "--revoke"])).toBe(true);
  expect(liveTestRefusal("agents", ["--json", "trust", "agy", "1.5.0"])).toBe(true);
  expect(liveTestRefusal("agents", [])).toBe(false);
  expect(liveTestRefusal("agents", ["--json"])).toBe(false);
  const { realPath } = await import("../src/hub/project.ts");
  const { mkdirSync, existsSync, rmSync } = await import("node:fs");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-compat-cli-"))), home = join(root, "home"), cli = join(import.meta.dir, "../src/cli/main.ts");
  mkdirSync(join(root, ".agenthub/state"), { recursive: true }); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  try {
    for (const live of [true, false]) for (const extra of [[], ["--revoke"]]) {
      const wrapper = join(root, "invoke.ts");
      writeFileSync(wrapper, `for (const key of ["CLAUDECODE","CLAUDE_CODE_SESSION_ID","CODEX_THREAD_ID","AGENTHUB_PROJECT_DIR","AGENTHUB_STATE_DIR","AGENTHUB_INSTANCE_ID"]) delete process.env[key];
Object.assign(process.env,{AGENTHUB_PEER_ID:"codex",AGENTHUB_HOME:${JSON.stringify(home)}});
process.argv=[process.execPath,${JSON.stringify(cli)},"--project",${JSON.stringify(root)},${live ? '"--live-test",' : ""}"agents","trust","agy","1.5.0",...${JSON.stringify(extra)}];
await import(${JSON.stringify(cli)});`);
      const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr).toBe(1);
      expect(existsSync(trustFile(home))).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("a planted temporary link or a linked record never carries trust or loses another file's bytes (#691)", async () => {
  const { symlinkSync, linkSync, readdirSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ahub-compat-link-")), path = join(dir, "agent-compat.json"), canary = join(dir, "canary");
  writeFileSync(canary, "canary");
  // Old predictable names are no longer used; a link planted at any name is never written through.
  symlinkSync(canary, `${path}.${process.pid}.tmp`);
  writeTrust("agy", "1.5.0", false, path, 1);
  expect(readFileSync(canary, "utf8")).toBe("canary");
  expect(readTrust(path)).toEqual([{ id: "agy", version: "1.5.0", at: 1 }]);
  // A hard-linked record is replaced, not truncated through the other name.
  const twin = join(dir, "twin"); linkSync(path, twin);
  const before = readFileSync(twin, "utf8");
  writeTrust("agy", "1.6.0", false, path, 2);
  expect(readFileSync(twin, "utf8")).toBe(before);
  // A record that is a link, oversized, or a link target refuses: nothing is trusted, nothing is written.
  const linked = join(dir, "linked.json"); symlinkSync(path, linked);
  expect(readTrust(linked)).toEqual([]);
  expect(() => writeTrust("agy", "1.7.0", false, linked)).toThrow("not a regular file");
  const big = join(dir, "big.json"); writeFileSync(big, JSON.stringify({ schemaVersion: 1, trusted: [], pad: "x".repeat(70_000) }));
  expect(readTrust(big)).toEqual([]);
  const linkedHome = join(dir, "linked-home"); mkdirSync(join(dir, "real-home")); symlinkSync(join(dir, "real-home"), linkedHome);
  expect(() => writeTrust("agy", "1.5.0", false, join(linkedHome, "agent-compat.json"))).toThrow("plain directory");
  expect(readdirSync(dir).filter(name => name.endsWith(".tmp") && !name.includes(String(process.pid)))).toEqual([]);
});

test("trust says what it covers before anything is recorded (#691)", async () => {
  const { spyOn } = await import("bun:test");
  const { runAgents } = await import("../src/cli/agents.ts");
  const { mkdirSync, rmSync } = await import("node:fs");
  // Make the record path a directory so the write fails after the disclosure.
  rmSync(trustFile(), { recursive: true, force: true });
  mkdirSync(trustFile(), { recursive: true });
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
  try {
    expect(() => runAgents(["trust", "codex-review", "0.165.0"], {}, message => { throw new Error(message); })).toThrow();
    expect(lines.join("\n")).toContain(COMPAT["codex-review"].trustNote);
  } finally { log.mockRestore(); (await import("node:fs")).rmSync(trustFile(), { recursive: true, force: true }); }
});

test("a FIFO at the record path neither blocks nor trusts (#691)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-compat-fifo-")), path = join(dir, "agent-compat.json");
  expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
  const started = performance.now();
  expect(readTrust(path)).toEqual([]);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(assessVersion("codex-review", "0.165.0", readTrust(path)).ok).toBe(false);
  expect(() => writeTrust("agy", "1.5.0", false, path)).toThrow("not a regular file");
});

test("the daemon's Jcode preflight does not block the event loop and stops its whole group at the deadline (#691)", async () => {
  const { jcodeVersionAsync } = await import("../src/adapters/jcode.ts");
  const { chmodSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ahub-compat-jcode-")), slow = join(dir, "jcode"), pidFile = join(dir, "descendant.pid");
  // A wrapper whose descendant would outlive a direct-child kill.
  writeFileSync(slow, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`); chmodSync(slow, 0o700);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  const started = performance.now();
  const verdict = await jcodeVersionAsync([slow], dir, 300);
  clearInterval(timer);
  expect(verdict.ok).toBe(false);
  expect(performance.now() - started).toBeLessThan(5000);
  expect(ticks).toBeGreaterThan(5);
  const descendant = Number(readFileSync(pidFile, "utf8"));
  expect(() => process.kill(descendant, 0)).toThrow();
  const fake = join(import.meta.dir, "../src/adapters/conformance/fakes/jcode-agent.ts");
  expect(await jcodeVersionAsync([process.execPath, fake], dir)).toMatchObject({ ok: true, state: "verified", version: "0.98.1" });
}, 20_000);

test("the Jcode preflight stops a probe whose output passes 64 KiB instead of buffering it (#691)", async () => {
  const { jcodeVersionAsync } = await import("../src/adapters/jcode.ts");
  const { chmodSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ahub-compat-jcode-flood-")), flood = join(dir, "jcode");
  writeFileSync(flood, "#!/bin/sh\nwhile :; do printf '%01024d' 0; done\n"); chmodSync(flood, 0o700);
  const started = performance.now();
  expect((await jcodeVersionAsync([flood], dir, 10_000)).ok).toBe(false);
  expect(performance.now() - started).toBeLessThan(5000);
}, 20_000);

test("the agent-compat step accepts only a clean run or a reported drift; a crash, an empty drift or another code fails (#691)", () => {
  const step = join(import.meta.dir, "../scripts/agent-compat-step.sh");
  const run = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), "ahub-compat-step-")), out = join(dir, "out"), report = join(dir, "report.md");
    writeFileSync(out, "");
    const result = Bun.spawnSync(["bash", step, report, "bash", "-c", script], { env: { ...process.env, GITHUB_OUTPUT: out } });
    return { code: result.exitCode, out: readFileSync(out, "utf8") };
  };
  expect(run("echo all verified; exit 0")).toEqual({ code: 0, out: "ahead=false\n" });
  expect(run("echo 'Published agent CLI versions ahead of their verified set (x).'; echo '- row'; exit 3")).toEqual({ code: 0, out: "ahead=true\n" });
  for (const crash of ["echo 'TypeError: boom' >&2; exit 1", "exit 3", "echo junk; exit 3", "exit 7"]) expect(run(crash)).toEqual({ code: 1, out: "" });
});

test("a refused Qwen version names itself and the trust command, keeping the identity contract text (#691)", async () => {
  const { qwenNativeIdentity } = await import("../src/adapters/definitions/qwen-native.ts");
  expect(() => qwenNativeIdentity("qwen", true, { agentInfo: { name: "qwen-code", version: "0.27.0" } })).toThrow(/native identity is not verified: Version not verified: Qwen Code 0\.27\.0 .*ahub agents trust qwen 0\.27\.0/);
  expect(qwenNativeIdentity("qwen", true, { agentInfo: { name: "qwen-code", version: "0.25.0" } })).toBe(true);
});

test("the probe's output collector never keeps more than its cap, and refuses everything after (#691)", async () => {
  const { boundedOutput } = await import("../src/adapters/jcode.ts");
  const output = boundedOutput(64 * 1024), chunk = Buffer.alloc(16 * 1024, 120);
  let accepted = 0;
  for (let i = 0; i < 64; i++) if (output.push(chunk)) accepted++; // 1 MiB offered
  expect(accepted).toBe(4);
  expect(output.size).toBe(64 * 1024);
  expect(output.text().length).toBe(64 * 1024);
  expect(output.overflowed).toBe(true);
  expect(output.push(Buffer.from("x"))).toBe(false);
  expect(output.size).toBe(64 * 1024);
});


test("Codex reviewer 0.163.0 is receipt-verified without machine trust (#371)", () => {
  expect(assessVersion("codex-review", "0.163.0", [])).toMatchObject({ ok: true, state: "verified", version: "0.163.0" });
});

test("Codex reviewer 0.164.0 is receipt-verified without machine trust, and its neighbours are not (#757)", () => {
  expect(assessVersion("codex-review", "0.164.0", [])).toMatchObject({ ok: true, state: "verified", version: "0.164.0" });
  expect(COMPAT["codex-review"].verified).toEqual(["0.146.0", "0.163.0", "0.164.0", "0.166.0"]);
  for (const near of ["0.164.1", "0.165.0", "0.164.0-rc.1", "0.164", "codex-cli 0.164.0"]) expect(assessVersion("codex-review", near, []).ok).toBe(false);
  expect(COMPAT["codex-review"].parse("codex-cli 0.164.0\n")).toBe("0.164.0");
});


test("Codex reviewer 0.166.0 is receipt-verified without machine trust, and nearby versions stay refused (#888)", () => {
  expect(assessVersion("codex-review", "0.166.0", [])).toMatchObject({ ok: true, state: "verified", version: "0.166.0" });
  expect(COMPAT["codex-review"].verified).toEqual(["0.146.0", "0.163.0", "0.164.0", "0.166.0"]);
  for (const near of ["0.165.0", "0.166.1", "0.167.0", "0.166.0-rc.1", "codex-cli 0.166.0"]) expect(assessVersion("codex-review", near, []).ok).toBe(false);
});

test("Kimi 2.3.0 and Qwen 0.26.0 are receipt-verified without machine trust (#373)", () => {
  expect(assessVersion("kimi-review", "2.3.0", [])).toEqual({ ok: true, state: "verified", version: "2.3.0" });
  expect(assessVersion("qwen", "0.26.0", [])).toEqual({ ok: true, state: "verified", version: "0.26.0" });
});

test("Claude 2.1.309 and 2.1.310 are receipt-verified without machine trust; their neighbours are not (#843)", () => {
  for (const version of ["2.1.309", "2.1.310"]) expect(assessVersion("claude-implementer", version, [])).toEqual({ ok: true, state: "verified", version });
  for (const near of ["2.1.308", "2.1.311", "2.1.310-rc.1", "2.2.0"]) expect(assessVersion("claude-implementer", near, []).ok).toBe(false);
});

test("Claude 2.1.314 is receipt-verified without machine trust; 2.1.311-2.1.313 and 2.1.315 are not (#888)", () => {
  expect(assessVersion("claude-implementer", "2.1.314", [])).toEqual({ ok: true, state: "verified", version: "2.1.314" });
  for (const near of ["2.1.311", "2.1.312", "2.1.313", "2.1.315", "2.1.314-rc.1"]) expect(assessVersion("claude-implementer", near, []).ok).toBe(false);
});

test("Claude 2.1.316 is receipt-verified without machine trust; 2.1.315 and 2.1.317 are not (#888)", () => {
  expect(assessVersion("claude-implementer", "2.1.316", [])).toEqual({ ok: true, state: "verified", version: "2.1.316" });
  for (const near of ["2.1.315", "2.1.317", "2.1.316-rc.1", "2.2.0"]) expect(assessVersion("claude-implementer", near, []).ok).toBe(false);
});

test("Kimi 2.3.1 and 2.3.2 are receipt-verified without machine trust; their neighbours are not (#792, #843)", () => {
  for (const version of ["2.3.1", "2.3.2"]) expect(assessVersion("kimi-review", version, [])).toEqual({ ok: true, state: "verified", version });
  for (const near of ["2.3.3", "2.4.0", "2.3.2-rc.1"]) expect(assessVersion("kimi-review", near, []).ok).toBe(false);
});

test("Qwen 0.26.1 is receipt-verified without machine trust; its neighbours are not (#843 AC5)", () => {
  expect(assessVersion("qwen", "0.26.1", [])).toEqual({ ok: true, state: "verified", version: "0.26.1" });
  for (const near of ["0.26.2", "0.27.0", "0.26.1-rc.1"]) expect(assessVersion("qwen", near, []).ok).toBe(false);
});

test("the compat watch covers every COMPAT source and renders ahead, unknown and no-public-source rows from an injected fetch (#843)", async () => {
  const { SOURCES, latestVersion, watch } = await import("../scripts/agent-compat-watch.ts");
  // Every key in SOURCES is a public source except agy, whose kind is "none". SOURCES is keyed by CompatId, so a pi
  // entry #843 AC2 adds is watched through the same SOURCES.pi hook asserted below, without touching this test.
  for (const id of Object.keys(SOURCES)) expect(id === "agy" || SOURCES[id]?.kind !== "none").toBe(true);
  expect(SOURCES.agy).toEqual({ kind: "none" });
  expect(SOURCES["claude-implementer"]).toEqual({ kind: "npm", pkg: "@anthropic-ai/claude-code" });
  expect(SOURCES.jcode).toEqual({ kind: "github", repo: "1jehuang/jcode" });
  expect(SOURCES["qwen-dual"]).toEqual({ kind: "npm", pkg: "@qwen-code/qwen-code" });
  expect(SOURCES.pi).toEqual({ kind: "npm", pkg: "@earendil-works/pi-coding-agent" }); // the hook: watched the moment #843 AC2 adds a COMPAT pi entry
  expect(await latestVersion({ kind: "github", repo: "x/y" }, async () => ({ json: async () => ({ tag_name: "v0.99.1" }) }))).toBe("0.99.1");
  expect(await latestVersion({ kind: "npm", pkg: "x" }, async () => { throw new Error("offline"); })).toBeUndefined();

  // The watched fixture is derived from COMPAT, not a fixed version list, so it survives a new COMPAT entry (pi, #843
  // AC2) without editing this test. Each public id is served its first fetch in COMPAT's key order (agy, kind none,
  // fetches nothing); qwen and qwen-dual read the same npm pkg but carry different verified sets, so serving each id
  // its own value in that order is what keeps them all verified. Every id's verified[0] is a plain semver.
  const publicOrder = Object.keys(COMPAT).filter(id => id !== "agy") as CompatId[];
  const owned = (id: CompatId, url: string): boolean => {
    const s = SOURCES[id];
    return s ? (s.kind === "npm" ? url.includes(s.pkg) : s.kind === "github" ? url.includes(s.repo) : false) : false;
  };
  // Hand each public id its first matching fetch as a body of its SOURCES kind's shape, unless forced ahead.
  const stub = (aheadOf?: Record<string, string>) => {
    const served: Record<string, string> = {};
    return ((url: string) => {
      const id = publicOrder.find(k => served[k] === undefined && owned(k, url));
      if (id) served[id] = url;
      const version = id ? (aheadOf?.[id] ?? COMPAT[id].verified[0]) : undefined;
      const source = id ? SOURCES[id] : undefined;
      return Promise.resolve({ json: async () => (source?.kind === "github" ? { tag_name: `v${version}` } : { version }) });
    }) as unknown as typeof fetch;
  };

  const allVerified = await watch(stub(), new Date("2026-10-26T00:00:00Z"));
  expect(allVerified.code).toBe(0);
  expect(allVerified.report).toContain("latest published version is verified");
  expect(allVerified.report).toContain("- **agy**: no public source; local drift only");
  expect(allVerified.report).not.toContain("Published agent CLI versions ahead");

  // The same walk with only claude-implementer forced to an unverified version: exit 3 with the drift header and that
  // id's drift row, while agy stays an informational notice (#843: a notice is never drift, so all-verified is exit 0).
  const driftId = publicOrder[0]!;
  const aheadVersion = "9.9.9";
  const ahead = await watch(stub({ [driftId]: aheadVersion }), new Date("2026-10-26T00:00:00Z"));
  expect(ahead.code).toBe(3);
  expect(ahead.report.startsWith("Published agent CLI versions ahead of their verified set")).toBe(true);
  const driftSource = SOURCES[driftId]!;
  const driftLabel = driftSource.kind === "npm" ? `npm ${driftSource.pkg}` : driftSource.kind === "github" ? `GitHub releases ${driftSource.repo}` : "no public source";
  const driftRow = ahead.report.split("\n").find(l => l.includes(`**${driftId}**`)) ?? "";
  expect(driftRow).toContain(driftLabel);
  expect(driftRow).toContain(`latest ${aheadVersion}`);
  expect(driftRow).toContain("refused");
  expect(driftRow).toContain(COMPAT[driftId].receipt);
  const otherVerified = publicOrder.find(id => id !== driftId)!;
  expect(ahead.report).not.toContain(`- **${otherVerified}**`); // still verified at its own verified[0]
  expect(ahead.report).toContain("- **agy**: no public source; local drift only"); // agy is a notice, not drift
  // A source that cannot be read is unknown, not a crash.
  const unknown = await watch(async () => { throw new Error("offline"); }, new Date("2026-10-26T00:00:00Z"));
  expect(unknown.code).toBe(3);
  expect(unknown.report).toContain("latest unknown, unknown");
});

test("every COMPAT entry names a receipt that exists and has a watcher source, so a new entry cannot land without either (#843)", async () => {
  const { SOURCES } = await import("../scripts/agent-compat-watch.ts");
  const { existsSync } = await import("node:fs");
  const ids = Object.keys(COMPAT) as CompatId[];
  expect(ids).toContain("pi"); // #847 added it; the receipt pointers and the watcher must cover it like every other entry
  for (const id of ids) {
    expect(SOURCES[id], `${id} has no watcher source`).toBeDefined();
    const receipt = COMPAT[id].receipt;
    expect(typeof receipt, `${id} has no receipt`).toBe("string");
    expect(receipt.startsWith("docs/verification/") && receipt.endsWith(".md"), `${id} receipt ${receipt}`).toBe(true);
    expect(existsSync(join(import.meta.dir, "..", receipt)), `${id} receipt ${receipt} does not exist`).toBe(true);
  }
  // The receipt to repeat is the newest one for each of the three #843 AC5 CLIs.
  expect(COMPAT.jcode.receipt).toBe("docs/verification/2026-10-26-jcode-0.99.1.md");
  expect(COMPAT.agy.receipt).toBe("docs/verification/2026-10-26-agy-1.4.7.md");
  expect(COMPAT.pi.receipt).toBe("docs/verification/2026-10-26-pi-140-compat.md");
});

test("Pi 1.4.0 has an exact receipt gate; other versions need the person's trust (#843 AC2)", () => {
  expect(assessVersion("pi", "1.4.0", [])).toEqual({ ok: true, state: "verified", version: "1.4.0" });
  expect(COMPAT.pi.gate).toBe("contract");
  expect(COMPAT.pi).not.toHaveProperty("line");
  expect(COMPAT.pi.parse("1.4.0\n")).toBe("1.4.0");
  for (const version of ["1.4.1", "1.5.0", "1.4.0-rc.1"]) {
    const verdict = assessVersion("pi", version, []);
    expect(verdict).toMatchObject({ ok: false, state: "refused" });
    if (!verdict.ok) expect(verdict.reason).toContain(`ahub agents trust pi ${version}`);
    expect(assessVersion("pi", version, [{ id: "pi", version, at: 1 }])).toMatchObject({ ok: true, state: "trusted" });
  }
});


test("Kimi reviewer 2.4.1 is exact-receipt verified; nearby untested versions stay refused (#888)", () => {
  expect(assessVersion("kimi-review", "2.4.1", [])).toEqual({ ok: true, state: "verified", version: "2.4.1" });
  for (const near of ["2.3.3", "2.4.0", "2.4.2", "2.4.1-rc.1", "kimi 2.4.1"]) expect(assessVersion("kimi-review", near, []).ok).toBe(false);
});

test("Qwen ACP 0.26.4 is exact-receipt verified; intermediate and nearby versions stay refused (#888)", () => {
  expect(assessVersion("qwen", "0.26.4", [])).toEqual({ ok: true, state: "verified", version: "0.26.4" });
  for (const near of ["0.26.2", "0.26.3", "0.26.5", "0.27.0", "0.26.4-rc.1", "qwen 0.26.4"]) expect(assessVersion("qwen", near, []).ok).toBe(false);
});


test("the Qwen ACP 0.26.4 receipt never admits the unqualified dual-output contract (#888)", () => {
  expect(assessVersion("qwen", "0.26.4", []).ok).toBe(true);
  expect(assessVersion("qwen-dual", "0.26.4", [])).toMatchObject({ ok: false, state: "refused", version: "0.26.4" });
  expect(COMPAT["qwen-dual"].verified).toEqual(["0.26.1"]);
});
