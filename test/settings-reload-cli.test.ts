import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
const CONTROL = join(import.meta.dir, "../src/hub/control-client.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION", "AGENTHUB_DELIVERY_ONLY"];
const challenge = { ok: true, text: "guarded settings await confirmation", confirmation: { token: "fixture-bound-token", keys: ["roster.codex", "permission_modes.kimi"] }, rejected: [{ key: "codex_bin", reason: "restart only, unsafe candidate\x1b[31m" }], applied: [] };

/** Real CLI entry and identity gate; replace only its WS connection, never a real hub or project setting. */
async function cli(options: { tty?: boolean; answer?: string; timeout?: boolean; markers?: Record<string, string>; args?: string[]; reply?: object } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-settings-reload-cli-")), journal = join(root, "requests.jsonl"), wrapper = join(root, "cli.ts");
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, snapshots: { enabled: false } }));
  writeFileSync(wrapper, `import { appendFileSync } from "node:fs";
for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify(options.markers ?? {})}, { AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))} });
for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: ${!!options.tty} });
${options.timeout ? "AbortSignal.timeout = () => AbortSignal.abort();" : ""}
const { ControlClient } = await import(${JSON.stringify(CONTROL)});
ControlClient.connect = async (_state, identity) => {
  appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ connect: identity }) + "\\n");
  return { close() {}, request: async msg => {
    appendFileSync(${JSON.stringify(journal)}, JSON.stringify(msg) + "\\n");
    return msg.confirm ? { ok: true, text: "guarded settings applied" } : ${JSON.stringify(options.reply ?? challenge)};
  } };
};
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(options.args ?? ["settings", "reload"])}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let out = "", answered = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  const read = async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder();
    for (;;) { const part = await reader.read(); if (part.done) break; out += decoder.decode(part.value, { stream: true });
      if (!answered && out.includes("Apply guarded settings")) { answered = true; if (options.answer !== undefined) child.stdin.write(options.answer); child.stdin.end(); }
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

test("#439 reload CLI requires interactive confirmation and lists guarded keys and sanitized refusals", async () => {
  const result = await cli();
  expect(result.code).toBe(1); expect(result.requests).toEqual([{ t: "settings_reload" }]);
  expect(result.out).toContain("roster.codex"); expect(result.out).toContain("permission_modes.kimi"); expect(result.out).toContain("codex_bin"); expect(result.out).toContain("restart only, unsafe candidate"); expect(result.out).not.toContain("\x1b[31m");
  expect(result.err).toContain("interactive"); expect(result.err).toContain("ahub settings reload");
});

test("#439 reload CLI sends the bound token only after a person's explicit y", async () => {
  const result = await cli({ tty: true, answer: "y\n" });
  expect(result.code, result.err).toBe(0); expect(result.requests).toEqual([{ t: "settings_reload" }, { t: "settings_reload", confirm: "fixture-bound-token" }]);
  expect(result.connections).toEqual([{ connect: { role: "console", projectRoot: expect.any(String) } }]);
  expect(result.out).toContain("guarded settings applied");
});

for (const [name, input] of [["n", "n\n"], ["yes is not y", "yes\n"], ["EOF", undefined]] as const) test(`#439 reload CLI ${name} never sends confirmation`, async () => {
  const result = await cli({ tty: true, answer: input });
  expect(result.requests).toEqual([{ t: "settings_reload" }]); expect(result.out).not.toContain("guarded settings applied"); expect(result.out + result.err).toContain("guarded settings were not applied");
});

test("#439 reload CLI confirmation timeout never sends the token", async () => {
  const result = await cli({ tty: true, timeout: true });
  expect(result.requests).toEqual([{ t: "settings_reload" }]); expect(result.out + result.err).toContain("guarded settings were not applied");
});

test("#439 reload CLI preserves safe reload output without prompting", async () => {
  const result = await cli({ reply: { ok: true, text: "configuration reloaded", applied: ["research.enabled"] } });
  expect(result.code).toBe(0); expect(result.out).toBe("configuration reloaded\n"); expect(result.requests).toEqual([{ t: "settings_reload" }]);
});

test("#439 reload CLI refuses --yes and inherited agent identity before any connection", async () => {
  const auto = await cli({ args: ["settings", "reload", "--yes"] }); expect(auto.code).toBe(1); expect(auto.connections).toEqual([]); expect(auto.requests).toEqual([]);
  const agent = await cli({ tty: true, markers: { AGENTHUB_PEER_ID: "codex" } }); expect(agent.code).toBe(1); expect(agent.err).toContain("codex cannot run"); expect(agent.connections).toEqual([]); expect(agent.requests).toEqual([]);
});
