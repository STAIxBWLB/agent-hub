/** Manual, account-free native fixture. Never imported or run by bun test.
 * bun test/fakes/kimi-oauth-race.ts --binary /absolute/kimi --receipt /absolute/result.json
 * Run only under the repository's serialized native resource admission.
 * Native contract: MoonshotAI/kimi-code@472192c34c1efad89a369870eff0da0b708ce9bb,
 * packages/oauth/src/{oauth.ts,oauth-manager.ts,storage.ts,toolkit.ts}.
 * Refresh endpoint is POST <oauth_host>/api/oauth/token, form-encoded refresh_token.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { peerChildEnv, stopOwnedProcess, trackGroup } from "../../src/hub/child-process.ts";
import { realPath } from "../../src/hub/project.ts";

const LIMIT_MS = 25_000;
const OUTPUT_LIMIT = 64 * 1024;
type Token = { access_token: string; refresh_token: string; expires_at: number; expires_in: number; scope: string; token_type: string };
type ChildResult = { code: number | null; output: string };

export async function kimiOAuthRace(binary: string, receiptFile: string): Promise<void> {
  assert(isAbsolute(binary) && isAbsolute(receiptFile), "explicit absolute binary and receipt paths required");
  const executable = realPath(binary);
  assert(lstatSync(executable).isFile(), "native executable must be a regular file");
  assert(!existsSync(receiptFile), "receipt already exists; choose a new output path");
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-kimi-oauth-race-")));
  const credentials = join(root, "shared-credentials"), locks = join(root, "shared-oauth"), device = join(root, "shared-device-id");
  mkdirSync(credentials); mkdirSync(locks);
  writeFileSync(device, "b017b011-33aa-4488-9900-112233445566", { mode: 0o600 });
  const tokenFile = join(credentials, "race.json");
  const active = new Set<ChildProcess>();
  const cleanupFailures: string[] = [];
  const deadline = Date.now() + LIMIT_MS;
  let stopped = false, refreshes = 0, modelCalls = 0, wrongTokenCalls = 0, unexpectedRequests = 0;
  let generation = 0;
  const refreshConcurrentChildren: number[] = [];
  const phases: Array<{ phase: string; refreshes: number; modelCalls: number }> = [];
  const receipt: Record<string, unknown> = {
    accountFree: true, nativeOAuth: true, staticProvider: false,
    startedAt: new Date().toISOString(), passed: false,
    ceiling: "Concurrent fresh print invocations stand in for reviewer and TUI; this is not an attached interactive TUI or a real-account proof.",
  };
  const remaining = () => Math.max(1, deadline - Date.now());
  const checkTime = () => assert(!stopped && Date.now() < deadline, "overall fixture deadline exceeded");
  async function cleanupChild(child: ChildProcess): Promise<void> {
    await stopOwnedProcess(child, { group: true, termMs: 300, killMs: 1_000 });
    active.delete(child);
  }
  async function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ChildResult> {
    checkTime();
    return await new Promise<ChildResult>((resolve, reject) => {
      const child = spawn(executable, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      active.add(child);
      let bytes = 0, output = "", finishing = false;
      const finish = async (code: number | null, failure?: Error) => {
        if (finishing) return;
        finishing = true; clearTimeout(timer);
        try { await cleanupChild(child); }
        catch { cleanupFailures.push("owned group cleanup unconfirmed"); reject(new Error("owned group cleanup unconfirmed")); return; }
        if (failure) reject(failure); else resolve({ code, output });
      };
      const timer = setTimeout(() => void finish(null, new Error("native child deadline exceeded")), Math.min(LIMIT_MS, remaining()));
      child.once("spawn", () => trackGroup(child));
      const take = (data: Buffer) => {
        bytes += data.length;
        if (bytes > OUTPUT_LIMIT) { void finish(null, new Error("native output bound exceeded")); return; }
        output += data.toString();
      };
      child.stdout.on("data", take); child.stderr.on("data", take);
      child.once("error", () => void finish(null, new Error("native child spawn failed")));
      child.once("close", code => void finish(code));
    });
  }
  const writeToken = (current: number, expired: boolean) => {
    const token: Token = { access_token: `fixture-access-${current}`, refresh_token: `fixture-refresh-${current}`, expires_at: Math.floor(Date.now() / 1000) + (expired ? -10 : 7200), expires_in: 7200, scope: "fixture", token_type: "Bearer" };
    const temporary = join(credentials, "host-rotation.tmp");
    writeFileSync(temporary, JSON.stringify(token), { mode: 0o600 }); renameSync(temporary, tokenFile);
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.has("origin") || stopped || Date.now() >= deadline) return new Response("refused", { status: 403 });
    if (Number(request.headers.get("content-length") ?? "0") > 262144) return new Response("bound", { status: 413 });
    const raw = await request.text();
    if (raw.length > 262144 || refreshes + modelCalls + unexpectedRequests >= 24) return new Response("bound", { status: 413 });
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/auth/api/oauth/token") {
      refreshes++;
      refreshConcurrentChildren.push(active.size);
      const body = new URLSearchParams(raw);
      if (body.get("grant_type") !== "refresh_token" || body.get("refresh_token") !== `fixture-refresh-${generation}`) {
        unexpectedRequests++;
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      generation++;
      return Response.json({ access_token: `fixture-access-${generation}`, refresh_token: `fixture-refresh-${generation}`, expires_in: 7200, token_type: "Bearer", scope: "fixture" });
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      modelCalls++;
      if (request.headers.get("x-api-key") !== `fixture-access-${generation}` || generation === 0) {
        wrongTokenCalls++;
        return Response.json({ type: "error", error: { type: "authentication_error", message: "synthetic token mismatch" } }, { status: 401 });
      }
      let body: { tools?: unknown[] };
      try { body = JSON.parse(raw); } catch { unexpectedRequests++; return new Response("json", { status: 400 }); }
      if (body.tools?.length) { unexpectedRequests++; return new Response("unexpected tools", { status: 400 }); }
      const events = [
        { type: "message_start", message: { id: `msg_${modelCalls}`, type: "message", role: "assistant", content: [], model: "kimi-for-coding", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OAUTH_RACE_OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    unexpectedRequests++;
    return new Response("unexpected endpoint", { status: 404 });
  } });
  const homes = ["reviewer", "tui-stand-in"].map(name => {
    const base = join(root, name), home = join(base, "home"), tool = join(base, "tool"), cwd = join(base, "workspace"), temporary = join(base, "tmp"), skills = join(base, "empty-skills");
    for (const dir of [home, tool, cwd, temporary, skills]) mkdirSync(dir, { recursive: true });
    symlinkSync(credentials, join(tool, "credentials"), "dir"); symlinkSync(locks, join(tool, "oauth"), "dir"); symlinkSync(device, join(tool, "device_id"));
    writeFileSync(join(tool, "config.toml"), `default_model = "race-probe"\ntelemetry = false\nhooks = []\n[providers.fixture]\ntype = "kimi"\nbase_url = "http://127.0.0.1:${server.port}/v1"\n[providers.fixture.oauth]\nstorage = "file"\nkey = "oauth/race"\noauth_host = "http://127.0.0.1:${server.port}/auth"\n[models.race-probe]\nprovider = "fixture"\nmodel = "kimi-for-coding"\nprotocol = "anthropic"\nmax_context_size = 32768\ncapabilities = ["tool_use"]\n`);
    const agent = join(cwd, "fixture.md");
    writeFileSync(agent, "---\nname: oauth-race-fixture\ndescription: Account-free OAuth locking fixture\ntools: []\nsubagents: []\n---\n\nReturn only the supplied fixture result.\n");
    const env = peerChildEnv(`kimi-race-${name}`, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, KIMI_CODE_HOME: tool, TMPDIR: `${temporary}/`, XDG_CONFIG_HOME: join(home, ".config"), LANG: "en_US.UTF-8", TERM: "dumb", USER: "oauth-fixture" });
    return { home, tool, cwd, skills, agent, env };
  });
  const overall = setTimeout(() => { stopped = true; }, remaining());
  const verifyLinks = () => {
    assert(lstatSync(tokenFile).isFile() && !lstatSync(tokenFile).isSymbolicLink(), "atomic native credential target must remain a regular file");
    for (const home of homes) {
      for (const [name, target] of [["credentials", credentials], ["oauth", locks], ["device_id", device]] as const) {
        assert(lstatSync(join(home.tool, name)).isSymbolicLink(), "private link replaced");
        assert.equal(readlinkSync(join(home.tool, name)), target, "private link target changed");
      }
    }
    assert(!existsSync(join(locks, "race.lock")), "OAuth lock remains after children exited");
  };
  async function wave(phase: string, expectedRefreshes: number, expectedModels: number) {
    checkTime();
    const results = await Promise.allSettled(homes.map(home => run(["-p", "Return OAUTH_RACE_OK.", "--output-format", "stream-json", "--agent-file", home.agent, "--skills-dir", home.skills], home.cwd, home.env)));
    for (const result of results) {
      assert.equal(result.status, "fulfilled", "native invocation failed or cleanup was incomplete");
      if (result.status === "fulfilled") { assert.equal(result.value.code, 0, "native invocation must exit zero"); assert(result.value.output.includes("OAUTH_RACE_OK"), "native final response missing"); }
    }
    assert.equal(refreshes, expectedRefreshes, "exactly one refresh per expired generation");
    assert(refreshConcurrentChildren.every(count => count === 2), "each refresh must overlap both native invocations");
    assert.equal(modelCalls, expectedModels, "both native children must reach the model");
    assert.equal(wrongTokenCalls, 0, "no model call may use stale credentials or return 401");
    assert.equal(unexpectedRequests, 0, "unexpected OAuth/model operation");
    const current = JSON.parse(readFileSync(tokenFile, "utf8")) as Token;
    assert.equal(current.access_token, `fixture-access-${generation}`); assert.equal(current.refresh_token, `fixture-refresh-${generation}`);
    assert(current.expires_at > Math.floor(Date.now() / 1000) + 3500, "native refreshed expiry must be fresh");
    verifyLinks(); phases.push({ phase, refreshes, modelCalls });
  }
  try {
    const home = homes[0]!;
    const version = await run(["--version"], home.cwd, home.env);
    assert.equal(version.code, 0); assert(/\b2\.2\.0\b/.test(version.output), "only Kimi 2.2.0 is supported by this fixture");
    writeToken(0, true);
    await wave("expired-generation-0", 1, 2);
    writeToken(1, true);
    await wave("expired-generation-1-host-atomic-rotation", 2, 4);
    await wave("already-fresh-reuse", 2, 6);
    assert.equal(active.size, 0, "all owned groups must be reaped");
    receipt.passed = true;
  } catch (error) {
    // No raw model/native output, transport environment or token record enters the receipt.
    receipt.failure = error instanceof assert.AssertionError ? error.message : "native fixture failed; no proof";
    throw error;
  } finally {
    stopped = true; clearTimeout(overall); server.stop(true);
    for (const child of [...active]) { try { await cleanupChild(child); } catch { cleanupFailures.push("final owned group cleanup unconfirmed"); } }
    receipt.phases = phases; receipt.refreshRequests = refreshes; receipt.modelRequests = modelCalls;
    receipt.refreshConcurrentChildren = refreshConcurrentChildren;
    receipt.wrongTokenCalls = wrongTokenCalls; receipt.unexpectedRequests = unexpectedRequests;
    receipt.ownedGroupsGone = active.size === 0 && cleanupFailures.length === 0;
    if (receipt.ownedGroupsGone) rmSync(root, { recursive: true, force: true });
    receipt.temporaryRootRemoved = !existsSync(root);
    receipt.passed = receipt.passed === true && receipt.ownedGroupsGone === true && receipt.temporaryRootRemoved === true;
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (!receipt.passed) process.exitCode = 1;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  assert(args.length === 4 && args[0] === "--binary" && args[2] === "--receipt", "usage: bun test/fakes/kimi-oauth-race.ts --binary /absolute/kimi --receipt /absolute/new-receipt.json");
  await kimiOAuthRace(args[1]!, args[3]!);
}
