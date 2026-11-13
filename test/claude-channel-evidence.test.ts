import { expect, test } from "bun:test";
import { claudeChannelEvidence, classifyClaudeParentCommand } from "../src/adapters/claude-channel-evidence.ts";

const launch = "claude --dangerously-load-development-channels plugin:agent-hub@agent-hub";

test("Claude channel evidence requires the exact leading development-channel target", () => {
  expect(classifyClaudeParentCommand(launch)).toBe("development-channel-launch");
  expect(classifyClaudeParentCommand("/opt/bin/claude --dangerously-load-development-channels server:agent-hub --mcp-config config.json")).toBe("development-channel-launch");
  expect(classifyClaudeParentCommand(`${launch} --resume session-123`)).toBe("development-channel-launch");
  for (const command of [
    "claude bg-spare --dangerously-load-development-channels plugin:agent-hub@agent-hub",
    "claude daemon run --origin transient",
    "claude -p --dangerously-load-development-channels plugin:agent-hub@agent-hub",
    `${launch} --print`,
    'claude --append-system-prompt "please run --dangerously-load-development-channels plugin:agent-hub@agent-hub"',
    `${launch} --dangerously-load-development-channels other-server`,
    `${launch} --dangerously-load-development-channels=other-server`,
    `${launch} daemon run`,
    `${launch} --background`,
    `${launch} bg-spare`,
    `${launch}\n--print`,
    `${launch}\0--print`,
    "x".repeat(4097),
    `claude --dangerously-load-development-channels ${"x".repeat(4097)}`,
  ]) expect(classifyClaudeParentCommand(command)).toBe("launch-unverified");
});

test("inherited marker is insufficient and an unreadable parent fails closed", () => {
  const reads: number[] = [];
  expect(claudeChannelEvidence({}, process.ppid, pid => { reads.push(pid); return launch; })).toBe("unknown");
  expect(reads).toHaveLength(0);
  expect(claudeChannelEvidence({ AGENTHUB_CHANNEL: "1" }, process.ppid, pid => { reads.push(pid); return launch; })).toBe("development-channel-launch");
  expect(reads).toEqual([process.ppid]);
  expect(claudeChannelEvidence({ AGENTHUB_CHANNEL: "1" }, process.ppid, () => undefined)).toBe("unknown");
  expect(claudeChannelEvidence({ AGENTHUB_CHANNEL: "1" }, process.ppid, () => { throw new Error("private process text"); })).toBe("unknown");
  expect(claudeChannelEvidence({ AGENTHUB_CHANNEL: "1" }, 1, () => launch)).toBe("unknown");
});
