import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PiPeer } from "../../src/adapters/pi.ts";
import { processSignature } from "../../src/pi/process-signature.ts";
const currentSignature = (pid: number) => { const signature = processSignature(pid); if (!signature) throw new Error("test owner process is not visible"); return signature; };

// A real owner process plus the shipped authenticated bridge protocol, without a native model.
export async function rosterPiFixture(executeTool: ConstructorParameters<typeof PiPeer>[1]["executeTool"] = async () => "ok", location: { cwd?: string; stateDir?: string; fencedPrompt?: boolean } = {}) {
  const cwd = location.cwd ?? process.cwd();
  const stateDir = location.stateDir ?? mkdtempSync(join(cwd, ".pi-roster-"));
  const owner = Bun.spawn(["sleep", "60"]);
  let budgetCalls = 0;
  const peer = new PiPeer("pi", { cwd, stateDir, mode: "tui", backend: "mlx", stopGraceMs: 100,
    relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [] }, tools: [], executeTool,
    admitBudget: async () => { budgetCalls++; return []; } });
  await peer.start();
  const launch = peer.tuiLaunch!, url = launch.env.AGENTHUB_PI_BRIDGE_URL!;
  const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
  const sessionId = "roster-session", sessionFile = join(stateDir, "personal.jsonl");
  let promptId: string | undefined;
  const post = (path: string, body: any) => {
    const lifecycle = path === "/event" && ["agent_start", "agent_end", "agent_settled"].includes(body.type);
    const wire = lifecycle && promptId && body.promptId === undefined ? { ...body, promptId } : body;
    if (body.type === "agent_settled") promptId = undefined;
    return fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(wire) });
  };
  await post("/event", { type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature: currentSignature(owner.pid), sessionId, sessionFile, fencedPrompt: location.fencedPrompt !== false });
  const next = async () => ((await (await fetch(`${url}/commands`, { headers })).json()) as any).command;
  const ack = (command: any, result?: unknown) => { if (command.type === "prompt") promptId = command.id; return post("/ack", { id: command.id, ok: true, result }); };
  const resume = async (idle: boolean, override: Record<string, unknown> = {}) => {
    const returning = peer.resumeFromRoster();
    const command = await next(); expect(command.type).toBe("get_session_state");
    await ack(command, { sessionId, sessionFile, idle, ...override }); await returning;
  };
  const cleanup = async () => {
    owner.kill(); await owner.exited;
    await post("/event", { type: "session_shutdown" }).catch(() => undefined); await peer.stop();
    if (!location.stateDir) rmSync(stateDir, { recursive: true, force: true });
  };
  return { peer, owner, launch, post, next, ack, resume, cleanup, sessionId, sessionFile, budgetCalls: () => budgetCalls };
}

