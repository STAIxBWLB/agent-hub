import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-instance-config-"));
  expect(hubGitSync(["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(root, ".agenthub"));
  return { root, write: (name: string, raw: object) => writeFileSync(join(root, ".agenthub", name), JSON.stringify(raw)),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

const declared = { "codex-2": { kind: "codex", roles: ["reviewer"], permission_mode: "ask-when-needed" } };

test("I2 local instance declarations project exact roles, permissions and headless defaults", () => {
  const f = fixture();
  try {
    f.write("config.local.json", { instances: declared });
    const config = loadConfig(f.root);
    expect(config.roles["codex-2"]).toEqual(["reviewer"]);
    expect(config.permission_modes["codex-2"]).toBe("ask-when-needed");
    expect(config.peers["codex-2"]?.start_mode).toBe("headless");
    expect(config.permission_default_sources?.["codex-2"]).toEqual({ mode: "ask-when-needed", source: ".agenthub/config.local.json" });
  } finally { f.close(); }
});

test("I2 instance declarations cannot enter from shared or git-tracked local config", () => {
  const f = fixture();
  try {
    f.write("config.json", { instances: declared });
    expect((loadConfig(f.root) as unknown as { instances?: object }).instances).toBeUndefined();
    f.write("config.json", {});
    f.write("config.local.json", { instances: declared });
    expect(hubGitSync(["-C", f.root, "add", "-f", ".agenthub/config.local.json"], { encoding: "utf8" }).status).toBe(0);
    const config = loadConfig(f.root) as unknown as { instances?: object; ignored?: string[] };
    expect(config.instances).toBeUndefined();
    expect(config.ignored?.join(" ")).toContain("instances");
  } finally { f.close(); }
});

test("I2 malformed declarations fail validation even before trust filtering", () => {
  const f = fixture();
  try {
    for (const instances of [
      { "codex-2": { kind: "unknown" } },
      { "kimi-2": { kind: "codex" } },
      { "codex-2": { kind: "codex", permission_mode: "allow-everything" } },
    ]) {
      f.write("config.local.json", { instances });
      expect(() => loadConfig(f.root)).toThrow();
    }
  } finally { f.close(); }
});
