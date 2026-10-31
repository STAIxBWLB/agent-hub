import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectChain } from "@staix/agent-mem";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { USER } from "../src/hub/envelope.ts";
import { campaignHash, parseResearchCampaign } from "../src/hub/research-campaign.ts";

// #597 through the real daemon and its control socket, not a Tasks fixture: an approved campaign is stored in hub.db, a real daemon starts over it, and a person's `backlog_pull`
// arrives as a control request. `task_assign` is not covered here: this roster has no runnable owner, so it is refused before the study gate is reached. The daemon reads the real clock, so "expired" is a stored deadline in the past and "live" is one far ahead.
async function daemonWith(deadline: string) {
  const root = mkdtempSync(join(tmpdir(), "ahub-dispatch-daemon-")), stateDir = join(root, "state");
  mkdirSync(stateDir);
  const envKeys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME", "KIMI_CODE_HOME"] as const;
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) { const dir = join(root, key.toLowerCase()); mkdirSync(dir); process.env[key] = dir; }
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => {
    try { client?.close(); await daemon?.stop(); }
    finally { for (const key of envKeys) { const previous = saved[key]; if (previous === undefined) delete process.env[key]; else process.env[key] = previous; } rmSync(root, { recursive: true, force: true }); }
  };
  try {
    const board = new Board(join(stateDir, "hub.db"));
    let unitTask: number, campaignId: string;
    try {
      const parent = board.propose(USER, { title: "Research parent", class: "plan" });
      const body = parseResearchCampaign({ question: "Which observations distinguish the alternatives?", scope: "Real-daemon fixture", exclusions: [], sourceIds: [],
        units: [{ id: "discovery", round: 0, question: "Collect observations", perspective: "Independent", requiredOutput: "Evidence list", sourceIds: [], dependsOn: [], purpose: "discovery" }],
        deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline } });
      campaignId = "rc-00000000d15c";
      board.saveResearchCampaignDraft({ id: campaignId, project: projectChain(root).at(-1)!, parentTaskId: parent.id, revision: 1, status: "draft", contract: body, hash: campaignHash(body), private: false, createdBy: USER, createdAt: 1 }, undefined, parent.history.length);
      const result = board.activateCampaign(campaignId, 1, projectChain(root).at(-1)!, USER, 2, [{ unitId: "discovery", create: { title: "Study unit discovery", class: "implement", signals: [] } }], board.get(parent.id)!.history.length, false);
      unitTask = result.bindings[0]!.taskId;
    } finally { board.close(); }
    daemon = await startDaemon({ cwd: root, stateDir, projectId: root, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      config: { ...DEFAULT_CONFIG, roster: {}, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
        research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    return { client, unitTask, campaignId, close, stateDir };
  } catch (error) { await close(); throw error; }
}

const expired = new Date(Date.UTC(2020, 0, 1)).toISOString(), live = new Date(Date.now() + 30 * 86_400_000).toISOString();
const held = (file: string, id: number) => { const board = new Board(file); try { return board.get(id)!.history.map(entry => `${entry.event}|${entry.note ?? ""}`); } finally { board.close(); } };

test("through the real daemon: a person's backlog_pull of an expired campaign's unit is held, with the reason on the stored task", async () => {
  const d = await daemonWith(expired);
  try {
    const pull = await d.client.request({ t: "task", op: "backlog_pull", args: { id: d.unitTask } });
    expect(pull.ok, JSON.stringify(pull)).toBe(true);
    expect(held(join(d.stateDir, "hub.db"), d.unitTask)).toContain("ready held|study deadline has expired");
  } finally { await d.close(); }
}, 30_000);

test("through the real daemon: the same pull against a live campaign is not held, so the hold above is the gate and not the fixture", async () => {
  const d = await daemonWith(live);
  try {
    const pull = await d.client.request({ t: "task", op: "backlog_pull", args: { id: d.unitTask } });
    expect(pull.ok, JSON.stringify(pull)).toBe(true);
    const history = held(join(d.stateDir, "hub.db"), d.unitTask);
    expect(history).toContain("ready|pulled from backlog");
    expect(history.some(entry => entry.startsWith("ready held"))).toBe(false);
  } finally { await d.close(); }
}, 30_000);
