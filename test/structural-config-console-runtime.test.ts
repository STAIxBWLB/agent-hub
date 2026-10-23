import { expect, test } from "bun:test";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";

const revision = "b".repeat(64);
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
type Reply = Record<string, unknown>;
/** The real console runtime and reducer; only the hub's WS client is a recorder. */
function fixture(replies: { preview?: (msg: any) => Reply | Promise<Reply>; apply?: (msg: any) => Reply; pendingRestart?: { key: string; reason: string }[]; panelRows?: boolean } = {}) {
  let data = (_text: string) => {};
  const output: string[] = [], requests: any[] = [], commands: string[][] = [];
  const terminal: ConsoleTerminal = { columns: 140, rows: 30, isTTY: true, write: text => { output.push(text); }, raw: () => {}, onData: listener => { data = listener; return () => {}; }, onResize: () => () => {}, onSignal: () => () => {} };
  const client = { onPush: (_msg: any) => {}, onClose: (_code: number, _reason: string) => {}, send: (_msg: any) => {}, close: () => {}, request: async (msg: any): Promise<Reply> => {
    requests.push(msg);
    if (msg.t === "settings_get") return { ok: true, rows: [], pendingRestart: replies.pendingRestart ?? [], configEdit: { revisions: { "config.local.json": revision, "sdlc.toml": "absent" } } };
    if (msg.t === "config_edit_preview") return replies.preview ? await replies.preview(msg) : { ok: true, lines: ["review.pool: (unset) -> [\"codex\"] (applies at next use)"] };
    if (msg.t === "config_edit_apply") return replies.apply ? replies.apply(msg) : { ok: true, text: "config.local.json written: review.pool", restartPending: [] };
    return { ok: true, status: { peers: {}, pendingRestart: replies.pendingRestart ?? [] }, budget: {}, text: "[]", deliveries: [] };
  } };
  const running = runConsole({ client, cwd: "/tmp/fixture-only", stateDir: "/tmp/fixture-only", terminal, panels: true, color: false, noPet: true, runCommand: args => { commands.push(args); return () => {}; } });
  const press = async (text: string) => { for (const ch of text) { data(ch); } await tick(); };
  return { output, requests, commands, press, enter: async () => { data("\r"); await tick(); }, text: () => output.join(""), stop: async () => { data("\x03"); await running; } };
}
const writes = (f: ReturnType<typeof fixture>) => f.requests.filter(msg => msg.t === "config_edit_apply");
async function pool(f: ReturnType<typeof fixture>) { await f.press("6"); await f.press("c"); await f.press("3"); await f.press("review.pool"); await f.enter(); await f.press('["codex"]'); await f.enter(); }

test("#689 Settings key c opens the form, previews through the hub, asks a reason and y, and writes with the revision the hub reported", async () => {
  const f = fixture();
  try {
    await pool(f);
    expect(f.requests.find(msg => msg.t === "config_edit_preview")).toEqual({ t: "config_edit_preview", edit: { file: "config.local.json", revision, set: [{ path: ["review", "pool"], value: ["codex"] }] } });
    expect(writes(f)).toEqual([]);
    expect(f.text()).toContain("review.pool: (unset)"); // the diff is on screen
    await f.enter(); expect(writes(f)).toEqual([]); // an empty reason is never a write
    await f.press("shorter pool"); await f.enter(); expect(writes(f)).toEqual([]);
    await f.press("y");
    expect(writes(f)).toEqual([{ t: "config_edit_apply", edit: { file: "config.local.json", revision, set: [{ path: ["review", "pool"], value: ["codex"] }] }, reason: "shorter pool" }]);
    expect(f.text()).toContain("config.local.json written: review.pool");
  } finally { await f.stop(); }
});

test("#689 the codex-review reviewer missing start_mode shows the hub's loader reason on screen and the form closes with nothing written", async () => {
  const reason = "instances.codex-review.review_mode: fresh requires reviewer-only roles, headless mode and a declared fresh-review capability";
  const f = fixture({ preview: () => ({ ok: false, error: reason, field: "instances.codex-review.review_mode" }) });
  try {
    await f.press("6"); await f.press("c"); await f.press("1");
    for (const answer of ["codex-review", "codex", "reviewer", "", "fresh", "", "", ""]) { await f.press(answer); await f.enter(); }
    expect(f.text()).toContain("fresh requires reviewer-only roles, headless mode");
    expect(writes(f)).toEqual([]);
    await f.press("y"); expect(writes(f)).toEqual([]);
  } finally { await f.stop(); }
});

test("#689 Esc at any step writes nothing, and n at the last step writes nothing", async () => {
  const f = fixture();
  try {
    await f.press("6"); await f.press("c"); await f.press("3"); await f.press("review"); await f.press("\x1b");
    await pool(f); await f.press("a reason"); await f.enter(); await f.press("n");
    expect(writes(f)).toEqual([]);
  } finally { await f.stop(); }
});

test("#689 a tier 3 preview asks for the key's name after the reason; y does not write it and the exact name does", async () => {
  const f = fixture({ preview: () => ({ ok: true, lines: ["instances.jcode-two.model: (set) -> (set) (pending restart)"], confirm: "instances.jcode-two.model", warning: "this runs code with the daemon's rights" }) });
  try {
    await f.press("6"); await f.press("c"); await f.press("3"); await f.press("instances.jcode-two.model"); await f.enter(); await f.press('"m"'); await f.enter();
    await f.press("why"); await f.enter();
    expect(f.text()).toContain("type instances.jcode-two.model to confirm");
    await f.press("y"); await f.enter(); expect(writes(f)).toEqual([]);
    await f.press("\x15"); await f.press("instances.jcode-two.model"); await f.enter();
    expect(writes(f)).toHaveLength(1);
    expect(writes(f)[0]).toMatchObject({ confirm: "instances.jcode-two.model", reason: "why" });
  } finally { await f.stop(); }
});

test("#689 with a restart pending, R on the Settings panel prefills the person's restart command; Enter asks its own y and nothing runs before it", async () => {
  const f = fixture({ pendingRestart: [{ key: "sdlc.mode", reason: "the lifecycle is read once at hub start" }] });
  try {
    await f.press("6");
    expect(f.text()).toContain("restart pending: sdlc.mode");
    expect(f.text()).toContain("R restart");
    await f.press("R");
    expect(f.commands).toEqual([]);
    await f.enter();
    expect(f.commands).toEqual([]); // the command's own y comes next
    expect(f.text()).toContain("restart");
    await f.press("n");
    expect(f.commands).toEqual([]);
  } finally { await f.stop(); }
});

test("#689 R does nothing when no restart is pending", async () => {
  const f = fixture();
  try { await f.press("6"); await f.press("R"); await f.enter(); expect(f.commands).toEqual([]); expect(f.text()).not.toContain("R restart"); } finally { await f.stop(); }
});

test("#689 the footer on the Settings panel lists c, and the form is not reachable from another panel", async () => {
  const f = fixture();
  try {
    await f.press("6"); expect(f.text()).toContain("c config");
    await f.press("1"); await f.press("c"); await f.press("3"); expect(f.requests.some(msg => msg.t === "config_edit_preview")).toBe(false);
  } finally { await f.stop(); }
});

test("#689 c opens nothing on any other panel, and the prompt line names the step while the form is open", async () => {
  const f = fixture();
  try {
    for (const panel of ["1", "2", "3", "4", "5", "7"]) { await f.press(panel); await f.press("c"); await f.press("3"); }
    expect(f.text()).not.toContain("edit: 1 instance");
    await f.press("6"); await f.press("c");
    expect(f.text()).toContain("edit: 1 instance  2 sdlc lifecycle  3 another key");
    await f.press("2");
    expect(f.text()).toContain("sdlc mode (off, advise, enforce");
  } finally { await f.stop(); }
});

test("#689 R is inert on the Settings panel with nothing pending, and prefills the person's restart when something is", async () => {
  const none = fixture();
  try { await none.press("6"); await none.press("R"); await none.press("\r"); expect(none.text()).not.toContain(": restart"); } finally { await none.stop(); }
  const some = fixture({ pendingRestart: [{ key: "sdlc.mode", reason: "read once at start" }] });
  try { await some.press("6"); await some.press("R"); expect(some.text()).toContain(": restart"); } finally { await some.stop(); }
});

test("#689 a refused preview closes the form with the hub's reason, so a later y writes nothing and the next c starts clean", async () => {
  const f = fixture({ preview: () => ({ ok: false, error: "instances.x: refused by the loader" }) });
  try {
    await f.press("6"); await f.press("c"); await f.press("3"); await f.press("review.pool"); await f.enter(); await f.press("[]"); await f.enter();
    expect(f.text()).toContain("instances.x: refused by the loader");
    await f.press("y"); await f.enter();
    expect(writes(f)).toEqual([]);
    await f.press("c"); expect(f.text().split("edit: 1 instance").length).toBeGreaterThan(1);
  } finally { await f.stop(); }
});

test("#689 a preview reply that arrives after the form was cancelled never opens a confirmation", async () => {
  let release: (reply: Reply) => void = () => {};
  const f = fixture({ preview: () => new Promise<Reply>(resolve => { release = resolve; }) });
  try {
    await f.press("6"); await f.press("c"); await f.press("3"); await f.press("review.pool"); await f.enter(); await f.press("[]"); await f.enter();
    await f.press("\x1b"); // cancel while the hub is still checking
    release({ ok: true, lines: ["review.pool: (unset) -> []"] }); await tick();
    await f.press("a reason"); await f.enter(); await f.press("y");
    expect(writes(f)).toEqual([]);
  } finally { await f.stop(); }
});

test("#689 an older preview reply never lands on a newer form: the second form's own preview is the only one it shows", async () => {
  const waiting: ((reply: Reply) => void)[] = [];
  const f = fixture({ preview: () => new Promise<Reply>(resolve => { waiting.push(resolve); }) });
  try {
    const open = async (path: string) => { await f.press("c"); await f.press("3"); await f.press(path); await f.enter(); await f.press("[]"); await f.enter(); };
    await f.press("6"); await open("review.pool");
    await f.press("\x1b"); await open("snapshots.keep"); // the first form is gone, the second waits on its own reply
    expect(waiting).toHaveLength(2);
    waiting[0]!({ ok: true, lines: ["FIRST-DIFF review.pool"] }); await tick();
    expect(f.text()).not.toContain("FIRST-DIFF");
    waiting[1]!({ ok: true, lines: ["SECOND-DIFF snapshots.keep"] }); await tick();
    expect(f.text()).toContain("SECOND-DIFF");
    await f.press("why"); await f.enter(); await f.press("y");
    expect(writes(f)).toHaveLength(1);
    expect(writes(f)[0].edit.set[0].path).toEqual(["snapshots", "keep"]);
  } finally { await f.stop(); }
});
