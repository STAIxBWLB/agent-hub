import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomCommands } from "../src/rooms/commands.ts";
const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); });
function service() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-room-command-")); close.push(() => rmSync(cwd, { recursive: true, force: true }));
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0); mkdirSync(join(cwd, ".agenthub"));
  const commands = new RoomCommands({ cwd, stateDir: join(cwd, "state") }); close.push(() => commands.stop()); return commands;
}
async function run(service: RoomCommands, action: string, input: unknown) { return (await service.preview(action, input, () => true)).commit(); }
test("signed out-of-band exposure can be accepted only by the pinned owner at the current digest", async () => {
  const owner = service(), guest = service();
  await run(owner, "create", { name: "test", broker: "ws://127.0.0.1:1/" });
  const invitation = await run(owner, "invite", { name: "test" });
  const request = await run(guest, "join", { name: "test", token: invitation.artifact });
  const roster = await run(owner, "invite", { name: "test", request: request.artifact });
  await run(guest, "join", { name: "test", roster: roster.artifact });
  const exposure = await run(guest, "expose", { name: "test", peers: ["codex"] });
  const next = await run(owner, "invite", { name: "test", request: exposure.artifact });
  expect(next.kind).toBe("roster");
  await expect(run(owner, "invite", { name: "test", request: exposure.artifact })).rejects.toThrow();
});
test("an invalidated room preview performs no room install", async () => {
  const commands = service(); let allowed = true;
  const preview = await commands.preview("create", { name: "test", broker: "ws://127.0.0.1:1/" }, () => allowed);
  allowed = false;
  await expect(preview.commit()).rejects.toThrow("state_changed");
  expect(await commands.rows()).toEqual([]);
});
