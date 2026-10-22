import { expect, test } from "bun:test";
import { initialConsoleState, reduceConsole, renderConsole, type ConsoleState } from "../src/cli/console-state.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";
import { choicePrompt, choiceTitle, reviewChoiceFor, reviewHint, reviewRefusal, reviewResult, verdictGuide, verdictInput } from "../src/cli/console-review.ts";
import { agentShellCause, detectCliIdentity, personOnlyRefusal } from "../src/cli/identity.ts";

// #711 (task #380): the console's review guidance, from state fixtures, plus the agent-shell cause line and the hub's done notice.
const NOW = Date.UTC(2026, 9, 22, 12);
const strip = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const row = (over: Record<string, unknown> = {}) => ({ id: 372, title: "Fix the thing", state: "in_review", class: "implement", owner: "codex", reviewer: "claude", flowRevision: 5, signals: [], ...over });
function tasksState(rows: any[] = [row()], over: Partial<ConsoleState> = {}): ConsoleState {
  const s = initialConsoleState(true); s.project = "agent-hub"; s.panel = 3; s.tasks = rows; s.tasksKnown = true; Object.assign(s, over);
  return s;
}
const screen = (s: ConsoleState, columns = 100, rows = 24) => strip(renderConsole(s, columns, rows, NOW));
const lastLine = (s: ConsoleState, columns = 100) => renderConsole(s, columns, 24, NOW).at(-1)!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
/** Feeds the keys one at a time: each key sees the state the previous one left, and `effects` are those of the last key (what a person's last press asked for). */
const press = (s: ConsoleState, ...keys: string[]) => {
  let state = s, effects: any[] = [];
  for (const key of keys) { const next = reduceConsole(state, key, NOW); state = next.state; effects = next.effects; }
  return { state, effects };
};

test("r on a task row in review opens the verdict choice, quoted and cut, instead of prefilling a half command (#711 change 1)", () => {
  const { state, effects } = press(tasksState(), "r");
  expect(effects).toEqual([]);
  expect(state.reviewChoice).toEqual({ id: 372, title: '"Fix the thing"', reviewerIsUser: false });
  expect(state.input).toBe(""); expect(state.editing).toBe(false);                          // nothing is on the input line yet
  expect(lastLine(state)).toBe('review #372 "Fix the thing": a approve  c request changes  Esc cancel');
  const long = press(tasksState([row({ title: "x".repeat(200) })]), "r").state;
  expect(long.reviewChoice!.title.length).toBeLessThanOrEqual(44);                           // cut to a width, quoted
  expect(long.reviewChoice!.title).toMatch(/^"x+\.\.\."$/);
});

test("a prefills `review N approved ` with the guide line, and Enter sends the review (#711 change 1)", () => {
  const chosen = press(tasksState(), "r", "a").state;
  expect(chosen.reviewChoice).toBeUndefined();
  expect(chosen.input).toBe("review 372 approved "); expect(chosen.editing).toBe(true);
  expect(screen(chosen)).toContain("Enter approves #372. You can type a note first. Esc cancels.");
  const typed = press(chosen, "l", "g", "t", "m").state;
  expect(typed.input).toBe("review 372 approved lgtm");
  const sent = press(typed, "\r");
  expect(sent.effects).toEqual([{ type: "command", args: ["review", "372", "approved", "lgtm"] }]);
  expect(sent.state.reviewGuide).toBeUndefined();                                           // the guide goes with the input
  expect(press(tasksState(), "r", "a", "\r").effects).toEqual([{ type: "command", args: ["review", "372", "approved"] }]);   // approving needs no note
});

test("c prefills `review N changes_requested `; an empty note is refused in the console, a note goes through (#711 change 1)", () => {
  const chosen = press(tasksState(), "r", "c").state;
  expect(chosen.input).toBe("review 372 changes_requested "); expect(chosen.editing).toBe(true);
  expect(screen(chosen)).toContain("Say what to fix, then Enter. Esc cancels.");
  const empty = press(chosen, "\r");
  expect(empty.effects).toEqual([]);                                                          // never reaches the hub
  expect(empty.state.notice).toBe("say what to fix before requesting changes");
  expect(press(tasksState(), "r", "c", " ", " ", "\r").effects).toEqual([]);               // spaces alone are no note
  const withNote = press(chosen, "n", "a", "m", "e", "\r");
  expect(withNote.effects).toEqual([{ type: "command", args: ["review", "372", "changes_requested", "name"] }]);
});

test("Esc cancels the choice and the input, and any other key leaves the choice open (#711 change 1)", () => {
  expect(press(tasksState(), "r", "\x1b").state.reviewChoice).toBeUndefined();
  const kept = press(tasksState(), "r", "x", "z", "1").state;
  expect(kept.reviewChoice).toBeDefined(); expect(kept.input).toBe(""); expect(kept.panel).toBe(3);   // a stray key neither acts nor leaves
  const typing = press(tasksState(), "r", "a", "\x1b").state;
  expect(typing.input).toBe(""); expect(typing.editing).toBe(false); expect(typing.reviewGuide).toBeUndefined();
  expect(screen(typing)).not.toContain("Enter approves");
});

test("r works from the open task detail and acts on the task the detail shows (#711 change 1)", () => {
  const s = tasksState([row({ id: 372 }), row({ id: 380, title: "other" })]);
  s.detail = { id: 372, title: "Fix the thing", state: "in_review", reviewer: "user", flowRevision: 5 };
  s.tasks.reverse();                                                                          // a refresh moved #380 under the selection
  expect(press(s, "r").state.reviewChoice).toMatchObject({ id: 372, reviewerIsUser: true });
  expect(press(s, "r", "a").state.input).toBe("review 372 approved ");
  s.detail = "task_show failed"; expect(press(s, "r").state.reviewChoice).toBeUndefined();      // a message names no item
});

test("r does nothing for a task that is not in review, and a task that left review while the choice was open says so (#711 change 1)", () => {
  for (const state of ["proposed", "in_progress", "changes_requested", "approved"]) {
    const out = press(tasksState([row({ state })]), "r").state;
    expect(out.reviewChoice).toBeUndefined(); expect(out.input).toBe("");
  }
  const s = press(tasksState(), "r").state;
  s.tasks = [row({ state: "approved" })];                                                     // approved elsewhere while the choice was open
  const after = press(s, "a").state;
  expect(after.input).toBe(""); expect(after.notice).toBe("#372 is no longer in review (approved)");
});

test("a private task shows [pii] in the choice, never its title (#711 change 1)", () => {
  for (const over of [{ signals: ["pii"] }, { signals: ["pii_path"] }, { title: "[pii]" }]) {
    const s = press(tasksState([row({ title: "SECRET-TITLE", ...over })]), "r").state;
    expect(s.reviewChoice!.title).toBe("[pii]");
    expect(lastLine(s)).toBe("review #372 [pii]: a approve  c request changes  Esc cancel");
    // The new surface is the choice line. (The hub sends a private task to the console as a stub whose title is already `[pii]`, so the table row is never the raw title;
    // this fixture hands the raw title in on purpose to prove the choice line does not depend on that.)
    expect(lastLine(s)).not.toContain("SECRET-TITLE");
    expect(s.reviewChoice!.title).not.toContain("SECRET");
  }
  expect(choiceTitle({ title: 'say "hi"\nthere' })).toBe('"say \\"hi\\" there"');           // quoted JSON, one line: a title cannot forge the line
});

test("hints say r approve or request changes, and your review when the reviewer is user, with the detail open too (#711 change 2)", () => {
  const hint = (s: ConsoleState) => lastLine(s, 200);
  expect(hint(tasksState())).toContain("r approve or request changes");
  expect(hint(tasksState())).not.toContain("your review:");
  expect(hint(tasksState([row({ reviewer: "user" })]))).toContain("your review: r approve or request changes");
  const open = tasksState([row({ reviewer: "user" })]); open.detail = { id: 372, title: "t", state: "in_review", reviewer: "user" };
  expect(hint(open)).toContain("your review: r approve or request changes");
  const other = tasksState(); other.detail = { id: 372, title: "t", state: "in_review", reviewer: "claude" };
  expect(hint(other)).toContain("r approve or request changes"); expect(hint(other)).not.toContain("your review:");
  const notInReview = tasksState([row({ state: "in_progress" })]); expect(hint(notInReview)).not.toContain("approve or request changes");
  expect(hint(tasksState([row({ state: "backlog" })]))).not.toContain("approve or request changes");
  const narrow = tasksState([row({ reviewer: "user" })]);
  expect(lastLine(narrow, 80).length).toBeLessThanOrEqual(80);                                // the footer still fits at 80 columns
});

test("the ? key table names the review flow (#711 change 6)", () => {
  const s = tasksState(); s.help = true;
  expect(screen(s, 120).replace(/\s+/g, " ")).toContain("r approve or request changes");
});

test("a review result is a notice in panels mode: approved, changes requested, or the CLI's refusal verbatim (#711 change 3)", () => {
  expect(reviewResult(["review", "372", "approved"], 0, "")).toEqual({ text: "#372 approved", tone: "success" });
  expect(reviewResult(["review", "372", "changes_requested", "fix it"], 0, "")).toEqual({ text: "#372 changes requested", tone: "success" });
  const refusal = 'ahub: task #372: only its reviewer (claude) or the console user can do that';
  expect(reviewResult(["review", "372", "approved"], 1, refusal)).toEqual({ text: refusal, tone: "failure" });
  expect(reviewResult(["review", "372", "approved"], 1, "")).toEqual({ text: "command exited 1", tone: "failure" });
  expect(reviewResult(["status"], 0, "")).toBeUndefined();                                    // other commands keep their own path
  expect(reviewResult(["review", "brief", "372"], 0, "")).toBeUndefined();
});

// The real path: `r`, `a`, Enter in runConsole runs the command through the injected runner, and the result notice reaches the screen in panels mode.
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); await Bun.sleep(5); };
function rig(runCommand: ConsoleTerminalRun) {
  let data = (_text: string) => {}; const out: string[] = [];
  const terminal: ConsoleTerminal = { columns: 120, rows: 30, isTTY: true, write: t => { out.push(t); }, raw: () => {}, onData: l => { data = l; return () => {}; }, onResize: () => () => {}, onSignal: () => () => {}, onError: () => () => {} };
  const listed = [row({ history: [] })];
  const client = { onPush: (_m: any) => {}, onClose: (_c: number, _r: string) => {}, send: () => {}, close: () => {},
    request: async (msg: any) => msg.t === "task" ? { ok: true, text: JSON.stringify(listed) } : { ok: true, status: { peers: {} }, budget: {}, text: "[]", deliveries: [] } };
  const running = runConsole({ client: client as any, cwd: "/tmp", stateDir: "/tmp", terminal, panels: true, runCommand: runCommand as any });
  return { out, input: (text: string) => data(text), running, screen: () => strip(out.join("").split("\x1b[r").slice(-1)) };
}
type ConsoleTerminalRun = (args: string[], output: (text: string) => void, done: (code?: number) => void) => () => void;

test("runConsole: r, a, Enter runs ahub review as the person and shows `#372 approved` as a notice in panels mode (#711 change 3)", async () => {
  const ran: string[][] = [];
  const f = rig((args, _output, done) => { ran.push(args); setTimeout(() => done(0), 5); return () => {}; });
  await tick(); f.input("3"); await tick(); f.input("r"); await tick();
  expect(f.screen()).toContain('review #372 "Fix the thing": a approve  c request changes');
  f.input("a"); await tick(); expect(f.screen()).toContain("Enter approves #372"); f.input("\r"); await tick(); await Bun.sleep(30); await tick();
  expect(ran).toEqual([["review", "372", "approved"]]);
  expect(f.screen()).toContain("#372 approved");
  f.input("q"); await f.running;
});

test("runConsole: the CLI's refusal is shown verbatim as a failure notice, not swallowed (#711 change 3)", async () => {
  const refusal = 'ahub: task #372: only its reviewer (claude) or the console user can do that';
  const f = rig((args, output, done) => { setTimeout(() => { output(refusal + "\n"); done(1); }, 5); return () => {}; });
  await tick(); f.input("3"); await tick(); f.input("r"); f.input("a"); await tick(); f.input("\r"); await Bun.sleep(40); await tick();
  expect(f.screen()).toContain("only its reviewer (claude) or the console user can do that");
  f.input("q"); await f.running;
});

// ---- the CLI side (#711 change 4) and the hub's notice (change 5) ----
const REFUSAL = "task #372: only its reviewer (user) or the console user can do that";
test("an agent shell refused a person-only action is told why, and the console identity never is (#711 change 4)", () => {
  const agent = detectCliIdentity({ AGENTHUB_PEER_ID: "claude", CLAUDECODE: "1" });
  expect(agent).toEqual({ role: "tools", peer: "claude" });
  expect(agentShellCause(agent, REFUSAL, { AGENTHUB_PEER_ID: "claude", CLAUDECODE: "1" })).toBe(
    'This shell runs as agent "claude" (AGENTHUB_PEER_ID and CLAUDECODE are set), not as you. Run the command in your own terminal, or use the ahub console: Tasks, select #372, r.');
  expect(agentShellCause(agent, REFUSAL, { CLAUDECODE: "1" })).toContain("(CLAUDECODE is set)");
  const person = detectCliIdentity({});
  expect(person).toEqual({ role: "console" });
  expect(agentShellCause(person, REFUSAL, {})).toBeUndefined();                              // never for the console identity
  expect(agentShellCause({ role: "invalid", reason: "x" }, REFUSAL, {})).toBeUndefined();
  for (const other of ["no task #9", "task #9: not in review", "refused: the hub is stopping", "invalid verdict"]) expect(agentShellCause(agent, other, { CLAUDECODE: "1" })).toBeUndefined();   // only person-only refusals
  expect(personOnlyRefusal("only the person may accept a plan departure")).toBe(true);
  expect(personOnlyRefusal("only the console user or the configured conductor may name a reviewer")).toBe(true);
  expect(agentShellCause(agent, "only the person may accept a plan departure", { CLAUDECODE: "1" })).toContain("Tasks, select the task, r.");   // no task id in it: no invented one
});

test("helper strings: prompt, prefill, guide, hint and refusal are exactly the contract (#711)", () => {
  expect(choicePrompt({ id: 7, title: '"t"', reviewerIsUser: false })).toBe('review #7 "t": a approve  c request changes  Esc cancel');
  expect(verdictInput(7, "approved")).toBe("review 7 approved "); expect(verdictInput(7, "changes_requested")).toBe("review 7 changes_requested ");
  expect(verdictGuide(7, "approved")).toBe("Enter approves #7. You can type a note first. Esc cancels.");
  expect(verdictGuide(7, "changes_requested")).toBe("Say what to fix, then Enter. Esc cancels.");
  expect(reviewHint("user")).toBe("your review: r approve or request changes"); expect(reviewHint("claude")).toBe("r approve or request changes");
  expect(reviewChoiceFor(row({ state: "approved" }))).toBeUndefined(); expect(reviewChoiceFor(undefined)).toBeUndefined(); expect(reviewChoiceFor({ id: "x", state: "in_review" })).toBeUndefined();
  expect(reviewRefusal(["review", "1", "changes_requested"])).toBe("say what to fix before requesting changes");
  expect(reviewRefusal(["review", "1", "changes_requested", "--unmet"])).toBe("say what to fix before requesting changes");   // a flag is not a note
  expect(reviewRefusal(["review", "1", "changes_requested", "fix"])).toBeUndefined();
  expect(reviewRefusal(["review", "1", "approved"])).toBeUndefined(); expect(reviewRefusal(["status"])).toBeUndefined();
});
