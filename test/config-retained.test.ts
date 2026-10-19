import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("#542 a retained guarded launch key stays visible until confirmed", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-config-retained-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const file = (name: string) => join(dir, ".agenthub", name);
  writeFileSync(file("config.json"), JSON.stringify({ batch_ms: 0, roster: { jcode: false }, memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false } }));
  writeFileSync(file("routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"'));
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml"); git("commit", "-qm", "fixture baseline");
  const daemon = await startDaemon({ cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(state, { role: "console" }); cleanup.push(() => client.close());

  writeFileSync(file("config.local.json"), JSON.stringify({ jcode_cmd: ["jcode", "--model", "new"] }));
  const preview = await client.request({ t: "settings_reload" });
  expect(preview.confirmation?.keys).toContain("jcode_cmd");
  const pending = (await client.request({ t: "status" })).status.retainedConfig;
  expect(pending).toContainEqual(expect.objectContaining({ key: "jcode_cmd", reason: expect.any(String) }));

  const applied = await client.request({ t: "settings_reload", confirm: preview.confirmation.token });
  expect(applied.ok).toBe(true);
  expect((await client.request({ t: "status" })).status.retainedConfig ?? []).toEqual([]);
}, 15_000);
