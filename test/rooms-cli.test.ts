import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP, helpCommands } from "../src/cli/help.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { parseRoomCommand, roomCommandError, runRoomCommand, type RoomRequest } from "../src/cli/room.ts";

const owner = "1".repeat(64), member = "2".repeat(64), artifact = "e30", ticket = "a".repeat(43);
const room = "b".repeat(43);
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const root = mkdtempSync(join(tmpdir(), "ahub-rooms-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const row = { name: "example", room, owner, member, epoch: "2", state: "ready" };

async function printed(work: (lines: string[]) => Promise<void>): Promise<string[]> {
  const lines: string[] = [], original = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
  try { await work(lines); return lines; }
  finally { console.log = original; }
}

test("room parser and help cover OOB enrollment, rotation and ids-only read forms", () => {
  expect(HELP.flatMap(helpCommands)).toContain("room");
  const forms: [string[], unknown][] = [
    [["create", "example", "--broker", "wss://relay.example/", "--label", "hub-one"], { action: "create", input: { name: "example", broker: "wss://relay.example/", label: "hub-one" } }],
    [["invite", "example"], { action: "invite", input: { name: "example" } }],
    [["invite", "example", "--accept", artifact], { action: "invite", input: { name: "example", request: artifact } }],
    [["join", artifact, "--name", "example", "--label", "hub-two"], { action: "join", input: { token: artifact, name: "example", label: "hub-two" } }],
    [["join", "example", "--roster", artifact], { action: "join", input: { name: "example", roster: artifact } }],
    [["leave", "example"], { action: "leave", input: { name: "example" } }],
    [["revoke", "example", member], { action: "revoke", input: { name: "example", member } }],
    [["expose", "example", "agent-one", "agent-two"], { action: "expose", input: { name: "example", peers: ["agent-one", "agent-two"] } }],
    [["expose", "example"], { action: "expose", input: { name: "example", peers: [] } }],
  ];
  for (const [args, expected] of forms) expect(parseRoomCommand(args)).toMatchObject({ op: "mutation", ...(expected as object) });
  expect(parseRoomCommand(["list", "--json"])).toEqual({ op: "list", input: {}, json: true });
  expect(parseRoomCommand(["status", "example"])).toEqual({ op: "status", input: { name: "example" }, json: false });
  expect(parseRoomCommand(["status", "--json"])).toEqual({ op: "status", input: {}, json: true });
});

test("room parser refuses extra flags, ambiguous artifacts and mutation JSON before any request", async () => {
  const invalid = [[], ["unknown"], ["list", "example"], ["list", "--json", "--json"], ["status", "one", "two"],
    ["create", "example"], ["create", "example", "--broker", "wss://relay.example/", "--broker", "wss://other.example/"],
    ["invite", "example", "--accept"], ["invite", "example", "--accept", "a=b"], ["join", "../secret"],
    ["join", "example", "--roster", artifact, "--label", "new"], ["leave", "example", "extra"],
    ["revoke", "example", "not-a-fingerprint"], ["expose", "example", "user@remote"], ["expose", "example", "same", "same"],
    ["invite", "example", "--json"], ["join", artifact, "--json"], ["leave", "example", "--live-test"]];
  let calls = 0;
  for (const args of invalid) {
    expect(() => parseRoomCommand(args), args.join(" ")).toThrow("usage:");
    await expect(runRoomCommand(args, async () => { calls++; return {}; })).rejects.toThrow("usage:");
  }
  expect(calls).toBe(0);
});

test("room reads are allowed exact forms while every mutation and live-test mutation stays person-only", () => {
  for (const args of [["list"], ["list", "--json"], ["status"], ["status", "example", "--json"]]) {
    expect(classifyPeerCommand("room", args)).toBe("allowed");
    expect(liveTestRefusal("room", args)).toBe(false);
  }
  for (const args of [["create", "example"], ["invite", "example"], ["invite", "example", "--accept", artifact],
    ["join", artifact], ["join", "example", "--roster", artifact], ["leave", "example"], ["revoke", "example", member],
    ["expose", "example", "agent-one"], ["list", "--accept", artifact], ["status", "--broker", "wss://relay.example/"], []]) {
    expect(classifyPeerCommand("room", args), args.join(" ")).toBe("console");
    if (!["list", "status"].includes(args[0] ?? "")) expect(liveTestRefusal("room", args)).toBe(true);
  }
  expect(cliCommandLabel("room", ["join", "private-invitation-token"])).toBe("room join");
  expect(cliCommandLabel("room", ["invite", "example", "--accept", artifact])).toBe("room invite");
  expect(cliCommandLabel("room", ["create", "example", "--broker", "wss://private.example/"])).toBe("room create");
});

test("room CLI shows both fingerprints before executing its same-connection preview ticket", async () => {
  const requests: Record<string, unknown>[] = [];
  const lines = await printed(async lines => {
    const request: RoomRequest = async message => {
      requests.push(message);
      if (message.op === "preview") {
        expect(lines).toEqual([]);
        return { ok: true, owner, member, ticket };
      }
      expect(lines).toEqual([`Owner fingerprint: ${owner}`, `Member fingerprint: ${member}`]);
      expect(message).toEqual({ t: "room", op: "execute", ticket });
      return { ok: true, artifact, kind: "invite" };
    };
    await runRoomCommand(["invite", "example"], request);
  });
  expect(requests).toEqual([{ t: "room", op: "preview", action: "invite", input: { name: "example" } }, { t: "room", op: "execute", ticket }]);
  expect(lines.slice(2)).toEqual(["Room artifact (share out of band):", artifact]);
});

test("room CLI never executes an invalid preview or prints artifacts from a refused execution", async () => {
  for (const response of [{ ok: false, artifact }, { ok: true, owner: "private text", member, ticket }, { ok: true, owner, member, ticket: "bad" }]) {
    let calls = 0;
    await printed(async lines => {
      await expect(runRoomCommand(["invite", "example"], async () => { calls++; return response; })).rejects.toThrow();
      expect(lines).toEqual([]);
    });
    expect(calls).toBe(1);
  }
  await printed(async lines => {
    await expect(runRoomCommand(["invite", "example"], async message => message.op === "preview" ? { ok: true, owner, member, ticket } : { ok: false, artifact })).rejects.toThrow("operation refused");
    expect(lines.join("\n")).not.toContain(artifact);
  });
  expect(roomCommandError(new Error("private token and broker details"))).toBe("room: operation failed");
});

test("room CLI read output projects only ids and uses JSON only when explicitly requested", async () => {
  const request: RoomRequest = async message => {
    expect(message).toMatchObject({ t: "room", op: "status", input: { name: "example" } });
    return { ok: true, rooms: [{ ...row, secret: "private invitation secret", body: "private body", broker: "wss://private.example/" }] };
  };
  const json = await printed(async () => { await runRoomCommand(["status", "example", "--json"], request); });
  expect(JSON.parse(json.join("\n"))).toEqual([row]);
  const human = await printed(async () => { await runRoomCommand(["status", "example"], request); });
  expect(human[0]).toBe("Rooms (1)");
  expect(human.join("\n")).toContain(owner);
  expect(human.join("\n")).toContain(member);
  expect(human.join("\n")).not.toContain("private");
  expect(() => JSON.parse(human.join("\n"))).toThrow();
});

test("real room CLI refuses agent-marker and live-test mutations without exposing their token", async () => {
  const env: Record<string, string | undefined> = { ...process.env, HOME: join(root, "home"), AGENTHUB_HOME: join(root, "ahub"), KIMI_CODE_HOME: join(root, "kimi") };
  for (const key of ["CODEX_THREAD_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "AGENTHUB_PEER_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_DELIVERY_ONLY"]) delete env[key];
  for (const marker of [{ CODEX_THREAD_ID: "test" }, { CLAUDECODE: "1" }, { AGENTHUB_PEER_ID: "codex" }]) {
    for (const prefix of [[], ["--live-test"]]) {
      const child = Bun.spawn([process.execPath, CLI, ...prefix, "room", "join", "private-invitation-token"], { cwd: root, env: { ...env, ...marker }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
      const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timeout));
      expect(code).not.toBe(0);
      expect(out).toBe("");
      expect(error).toContain(prefix.length ? "live-test cannot" : "agent");
      expect(error).not.toContain("private-invitation-token");
    }
  }
});


test("room CLI reports the generated pending name needed by the later roster import", async () => {
  const lines = await printed(async () => runRoomCommand(["join", artifact], async message => message.op === "preview"
    ? { ok: true, owner, member, ticket }
    : { ok: true, name: "room-generated", artifact, kind: "join-request" }));
  expect(lines).toContain("Room: room-generated");
});
