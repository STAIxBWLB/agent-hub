import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { claimPetWindow, closePetWindow, petWindowArgv, PET_WINDOW_UNSUPPORTED, startPetWindow, windowView, writePetView } from "../src/pet/window.ts";
import { loadPetConfig } from "../src/pet/config.ts";
import { readPet } from "../src/cli/pet.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { personEnv } from "../src/hub/child-process.ts";
import { CHARACTERS } from "../src/pet/characters.ts";
import { petPixels } from "../src/pet/pixels.ts";

const rootPath = join(import.meta.dir, "..");
const jxa = readFileSync(join(rootPath, "src/pet/window.jxa.js"), "utf8");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-pet-window-"));
  const state = join(root, ".agenthub/state"); mkdirSync(state, { recursive: true });
  return { root, state, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
async function until(condition: () => boolean) {
  const end = Date.now() + 5000;
  while (!condition() && Date.now() < end) await Bun.sleep(20);
  expect(condition()).toBe(true);
}
function status(state: string, needs: object) {
  writeFileSync(join(state, "status.json"), JSON.stringify({ pid: process.pid, pidSignature: processSignature(process.pid), needs, privateTitle: "SECRET_TASK_TEXT", refs: ["SECRET_PATH"] }));
}

test("window file copies only counts, state and approved pixels atomically", async () => {
  const f = fixture();
  try {
    status(f.state, { act: 1, watch: 0, state: "waiting", first: { kind: "approval", level: "act", id: "SECRET_ID", until: Date.now() + 10000, title: "SECRET_TASK_TEXT" } });
    const config = { enabled: true, blink: true, bell: false, character: "gyul" as const };
    const first = windowView(readPet(f.state), config, 0);
    expect(Object.keys(first).sort()).toEqual(["act", "blink", "character", "frame", "state", "watch"]);
    expect(first).toMatchObject({ act: 1, watch: 0, state: "waiting", character: "gyul", blink: true, frame: petPixels(CHARACTERS.gyul.frames.blocks.waiting.full) });
    expect(JSON.stringify(first)).not.toContain("SECRET");
    expect(windowView(readPet(f.state), config, 1000)).toMatchObject({ frame: petPixels(CHARACTERS.gyul.frames.blocks.waitingBlink.full) });
    expect(windowView(readPet(f.state), { ...config, blink: false }, 1000)).toMatchObject({ frame: petPixels(CHARACTERS.gyul.frames.blocks.waiting.full) });
    writePetView(f.state, first);
    const held = Bun.file(join(f.state, "pet-view.json"));
    // Open the old inode before replacing it; rename gives readers a complete generation.
    const { openSync, readFileSync: read, closeSync } = await import("node:fs");
    const oldFd = openSync(join(f.state, "pet-view.json"), "r");
    try {
      writePetView(f.state, { offline: true });
      expect(JSON.parse(read(oldFd, "utf8"))).toEqual(first);
      expect(await held.json()).toEqual({ offline: true });
    } finally { closeSync(oldFd); }
    expect(readdirSync(f.state).filter(name => name.endsWith(".tmp"))).toEqual([]);
    status(f.state, { act: 0, watch: 0, state: "working" });
    expect(windowView(readPet(f.state), config)).toMatchObject({ state: "working", act: 0 });
  } finally { f.dispose(); }
});

test("offline and recovery-unavailable views never publish an empty live hub", () => {
  const f = fixture();
  try {
    const config = loadPetConfig(f.root);
    expect(windowView(readPet(f.state), config)).toEqual({ offline: true });
    expect(windowView({ unavailable: true, summary: { state: "blocked", act: 1, watch: 0 } }, config)).toEqual({ offline: true });
    writeFileSync(join(f.state, "status.json"), JSON.stringify({ pid: process.pid, pidSignature: "different", needs: { state: "idle", act: 0, watch: 0 } }));
    expect(windowView(readPet(f.state), config)).toEqual({ offline: true });
  } finally { f.dispose(); }
});

test("signed pidfile is exclusive and --close clears gone owners, retaining malformed owners", async () => {
  const f = fixture();
  try {
    const claim = claimPetWindow(f.state)!;
    expect(claimPetWindow(f.state)).toBeUndefined();
    expect(await startPetWindow(f.state, f.root, "darwin").catch(e => e.message)).toContain("starting, stale or unconfirmed");
    claim.release();
    writeFileSync(join(f.state, "pet-window.pid"), JSON.stringify({ pid: process.pid, signature: "a".repeat(64), token: "gone" }));
    expect(() => claimPetWindow(f.state)).toThrow("stale or unconfirmed");
    expect(await closePetWindow(f.state, "darwin")).toBe("Pet window closed.");
    expect(await closePetWindow(f.state, "darwin")).toBe("Pet window is not running.");
    writeFileSync(join(f.state, "pet-window.pid"), "broken");
    expect(await closePetWindow(f.state, "darwin").catch(e => e.message)).toContain("pidfile retained");
    expect(readFileSync(join(f.state, "pet-window.pid"), "utf8")).toBe("broken");
  } finally { f.dispose(); }
});

test("window config merges its local opt-in without changing terminal defaults", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, ".agenthub/config.json"), JSON.stringify({ pet: { window: true, character: "boxbot" } }));
    expect(loadPetConfig(f.root)).toMatchObject({ window: true, character: "boxbot" });
    writeFileSync(join(f.root, ".agenthub/config.local.json"), JSON.stringify({ pet: { window: false, blink: false } }));
    expect(loadPetConfig(f.root)).toMatchObject({ window: false, character: "boxbot", blink: false });
    writeFileSync(join(f.root, ".agenthub/config.local.json"), JSON.stringify({ pet: { window: "true" } }));
    expect(loadPetConfig(f.root).window).toBeUndefined();
    expect(loadPetConfig(f.root).notice).toBeDefined();
  } finally { f.dispose(); }
});

test("JXA sends literal text as NSTask argv with silent output and no null completion blocks", () => {
  const tasks: any[] = [];
  const dollar: any = (value: any) => value;
  dollar.NSTask = { alloc: { get init() { const task: any = { launchAndReturnError: () => true }; tasks.push(task); return task; } } };
  dollar.NSURL = { fileURLWithPath: (path: string) => path };
  dollar.NSFileHandle = { fileHandleWithNullDevice: "null-device" };
  const context: any = { $: dollar, ObjC: { import: () => {}, registerSubclass: () => {} }, cliArgv: undefined };
  runInNewContext(jxa, context);
  const argv = ["/bun path", "/cli path", "--project", "/project path"];
  const text = '@claude --flag $(touch /should-not-exist); "quotes"\nsecond line';
  context.runCommand("say", text, argv);
  expect(tasks[0].arguments).toEqual(["/cli path", "--project", "/project path", "say", "--", text]);
  expect(tasks[0].executableURL).toBe("/bun path");
  expect(tasks[0].standardOutput).toBe("null-device"); expect(tasks[0].standardError).toBe("null-device");
  expect(jxa).not.toContain("doShellScript");
  expect(jxa).toContain("task.arguments = $(args)");
  expect(jxa).toContain("evaluateJavaScriptCompletionHandler(source, ignoreCompletion)");
  expect(jxa).not.toMatch(/evaluateJavaScriptCompletionHandler\([^;]*,\s*null\)/);
  expect(jxa).toContain("NSWindowStyleMaskNonactivatingPanel");
  expect(jxa).toContain("NSWindowCollectionBehaviorCanJoinAllSpaces");
  expect(jxa).toContain("savePosition()");
  const html = readFileSync(join(rootPath, "src/pet/window.html"), "utf8");
  expect(html).toContain("connect-src 'none'"); expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest|new WebSocket/);
  expect(petWindowArgv("/project path")).toEqual([process.execPath, join(rootPath, "src/cli/main.js"), "--project", "/project path"]);
});

test("non-macOS refuses window start and close; marker-bound CLI refuses --window only", async () => {
  const f = fixture();
  try {
    expect(await startPetWindow(f.state, f.root, "linux")).toBe(PET_WINDOW_UNSUPPORTED);
    expect(await closePetWindow(f.state, "win32")).toBe(PET_WINDOW_UNSUPPORTED);
    expect(classifyPeerCommand("pet", [])).toBe("allowed");
    expect(classifyPeerCommand("pet", ["--short"])).toBe("allowed");
    expect(classifyPeerCommand("pet", ["--window"])).toBe("console");
    expect(classifyPeerCommand("pet", ["--window", "--close"])).toBe("console");
    const env = { ...personEnv(), AGENTHUB_PEER_ID: "codex", AGENTHUB_HOME: join(f.root, "home") };
    const child = Bun.spawn([process.execPath, join(rootPath, "src/cli/main.ts"), "--project", f.root, "pet", "--window"], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1); expect(out + err).toContain("codex cannot run ahub pet");
    expect(readdirSync(f.state)).not.toContain("pet-window.pid");
  } finally { f.dispose(); }
}, 20000);

test("host exits with its child, reloads state/config, writes offline, and --close stops only its owner", async () => {
  const f = fixture();
  const hostModule = join(rootPath, "src/pet/window.ts");
  const worker = join(f.root, "worker.ts"), host = join(f.root, "host.ts");
  writeFileSync(worker, `import { writeFileSync, readFileSync } from 'node:fs'; import { join } from 'node:path'; const state = process.argv[2]!; writeFileSync(join(state, 'pet-window-ready-' + process.pid), 'ready'); const timer = setInterval(() => { if (JSON.parse(readFileSync(join(state, 'pet-view.json'), 'utf8')).offline) { clearInterval(timer); process.exit(0); } }, 20);`);
  writeFileSync(host, `import { runPetWindowHost } from ${JSON.stringify(hostModule)}; await runPetWindowHost(process.argv[2]!, process.argv[3]!, { childArgv: [process.execPath, ${JSON.stringify(worker)}, process.argv[2]!] });`);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    status(f.state, { act: 0, watch: 0, state: "idle" });
    const launch = () => Bun.spawn([process.execPath, host, f.state, f.root], { stdout: "ignore", stderr: "pipe" });
    child = launch();
    await until(() => { try { return JSON.parse(readFileSync(join(f.state, "pet-window.pid"), "utf8")).ready === true; } catch { return false; } });
    expect(await startPetWindow(f.state, f.root, "darwin")).toBe("Pet window is already running.");
    status(f.state, { act: 0, watch: 0, state: "working" });
    writeFileSync(join(f.root, ".agenthub/config.local.json"), JSON.stringify({ pet: { character: "lantern" } }));
    await until(() => { const view = JSON.parse(readFileSync(join(f.state, "pet-view.json"), "utf8")); return view.state === "working" && view.character === "lantern"; });
    expect(await closePetWindow(f.state, "darwin")).toBe("Pet window closed.");
    expect(await child.exited).toBe(0);
    child = launch();
    await until(() => { try { return JSON.parse(readFileSync(join(f.state, "pet-window.pid"), "utf8")).ready === true; } catch { return false; } });
    rmSync(join(f.state, "status.json"));
    expect(await child.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(f.state, "pet-view.json"), "utf8"))).toEqual({ offline: true });
    expect(readdirSync(f.state)).not.toContain("pet-window.pid");
  } finally { if (child && child.exitCode === null) { child.kill(); await child.exited; } f.dispose(); }
}, 20000);

test("page recovers its pencil after transient offline and sends keyboard text without HTML insertion", () => {
  const html = readFileSync(join(rootPath, "src/pet/window.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const elements: Record<string, any> = {};
  for (const id of ["pet", "frame", "state", "composer", "message", "result", "pencil", "close"]) elements[id] = {
    disabled: false, hidden: true, value: "", handlers: {} as Record<string, (event: any) => void>,
    setAttribute() {}, replaceChildren() {}, focus() {}, setPointerCapture() {},
    addEventListener(name: string, callback: any) { this.handlers[name] = callback; },
  };
  const posted: unknown[] = [];
  const page: any = { webkit: { messageHandlers: { pet: { postMessage: (body: unknown) => posted.push(body) } } } };
  runInNewContext(script, { window: page, document: { body: { dataset: {} }, getElementById: (id: string) => elements[id], createElementNS: () => ({ setAttribute() {} }) } });
  page.update({ offline: true }); expect(elements.pencil.disabled).toBe(true);
  page.update({ state: "idle", act: 0, watch: 0, frame: { width: 1, height: 1, pixels: [[0, 0]] } });
  expect(elements.pencil.disabled).toBe(false);
  page.focusInput(); expect(elements.composer.hidden).toBe(false);
  elements.message.value = '<img src="https://example.invalid"> $(command)';
  elements.message.handlers.keydown({ key: "Enter", isComposing: true, preventDefault() {} });
  expect(posted.filter((body: any) => body.kind === "send")).toHaveLength(0);
  elements.message.handlers.keydown({ key: "Enter", isComposing: false, preventDefault() {} });
  expect(posted.at(-1)).toEqual({ kind: "send", text: elements.message.value });
  expect(elements.message.disabled).toBe(true);
  page.commandResult(true); expect(elements.message.disabled).toBe(false); expect(elements.message.value).toBe("");
  page.focusInput(); elements.message.handlers.keydown({ key: "Escape" }); expect(elements.composer.hidden).toBe(true);
});
