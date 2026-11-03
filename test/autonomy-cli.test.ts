import { expect, test } from "bun:test";
import { autonomyPreset } from "../src/hub/autonomy.ts";
import { autonomyEnvironment, renderAutonomyStatus, runAutonomy } from "../src/cli/autonomy.ts";

test("one person confirmation follows the concrete preview; refusal writes nothing", async () => {
  const calls: string[] = [], printed: string[] = [];
  const ports = { environment: "terminal", print: (line: string) => printed.push(line), ask: async () => { expect(printed).toContain("permission_modes.codex: never-ask (next peer start)"); return "n"; }, request: async (message: Record<string, unknown>) => { calls.push(String(message.action)); return { ok: true, confirmation: "preview-token", lines: ["permission_modes.codex: never-ask (next peer start)"] }; } };
  await runAutonomy(["on"], ports);
  expect(calls).toEqual(["preview"]);
  ports.ask = async () => "y";
  await runAutonomy(["on"], ports);
  expect(calls).toEqual(["preview", "preview", "on"]);
});

test("machine-default effects are disclosed and run only after the person confirms", async () => {
  for (const answer of ["n", "y"]) {
    const events: string[] = [];
    await runAutonomy(["on"], { environment: "terminal", contextLines: ["This also changes the machine default."], confirmPrompt: "Apply project and machine defaults?",
      print: line => { events.push(`print:${line}`); },
      ask: async prompt => { expect(prompt).toBe("Apply project and machine defaults?"); expect(events).toContain("print:This also changes the machine default."); events.push("confirm"); return answer; },
      beforeApply: () => { events.push("machine-write"); },
      request: async message => { events.push(String(message.action)); return { ok: true, confirmation: "token", lines: [] }; },
    });
    if (answer === "n") expect(events).not.toContain("machine-write");
    else { expect(events.indexOf("confirm")).toBeLessThan(events.indexOf("machine-write")); expect(events.indexOf("machine-write")).toBeLessThan(events.indexOf("on")); }
  }
});

test("a project apply failure states that the machine-default step already completed", async () => {
  let saved = false;
  await expect(runAutonomy(["on", "--yes"], { environment: "terminal", print() {}, ask: async () => null,
    beforeApply: () => { saved = true; },
    request: async message => message.action === "preview" ? { ok: true, confirmation: "token", lines: [] } : { ok: false, error: "project apply refused" },
  })).rejects.toThrow("Machine autonomy default was set to on; project apply failed");
  expect(saved).toBe(true);
});

test("--yes is one explicit on confirmation, not a generic flag accepted on off or status", async () => {
  const calls: Record<string, unknown>[] = [];
  const ports = { environment: "headless", print: () => {}, ask: async () => { throw new Error("unexpected ask"); }, request: async (message: Record<string, unknown>) => { calls.push(message); return { ok: true, confirmation: "preview-token" }; } };
  await runAutonomy(["on", "--yes"], ports);
  expect(calls.map(call => call.action)).toEqual(["preview", "on"]);
  expect(calls[1]!.confirmed).toBe(true);
  expect(calls[1]!.confirmation).toBe("preview-token");
  expect(await runAutonomy(["off", "--yes"], ports)).toContain("usage:");
  expect(await runAutonomy(["on", "--all-projects"], ports)).toContain("usage:");
});

test("status JSON and current environment are explicit; default output is readable lines", async () => {
  const printed: string[] = [];
  const ports = { environment: "orca", print: (line: string) => printed.push(line), ask: async () => null, request: async () => ({ ok: true, status: { environment: "orca", peers: [] }, lines: ["Project autonomy, environment: orca"] }) };
  await runAutonomy(["status"], ports);
  expect(printed).toEqual(["Project autonomy · environment orca", "", "PEER  NOW  NEXT START", "", "Guarded actions (0 classes; 0 enforced for at least one peer)"]);
  printed.length = 0;
  await runAutonomy(["status", "--json"], ports);
  expect(printed).toEqual([JSON.stringify({ environment: "orca", peers: [] })]);
  expect(autonomyEnvironment({ ORCA_WORKTREE_ID: "x", CI: "1" }, true)).toBe("orca");
  expect(autonomyEnvironment({ CI: "1" }, false)).toBe("ci");
  expect(autonomyEnvironment({}, false)).toBe("headless");
});

test("status groups identical floor verdicts and unknowns, preserves differences and falls back for older hubs", async () => {
  const shared = { class: "future-class", status: "not-enforced", reason: "Future guard has not been verified; keep this exact text." };
  const structural = { class: "structural", status: "structural-guard", reason: "Verified structural guard." };
  const peer = (id: string, effectiveMode: string, nextMode: string | null, floor = [shared, structural]) => ({
    id, effectiveMode, nextMode, floor,
    missing: ["future-class: duplicate floor reason", "structural: duplicate guard reason", "Unknown native tool confirmation?", "future-classification: retain this unknown."],
  });
  const status = { environment: "orca", machineDefault: { enabled: false, notice: "Machine evidence is unsafe." },
    peers: [peer("alpha", "never-ask", "never-ask"), peer("beta-long", "ask-when-needed", "ask-when-needed"), peer("gamma", "unmanaged", null),
      peer("delta", "ask", "ask", [{ ...shared, status: "hub-enforced", reason: "The hub asks before running." }, structural])],
    claudeHomes: [{ home: { path: "/fixture/home/profile" }, plugin: { state: "current" }, hook: { state: "missing", reason: "The project-neutral profile hook is not configured." } },
      { home: { path: "/fixture/home-other/profile" }, plugin: { state: "unknown" }, hook: { state: "refused", reason: "Unsafe home." } }],
    claudeHomeNotices: ["Profile discovery is incomplete."],
  };
  const lines = renderAutonomyStatus(status, "/fixture/home")!;
  expect(lines.slice(0, 7)).toEqual([
    "Project autonomy · environment orca · machine default off", "", "PEER       NOW              NEXT START",
    "alpha      never-ask        never-ask", "beta-long  ask-when-needed  ask-when-needed", "gamma      unmanaged        unmanaged", "delta      ask              ask",
  ]);
  expect(lines).toContain("Guarded actions (2 classes; 2 enforced for at least one peer)");
  expect(lines).toContain("  future-class · not-enforced · alpha, beta-long, gamma");
  expect(lines).toContain("  future-class · hub-enforced · delta");
  expect(lines).toContain("  structural · structural-guard · all peers");
  expect(lines.filter(line => line.includes(shared.reason))).toEqual([`    ${shared.reason}`]);
  expect(lines.filter(line => line.includes("Unknown native tool confirmation?"))).toEqual(["  alpha, beta-long, gamma, delta: Unknown native tool confirmation?"]);
  expect(lines).toContain("  alpha, beta-long, gamma, delta: future-classification: retain this unknown.");
  expect(lines.join("\n")).not.toContain("duplicate");
  expect(lines).toContain("Machine evidence is unsafe.");
  expect(lines).toContain("  Profile discovery is incomplete.");
  expect(lines).toContain("  ~/profile: plugin current; hook missing. The project-neutral profile hook is not configured.");
  expect(lines).toContain("  /fixture/home-other/profile: plugin unknown; hook refused. Unsafe home.");
  const printed: string[] = [];
  const reply = { ok: true, status, lines: ["legacy output", "  retained spacing", ""] };
  const ports = { environment: "orca", print: (line: string) => printed.push(line), ask: async () => null, request: async () => reply };
  await runAutonomy(["status"], ports);
  expect(printed).toEqual(renderAutonomyStatus(status)!);
  printed.length = 0;
  await runAutonomy(["status", "--json"], ports);
  expect(printed).toEqual([JSON.stringify(status)]);
  for (const oldStatus of [{ environment: "orca" }, { peers: null }, { peers: {} }]) {
    printed.length = 0;
    await runAutonomy(["status"], { ...ports, request: async () => ({ ...reply, status: oldStatus }) });
    expect(printed).toEqual(reply.lines);
  }
});

test("new environment detection is preset data rather than a native-name branch", () => {
  const preset = structuredClone(autonomyPreset());
  preset.environments.remote = { ...preset.environments.headless, aliases: [], detect: { priority: 20, variable: "REMOTE_EXECUTION" } };
  for (const kind of Object.values(preset.kinds)) kind.start.remote = kind.start.headless;
  expect(autonomyEnvironment({ REMOTE_EXECUTION: "1" }, false, preset)).toBe("remote");
});
