import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("manager accepts the explicitly supported protocol-9 HTTP owner during protocol-10 refresh", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-v9-"));
  const instanceId = "legacy-manager-instance";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      if (req.headers.get("authorization") !== "Bearer legacy") return new Response("unauthorized", { status: 401 });
      return Response.json({ ok: true, instanceId, url: "http://127.0.0.1:1/#ticket" });
    },
  });
  const managerDir = join(home, "manager");
  mkdirSync(managerDir, { recursive: true });
  writeFileSync(join(managerDir, "control-token"), "legacy\n");
  writeFileSync(join(managerDir, "status.json"), JSON.stringify({ port: server.port, protocol: 9, instanceId, pid: process.pid }));
  try {
    expect(await openManager({ home })).toBe("http://127.0.0.1:1/#ticket");
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});
