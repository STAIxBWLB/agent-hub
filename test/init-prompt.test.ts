import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { INIT_SETTINGS } from "../src/cli/init-settings.ts";
import { initQuestions, promptGate, questionLine, runInitPrompt, shadowOffered, shownDefault, type InitAnswers, type InitPromptPorts } from "../src/cli/init-prompt.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { loadSdlc } from "../src/hub/sdlc.ts";
import { autonomyInheritanceChange } from "../src/cli/init.ts";
import { HELP } from "../src/cli/help.ts";

// #1065 T2 (AC4, AC5): the guided prompt of `ahub init`, scripted. A scripted terminal answers each question and the files it leads to equal the files the equivalent flags write; Ctrl-C and N write nothing;
// a delegated peer, a live test and a non-terminal are never asked. Nothing here opens a real terminal session in a person's home: every run is a bounded child in a temporary HOME.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const MAIN = join(import.meta.dir, "../src/cli/main.ts");
function fixture() {
  const made = mkdtempSync(join(tmpdir(), "ahub-init-prompt-")); roots.push(made); // registered before anything that can throw
  const root = realPath(made), user = join(root, "user"), home = join(root, "hub"); mkdirSync(user);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(AGENTHUB_|CLAUDE|CODEX_|ORCA_|KIMI|QWEN|JCODE|PI_|OMNIROUTE|CI$)/.test(key)) env[key] = value;
  Object.assign(env, { HOME: user, AGENTHUB_HOME: home, CLAUDE_CONFIG_DIR: join(user, "claude"), AMEM_HOME: join(root, "memory"), GIT_CONFIG_GLOBAL: "/dev/null" });
  const repo = (name: string) => { const cwd = join(root, name); mkdirSync(cwd); expect(hubGitSync(["init", "-q"], { cwd, env, encoding: "utf8", timeout: 3000 }).status).toBe(0); return cwd; };
  const folder = (name: string) => { const cwd = join(root, name); mkdirSync(cwd); return cwd; };   // a folder with no Git work tree
  const run = (cwd: string, args: string[], extra: Record<string, string> = {}) => Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, env: { ...env, ...extra }, stdin: "ignore", timeout: 20_000 });
  /** A real `ahub init` under a pty: each question line is answered from `answers` (an entry per question, in order); a bounded child, killed at `ms`. */
  const session = async (cwd: string, args: string[], answers: readonly string[], ms = 25_000, extraEnv: Record<string, string> = {}) => {
    let text = "";
    const proc = Bun.spawn([process.execPath, MAIN, ...args], { cwd, env: { ...env, ...extraEnv }, terminal: { cols: 200, rows: 50, data: (_t: unknown, data: Uint8Array) => { text += new TextDecoder().decode(data); } } } as never);
    const timer = setTimeout(() => proc.kill("SIGKILL"), ms);
    const clean = () => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
    let answered = 0, seen = 0;
    try {
      const pty = (proc as unknown as { terminal: { write(data: string): void } }).terminal;
      for (let tick = 0; tick < 1000 && proc.exitCode === null; tick++) {
        await Bun.sleep(20);
        const lines = clean().split("\n"), last = lines.at(-1) ?? "";
        const prompts = clean().match(/\[[^\]\n]*\]: |\[y\/N\]: /g)?.length ?? 0;
        if (/\]: $/.test(last) && prompts > seen) { seen = prompts; const next = answers[answered++]; if (next === undefined) break; pty.write(next === "\u0003" ? next : `${next}\n`); }
      }
      await proc.exited;
    } finally { clearTimeout(timer); }
    return { code: proc.exitCode, text: clean() };
  };
  return { root, home, env, repo, folder, run, session };
}
const tree = (cwd: string): Record<string, string> => {
  const dir = join(cwd, ".agenthub"), result: Record<string, string> = {};
  if (!existsSync(dir)) return result;
  for (const name of readdirSync(dir).sort()) if (!name.startsWith("state") && !name.endsWith(".db")) { try { result[name] = readFileSync(join(dir, name), "utf8"); } catch { result[name] = "(unreadable)"; } }
  return result;
};

const NO_FLAGS: InitAnswers = { request: { values: {} }, shadow: false, releaseGuard: false };
const scripted = (answers: (string | null)[]): { ports: InitPromptPorts; asked: string[]; printed: string[] } => {
  const asked: string[] = [], printed: string[] = [], queue = [...answers];
  return { asked, printed, ports: { ask: async question => { asked.push(question); return queue.length ? queue.shift()! : null; }, print: line => printed.push(line) } };
};
const blank = (n: number) => Array.from({ length: n }, () => "");
/** One Enter per question of a project with no Git work tree to offer shadow for: what the scripted answers below assume. */
const ALL = initQuestions({ shadowAvailable: false }).length;

test("the questions follow the spec's table, one per setting with its default in brackets, and every settings row is asked (#1065 AC4)", () => {
  const questions = initQuestions({ packs: [], shadowAvailable: true });
  expect(questions.map(q => q.id)).toEqual(["profile", "start.agents", "specs.enabled", "specs.review", "sdlc.mode", "coordination", "memory.enabled", "snapshots.enabled", "pi.enabled", "autonomy", "release-guard", "shadow"]);
  // every row of the settings table is a question, so a row added later cannot go unasked
  for (const row of INIT_SETTINGS) expect(questions.map(q => q.id), row.id).toContain(row.id);
  const line = (id: string) => questionLine(questions.find(q => q.id === id)!);
  expect(line("coordination")).toBe("Coordination (advisory|turn-free) [advisory]: ");
  expect(line("specs.review")).toBe("Spec review mode (off|report|require) [report]: ");
  expect(line("memory.enabled")).toBe("Shared memory (on|off) [on]: ");
  expect(line("pi.enabled")).toContain("[off]");
  expect(line("sdlc.mode")).toBe("SDLC mode (off|advise|enforce) [off]: ");
  expect(line("profile")).toBe("Profile (dev|research|writing|general) [dev]: ");
  // a pack is offered as a profile, shadow only where a Git work tree is absent, and the machine's agent set is the default shown
  expect(questionLine(initQuestions({ packs: ["analysis"] })[0]!)).toContain("analysis");
  expect(initQuestions({ shadowAvailable: false }).map(q => q.id)).not.toContain("shadow");
  expect(line("start.agents")).toContain("claude, codex");
  expect(questionLine(initQuestions({ machineAgents: ["codex"] }).find(q => q.id === "start.agents")!)).toContain("[codex]");
  expect(questionLine(initQuestions({ machineAgents: [] }).find(q => q.id === "start.agents")!)).toContain("[none]");
});

test("Enter keeps every default: the request is empty and the plan is shown before the question to write (#1065 AC4)", async () => {
  const s = scripted([...blank(ALL), "y"]);
  const result = await runInitPrompt(s.ports, { shadowAvailable: false }, () => ["create .agenthub/config.json: create missing project defaults"]);
  expect(result).toEqual({ ok: true, answers: NO_FLAGS });
  expect(s.asked).toHaveLength(ALL + 1);
  expect(s.asked.at(-1)).toBe("Write this? [y/N]: ");
  expect(s.printed.join("\n")).toContain("This will be written:\ncreate .agenthub/config.json");
});

test("each answer becomes the value the equivalent flag sets, including a repeated default (an explicit choice, as a flag is) (#1065 AC4)", async () => {
  const s = scripted(["research", "codex,claude", "off", "require", "enforce", "turn-free", "off", "off", "on", "off", "yes", "y"]);
  const result = await runInitPrompt(s.ports, { shadowAvailable: false, packs: [] }, () => []);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.answers.profile).toBe("research");
  expect(result.answers.request.values).toEqual({ "start.agents": ["codex", "claude"], "specs.enabled": false, "specs.review": "require", "sdlc.mode": "enforce", coordination: "turn-free", "memory.enabled": false, "snapshots.enabled": false, "pi.enabled": true });
  expect(result.answers.request.autonomy).toBe("off");
  expect(result.answers.releaseGuard).toBe(true);
  // typing the default is an explicit choice: the key is written, exactly as `--coordination advisory` writes it
  const again = await runInitPrompt(scripted(["", "", "", "", "", "advisory", ...blank(5), "y"]).ports, { shadowAvailable: false }, () => []);
  expect(again.ok && again.answers.request.values).toEqual({ coordination: "advisory" });
});

test("unknown input asks again and never guesses; three bad answers refuse the prompt and write nothing (#1065 AC4)", async () => {
  const s = scripted(["dev", "claude", "maybe", "on", ...blank(8), "y"]);
  const result = await runInitPrompt(s.ports, { shadowAvailable: false }, () => []);
  expect(result.ok).toBe(true);
  expect(s.printed.join("\n")).toContain("answer on or off; asking again");
  expect(s.asked.filter(q => q.startsWith("Design specs"))).toHaveLength(2); // the bad answer was asked again, not guessed
  const refused = await runInitPrompt(scripted(["", "", "x", "maybe", "perhaps"]).ports, { shadowAvailable: false }, () => []);
  expect(refused).toMatchObject({ ok: false, reason: "refused" });
  expect(refused.ok === false && refused.message).toContain('no valid answer for "Design specs and their freshness checks" after 3 tries, so nothing was written; run ahub init again, or pass the setting as a flag');
  // an unknown agent is refused with the allowed ones by the table's own parser, then the next answer is read
  const total = initQuestions({ shadowAvailable: false }).length;
  const badAgent = scripted(["", "nonexistent-agent", "claude", ...blank(total - 2), "y"]);
  const accepted = await runInitPrompt(badAgent.ports, { shadowAvailable: false }, () => []);
  expect(accepted.ok && accepted.answers.request.values).toEqual({ "start.agents": ["claude"] });
  expect(badAgent.printed.join("\n")).toContain("asking again");
});

test("N, an empty answer, Ctrl-D and a throwing preview all end the prompt with nothing returned to write (#1065 AC4)", async () => {
  for (const final of ["n", "no", "", "later"]) expect(await runInitPrompt(scripted([...blank(ALL), final]).ports, { shadowAvailable: false }, () => []), final).toMatchObject({ ok: false, reason: "declined", message: "nothing was written" });
  expect(await runInitPrompt(scripted(blank(ALL)).ports, { shadowAvailable: false }, () => []), "end of input at the confirmation").toMatchObject({ ok: false, reason: "interrupted" });
  expect(await runInitPrompt(scripted(blank(4)).ports, { shadowAvailable: false }, () => []), "end of input mid-questions").toMatchObject({ ok: false, reason: "interrupted" });
  const thrown = await runInitPrompt(scripted(blank(ALL)).ports, { shadowAvailable: false }, () => { throw new Error("release guard refuses custom core.hooksPath; no files changed"); });
  expect(thrown).toMatchObject({ ok: false, reason: "refused", message: "release guard refuses custom core.hooksPath; no files changed" });
});

test("promptGate: only a person at a terminal on a new project, with no flag and no --yes, is asked (#1065 AC5)", () => {
  const base = { newProject: true, flagGiven: false, yes: false, dryRun: false, stdinIsTTY: true, stdoutIsTTY: true, role: "console", delegated: false, liveTest: false };
  expect(promptGate(base)).toBe(true);
  for (const change of [{ newProject: false }, { flagGiven: true }, { yes: true }, { dryRun: true }, { stdinIsTTY: false }, { stdoutIsTTY: false }, { role: "tools" }, { role: "invalid" }, { delegated: true }, { liveTest: true }]) {
    expect(promptGate({ ...base, ...change }), JSON.stringify(change)).toBe(false);
  }
});

test("the real ahub init under a pty: Enter on every question produces the same files as a plain init (#1065 AC4)", async () => {
  const p = fixture(), guided = p.repo("guided"), plain = p.repo("plain");
  const done = await p.session(guided, ["init"], [...blank(ALL), "y"]);
  expect(done.code, done.text).toBe(0);
  expect(done.text).toContain("Profile (dev|research|writing|general");   // the shipped profiles first, then any packs
  expect(done.text).toContain("Write this? [y/N]: ");
  expect(p.run(plain, ["init"]).exitCode).toBe(0);
  expect(tree(guided)).toEqual(tree(plain));
  expect(readFileSync(join(guided, "AGENTS.md"), "utf8")).toEqual(readFileSync(join(plain, "AGENTS.md"), "utf8"));
}, 60_000);

test("the real ahub init under a pty: answering each question writes the files the equivalent flags write (#1065 AC4)", async () => {
  const p = fixture(), guided = p.repo("guided"), flagged = p.repo("flagged");
  const answers = ["", "claude", "off", "", "advise", "turn-free", "off", "", "on", "off", "", "y"];
  const done = await p.session(guided, ["init"], answers);
  expect(done.code, done.text).toBe(0);
  const flags = ["init", "--agents", "claude", "--no-specs", "--sdlc", "advise", "--coordination", "turn-free", "--no-memory", "--pi", "--autonomy", "off"];
  expect(p.run(flagged, flags).exitCode).toBe(0);
  expect(tree(guided)).toEqual(tree(flagged));
  expect(readFileSync(join(guided, "AGENTS.md"), "utf8")).toEqual(readFileSync(join(flagged, "AGENTS.md"), "utf8"));
  expect(done.text).toContain("specs.enabled");
}, 60_000);

test("the real ahub init under a pty: yes to the release guard and a chosen profile reach the written files, as --release-guard and --profile do (#1065 AC4)", async () => {
  const p = fixture(), guided = p.repo("guided"), flagged = p.repo("flagged");
  // profile research, release guard on, everything else Enter; the release-guard question is the one before the optional shadow question
  const questions = initQuestions({ shadowAvailable: false }).map(q => q.id);
  const answers = questions.map(id => id === "profile" ? "research" : id === "release-guard" ? "yes" : "");
  const done = await p.session(guided, ["init"], [...answers, "y"]);
  expect(done.code, done.text).toBe(0);
  expect(p.run(flagged, ["init", "--profile", "research", "--release-guard"]).exitCode).toBe(0);
  expect(tree(guided)).toEqual(tree(flagged));
  const agents = readFileSync(join(guided, "AGENTS.md"), "utf8");
  expect(agents).toContain("AGENT_HUB_RELEASE_GUARD:BEGIN");                                  // the answer reached the writer
  expect(agents).toEqual(readFileSync(join(flagged, "AGENTS.md"), "utf8"));
  expect(existsSync(join(guided, ".git/hooks/pre-push"))).toBe(true);
  expect(JSON.parse(readFileSync(join(guided, ".agenthub/config.json"), "utf8")).profile).toBe("research");
}, 60_000);

test("the real ahub init under a pty: N and Ctrl-C write nothing, not even a .agenthub directory's config (#1065 AC4)", async () => {
  const p = fixture(), declined = p.repo("declined"), interrupted = p.repo("interrupted");
  const no = await p.session(declined, ["init"], [...blank(ALL), "n"]);
  expect(no.code, no.text).toBe(0);
  expect(existsSync(join(declined, ".agenthub/config.json"))).toBe(false);
  expect(existsSync(join(declined, "AGENTS.md"))).toBe(false);
  expect(no.text).toContain("nothing was written");
  const cc = await p.session(interrupted, ["init"], ["", "", "\u0003"]);
  expect(existsSync(join(interrupted, ".agenthub/config.json"))).toBe(false);
  expect(existsSync(join(interrupted, "AGENTS.md"))).toBe(false);
  expect(cc.text).not.toContain("wrote ");
}, 60_000);

test("a non-terminal, --yes, --dry-run, a flag and an existing project are never asked, and a delegated live test is not either (#1065 AC5)", async () => {
  const p = fixture();
  const asked = (text: string) => /\[(?:dev|advisory|on|off|report|claude, codex)[^\]]*\]: /.test(text) || text.includes("Write this?");
  // no terminal: stdin is not a tty, so no prompt and the defaults are written
  const piped = p.repo("piped"), pipe = p.run(piped, ["init"]);
  expect(pipe.exitCode, `${pipe.stdout}${pipe.stderr}`).toBe(0);
  expect(asked(`${pipe.stdout}${pipe.stderr}`)).toBe(false);
  expect(existsSync(join(piped, ".agenthub/config.json"))).toBe(true);
  // --yes at a terminal takes the defaults without a question
  const yes = p.repo("yes"), withYes = await p.session(yes, ["init", "--yes"], []);
  expect(withYes.code, withYes.text).toBe(0);
  expect(asked(withYes.text)).toBe(false);
  expect(existsSync(join(yes, ".agenthub/config.json"))).toBe(true);
  expect(tree(yes)).toEqual(tree(piped));
  // a flag at a terminal: only that flag, no questions
  const flag = p.repo("flag"), withFlag = await p.session(flag, ["init", "--coordination", "turn-free"], []);
  expect(withFlag.code, withFlag.text).toBe(0);
  expect(asked(withFlag.text)).toBe(false);
  expect(JSON.parse(readFileSync(join(flag, ".agenthub/config.json"), "utf8")).coordination).toBe("turn-free");
  // --dry-run at a terminal shows the plan and writes nothing
  const dry = p.repo("dry"), preview = await p.session(dry, ["init", "--dry-run"], []);
  expect(preview.code, preview.text).toBe(0);
  expect(asked(preview.text)).toBe(false);
  expect(existsSync(join(dry, ".agenthub/config.json"))).toBe(false);
  // an existing project at a terminal is never asked: init refreshes it as it always did
  const again = await p.session(piped, ["init"], []);
  expect(again.code, again.text).toBe(0);
  expect(asked(again.text)).toBe(false);
  // a delegated live test never sees a prompt: an agent shell with --live-test is not the console role, and the run ends without a question
  const live = p.repo("live"), delegated = await p.session(live, ["--live-test", "init"], []);
  expect(asked(delegated.text)).toBe(false);
  // an agent shell (a peer marker in the environment) at a terminal is refused as an agent before init runs, and is never asked; a delegated live test from one is not asked either
  const agent = p.repo("agent"), shell = await p.session(agent, ["init"], [], 25_000, { AGENTHUB_PEER_ID: "codex" });
  expect(asked(shell.text)).toBe(false);
  expect(existsSync(join(agent, ".agenthub/config.json"))).toBe(false);
  const agentLive = p.repo("agent-live"), viaLive = await p.session(agentLive, ["--live-test", "init"], [], 25_000, { AGENTHUB_PEER_ID: "codex" });
  expect(asked(viaLive.text)).toBe(false);
}, 120_000);

test("the init help entry lists --yes and describes the prompt and who is asked (#1065 AC7)", () => {
  const row = HELP.find(entry => entry.usage.startsWith("ahub init"))!;
  expect(row.usage).toContain("[--yes]");
  expect(row.description).toContain("asked each setting in turn with its default in brackets");
  expect(row.description).toContain("N, Ctrl-C and Ctrl-D write nothing");
  expect(row.description).toContain("A peer, a live test, a pipe and --dry-run are never asked");
});

test("shadow history is offered in a folder with no Git work tree, kept for an existing shadow repository, and withheld from a real Git work tree (#1065 AC4 review)", async () => {
  expect(shadowOffered(undefined)).toBe(true);              // no repository: the case shadow history is for
  expect(shadowOffered({ shadow: true })).toBe(true);       // an existing shadow repository, which `--shadow` accepts
  expect(shadowOffered({ shadow: false })).toBe(false);     // a real Git work tree, which `ahub init --shadow` refuses
  expect(shadowOffered({})).toBe(false);
  const p = fixture();
  // the real CLI: the question appears in a plain folder and not in a Git repository
  const plain = p.folder("plain"), offered = await p.session(plain, ["init"], [...blank(ALL + 1), "n"]);
  expect(offered.text).toContain("Shadow history (a folder with no Git work tree) (on|off) [off]: ");
  const git = p.repo("git"), withheld = await p.session(git, ["init"], [...blank(ALL), "n"]);
  expect(withheld.text).not.toContain("Shadow history");
  // answering on creates the same files `--shadow` does
  const guided = p.folder("guided"), flagged = p.folder("flagged");
  const questions = initQuestions({ shadowAvailable: true }).map(q => q.id);
  const done = await p.session(guided, ["init"], [...questions.map(id => id === "shadow" ? "on" : ""), "y"]);
  expect(done.code, done.text).toBe(0);
  expect(p.run(flagged, ["init", "--shadow"]).exitCode).toBe(0);
  expect(existsSync(join(guided, ".agenthub/shadow.git"))).toBe(true);
  expect(tree(guided)).toEqual(tree(flagged));
}, 60_000);

test("the plan the person confirms names the machine autonomy inheritance the write applies, and answering off removes it (#1065 AC4 review)", async () => {
  const p = fixture();
  // trust the machine default: `ahub autonomy on` in a first project writes defaults.json, which a new project then inherits
  const seed = p.repo("seed");
  expect(p.run(seed, ["init"]).exitCode).toBe(0);
  const on = p.run(seed, ["autonomy", "on", "--yes"]);
  expect(on.exitCode, `${on.stdout}${on.stderr}`).toBe(0);
  const inherits = p.repo("inherits"), kept = await p.session(inherits, ["init"], [...blank(ALL), "y"]);
  expect(kept.code, kept.text).toBe(0);
  const plan = kept.text.slice(kept.text.indexOf("This will be written:"), kept.text.indexOf("Write this?"));
  expect(plan).toContain("config.local.json: inherit the trusted machine autonomy preset");   // named in the plan before the question
  expect(kept.text).toContain("Inherited the trusted machine autonomy default");                // and then applied, as the plan said
  expect(JSON.parse(readFileSync(join(inherits, ".agenthub/config.local.json"), "utf8")).permission_modes.codex).toBe("never-ask");
  // answering off for the autonomy question: the plan does not name it and nothing is inherited
  const questions = initQuestions({ shadowAvailable: false }).map(q => q.id);
  const skipped = p.repo("skipped"), off = await p.session(skipped, ["init"], [...questions.map(id => id === "autonomy" ? "off" : ""), "y"]);
  expect(off.code, off.text).toBe(0);
  expect(off.text.slice(off.text.indexOf("This will be written:"), off.text.indexOf("Write this?"))).not.toContain("inherit the trusted machine autonomy preset");
  expect(off.text).not.toContain("Inherited the trusted machine autonomy default");
  expect(existsSync(join(skipped, ".agenthub/config.local.json"))).toBe(false);
}, 90_000);

test("each default the prompt shows is the value an init with no flag really leaves in effect, read back through the loaders the daemon uses (#1065 AC4 review, default drift)", () => {
  const p = fixture(), plain = p.repo("plain");
  expect(p.run(plain, ["init"]).exitCode).toBe(0);
  const config = loadConfig(plain), sdlc = loadSdlc(plain);
  const inEffect: Record<string, unknown> = {
    "specs.enabled": config.specs.enabled, "specs.review": config.specs.review, "coordination": config.coordination, "sdlc.mode": sdlc.mode,
    "memory.enabled": config.memory.enabled, "snapshots.enabled": config.snapshots.enabled, "pi.enabled": config.pi.enabled,
  };
  const shown = (id: string) => { const v = inEffect[id]; return typeof v === "boolean" ? (v ? "on" : "off") : String(v); };
  for (const id of Object.keys(inEffect)) {
    expect(shownDefault(id), `the bracket for ${id}`).toBe(shown(id));
    const question = initQuestions({ shadowAvailable: false }).find(q => q.id === id);
    expect(question, id).toBeDefined();
    expect(questionLine(question!), id).toContain(`[${shown(id)}]`);
  }
  // every row of the table with a boolean or choice default is covered above, or this fails and names the row
  for (const row of INIT_SETTINGS) if (row.id !== "start.agents") expect(Object.keys(inEffect), `${row.id} has no read-back in this test`).toContain(row.id);
});

test("a setting with no known default fails loudly instead of showing a guess (#1065 AC4 review, default drift)", () => {
  expect(() => shownDefault("not.a.setting")).toThrow("no init setting not.a.setting");
});

test("the autonomy plan row comes from one helper: named when the machine default is trusted and the answer is not off, absent otherwise, and --dry-run shows the same row (#1065 AC4 review)", async () => {
  const p = fixture(), seed = p.repo("seed");
  expect(p.run(seed, ["init"]).exitCode).toBe(0);
  expect(p.run(seed, ["autonomy", "on", "--yes"]).exitCode).toBe(0);
  const dir = p.repo("fresh");
  expect(autonomyInheritanceChange(dir, true, undefined)).toMatchObject({ action: "create", reason: expect.stringContaining("inherit the trusted machine autonomy preset") });
  expect(autonomyInheritanceChange(dir, true, "inherit")).toBeDefined();
  expect(autonomyInheritanceChange(dir, true, "off")).toBeUndefined();
  expect(autonomyInheritanceChange(dir, false, undefined)).toBeUndefined();
  // the CLI's --dry-run names the same row, and the guided plan names it too
  const dry = p.run(dir, ["init", "--dry-run", "--json"]);
  expect(dry.exitCode, `${dry.stdout}${dry.stderr}`).toBe(0);
  expect(JSON.parse(dry.stdout.toString()).some((row: { reason: string }) => row.reason.includes("inherit the trusted machine autonomy preset"))).toBe(true);
  const guided = await p.session(p.repo("guided"), ["init"], [...blank(ALL), "y"]);
  expect(guided.text.slice(guided.text.indexOf("This will be written:"), guided.text.indexOf("Write this?"))).toContain("inherit the trusted machine autonomy preset");
}, 60_000);
