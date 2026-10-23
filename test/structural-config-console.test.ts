import { expect, test } from "bun:test";
import { configFormPrompt, openConfigForm, reduceConfigForm, type ConfigForm } from "../src/cli/console-config.ts";

const rev = { "config.local.json": "a".repeat(64), "sdlc.toml": "absent" };
const type = (form: ConfigForm, text: string) => { let state: ConfigForm | undefined = form; for (const ch of text) state = reduceConfigForm(state!, ch, rev).form; return state!; };
const enter = (form: ConfigForm) => reduceConfigForm(form, "\r", rev);

test("#689 the instance form asks id, kind, roles, start mode, review mode, worktree, permission mode and read-only, then previews exactly the request the hub will validate", () => {
  let f = openConfigForm("1", 8)!; let effect;
  expect(configFormPrompt(f)).toContain("instance id");
  for (const answer of ["codex-review", "codex", "reviewer", "headless", "fresh", "", "", ""]) {
    expect(effect, "no preview before the last field").toBeUndefined();
    f = type(f, answer); const r = enter(f); f = r.form ?? f; effect = r.effect ?? effect;
  }
  expect(effect).toEqual({ type: "config_preview", token: 8, edit: { file: "config.local.json", revision: "a".repeat(64), set: [{ path: ["instances", "codex-review"], value: { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } }] } });
  expect(f.phase).toBe("preview");
});

test("#689 worktree, permission mode and read-only are typed as the loaders expect them", () => {
  let f = openConfigForm("1", 2)!; let effect;
  for (const answer of ["claude-impl", "claude", "implementer, verifier", "", "", "/tmp/wt", "ask", "true"]) { f = type(f, answer); const r = enter(f); f = r.form ?? f; effect = r.effect ?? effect; }
  expect((effect as { edit: { set: { value: object }[] } }).edit.set[0]!.value).toEqual({ kind: "claude", roles: ["implementer", "verifier"], worktree: "/tmp/wt", permission_mode: "ask", readOnly: true });
  let g = openConfigForm("1", 3)!;
  for (const answer of ["claude-x", "claude", "", "", "", "", ""]) { g = type(g, answer); g = enter(g).form!; }
  g = type(g, "maybe"); expect(enter(g).note).toContain("true or false");
});

test("#689 an empty answer omits the field; the missing start_mode case reaches the hub as typed, so the loader's reason is the hub's", () => {
  let f = openConfigForm("1", 1)!; let effect;
  for (const answer of ["codex-review", "codex", "reviewer", "", "fresh", "", "", ""]) { f = type(f, answer); const r = enter(f); f = r.form ?? f; effect = r.effect ?? effect; }
  expect((effect as { edit: { set: { value: object }[] } }).edit.set[0]!.value).toEqual({ kind: "codex", roles: ["reviewer"], review_mode: "fresh" });
});

test("#689 the form refuses a missing id or kind on the spot, edits with backspace and Ctrl-U, and Esc leaves nothing behind", () => {
  let f = openConfigForm("1", 1)!;
  expect(enter(f).note).toContain("instance id");
  f = type(f, "abc"); f = reduceConfigForm(f, "\x7f", rev).form!; expect(f.text).toBe("ab"); f = reduceConfigForm(f, "\x15", rev).form!; expect(f.text).toBe("");
  f = type(f, "codex-x"); f = enter(f).form!; expect(enter(f).form!.step).toBe(2); // an empty kind is allowed here: it is only required for a new instance, and the end says so
  let g = openConfigForm("1", 2, [])!;
  for (const answer of ["codex-x", "", "", "", "", "", "", ""]) { g = type(g, answer); const r = enter(g); if (answer === "") { g = r.form ?? g; } else g = r.form!; }
  expect(g.phase).toBe("fields"); // the last Enter was refused: no preview for a new instance without a kind
  expect(reduceConfigForm(f, "\x1b", rev)).toEqual({ form: undefined });
  expect(openConfigForm("9", 1)).toBeUndefined();
});

test("#689 the sdlc form takes a mode and optional required checks; an unknown choice is the hub's to refuse", () => {
  let f = openConfigForm("2", 3)!; let effect;
  for (const answer of ["enforce", "gate, seeded guards"]) { f = type(f, answer); const r = enter(f); f = r.form ?? f; effect = r.effect ?? effect; }
  expect(effect).toEqual({ type: "config_preview", token: 3, edit: { file: "sdlc.toml", revision: "absent", set: [{ path: ["mode"], value: "enforce" }, { path: ["required_checks"], value: ["gate", "seeded guards"] }] } });
});

test("#689 the other-key form takes a path and JSON; empty JSON removes the key; invalid JSON is refused before the hub", () => {
  let f = openConfigForm("3", 4)!;
  f = type(f, "review.pool"); f = enter(f).form!;
  f = type(f, "{bad"); expect(enter(f).note).toContain("JSON");
  f = reduceConfigForm(f, "\x15", rev).form!;
  f = type(f, '["claude","codex"]'); const r = enter(f);
  expect((r.effect as { edit: { set: unknown[] } }).edit.set).toEqual([{ path: ["review", "pool"], value: ["claude", "codex"] }]);
  let g = openConfigForm("3", 5)!; g = type(g, "review.pool"); g = enter(g).form!;
  expect((enter(g).effect as { edit: { set: unknown[] } }).edit.set).toEqual([{ path: ["review", "pool"], value: null }]);
  let h = openConfigForm("3", 6)!; h = type(h, "a..b"); expect(enter(h).note).toContain("path");
});

test("#689 after the preview the person gives a reason, then y writes; n and Esc write nothing; an empty reason is never a write", () => {
  let f: ConfigForm = { ...openConfigForm("3", 4)!, phase: "reason", text: "", edit: { file: "config.local.json", revision: "a".repeat(64), set: [{ path: ["review", "pool"], value: [] }] }, lines: ["review.pool: (unset) -> []"] };
  expect(enter(f).note).toContain("reason");
  f = type(f, "because"); f = enter(f).form!;
  expect(f.phase).toBe("confirm");
  expect(reduceConfigForm(f, "n", rev)).toEqual({ form: undefined });
  expect(reduceConfigForm(f, "x", rev).form).toBe(f);
  const written = reduceConfigForm(f, "y", rev);
  expect(written.form).toBeUndefined();
  expect(written.effect).toEqual({ type: "config_write", edit: f.edit!, reason: "because" });
});

test("#689 a tier 3 preview asks for the key's name, and only the exact name writes it", () => {
  let f: ConfigForm = { ...openConfigForm("3", 4)!, phase: "reason", text: "", edit: { file: "config.local.json", revision: "a".repeat(64), set: [{ path: ["instances", "jcode-two", "model"], value: "m" }] }, lines: ["x"], typed: "instances.jcode-two.model", warning: "runs code" };
  f = type(f, "why"); f = enter(f).form!;
  expect(f.phase).toBe("typed");
  expect(configFormPrompt(f)).toContain("type instances.jcode-two.model");
  expect(reduceConfigForm(type(f, "y"), "\r", rev).effect).toBeUndefined();
  const ok = reduceConfigForm(type({ ...f, text: "" }, "instances.jcode-two.model"), "\r", rev);
  expect(ok.effect).toEqual({ type: "config_write", edit: f.edit!, reason: "why", confirm: "instances.jcode-two.model" });
  expect(ok.form).toBeUndefined();
  expect(reduceConfigForm(type({ ...f, text: "" }, "instances.jcode-two.mode"), "\r", rev).effect).toBeUndefined();
});

test("#689 pasted text never confirms: a multi-character chunk is text in a text phase and ignored at y", () => {
  const f: ConfigForm = { ...openConfigForm("3", 4)!, phase: "confirm", text: "", edit: { file: "sdlc.toml", revision: "absent", set: [{ path: ["mode"], value: "off" }] }, lines: [], reason: "r" };
  expect(reduceConfigForm(f, "yy", rev).effect).toBeUndefined();
  expect(reduceConfigForm(f, "y\n", rev).effect).toBeUndefined();
});

test("#689 control bytes in typed or pasted text never enter an answer, so a terminal escape cannot be smuggled into a path or reason", () => {
  let f = openConfigForm("3", 1)!;
  f = reduceConfigForm(f, "review\x07.pool\x00", rev).form!;
  expect(f.text).toBe("review.pool");
  f = reduceConfigForm(f, "\x1b[31m", rev).form ?? f;
  expect(f.text).not.toContain("\x1b");
});

test("#689 the form first asks what to edit: 1 an instance, 2 the lifecycle, 3 another key; anything else is ignored and Esc leaves", () => {
  const start: ConfigForm = { kind: "other", token: 5, phase: "fields", step: 0, answers: [], text: "", choosing: true };
  expect(configFormPrompt(start)).toContain("1 instance");
  for (const [key, kind] of [["1", "instance"], ["2", "sdlc"], ["3", "other"]] as const) {
    const next = reduceConfigForm(start, key, rev).form!;
    expect(next).toMatchObject({ kind, token: 5, phase: "fields", step: 0 });
    expect(next.choosing).toBeUndefined();
  }
  expect(reduceConfigForm(start, "x", rev).form).toBe(start);
  expect(reduceConfigForm(start, "\r", rev).form).toBe(start);
  expect(reduceConfigForm(start, "12", rev).form).toBe(start);
  expect(reduceConfigForm(start, "\x1b", rev)).toEqual({ form: undefined });
});

test("#689 the instance form for an id the hub already declares sends only the fields typed, as leaves; a new id is one object", () => {
  const known = { "config.local.json": "a".repeat(64) };
  const run = (id: string, answers: string[]) => { let f = openConfigForm("1", 9, ["codex-review"])!; let effect; for (const answer of [id, ...answers]) { f = type(f, answer); const r = enter(f); f = r.form ?? f; effect = r.effect ?? effect; } void known; return (effect as { edit: { set: unknown[] } }).edit.set; };
  expect(run("codex-review", ["", "verifier", "", "", "", "", ""])).toEqual([{ path: ["instances", "codex-review", "roles"], value: ["verifier"] }]);
  expect(run("codex-review", ["", "", "clear", "", "", "", ""])).toEqual([{ path: ["instances", "codex-review", "start_mode"], value: null }]);
  expect(run("codex-new", ["codex", "reviewer", "headless", "fresh", "", "", ""])).toEqual([{ path: ["instances", "codex-new"], value: { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } }]);
});

test("#689 an existing instance with nothing typed is refused on the spot, and the kind is not required for it", () => {
  let f = openConfigForm("1", 9, ["codex-review"])!;
  f = type(f, "codex-review"); f = enter(f).form!;
  expect(f.step).toBe(1);
  for (let i = 0; i < 6; i++) f = enter(f).form!;
  const last = enter(f);
  expect(last.effect).toBeUndefined();
  expect(last.note).toContain("type a field to change");
});

test("#689 readOnly other than true, false or clear is refused rather than turned into false", () => {
  let f = openConfigForm("1", 9, [])!;
  for (const answer of ["codex-x", "codex", "", "", "", "", ""]) { f = type(f, answer); f = enter(f).form!; }
  f = type(f, "TRUE");
  expect(enter(f).note).toContain("true or false");
});
