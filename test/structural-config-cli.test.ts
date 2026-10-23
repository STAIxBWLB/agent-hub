import { expect, test } from "bun:test";
import { parseSettingsEditArgs, renderEditPreview } from "../src/cli/settings-edit.ts";

test("#689 ahub settings edit parses file, set and remove into one request body", () => {
  expect(parseSettingsEditArgs(["config.local.json", "set", "instances.codex-review", '{"kind":"codex","roles":["reviewer"]}', "--reason", "add reviewer"])).toEqual({
    file: "config.local.json", set: [{ path: ["instances", "codex-review"], value: { kind: "codex", roles: ["reviewer"] } }], reason: "add reviewer", preview: false, yes: false });
  expect(parseSettingsEditArgs(["sdlc.toml", "set", "mode", '"enforce"', "--preview"])).toMatchObject({ file: "sdlc.toml", set: [{ path: ["mode"], value: "enforce" }], preview: true });
  expect(parseSettingsEditArgs(["config.local.json", "remove", "review.pool"])).toMatchObject({ set: [{ path: ["review", "pool"], value: null }] });
  expect(parseSettingsEditArgs(["sdlc.toml", "set", "required_checks", '["a","b"]', "remove", "mode"])).toMatchObject({ set: [{ path: ["required_checks"], value: ["a", "b"] }, { path: ["mode"], value: null }] });
});

test("#689 a bad command line is refused with usage and never reaches the hub", () => {
  for (const argv of [[], ["config.local.json"], ["routing.toml", "set", "x", "1"], ["config.local.json", "set", "review.pool"], ["config.local.json", "set", "review.pool", "{not json"],
    ["config.local.json", "set", "a..b", "1"], ["config.local.json", "set", ".a", "1"], ["config.local.json", "bogus", "x"], ["config.local.json", "set", "review.pool", "[]", "--reason"],
    ["config.local.json", "set", "review.pool", "[]", "--nope"], ["config.local.json", "remove"]]) {
    const result = parseSettingsEditArgs(argv);
    expect(typeof result, JSON.stringify(argv)).toBe("string");
    expect(result as string).toContain("usage: ahub settings edit");
  }
});

test("#689 the preview text shows diff lines, the warning and the exact word to type, never a secret value", () => {
  const lines = renderEditPreview({ ok: true, lines: ['instances.jcode-two.model: (set) -> (set) (pending restart)'], confirm: "instances.jcode-two.model", warning: "this runs code with the daemon's rights, or chooses where secrets are read from" });
  expect(lines.join("\n")).toContain("instances.jcode-two.model: (set) -> (set)");
  expect(lines.join("\n")).toContain("runs code with the daemon's rights");
  expect(lines.join("\n")).toContain("type instances.jcode-two.model to confirm");
  expect(renderEditPreview({ ok: true, lines: ['review.pool: ["claude"] -> ["codex"] (applies at next use)'] }).join("\n")).not.toContain("to confirm");
});

import { runSettingsEdit, type SettingsEditPorts } from "../src/cli/settings-edit.ts";

function ports(replies: Record<string, Record<string, unknown>>, answers: (string | null)[] = []) {
  const sent: Record<string, unknown>[] = [], printed: string[] = [], prompts: string[] = [];
  const port: SettingsEditPorts = {
    request: async message => { sent.push(message); const reply = replies[String(message.t)]; if (!reply) throw new Error(`unexpected ${String(message.t)}`); return reply; },
    ask: async prompt => { prompts.push(prompt); return answers.shift() ?? null; },
    print: line => { printed.push(line); },
  };
  return { port, sent, printed, prompts };
}
const view = { ok: true, revisions: { "config.local.json": "a".repeat(64), "sdlc.toml": "absent" }, backups: [{ name: "config.local.json.1700000000000.abcdef12.bak", file: "config.local.json", at: 1_700_000_000_000, bytes: 42 }] };

test("#689 a structural edit previews, asks y, then applies with the revision the hub reported", async () => {
  const t = ports({ config_edit_get: view, config_edit_preview: { ok: true, lines: ["review.pool: (unset) -> [\"codex\"] (applies at next use)"] }, config_edit_apply: { ok: true, text: "config.local.json written: review.pool", restartPending: [] } }, ["y"]);
  expect(await runSettingsEdit(["edit", "config.local.json", "set", "review.pool", '["codex"]', "--reason", "why"], t.port)).toBeUndefined();
  expect(t.sent.map(m => m.t)).toEqual(["config_edit_get", "config_edit_preview", "config_edit_apply"]);
  expect(t.sent[2]).toEqual({ t: "config_edit_apply", edit: { file: "config.local.json", revision: "a".repeat(64), set: [{ path: ["review", "pool"], value: ["codex"] }] }, reason: "why" });
  expect(t.printed.at(-1)).toBe("config.local.json written: review.pool");
});

test("#689 --preview and a declined prompt write nothing; --yes skips the prompt for tier 2 only", async () => {
  const replies = { config_edit_get: view, config_edit_preview: { ok: true, lines: ["x"] }, config_edit_apply: { ok: true, text: "done", restartPending: ["sdlc.mode"] } };
  const preview = ports(replies, ["y", "y"]);
  await runSettingsEdit(["config.local.json", "set", "review.pool", "[]", "--preview", "--yes"], preview.port);
  expect(preview.sent.map(m => m.t)).toEqual(["config_edit_get", "config_edit_preview"]);
  expect(preview.prompts).toEqual([]);
  const declined = ports(replies, ["n"]);
  await runSettingsEdit(["config.local.json", "set", "review.pool", "[]"], declined.port);
  expect(declined.sent.map(m => m.t)).not.toContain("config_edit_apply");
  const noTty = ports(replies, [null]);
  expect(await runSettingsEdit(["config.local.json", "set", "review.pool", "[]"], noTty.port)).toContain("not a terminal");
  expect(noTty.sent.map(m => m.t)).not.toContain("config_edit_apply");
  const yes = ports(replies);
  await runSettingsEdit(["config.local.json", "set", "review.pool", "[]", "--yes"], yes.port);
  expect(yes.sent.map(m => m.t)).toContain("config_edit_apply");
  expect(yes.printed.join("\n")).toContain("restart pending: sdlc.mode");
});

test("#689 a tier 3 key needs its name typed: --yes never confirms it, a wrong word or no terminal writes nothing", async () => {
  const replies = { config_edit_get: view, config_edit_preview: { ok: true, lines: ["instances.jcode-two.model: (set) -> (set) (pending restart)"], confirm: "instances.jcode-two.model", warning: "runs code" }, config_edit_apply: { ok: true, text: "done" } };
  const argv = ["config.local.json", "set", "instances.jcode-two.model", '"m"', "--yes"];
  const noTty = ports(replies, [null]);
  expect(await runSettingsEdit(argv, noTty.port)).toContain("by typing its name");
  const wrong = ports(replies, ["y"]);
  await runSettingsEdit(argv, wrong.port);
  expect(wrong.sent.map(m => m.t)).not.toContain("config_edit_apply");
  const right = ports(replies, ["instances.jcode-two.model"]);
  await runSettingsEdit(argv, right.port);
  expect(right.sent.at(-1)).toMatchObject({ t: "config_edit_apply", confirm: "instances.jcode-two.model" });
});

test("#689 backups lists what the hub reports, newest first as sent, and an old hub is named, not guessed", async () => {
  const t = ports({ config_edit_get: view });
  await runSettingsEdit(["backups"], t.port);
  expect(t.printed[0]).toContain("config.local.json.1700000000000.abcdef12.bak");
  expect(await runSettingsEdit(["backups", "--bad"], ports({}).port)).toContain("usage: ahub settings edit");
  const old = ports({ config_edit_get: { ok: true } });
  expect(await runSettingsEdit(["config.local.json", "set", "review.pool", "[]"], old.port)).toContain("does not report config revisions");
});
