import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { queueResolveArgsValid, queueResolveChoices, queueResolveCommand } from "../src/hub/person-command.ts";
import { SupervisionFeed } from "../src/hub/supervision.ts";
import { PERSON_COMMAND_INSTRUCTION, STANDING_INSTRUCTION } from "../src/hub/envelope.ts";
import { upsertBlock } from "../src/cli/init.ts";
import { renderQueueShow } from "../src/cli/output.ts";

/** Split a printed command the way a POSIX shell would for these hints: `cd X && ahub queue resolve ...` with one double-quoted reason. */
function argv(command: string): string[] {
  const words: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3]!);
  return words;
}
/** The same reading `ahub queue resolve` does: three single-value flags, anything else is extra. */
function parse(words: string[]) {
  const at = words.indexOf("resolve"), id = words[at + 1], one: Record<string, string> = {}, extra: string[] = [];
  for (let i = at + 2; i < words.length; i++) {
    if (["--action", "--reason", "--revision"].includes(words[i]!)) one[words[i]!] = words[++i] ?? "";
    else extra.push(words[i]!);
  }
  return { id, one, extra };
}

test("#1399 the needs_review hold notice carries a command that passes the CLI argument rule, with id, revision, action and reason", () => {
  const sent: string[] = [];
  const feed = new SupervisionFeed({ conductor: () => "claude", scope: () => "own", tasks: () => [], publicTitle: () => "", isPrivate: () => false, emit: notice => { sent.push(JSON.stringify(notice)); } });
  const command = queueResolveCommand({ id: "d-1", revision: 42, state: "needs_review", peer: "codex", senders: ["claude"], kinds: ["chat"] }, "/work/my project");
  expect(feed.needsReview("codex", "d-1", command)).toBe(true);
    const text = Object.values(JSON.parse(sent[0]!) as Record<string, unknown>).find((v): v is string => typeof v === "string" && v.includes("ahub queue resolve"))!;
  const printed = text.slice(text.indexOf("cd "));
  const words = argv(printed);
  expect(words.slice(0, 3)).toEqual(["cd", "/work/my project", "&&"]);
  const { id, one, extra } = parse(words);
  expect(id).toBe("d-1");
  expect(one).toEqual({ "--revision": "42", "--action": "retry", "--reason": "chat from claude to codex" });
  expect(queueResolveArgsValid(one["--action"], one["--reason"], one["--revision"], extra)).toBe(true);
  expect(printed).not.toMatch(/<[a-z-]+>|completed\|retry/);
});

test("#1399 the argument rule refuses what the old hints produced", () => {
  expect(queueResolveArgsValid(undefined, undefined, undefined, [])).toBe(false);          // ahub queue resolve <id>
  expect(queueResolveArgsValid("completed|retry|discard", "<text>", undefined, [])).toBe(false);
  expect(queueResolveArgsValid("retry", " ", undefined, [])).toBe(false);
  expect(queueResolveArgsValid("retry", "why", "1.5", [])).toBe(false);
  expect(queueResolveArgsValid("retry", "why", undefined, ["stray"])).toBe(false);
});

test("#1399 a row with no known metadata still yields a runnable command, and unsafe text never reaches the shell line", () => {
  const bare = parse(argv(queueResolveCommand({ id: "d-2" })));
  expect(queueResolveArgsValid(bare.one["--action"], bare.one["--reason"], bare.one["--revision"], bare.extra)).toBe(true);
  const hostile = queueResolveCommand({ id: "d-3", state: "failed", peer: "co\"dex", senders: ["a$(rm -rf)b", "a$(rm -rf)b"], kinds: ["task`x`"] }, "/tmp/it's here");
  expect(hostile).toBe(`cd '/tmp/it'\\''s here' && ahub queue resolve d-3 --action discard --reason "taskx from arm-rfb to codex"`);
  expect(queueResolveChoices("failed")).toContain("discard drops it");
  expect(queueResolveChoices("needs_review")).toContain("retry sends it again");
});

test("#1399 ahub queue show prints the full command for a held and for a failed row", () => {
  const flat = (delivery: unknown) => renderQueueShow(delivery, 400, 0, "/work/p").map(line => line.map(span => span.text).join("")).join("\n");
  const held = flat({ id: "d-4", peer: "codex", state: "needs_review", revision: 7, messages: [{ from: "hub", kind: "task" }] });
  expect(held).toContain(`cd /work/p && ahub queue resolve d-4 --revision 7 --action retry --reason "task from hub to codex"`);
  const failed = flat({ id: "d-5", peer: "jcode", state: "failed", revision: 9, messages: [{ from: "claude", kind: "chat" }] });
  expect(failed).toContain(`cd /work/p && ahub queue resolve d-5 --revision 9 --action discard --reason "chat from claude to jcode"`);
  expect(held + failed).not.toContain("<text>");
});

test("#1399 the relay rule is in the managed block, the standing instruction and every profile's rendered block; profiles hold no second copy", () => {
  const template = readFileSync(join(import.meta.dir, "../templates/AGENTS.block.md"), "utf8");
  expect(template).toContain("pass it on exactly as printed, with every flag and the `cd` prefix");
  expect(STANDING_INSTRUCTION).toContain(PERSON_COMMAND_INSTRUCTION);
  const bullets = template.split("\n").filter(line => line.startsWith("- "));
  expect(bullets.length).toBeGreaterThan(10);
  for (const name of ["general", "research", "writing"]) {
    const addition = (JSON.parse(readFileSync(join(import.meta.dir, `../templates/profiles/${name}.json`), "utf8")) as { agents: string }).agents;
    expect(addition, name).toStartWith(`# Project profile: ${name}`);
    expect(addition, name).not.toContain("## agent-hub");
    const rendered = upsertBlock("", `${template.trim()}\n\n${addition}`);
    for (const bullet of bullets) expect(rendered, name).toContain(bullet);
  }
});

test("#1399 an older project's block is reported as stale by the plan doctor reads, and init refreshes it without touching other text", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { init, planInit } = await import("../src/cli/init.ts");
  const dir = mkdtempSync(join(tmpdir(), "ahub-1399-"));
  try {
    init(dir);
    const agents = join(dir, "AGENTS.md"), current = readFileSync(agents, "utf8");
    expect(planInit(dir).some(change => change.path === agents)).toBe(false);
    const old = `# Mine\n\nKeep this line.\n\n${current.replace("pass it on exactly as printed", "OLD WORDING")}\nTail stays.\n`;
    writeFileSync(agents, old);
    expect(planInit(dir).some(change => change.path === agents)).toBe(true);
    init(dir);
    const refreshed = readFileSync(agents, "utf8");
    expect(refreshed).toStartWith("# Mine\n\nKeep this line.\n\n"); expect(refreshed).toEndWith("Tail stays.\n");
    expect(refreshed).toContain("pass it on exactly as printed"); expect(refreshed).not.toContain("OLD WORDING");
    expect(planInit(dir).some(change => change.path === agents)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#1399 the block states no heavy-job number of its own: it defers to the machine's admission tool and keeps one per repository only as the fallback", () => {
  const template = readFileSync(join(import.meta.dir, "../templates/AGENTS.block.md"), "utf8");
  expect(template).toContain("follow this machine's own limit");
  expect(template).toContain("`dot admit`");
  expect(template).toContain("without such a tool, run at most one per repository at a time");
  expect(template).not.toContain("Run at most one heavy job");
});
