import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";
import { configSourceTexts, parseConfigSources } from "../src/hub/config-reload.ts";
import { createConfigEditor, type ConfigEditHost, type EditAuthority } from "../src/hub/config-edit-host.ts";
import { configBackups, editRevisions } from "../src/hub/config-edit.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import type { HubEvent } from "../src/hub/events.ts";

const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const reviewer = { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" };

function fixture(local: unknown = {}, hold?: string, override: Partial<ConfigEditHost> = {}) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-config-host-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ batch_ms: 0, memory: { enabled: false, native: false } }));
  const git = (...args: string[]) => { const r = hubGitSync(["-C", dir, "-c", "user.name=F", "-c", "user.email=f@x", ...args], { encoding: "utf8" }); expect(r.status, r.stderr).toBe(0); };
  git("init", "-q"); git("add", "-f", ".agenthub/config.json"); git("commit", "-qm", "base");
  writeFileSync(join(dir, ".agenthub/config.local.json"), JSON.stringify(local, null, 2));
  const events: HubEvent[] = [], notices: string[] = [], reloads: { authority: EditAuthority; key: string }[] = [];
  const state2 = { held: hold, running: { mode: "off", requiredChecks: [] as string[] }, reloadError: undefined as string | undefined, pending: [] as { key: string; reason: string }[], changed: 0 };
  const host: ConfigEditHost = {
    cwd: dir, stateDir: state,
    check: (file, text) => {
      if (file !== "config.local.json") return;
      const texts = configSourceTexts(dir); texts["config.local.json"] = text;
      const sources = parseConfigSources(texts, undefined, dir);
      loadConfig(dir, sources.layers, sources.routing.retired ?? []);
    },
    held: () => state2.held,
    reload: async (authority, key) => { reloads.push({ authority, key }); return state2.reloadError ? { ok: false, error: state2.reloadError } : { ok: true }; },
    event: event => { events.push(event); }, notify: text => { notices.push(text); }, changed: () => { state2.changed++; },
    pending: () => state2.pending,
    effective: () => undefined,
    runningSdlc: () => state2.running,
    fileSdlc: () => {
      try {
        const doc = existsSync(join(dir, ".agenthub/sdlc.toml")) ? Bun.TOML.parse(readFileSync(join(dir, ".agenthub/sdlc.toml"), "utf8")) as { mode?: string; required_checks?: string[] } : {};
        return { mode: doc.mode ?? "off", requiredChecks: doc.required_checks ?? [] };
      } catch (error) { return (error as Error).message; }
    },
    declared: () => ({}),
    tier3Set: () => false,
    ...override,
  };
  const editor = createConfigEditor(host);
  const request = (set: { path: string[]; value: unknown }[], file: "config.local.json" | "sdlc.toml" = "config.local.json") => ({ file, revision: editRevisions(dir)[file], set });
  const read = (name: string) => existsSync(join(dir, ".agenthub", name)) ? readFileSync(join(dir, ".agenthub", name), "utf8") : null;
  return { dir, state, editor, events, notices, reloads, request, read, state2 };
}
const valid = (f: ReturnType<typeof fixture>) => f.request([{ path: ["instances", "codex-review"], value: reviewer }]);

test("#689 an ordinary dashboard session cannot preview or apply, and learns nothing about the project", async () => {
  const f = fixture();
  const before = f.read("config.local.json");
  const preview = f.editor.preview(valid(f), "ordinary");
  expect(preview).toMatchObject({ ok: false });
  expect(String(preview.error)).toContain("settings session");
  const applied = await f.editor.apply(valid(f), "ordinary");
  expect(applied.ok).toBe(false);
  expect(f.read("config.local.json")).toBe(before);
  expect(f.events).toEqual([]); expect(f.reloads).toEqual([]);
  // A request the loaders would refuse gets the same answer: the refusal does not depend on the project's content.
  expect(f.editor.preview(f.request([{ path: ["instances", "codex-review"], value: { kind: "codex" } }]), "ordinary").error).toBe(preview.error);
});

test("#689 the codex-review reviewer missing start_mode: the loader's reason, nothing written, no backup, no event", async () => {
  for (const authority of ["settings", "terminal"] as const) {
    const f = fixture({ roster: { codex: false } });
    const before = f.read("config.local.json");
    const request = f.request([{ path: ["instances", "codex-review"], value: { kind: "codex", roles: ["reviewer"], review_mode: "fresh" } }]);
    for (const result of [f.editor.preview(request, authority), await f.editor.apply(request, authority)]) {
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain("fresh requires reviewer-only roles, headless mode");
      expect(result.field).toBe("instances.codex-review.review_mode");
    }
    expect(f.read("config.local.json")).toBe(before);
    expect(configBackups(f.state)).toEqual([]); expect(f.events).toEqual([]); expect(f.reloads).toEqual([]);
  }
});

test("#689 a valid edit from a settings session or the console writes, backs up, audits with hashes only, and publishes each leaf scoped", async () => {
  for (const authority of ["settings", "terminal"] as const) {
    const f = fixture({ roster: { codex: false } });
    const preview = f.editor.preview(valid(f), authority);
    expect(preview).toMatchObject({ ok: true, tier: 2, file: "config.local.json" });
    expect(f.read("config.local.json")).toBe(JSON.stringify({ roster: { codex: false } }, null, 2)); // preview wrote nothing
    const result = await f.editor.apply(valid(f), authority, undefined, "add the fresh codex reviewer");
    expect(result).toMatchObject({ ok: true, saved: true });
    expect(String(result.text)).toContain("restart pending");
    expect(JSON.parse(f.read("config.local.json")!).instances["codex-review"]).toEqual(reviewer);
    expect(configBackups(f.state)).toHaveLength(1);
    expect(f.reloads.map(item => item.key).sort()).toEqual(["instances.codex-review.kind", "instances.codex-review.review_mode", "instances.codex-review.roles", "instances.codex-review.start_mode"]);
    expect(new Set(f.reloads.map(item => item.authority))).toEqual(new Set([authority]));
    expect(f.events).toHaveLength(1);
    const event = f.events[0] as Extract<HubEvent, { type: "config_edit" }>;
    expect(event).toMatchObject({ type: "config_edit", file: "config.local.json", by: "person", tier: 2, source: authority === "terminal" ? "terminal" : "dashboard", reason: "add the fresh codex reviewer" });
    expect(event.paths.map(row => row.path)).toEqual(["instances.codex-review"]);
    expect(JSON.stringify(event)).not.toContain("headless");
    expect(f.notices).toHaveLength(1);
  }
});

test("#689 a forged dashboard request for a tier 3 key is refused server side, for every form of the key, and writes nothing", async () => {
  const home = join(tmpdir(), "ahub-config-host-home"); mkdirSync(home, { recursive: true }); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const f = fixture({ instances: { "jcode-two": { kind: "jcode", jcode_home: home } } });
  const before = f.read("config.local.json");
  for (const set of [
    [{ path: ["instances", "jcode-two", "model"], value: "x" }],
    [{ path: ["instances", "jcode-two"], value: { kind: "jcode", jcode_home: "/tmp/elsewhere" } }],
    [{ path: ["kimi_cmd"], value: ["/bin/sh"] }],
    [{ path: ["terminal", "open"], value: "sh -c x" }],
    [{ path: ["omniroute", "api_key_file"], value: "/etc/passwd" }],
    [{ path: ["adapters", "evil"], value: { command: ["sh"] } }],
    [{ path: ["instances", "codex-review", "kind"], value: "codex" }, { path: ["jcode_cmd"], value: ["sh"] }],
  ]) {
    for (const call of [() => f.editor.preview(f.request(set), "settings"), () => f.editor.apply(f.request(set), "settings", "kimi_cmd")]) {
      const result = await call();
      expect(result.ok, JSON.stringify(set)).toBe(false);
      expect(String(result.error), JSON.stringify(set)).toMatch(/never editable from the dashboard|not a structural setting|unknown instance field/);
    }
  }
  expect(f.read("config.local.json")).toBe(before);
  expect(f.events).toEqual([]); expect(configBackups(f.state)).toEqual([]);
});

test("#689 the console may change a tier 3 key only with its exact typed name, one key at a time, and the preview never shows the value", async () => {
  const home = join(tmpdir(), "ahub-config-host-home2"); mkdirSync(home, { recursive: true }); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const f = fixture({ instances: { "jcode-two": { kind: "jcode", jcode_home: home, model: "old-model-name" } } });
  const set = [{ path: ["instances", "jcode-two", "model"], value: "new-model-name" }];
  const preview = f.editor.preview(f.request(set), "terminal");
  expect(preview).toMatchObject({ ok: true, tier: 3, confirm: "instances.jcode-two.model" });
  expect(String(preview.warning)).toContain("runs code with the daemon's rights");
  expect(JSON.stringify(preview)).not.toContain("old-model-name"); expect(JSON.stringify(preview)).not.toContain("new-model-name");
  for (const wrong of [undefined, "", "model", "instances.jcode-two", "instances.jcode-two.model ", "y"]) {
    const refused = await f.editor.apply(f.request(set), "terminal", wrong);
    expect(refused.ok, String(wrong)).toBe(false);
    expect(String(refused.error)).toContain("type the key name to confirm");
  }
  expect(f.read("config.local.json")).toContain("old-model-name");
  const two = await f.editor.apply(f.request([...set, { path: ["instances", "jcode-two", "provider"], value: "p" }]), "terminal", "instances.jcode-two.model");
  expect(String(two.error)).toContain("one executable or secret-locating key at a time");
  const done = await f.editor.apply(f.request(set), "terminal", "instances.jcode-two.model");
  expect(done.ok).toBe(true);
  expect(f.read("config.local.json")).toContain("new-model-name");
  const event = f.events[0] as Extract<HubEvent, { type: "config_edit" }>;
  expect(event.tier).toBe(3);
  expect(JSON.stringify(event)).not.toContain("model-name");
  expect(JSON.stringify(f.notices)).not.toContain("model-name");
});

test("#689 recovery or shutdown holds every edit, and a request's own revision is the one it read", async () => {
  const f = fixture({ roster: { codex: false } }, "recovery or shutdown");
  const request = valid(f);
  expect(String((await f.editor.apply(request, "terminal")).error)).toContain("recovery or shutdown is holding config edits");
  expect(String(f.editor.preview(request, "terminal").error)).toContain("holding config edits");
  f.state2.held = undefined;
  writeFileSync(join(f.dir, ".agenthub/config.local.json"), JSON.stringify({ roster: { codex: false }, approvals: { notify: true } }));
  const stale = await f.editor.apply(request, "terminal");
  expect(stale.ok).toBe(false);
  expect(String(stale.error)).toContain("changed on disk since it was read");
  expect(f.events).toEqual([]);
});

test("#689 sdlc.toml: advise to enforce is validated, written with a backup, audited, and reported as restart pending", async () => {
  const f = fixture();
  writeFileSync(join(f.dir, ".agenthub/sdlc.toml"), 'mode = "advise"\nrequired_checks = ["gate"]\n');
  f.state2.running = { mode: "advise", requiredChecks: ["gate"] };
  const preview = f.editor.preview(f.request([{ path: ["mode"], value: "enforce" }], "sdlc.toml"), "settings");
  expect(preview).toMatchObject({ ok: true, file: "sdlc.toml", tier: 2 });
  expect(preview.lines).toEqual(['sdlc.mode: "advise" -> "enforce" (pending restart)']);
  const bad = await f.editor.apply(f.request([{ path: ["mode"], value: "strict" }], "sdlc.toml"), "settings");
  expect(bad.ok).toBe(false); expect(String(bad.error)).toContain("expected off, advise or enforce");
  expect(f.read("sdlc.toml")).toBe('mode = "advise"\nrequired_checks = ["gate"]\n');
  const done = await f.editor.apply(f.request([{ path: ["mode"], value: "enforce" }], "sdlc.toml"), "settings");
  expect(done).toMatchObject({ ok: true, saved: true, restartPending: ["sdlc.mode"] });
  expect(f.read("sdlc.toml")).toBe('mode = "enforce"\nrequired_checks = ["gate"]\n');
  expect(f.reloads).toEqual([]); // the lifecycle is read once at start: there is nothing to publish
  expect(f.state2.changed).toBe(1); // status.json is rewritten so the pending restart shows
  expect(configBackups(f.state).map(item => item.file)).toEqual(["sdlc.toml"]);
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({ type: "config_edit", file: "sdlc.toml", tier: 2 });
  expect(f.editor.pendingRestart()).toEqual([{ key: "sdlc.mode", reason: "the lifecycle is read once at hub start" }]);
  expect(f.editor.view().sdlc).toMatchObject({ mode: "advise", pending: true });
});

test("#689 a write that saved but could not publish says so, keeps the file and the audit event", async () => {
  const f = fixture({ roster: { codex: false } });
  f.state2.reloadError = "instance declaration changed; its derived defaults apply together after daemon restart";
  const result = await f.editor.apply(valid(f), "settings");
  expect(result.ok).toBe(false);
  expect(result.saved).toBe(true);
  expect(String(result.error)).toContain("saved, but not published");
  expect(JSON.parse(f.read("config.local.json")!).instances["codex-review"]).toEqual(reviewer);
  expect(f.events).toHaveLength(1);
  expect(f.state2.changed).toBe(1); // a saved-but-unpublished edit still changes what status shows
});

test("#689 a status refresh that throws never turns a saved edit into a failure", async () => {
  const f = fixture({ roster: { codex: false } }, undefined, { changed: () => { throw new Error("status write failed"); } });
  const result = await f.editor.apply(valid(f), "terminal");
  expect(result).toMatchObject({ ok: true, saved: true });
  expect(f.events).toHaveLength(1);
});

test("#689 a reason that is empty, too long or carries control bytes is bounded before anything is written", async () => {
  const f = fixture({});
  for (const reason of ["", "   ", "x".repeat(401), 5]) expect((await f.editor.apply(valid(f), "terminal", undefined, reason)).ok, String(reason)).toBe(false);
  expect(f.events).toEqual([]);
  expect((await f.editor.apply(valid(f), "terminal", undefined, "ok\u0007reason")).ok).toBe(true);
  expect((f.events[0] as { reason?: string }).reason).toBe("ok reason");
});
