import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManager, startManager, stopManager, type Lifecycle, type ProjectRecord } from "../src/hub/manager.ts";

const dirs: string[] = [];
afterEach(async () => { await stopManager({ home: dirs.at(-1) }); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-")); dirs.push(home);
  const project: ProjectRecord = { id: "p1", root: "/tmp/project", stateDir: join(home, "state"), basePort: 4600, instanceId: "i1", pid: 42 };
  const registry = { get: (id: string) => id === project.id ? project : undefined, list: () => [project] } as any;
  const lifecycle: Lifecycle = {
    inspectProject: async () => ({ state: "running", status: { instanceId: "i1", peers: {} } }),
    startProject: async () => ({ started: true }),
    stopProject: async () => {},
  };
  return { home, registry, lifecycle };
}

test("manager starts with an authenticated one-time dashboard ticket", async () => {
  const { home, registry, lifecycle } = setup();
  await startManager({ home, registry, lifecycle });
  const files = join(home, "manager");
  const status = JSON.parse(readFileSync(join(files, "status.json"), "utf8"));
  const token = readFileSync(join(files, "control-token"), "utf8").trim();
  const denied = await fetch(`http://127.0.0.1:${status.port}/open`, { method: "POST" });
  expect(denied.status).toBe(401);
  const opened = await fetch(`http://127.0.0.1:${status.port}/open`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(opened.status).toBe(200);
  expect(((await opened.json()) as { url?: string }).url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(await openManager({ home, registry, lifecycle })).not.toBe(await openManager({ home, registry, lifecycle }));
});

test("listing isolates an unavailable project", async () => {
  const { home, registry, lifecycle } = setup();
  lifecycle.inspectProject = async () => { throw new Error("dead hub"); };
  await startManager({ home, registry, lifecycle });
  const status = JSON.parse(readFileSync(join(home, "manager", "status.json"), "utf8"));
  const token = readFileSync(join(home, "manager", "control-token"), "utf8").trim();
  const opened = await fetch(`http://127.0.0.1:${status.port}/open`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const url = (await opened.json() as { url: string }).url;
  const origin = new URL(url).origin;
  const cookie = (await fetch(`${origin}/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: url.split("#")[1] }) })).headers.get("set-cookie")!;
  const projects = await fetch(`${origin}/projects`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: "{}" });
  const body = await projects.json() as any;
  expect(body.projects[0].state).toBe("unavailable");
});
