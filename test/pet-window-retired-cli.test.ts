import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { PET_WINDOW_RETIRED_NOTICE } from "../src/pet/config.ts";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";

function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-pet-retired-"))), state = join(root, ".agenthub/state"), marker = join(root, "unexpected-effects.log"), bin = join(root, "bin");
  for (const dir of [state, bin, "home", "data", "amem", "codex", "claude", "kimi"].map(dir => dir.startsWith(root) ? dir : join(root, dir))) mkdirSync(dir, { recursive: true });
  // The compatibility pointer must not load presentation config or need a daemon.
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ pet: { window: { legacy: "ignored" }, character: "invalid-presentation-canary" } }));
  for (const name of ["osascript", "open", "acon", "ahub"]) writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$RETIRED_PET_EFFECTS"\nexit 77\n', { mode: 0o755 });
  const cli = join(import.meta.dir, "../src/cli/main.ts"), wrapper = join(root, "run-retired.ts");
  writeFileSync(wrapper, `import { appendFileSync } from 'node:fs';
import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const marker=${JSON.stringify(marker)};const reject=kind=>{appendFileSync(marker,kind+'\\n');throw new Error('unexpected '+kind)};
globalThis.fetch=()=>reject('fetch');globalThis.WebSocket=class{constructor(){reject('WebSocket')}};
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']){const original=cp[key];cp[key]=function(...args){const words=[args[0],...(Array.isArray(args[1])?args[1]:[])].map(String).join(' ');if(/osascript|window[.]jxa|(?:^|[/ ])acon(?: |$)|(?:^|[/ ])open(?: |$)/.test(words))reject(key);return original.apply(this,args)}}syncBuiltinESMExports();
await import(${JSON.stringify(cli)});`);
  const env: Record<string, string> = { HOME: join(root, "home"), AGENTHUB_HOME: join(root, "data"), AMEM_HOME: join(root, "amem"), CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), KIMI_CODE_HOME: join(root, "kimi"), PATH: `${bin}:${process.env.PATH}`, TERM: "xterm-256color", RETIRED_PET_EFFECTS: marker };
  const run = async (args: string[], agent: boolean, live: boolean) => {
    const child = Bun.spawn([process.execPath, wrapper, "--project", root, ...(live ? ["--live-test"] : []), "pet", ...args], { cwd: root, env: { ...env, ...(agent ? { AGENTHUB_PEER_ID: "codex" } : {}) }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  const noEffects = () => {
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(state).some(name => name.startsWith("pet-window") || name === "pet-view.json" || name === "hub.db")).toBe(false);
    expect(existsSync(join(root, "data/manager"))).toBe(false);
  };
  return { run, noEffects, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

for (const mode of [{ name: "person", agent: false, live: false }, { name: "agent", agent: true, live: false }, { name: "agent live-test", agent: true, live: true }, { name: "person live-test", agent: false, live: true }]) {
  test(`retired pet window is an offline one-line acon Mini pointer for ${mode.name} (#1012)`, async () => {
    const f = fixture();
    try {
      for (const args of [["--window"], ["--window", "--close"]]) {
        const result = await f.run(args, mode.agent, mode.live);
        expect(result.code, result.stderr).toBe(0); expect(result.stdout).toBe(PET_WINDOW_RETIRED_NOTICE + "\n"); expect(result.stderr).toBe("");
        f.noEffects();
      }
    } finally { f.cleanup(); }
  }, 20_000);
}

test("retired pet window retains usage validation and its valid forms never require console delegation (#1012)", async () => {
  for (const args of [["--window"], ["--window", "--close"]]) {
    expect(classifyPeerCommand("pet", args)).toBe("allowed"); expect(liveTestRefusal("pet", args)).toBe(false);
  }
  for (const arg of ["--as-user", "--as-user=person"]) {
    expect(classifyPeerCommand("pet", ["--window", arg])).toBe("console");
    expect(liveTestRefusal("pet", ["--window", arg])).toBe(true);
  }
  const f = fixture();
  try {
    for (const args of [["--window", "--bogus"], ["--window", "--short"], ["--close"]]) {
      const result = await f.run(args, true, true);
      expect(result.code).not.toBe(0); expect(result.stderr).toContain("usage: ahub pet"); expect(result.stdout).toBe("");
      f.noEffects();
    }
  } finally { f.cleanup(); }
}, 20_000);
