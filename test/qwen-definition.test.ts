import { expect, test } from "bun:test";
import { QWEN_DEFINITION } from "../src/adapters/definitions/qwen.ts";
import { AcpPeer } from "../src/adapters/acp.ts";
import { QwenIdentityError, QWEN_MODE_IDS, qwenNativeIdentity } from "../src/adapters/definitions/qwen-native.ts";
import { shellQuote } from "../src/cli/terminal-recovery.ts";
import type { CreateContext, LaunchContext } from "../src/adapters/registry-types.ts";

const launchContext: LaunchContext = { instance: "qwen", form: "headless", projectRoot: "/fixture/project root", stateDir: "/fixture/state", entrypoint: "/fixture/package/src/cli/main.js", userArgs: [], unattended: false, env: {} };

test("#451 Qwen definition preserves its optional headless ACP policy", () => {
  expect(QWEN_DEFINITION.api).toBe(1); expect(QWEN_DEFINITION.kind).toBe("qwen"); expect(QWEN_DEFINITION.family).toBe("qwen");
  expect(QWEN_DEFINITION.transport).toBe("acp"); expect(QWEN_DEFINITION.optional).toBe(true); expect(QWEN_DEFINITION.defaultOnRoster).toBe(false);
  expect(QWEN_DEFINITION.roles).toEqual(["implementer", "verifier"]); expect(QWEN_DEFINITION.start.forms).toEqual(["headless"]);
  expect(QWEN_DEFINITION.start.defaultForm).toBe("headless"); expect(QWEN_DEFINITION.start).not.toHaveProperty("ownsTerminal");
  // #286 Part 3: the TUI is explicit-only (forms stays headless); preflight admits it, refuses an unknown form, and the launch plan never builds a TUI argv.
  expect(QWEN_DEFINITION.start.preflight?.({ instance: "qwen", form: "tui" })).toBeUndefined();
  expect(QWEN_DEFINITION.start.preflight?.({ instance: "qwen", form: "other" as never })).toContain("unknown Qwen mode");
  expect(() => QWEN_DEFINITION.start.launch!({ ...launchContext, form: "tui" })).toThrow("ahub qwen --mode tui");
  expect(typeof QWEN_DEFINITION.start.createTui).toBe("function");
  expect(QWEN_DEFINITION.identity.mcp).toBe("acp-session"); expect(QWEN_DEFINITION.capabilities?.watch).toBe(true);
  expect(QWEN_DEFINITION.trust.onPrem).toBe(false); expect(QWEN_DEFINITION.trust.hubSandboxed).toBe(false);
  expect(QWEN_DEFINITION.permission).not.toHaveProperty("readOnly"); expect(QWEN_DEFINITION.turnEnd).toBe("adapter");
});

test("#451 Qwen definition launch keeps configured wrapper argv before model and produces quoted metadata", () => {
  const command = ["/fixture/native qwen", "wrapper.js", "--acp", "--source", "fixture source"];
  const plan = QWEN_DEFINITION.start.launch!({ ...launchContext, nativeCommand: command, model: "fixture/model" });
  expect(plan.cmd).toBe(command[0]!); expect(plan.args).toEqual([...command.slice(1), "--model", "fixture/model"]);
  expect(command).toEqual(["/fixture/native qwen", "wrapper.js", "--acp", "--source", "fixture source"]);
  expect(plan.metadata.packageEntrypoint).toBe(launchContext.entrypoint); expect(plan.metadata.argv).toEqual([plan.cmd, ...plan.args]);
  expect(plan.metadata.command).toBe(plan.metadata.argv.map(shellQuote).join(" ")); expect(plan.metadata.env).toEqual({});
  expect(QWEN_DEFINITION.start.launch!(launchContext).args).toEqual(["--acp"]);
});

test("#451 Qwen definition retains its exact native identity and permission mappings", () => {
  expect(() => qwenNativeIdentity("qwen", true, { agentInfo: { name: "qwen-code", version: "0.25.0" } })).not.toThrow();
  for (const agentInfo of [{ name: "qwen-code", version: "0.24.7" }, { name: "Qwen Code", version: "0.25.0" }, {}]) expect(() => qwenNativeIdentity("qwen", true, { agentInfo })).toThrow(QwenIdentityError);
  expect(QWEN_MODE_IDS).toEqual({ ask: "default", "ask-when-needed": "auto-edit", "never-ask": "yolo" });
  expect(QWEN_DEFINITION.permission).not.toHaveProperty("modes");
  expect(QWEN_DEFINITION.permission.grants?.["never-ask"]).toContain("every tool");
  expect(QWEN_DEFINITION.permission.grants?.["ask-when-needed"]).toContain("auto-edit");
});

test("#451 Qwen definition factory creates an unstarted ACP peer with existing options only", () => {
  const mcpServers = [{ name: "agent-hub", command: "fixture-unused", args: [], env: [] }];
  const context: CreateContext = { instance: "qwen", projectRoot: "/fixture/project", stateDir: "/fixture/state", kindConfig: undefined, permission: "ask-when-needed", mcpServers,
    daemon: { acp: { cmd: ["fixture-unused", "--acp"], cwd: "/fixture/project", launchModel: "fixture/model", mcpServers } } };
  const peer = QWEN_DEFINITION.start.create!(context);
  expect(peer instanceof AcpPeer).toBe(true); expect(peer.id).toBe("qwen"); expect(peer.state).toBe("offline");
  expect((peer as AcpPeer).getPermissionMode()).toBe("ask-when-needed"); expect(peer.recoveryMetadata?.().launch).toEqual({ kind: "acp", model: "fixture/model" });
  expect(QWEN_DEFINITION.session.currentId(peer)).toBeUndefined();
  expect(() => QWEN_DEFINITION.start.create!({ ...context, permission: "read-only" })).toThrow("read-only");
});

test("#451 Qwen definition crash identity never fabricates an unavailable ACP session", () => {
  expect(QWEN_DEFINITION.session.crashIdentity?.({ sessionId: "qwen-saved_1:fixture" })).toEqual({ sessionId: "qwen-saved_1:fixture" });
  expect(QWEN_DEFINITION.session.crashIdentity?.({ sessionId: "not a session" })).toEqual({});
  expect(QWEN_DEFINITION.session.crashIdentity?.(undefined)).toEqual({});
});
