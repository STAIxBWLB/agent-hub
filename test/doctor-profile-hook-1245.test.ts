import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { shellQuote } from "../src/cli/shell-quote.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("doctor CLI warns about an unselected default's stale profile hook and names its exact repair home", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-doctor-profile-1245-"))); roots.push(root);
  const home = join(root, "home"), selected = join(root, "selected-profile"), fallback = join(home, ".claude"), bin = join(root, "bin");
  for (const directory of [home, selected, fallback, bin, join(root, ".agenthub")]) mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(root, ".agenthub/config.json"), "{}", { mode: 0o600 });
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ memory: { enabled: false }, mlx: { enabled: false } }), { mode: 0o600 });
  const packageRoot = resolve(import.meta.dir, ".."), calls = join(root, "claude-calls.log");
  const hook = (script: string) => ({ matcher: "*", hooks: [{ type: "command", timeout: 5,
    command: `${shellQuote(process.execPath)} ${shellQuote(script)} --run` }] });
  const settings = (entry: ReturnType<typeof hook>) => ({ statusLine: { type: "command", command: "preserve-status" },
    hooks: { PreToolUse: [entry], Stop: [{ hooks: [{ type: "command", command: "preserve-stop" }] }] }, caller: { preserve: true } });
  const selectedFile = join(selected, "settings.json"), fallbackFile = join(fallback, "settings.json");
  writeFileSync(selectedFile, JSON.stringify(settings(hook(join(packageRoot, "src/cli/claude-profile-hook.ts")))), { mode: 0o600 });
  writeFileSync(fallbackFile, JSON.stringify(settings(hook(join(root, "removed-package", "src/cli/claude-profile-hook.ts")))), { mode: 0o600 });
  const snapshot = (file: string) => {
    const info = statSync(file);
    return { bytes: readFileSync(file, "utf8"), ino: info.ino, mtime: info.mtimeMs, mode: info.mode };
  };
  const before = [snapshot(selectedFile), snapshot(fallbackFile)], listings = [readdirSync(selected), readdirSync(fallback)];
  for (const name of ["bun", "codex", "kimi", "jcode", "qwen", "agy", "pi", "dot", "amem"]) {
    writeFileSync(join(bin, name), '#!/bin/sh\ncase "$1" in --version) echo "fixture 1.0";; *) echo "{}";; esac\n', { mode: 0o755 });
  }
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$CLAUDE_CONFIG_DIR" >> ${shellQuote(calls)}\ncase "$1" in --version) echo "2.1.319 (Claude Code)";; plugin) echo "[]";; *) exit 1;; esac\n`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: selected,
    CODEX_HOME: join(root, "codex"), KIMI_CODE_HOME: join(root, "kimi"), QWEN_HOME: join(root, "qwen"), XDG_CONFIG_HOME: join(root, "xdg"),
    AGENTHUB_HOME: join(root, "ahub"), AMEM_HOME: join(root, "mem"), TMPDIR: root,
    PATH: `${bin}:/usr/bin:/bin`, AGENTHUB_OMNIROUTE_URL: "http://127.0.0.1:9/v1" };
  for (const marker of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "AGENTHUB_DELIVERY_ONLY", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID",
    "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "NODE_OPTIONS", "BUN_OPTIONS"]) delete env[marker];
  const child = Bun.spawn([process.execPath, join(packageRoot, "src/cli/main.ts"), "doctor", "--json"], {
    cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const rows = JSON.parse(stdout) as { name: string; level: string; section: string; detail: string }[];
    expect(code, stderr).toBe(rows.some(row => row.level === "fail") ? 1 : 0); // #1484: exit 1 exactly when a row failed
    const profiles = rows.filter(row => row.name.includes("profile hook"));
    const current = profiles.find(row => JSON.stringify(row).includes(selected));
    const stale = profiles.find(row => JSON.stringify(row).includes(fallback));
    expect(current).toMatchObject({ level: "ok", section: "Hub" });
    expect(stale).toMatchObject({ level: "warn", section: "Hub" });
    expect(stale!.detail).toContain("missing");
    expect(stale!.detail).toContain(`CLAUDE_CONFIG_DIR=${shellQuote(fallback)} ahub setup`);
    const probed = readFileSync(calls, "utf8").split("\n");
    expect(probed).toContain(selected); expect(probed).toContain(fallback);
    expect([snapshot(selectedFile), snapshot(fallbackFile)]).toEqual(before);
    expect([readdirSync(selected), readdirSync(fallback)]).toEqual(listings);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}, 20_000);
