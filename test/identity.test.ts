import { expect, test } from "bun:test";
import { classifyPeerCommand, cliCommandLabel, detectCliIdentity, liveTestRefusal, peerCommandRefusal, type PeerCommandAccess } from "../src/cli/identity.ts";
import { operationalRequestLabel } from "../src/hub/operational-authority.ts";
import { HELP, helpCommands } from "../src/cli/help.ts";

test("plain terminals keep console identity and native markers select tools identity", () => {
  expect(detectCliIdentity({})).toEqual({ role: "console" });
  for (const peer of ["claude", "codex", "kimi", "pi", "local"]) expect(detectCliIdentity({ AGENTHUB_PEER_ID: peer })).toEqual({ role: "tools", peer });
  expect(detectCliIdentity({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "session-1" })).toEqual({ role: "tools", peer: "claude" });
  expect(detectCliIdentity({ CODEX_THREAD_ID: "thread-1" })).toEqual({ role: "tools", peer: "codex" });
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "thread-1" })).toEqual({ role: "tools", peer: "codex" });
});

test("malformed and conflicting native identity never falls back to the person", () => {
  for (const env of [
    { AGENTHUB_PEER_ID: "" }, { AGENTHUB_PEER_ID: "user" }, { AGENTHUB_PEER_ID: "hub" }, { AGENTHUB_PEER_ID: "digest" }, { AGENTHUB_PEER_ID: "x".repeat(33) }, { AGENTHUB_PEER_ID: "codex\n" },
    { CLAUDECODE: "" }, { CLAUDECODE: "0" }, { CODEX_THREAD_ID: "" }, { CODEX_THREAD_ID: "thread with spaces" },
    { CLAUDE_CODE_SESSION_ID: "session-1" }, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "" },
    { CLAUDECODE: "1", CODEX_THREAD_ID: "thread-1" }, { AGENTHUB_PEER_ID: "kimi", CODEX_THREAD_ID: "thread-1" },
    { AGENTHUB_PEER_ID: "codex", CLAUDECODE: "1" },
  ]) expect(detectCliIdentity(env).role).toBe("invalid");
});

test("agent command classification refuses all human authority and keeps ordinary tools", () => {
  for (const command of ["permit", "kill", "down", "recovery-run", "up", "ask", "console", "ui", "tail", "undo", "unknown"]) expect(classifyPeerCommand(command, [])).toBe("console");
  // #812 moved bare recovery's screen forms and the dry-run previews to Allowed; these bare forms stay console.
  for (const command of ["queue", "recovery", "upgrade", "restart"]) expect(classifyPeerCommand(command, [])).toBe("console");
  for (const sub of ["resume", "set", "execution"]) expect(classifyPeerCommand("budget", [sub])).toBe("console");
  // #812 T1b: queue list is public; held bodies and writes remain conductor-only.
  expect(classifyPeerCommand("queue", ["list"])).toBe("allowed");
  for (const sub of ["show", "resolve", "discard"]) expect(classifyPeerCommand("queue", [sub])).toBe("conductor");
  for (const command of ["say", "status", "board", "report", "turns", "review", "remember", "help", "version", "facts", "check-path"]) expect(classifyPeerCommand(command, [])).toBe("allowed");
  expect(classifyPeerCommand("task", ["propose"])).toBe("allowed");
  expect(classifyPeerCommand("task", ["show"])).toBe("allowed");
  expect(classifyPeerCommand("task", ["unassign", "123"])).toBe("conductor");
  expect(classifyPeerCommand("route", ["explain"])).toBe("allowed");
  expect(classifyPeerCommand("budget", [])).toBe("allowed");
  expect(classifyPeerCommand("say", ["--as-user", "hello"])).toBe("console");
  expect(classifyPeerCommand("status", ["--as-user=true"])).toBe("console");
});

test("starts, holds and assignment require daemon conductor authority, never an environment flag", () => {
  for (const command of ["claude", "codex", "kimi", "pi", "local", "pause", "resume"]) expect(classifyPeerCommand(command, [])).toBe("conductor");
  for (const sub of ["assign", "escalate"]) expect(classifyPeerCommand("task", [sub])).toBe("conductor");
  expect(detectCliIdentity({ AGENTHUB_PEER_ID: "kimi", AGENTHUB_CONDUCTOR: "true" })).toEqual({ role: "tools", peer: "kimi" });
});

test("only exact restart, upgrade, recovery and unassign forms enter the conductor family", () => {
  const conductor: readonly [string, readonly string[]][] = [
    ["restart", ["--yes"]], ["restart", ["--yes", "--json"]],
    ["upgrade", ["--yes", "--to", "not-validated-here"]], ["upgrade", ["--to", "0.18.1", "--yes", "--json"]],
    ["recovery", ["resume"]], ["recovery", ["resume", "op-1"]], ["recovery", ["--json", "abort", "op-1"]],
    ["task", ["unassign", "123"]], ["task", ["unassign", "123", "--role", "reviewer"]],
  ];
  for (const [command, args] of conductor) expect(classifyPeerCommand(command, args)).toBe("conductor");

  const refused: readonly [string, readonly string[]][] = [
    ["restart", []], ["restart", ["--dry-run", "--yes"]], ["restart", ["--yes", "--to", "0.18.1"]],
    ["upgrade", ["--yes"]], ["upgrade", ["--to", "0.18.1"]], ["upgrade", ["--yes", "--to", "0.18.1", "--dry-run"]],
    ["recovery", ["resume", "op-1", "extra"]], ["recovery", ["abort", "--reason", "text"]], ["recovery", ["dispose", "op-1"]],
    ["recovery-run", ["op-1"]],
    ["backlog", ["list"]], ["release", ["list"]], ["sdlc", ["costs"]], ["sdlc", ["metrics"]],
  ];
  for (const [command, args] of refused) expect(classifyPeerCommand(command, args)).toBe("console");
});

test("operational request audit labels are closed and never include operands", () => {
  for (const command of ["restart", "upgrade", "recovery resume", "recovery abort", "task unassign"]) {
    expect(operationalRequestLabel({ t: "conductor_operational", op: "authorize", command, id: "PRIVATE_ID_CANARY", reason: "PRIVATE_REASON_CANARY" })).toBe(command);
  }
  expect(operationalRequestLabel({ t: "task", op: "task_unassign", args: { id: "PRIVATE_ID_CANARY", role: "owner" } })).toBe("task unassign");
  expect(operationalRequestLabel({ t: "conductor_operational", op: "authorize", command: "recovery-run", id: "PRIVATE_ID_CANARY" })).toBe("unknown");
  expect(operationalRequestLabel({ t: "task", op: "task_cancel", args: { id: "PRIVATE_ID_CANARY" } })).toBeUndefined();
});

test("audit labels and human-action hints contain command names only", () => {
  expect(cliCommandLabel("say", ["private-text"])).toBe("say");
  expect(cliCommandLabel("stop", ["private-peer"])).toBe("stop");
  expect(cliCommandLabel("down", [])).toBe("down");
  for (const args of [[], ["pi", "--as-user"]]) expect(classifyPeerCommand("stop", args)).toBe("console");
  expect(classifyPeerCommand("stop", ["pi"])).toBe("conductor");
  expect(cliCommandLabel("task", ["private-text"])).toBe("task");
  expect(cliCommandLabel("task", ["assign", "42", "private-text"])).toBe("task assign");
  expect(cliCommandLabel("task", ["unassign", "42"])).toBe("task unassign");
  expect(cliCommandLabel("task", ["claim", "42", "1", "supported"])).toBe("task claim");   // #901: its own label, not the generic "task"
  expect(cliCommandLabel("malformed\ncommand", [])).toBe("unknown");
  expect(cliCommandLabel("permit\n", [])).toBe("unknown");
  expect(peerCommandRefusal("claude", "permit")).toContain("ahub console or a terminal");
});

 test("permission is human-only even with --as-user or conductor markers (#242)", () => {
  for (const args of [[], ["pi"], ["pi", "never-ask", "--yes"], ["pi", "never-ask", "--yes", "--as-user"]]) expect(classifyPeerCommand("permission", args)).toBe("console");
  expect(cliCommandLabel("permission", ["private-peer"])).toBe("permission");
});

test("roster mutation requires conductor authority while direct roster settings stay person-only (#812)", () => {
  // #494: roster reads use the public settings projection; roster mutations retain their existing gate.
  for (const args of [[], ["--json"]]) expect(classifyPeerCommand("roster", args)).toBe("allowed");
  for (const args of [["add", "kimi"], ["remove", "kimi", "--yes", "--now"]]) expect(classifyPeerCommand("roster", args)).toBe("conductor");
  for (const args of [["set", "roster.kimi", "true"], ["set", "roster.kimi", "false", "--yes"]]) expect(classifyPeerCommand("settings", args)).toBe("console");
});

test("structural config edits and their backups are human-only for an agent identity (#689)", () => {
  for (const args of [["edit", "config.local.json", "set", "review.pool", "[]"], ["edit", "sdlc.toml", "set", "mode", "\"off\"", "--yes"], ["edit", "config.local.json", "set", "instances.jcode-two.model", "\"m\"", "--as-user"], ["backups"], ["backups", "--json"]]) expect(classifyPeerCommand("settings", args)).toBe("console");
});


test("memory dedupe listing and apply are console-only and audit-labeled without note text (#380)", () => {
  for (const args of [["dedupe"], ["dedupe", "--json"], ["dedupe", "--apply"], ["dedupe", "--apply", "--as-user"]]) {
    expect(classifyPeerCommand("memory", args)).toBe("console");
    expect(cliCommandLabel("memory", args)).toBe("memory dedupe");
  }
});

test("explicit Pi history replacement is a person-only CLI command", () => {
  expect(classifyPeerCommand("pi", ["--replace-session", "--session-file", "preserved.jsonl"])).toBe("console");
});

test("AC6: console refusal explains inherited markers and bang commands (#434)", () => {
  const refusal = peerCommandRefusal("claude", "queue");
  expect(refusal).toContain("inherited agent markers");
  expect(refusal).toContain("! command");
  expect(refusal).toContain("separate terminal");
  expect(refusal).toContain("ahub console");
});


test("console refusal names only identity markers actually present, never their values (#434 follow-up)", () => {
  const markerOnly = peerCommandRefusal("codex", "queue", { CODEX_THREAD_ID: "private-thread-marker" });
  expect(markerOnly).toContain("CODEX_THREAD_ID");
  expect(markerOnly).not.toContain("CLAUDECODE");
  expect(markerOnly).not.toContain("AGENTHUB_PEER_ID");
  expect(markerOnly).not.toContain("private-thread-marker");
  const combined = peerCommandRefusal("claude", "queue", { CLAUDECODE: "1", AGENTHUB_PEER_ID: "private-peer-marker" });
  expect(combined).toContain("CLAUDECODE"); expect(combined).toContain("AGENTHUB_PEER_ID");
  expect(combined).not.toContain("CODEX_THREAD_ID"); expect(combined).not.toContain("private-peer-marker");
  const empty = peerCommandRefusal("claude", "queue", {});
  for (const marker of ["CLAUDECODE", "AGENTHUB_PEER_ID", "CODEX_THREAD_ID"]) expect(empty).not.toContain(marker);
});


test("release authorization stays person-only while exact release preflights are peer reads", () => {
  expect(classifyPeerCommand("sdlc", ["authorize-release", "1.2.3"])).toBe("console");
  expect(liveTestRefusal("sdlc", ["authorize-release", "1.2.3"])).toBe(true);
  for (const sub of ["release-guard", "release-guard-hook"]) expect(classifyPeerCommand("sdlc", [sub])).toBe("allowed");
  for (const sub of ["record", "accept", "plan-review", "unknown"]) expect(classifyPeerCommand("sdlc", [sub])).toBe("console");
  // #786: the guarded merge is the person's or the configured conductor's (the daemon checks the role); live-test never delegates it.
  expect(classifyPeerCommand("sdlc", ["merge", "1"])).toBe("conductor"); expect(classifyPeerCommand("sdlc", ["merge", "1", "--dry-run"])).toBe("conductor");
  expect(liveTestRefusal("sdlc", ["merge", "1"])).toBe(true);
});

// #812 Allowed (round 2): only the forms the daemon admits for a tools connection; every demoted row sits in its command's block as a console expectation.
// queue list, bare roster (+ display flags), settings/list/get, sdlc status|explain|queue|release|costs|metrics, release show, backlog list and release list need a daemon check (#812 follow-up).
const allowedForms: readonly [string, readonly string[], PeerCommandAccess][] = [
  ["doctor", [], "allowed"],
  ["doctor", ["--json"], "allowed"],
  ["doctor", ["--full"], "allowed"],
  ["doctor", ["--color=always"], "allowed"],
  ["doctor", ["--stale-anchors"], "allowed"],
  ["doctor", ["--stale-anchors", "--json"], "allowed"],
  ["doctor", ["--orphans"], "console"],
  ["doctor", ["--orphans", "--kill", "--json"], "conductor"], // #818 routes doctor orphans kill to the conductor
  ["queue", ["list"], "allowed"],
  ["queue", ["list", "--peer", "kimi", "--json", "--color=never"], "allowed"],
  ["queue", ["show", "d1"], "conductor"],
  ["queue", ["resolve", "d1", "--action", "completed", "--reason", "done"], "conductor"],
  ["queue", ["discard", "--peer", "kimi", "--reason", "all"], "conductor"],
  ["roster", [], "allowed"],
  ["roster", ["--json"], "allowed"],
  ["roster", ["--color=always"], "allowed"],
  ["roster", ["add", "kimi"], "conductor"],
  ["roster", ["remove", "kimi", "--yes", "--now"], "conductor"],
  ["projects", [], "allowed"],
  ["projects", ["--json"], "allowed"],
  ["projects", ["remove", "p1"], "console"],
  ["models", ["status"], "allowed"],
  ["models", ["status", "--json", "--color=auto"], "allowed"],
  ["models", ["setup"], "console"],
  ["models", ["start"], "console"],
  ["models", ["stop"], "console"],
  ["recovery", ["status"], "allowed"],
  ["recovery", ["status", "op-1", "--json"], "allowed"],
  ["recovery", [], "console"],
  ["recovery", ["resume", "op-1"], "conductor"],
  ["recovery", ["abort", "op-1"], "conductor"],
  ["recovery", ["reattach", "op-1", "codex"], "console"],
  ["upgrade", ["--dry-run"], "allowed"],
  ["upgrade", ["--dry-run", "--json"], "allowed"],
  ["upgrade", ["--to", "1.2.3", "--dry-run"], "allowed"],
  ["upgrade", [], "console"],
  ["upgrade", ["--dry-run", "--yes"], "console"],
  ["upgrade", ["--yes"], "console"],
  ["restart", ["--dry-run"], "allowed"],
  ["restart", ["--dry-run", "--json", "--color=never"], "allowed"],
  ["restart", [], "console"],
  ["restart", ["--yes"], "conductor"],
  ["restart", ["--dry-run", "--yes"], "console"],
  ["settings", [], "allowed"],
  ["settings", ["list"], "allowed"],
  ["settings", ["list", "--json"], "allowed"],
  ["settings", ["get", "routing.claude"], "allowed"],
  ["settings", ["get", "routing.claude", "--json"], "allowed"],
  ["settings", ["set", "routing.claude", "implement"], "console"],
  ["settings", ["undo"], "console"],
  ["settings", ["reload"], "console"],
  ["settings", ["edit", "sdlc.toml", "set", "mode", "\"off\"", "--yes"], "console"],
  ["settings", ["backups"], "console"],
  ["sdlc", ["status"], "allowed"],
  ["sdlc", ["status", "42"], "allowed"],
  ["sdlc", ["explain", "42"], "allowed"],
  ["sdlc", ["queue", "STAIXBWLB/agent-hub"], "allowed"],
  ["sdlc", ["release", "STAIXBWLB/agent-hub"], "allowed"],
  ["sdlc", ["costs"], "console"],
  ["sdlc", ["metrics", "--since", "2026-10-01"], "console"],
  ["sdlc", ["export", "42"], "console"],
  ["sdlc", ["record", "42", "{}"], "console"],
  ["sdlc", ["train", "report"], "console"],
  ["sdlc", ["release-assign", "42", "1", "none", "reason"], "console"],
  ["backlog", ["list"], "console"],
  ["backlog", ["list", "--json", "--full", "--color=always"], "console"],
  ["backlog", ["add", "implement", "a title"], "console"],
  ["backlog", ["pull", "42"], "console"],
  ["release", ["list"], "console"],
  ["release", ["show", "0.18.0"], "allowed"],
  ["release", ["new", "0.18.0", "goal", "1"], "console"],
  ["release", ["freeze", "0.18.0", "1"], "console"],
];

test("#812 Allowed: every read-only form classifies allowed and each listed neighbour keeps its class", () => {
  for (const [command, args, access] of allowedForms) expect([command, args.join(" "), classifyPeerCommand(command, args)]).toEqual([command, args.join(" "), access]);
});

test("#812 AC1: every ahub help command has a class, so classification never throws", () => {
  const classes: readonly PeerCommandAccess[] = ["allowed", "conductor", "console"];
  for (const entry of HELP) {
    for (const word of helpCommands(entry)) expect(classes).toContain(classifyPeerCommand(word, []));
  }
});


test("#494 read forms keep planner reports and malformed/mutating neighbours closed", () => {
  for (const [command, args] of [
    ["queue", ["list", "--peer", "pi", "--json"]], ["roster", ["--json"]],
    ["settings", ["get", "research.enabled", "--json"]],
    ["sdlc", ["release", "owner/repository", "1", "2"]], ["release", ["show", "version"]],
  ] as [string, string[]][]) expect(classifyPeerCommand(command, args)).toBe("allowed");
  for (const [command, args] of [
    ["queue", ["list", "--peer"]], ["queue", ["list", "--yes"]], ["queue", ["list", "--verbose"]], ["roster", ["--now"]], ["roster", ["--verbose"]],
    ["settings", ["get"]], ["settings", ["get", "x", "y"]], ["settings", ["list", "--now"]],
    ["sdlc", ["queue"]], ["sdlc", ["status", "1", "2"]], ["sdlc", ["authorize-release", "1.0.0"]],
    ["sdlc", ["costs"]], ["sdlc", ["metrics"]], ["release", ["show"]],
    ["release", ["list"]], ["backlog", ["list"]],
  ] as [string, string[]][]) expect(classifyPeerCommand(command, args)).toBe("console");
});


test("#494 keeps the merged SDLC renderer flags on public reads only", () => {
  for (const sub of ["status", "explain", "queue", "release"]) {
    const positional = sub === "queue" || sub === "release" ? ["owner/repo"] : ["1"];
    for (const flag of ["--json", "--color=auto", "--color=always", "--color=never"])
      expect(classifyPeerCommand("sdlc", [sub, ...positional, flag])).toBe("allowed");
    expect(classifyPeerCommand("sdlc", [sub, ...positional, "--full"])).toBe("console");
  }
  for (const sub of ["costs", "metrics", "authorize-release"])
    expect(classifyPeerCommand("sdlc", [sub, "--json", "--color=never"])).toBe("console");
});

// #933: the console class shrinks to trust, money, attribution and interactive terminals. One row per form the issue lists.
const consoleClassForms: readonly [string, readonly string[], PeerCommandAccess][] = [
  // the person keeps these
  ["permission", ["pi", "never-ask", "--yes"], "console"],
  ["agents", ["trust", "codex-review", "0.165.0"], "console"],
  ["agents", ["--json"], "allowed"],
  ["role", ["assign", "codex", "backend-engineer"], "console"],
  ["budget", ["set", "claude", "1"], "console"],
  ["budget", ["resume", "claude"], "console"],
  ["say", ["--as-user", "hello"], "console"],
  ["task", ["cancel", "1", "--reason", "x", "--as-user"], "console"],
  ["board", ["import", "github", "--label", "x", "--as-user=1"], "console"],
  ["pi", ["--replace-session", "--session-file", "preserved.jsonl"], "console"],
  ["pet", ["--window"], "console"],
  ["watch", ["kimi"], "console"],
  ["recovery", ["reattach", "op-1", "codex"], "console"],
  ["no-such-command", [], "console"],
  ["restart", ["--yes"], "console"], // #900
  ["task", ["unassign", "1"], "console"], // #900
  ["route", ["set", "x"], "console"], // route has no form beyond explain
  ["route", ["explain", "1"], "allowed"],
  // conductor: operational, audited once by the daemon
  ["research", ["backfill"], "conductor"],
  ["bench", ["run", "suite.json", "--arm", "x"], "conductor"],
  ["board", ["import", "github", "--label", "ready"], "conductor"],
  ["upgrade", ["--to", "1.2.3", "--yes"], "console"], // its recovery runner and every running project: with restart in #900
  ["upgrade", ["--to", "1.2.3", "--yes", "--dry-run"], "console"],
  ["upgrade", ["--dry-run"], "allowed"],
  ["jcode", [], "conductor"],
  ["agy", [], "conductor"],
  ["settings", ["set", "tasks.escalate_after", "4"], "conductor"],
  ["settings", ["set", "tasks.queue_backpressure.max_queued", "10"], "console"], // money: limits automatic offers (queue-backpressure-config test)
  ["settings", ["set", "tasks.queue_backpressure.max_oldest_s", "60"], "console"],
  ["settings", ["set", "tasks.wip_limits.codex", "2"], "console"],
  ["settings", ["set", "tasks.auto_pull", "true"], "console"],
  ["settings", ["set", "permission_modes.codex", "ask"], "console"],
  ["settings", ["set", "planner", "codex"], "console"],
  ["source", ["add", "notes.md"], "conductor"],
  ["source", ["list"], "console"],
  ["intake", ["approve", "3"], "conductor"],
  ["intake", ["discard", "3"], "console"],
  ["schedule", ["run", "nightly"], "conductor"],
  ["schedule", ["pause", "nightly"], "conductor"],
  ["schedule", ["resume", "nightly"], "conductor"],
  ["schedule", ["list"], "console"],
  // amem 0.12.0 records these as "user": they stay the person's until the hub passes an agent actor
  ...["promote", "demote", "forget", "supersede", "rebuild"].map((sub): [string, string[], PeerCommandAccess] => ["memory", [sub, "x"], "console"]),
  ["memory", ["machine", "--label", "office"], "console"],
  ["memory", ["sync"], "console"],
  ["memory", ["graph", "x"], "console"],
  ...["new", "state", "done", "take"].map((sub): [string, string[], PeerCommandAccess] => ["goal", [sub, "x"], "console"]),
  ["goal", ["link", "x", "1"], "conductor"], // the daemon records the peer as the link's actor
  ["goal", ["take", "x", "--force"], "console"],
  // any agent, as itself, on its own task (the daemon refuses another peer's)
  ["task", ["cancel", "1", "--reason", "obsolete"], "allowed"],
  ["task", ["label", "1", "ok"], "allowed"],
  ["task", ["role", "1", "none"], "allowed"],
  ["deliverables", [], "allowed"],
  ["deliverables", ["--task", "1", "--check"], "allowed"],
];

test("#933: the fixture table covers every console, conductor and own-task row of the issue", () => {
  for (const [command, args, access] of consoleClassForms) expect([command, args.join(" "), classifyPeerCommand(command, args)]).toEqual([command, args.join(" "), access]);
});
