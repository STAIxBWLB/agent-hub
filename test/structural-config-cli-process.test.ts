import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
const CONTROL = join(import.meta.dir, "../src/hub/control-client.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION", "AGENTHUB_DELIVERY_ONLY"];
const revision = "a".repeat(64);
const replies: Record<string, object> = {
  config_edit_get: { ok: true, revisions: { "config.local.json": revision, "sdlc.toml": "absent" }, backups: [{ name: "sdlc.toml.1700000000000.abcdef12.bak", file: "sdlc.toml", at: 1_700_000_000_000, bytes: 9 }] },
  config_edit_preview: { ok: true, lines: ["review.pool: (unset) -> [\"codex\"] (applies at next use)"] },
  config_edit_apply: { ok: true, text: "config.local.json written: review.pool", restartPending: ["sdlc.mode"] },
};

/** The real CLI entry and identity gate; only its WS connection is a recorder, so no hub or project file is touched. */
async function cli(options: { args: string[]; tty?: boolean; answer?: string; markers?: Record<string, string>; replies?: Record<string, object> }) {
  const root = mkdtempSync(join(tmpdir(), "ahub-config-edit-cli-")), journal = join(root, "requests.jsonl"), wrapper = join(root, "cli.ts");
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, snapshots: { enabled: false } }));
  writeFileSync(wrapper, `import { appendFileSync } from "node:fs";
for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify(options.markers ?? {})}, { AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))} });
for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: ${!!options.tty} });
const { ControlClient } = await import(${JSON.stringify(CONTROL)});
const replies = ${JSON.stringify(options.replies ?? replies)};
ControlClient.connect = async (_state, identity) => {
  appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ connect: identity }) + "\\n");
  return { close() {}, request: async msg => { appendFileSync(${JSON.stringify(journal)}, JSON.stringify(msg) + "\\n"); return replies[msg.t] ?? { ok: false, error: "unexpected " + msg.t }; } };
};
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(options.args)}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let out = "", answered = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  const read = async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read(); if (part.done) break; out += decoder.decode(part.value, { stream: true });
      if (!answered && /\[y\/N\]|to confirm: /.test(out)) { answered = true; if (options.answer !== undefined) child.stdin.write(options.answer); child.stdin.end(); }
    }
    out += decoder.decode();
  };
  if (!options.tty) child.stdin.end();
  try {
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text(), read()]);
    const records = existsSync(journal) ? readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    return { code, out, err, requests: records.filter(row => row.t), connections: records.filter(row => row.connect) };
  } finally { clearTimeout(timer); rmSync(root, { recursive: true, force: true }); }
}
const edit = ["settings", "edit", "config.local.json", "set", "review.pool", '["codex"]', "--reason", "why"];

test("#689 a person at a terminal previews, answers y and the hub gets exactly the revision it reported", async () => {
  const result = await cli({ args: edit, tty: true, answer: "y\n" });
  expect(result.code, result.err).toBe(0);
  expect(result.requests).toEqual([{ t: "config_edit_get" }, { t: "config_edit_preview", edit: { file: "config.local.json", revision, set: [{ path: ["review", "pool"], value: ["codex"] }] } },
    { t: "config_edit_apply", edit: { file: "config.local.json", revision, set: [{ path: ["review", "pool"], value: ["codex"] }] }, reason: "why" }]);
  expect(result.connections).toEqual([{ connect: { role: "console", projectRoot: expect.any(String) } }]);
  expect(result.out).toContain("config.local.json written: review.pool");
  expect(result.out).toContain("restart pending: sdlc.mode");
});

test("#689 without a terminal and without --yes nothing is written; with --yes it is; --preview never writes", async () => {
  const none = await cli({ args: edit });
  expect(none.code).toBe(1); expect(none.err).toContain("nothing was changed");
  expect(none.requests.map(row => row.t)).toEqual(["config_edit_get", "config_edit_preview"]);
  const yes = await cli({ args: [...edit, "--yes"] });
  expect(yes.code, yes.err).toBe(0); expect(yes.requests.map(row => row.t)).toEqual(["config_edit_get", "config_edit_preview", "config_edit_apply"]);
  const preview = await cli({ args: [...edit, "--preview", "--yes"] });
  expect(preview.requests.map(row => row.t)).toEqual(["config_edit_get", "config_edit_preview"]);
  expect(preview.out).toContain("preview only");
});

test("#689 a tier 3 key is confirmed by its typed name: --yes, a wrong word and no terminal all write nothing", async () => {
  const tier3 = { ...replies, config_edit_preview: { ok: true, lines: ["instances.jcode-two.model: (set) -> (set) (pending restart)"], confirm: "instances.jcode-two.model", warning: "runs code" } };
  const args = ["settings", "edit", "config.local.json", "set", "instances.jcode-two.model", '"m"', "--yes"];
  const noTty = await cli({ args, replies: tier3 });
  expect(noTty.code).toBe(1); expect(noTty.err).toContain("by typing its name");
  const wrong = await cli({ args, replies: tier3, tty: true, answer: "y\n" });
  expect(wrong.requests.map(row => row.t)).not.toContain("config_edit_apply");
  const right = await cli({ args, replies: tier3, tty: true, answer: "instances.jcode-two.model\n" });
  expect(right.code, right.err).toBe(0);
  expect(right.requests.at(-1)).toMatchObject({ t: "config_edit_apply", confirm: "instances.jcode-two.model" });
});

test("#689 an agent identity is refused at the real gate and reaches no hub", async () => {
  for (const markers of [{ AGENTHUB_PEER_ID: "codex" }, { CLAUDECODE: "1" }, { CODEX_THREAD_ID: "t" }] as Record<string, string>[]) {
    for (const args of [edit, ["settings", "backups"]]) {
      const result = await cli({ args, markers, tty: true, answer: "y\n" });
      expect(result.code, JSON.stringify(markers)).not.toBe(0);
      expect(result.requests, JSON.stringify(markers)).toEqual([]);
    }
  }
});

test("#689 backups lists, an old hub is named, and a hub refusal is shown as the hub worded it", async () => {
  const backups = await cli({ args: ["settings", "backups"] });
  expect(backups.code, backups.err).toBe(0); expect(backups.out).toContain("sdlc.toml.1700000000000.abcdef12.bak");
  const old = await cli({ args: edit, replies: { config_edit_get: { ok: false, error: "unknown message config_edit_get" } } });
  expect(old.err).toContain("upgrade and restart the running hub");
  const refused = await cli({ args: edit, replies: { ...replies, config_edit_preview: { ok: false, error: "instances.codex-review.review_mode: fresh requires reviewer-only roles, headless mode and a declared fresh-review capability" } } });
  expect(refused.code).toBe(1); expect(refused.err).toContain("fresh requires reviewer-only roles, headless mode");
  expect(refused.requests.map(row => row.t)).toEqual(["config_edit_get", "config_edit_preview"]);
});

test("#689 a bad command line prints usage and never connects", async () => {
  const result = await cli({ args: ["settings", "edit", "routing.toml", "set", "x", "1"] });
  expect(result.code).toBe(1); expect(result.err).toContain("usage: ahub settings edit");
  expect(result.connections).toEqual([]);
});

test("#689 a terminal escape inside a preview line or a hub reply never reaches the person's terminal", async () => {
  const hostile = { ...replies, config_edit_preview: { ok: true, lines: ["review.pool: (unset) -> [\"\u001b]0;pwned\u0007\u001b[31mred\"] (applies at next use)"] }, config_edit_apply: { ok: true, text: "written \u001b[2Jcleared", restartPending: [] } };
  const result = await cli({ args: [...edit, "--yes"], replies: hostile });
  expect(result.code, result.err).toBe(0);
  expect(result.out).not.toContain("\u001b");
  expect(result.out).not.toContain("\u0007");
  expect(result.out).toContain("red");
});
