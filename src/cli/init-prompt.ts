/**
 * #1065 T2: the guided prompt of `ahub init` for a person in a terminal on a new project.
 *
 * It asks one question per setting of the spec's table, in the table's order, one line each: the label, the choices and the default in brackets. Enter keeps the default and leaves
 * that setting out of the request; any other answer is an explicit choice, exactly as the equivalent flag is (so typing the default is `--coordination advisory`, which writes the
 * key). Unknown input asks again and never guesses. When every question is answered it shows the plan, in the words `--dry-run` prints, and asks y/N. N, an empty answer, end of
 * input and Ctrl-C write nothing. What it returns are the values the flags would have set, so the files it leads to are the files the equivalent flags write (AC4); nothing here
 * writes or reads a file.
 *
 * Who is offered it is decided by `promptGate`: a person at a terminal, on a new project, with no setting flag and no `--yes`. A delegated peer, a live test and any run without a
 * terminal never reach `runInitPrompt` and get defaults plus their flags (AC5).
 */
import { INIT_SETTINGS, SDLC_MODES, SPEC_REVIEW_MODES, COORDINATION_MODES, AUTONOMY_CHOICES, type InitSettingRow, type InitSettingsRequest } from "./init-settings.ts";
import { PROFILE_NAMES } from "../hub/profiles.ts";
import { START_AGENTS_ALLOWED, START_AGENTS_DEFAULT } from "../hub/start-agents.ts";

/** What a prompt needs from its surroundings. `ask` resolves to `null` at the end of input and after Ctrl-C (the caller turns both into `null`); it never throws for either. */
export interface InitPromptPorts {
  ask(question: string): Promise<string | null>;
  print(line: string): void;
}

/** Everything the questions set: the settings request the flags build, plus the three choices that are not settings rows. */
export interface InitAnswers { request: InitSettingsRequest; profile?: string; shadow: boolean; releaseGuard: boolean }

/** `declined`: the person answered no. `interrupted`: end of input or Ctrl-C. `refused`: a question got no valid answer in three tries. Nothing is written in any of the three. */
export type InitPromptResult = { ok: true; answers: InitAnswers } | { ok: false; reason: "declined" | "interrupted" | "refused"; message: string };

/** The four questions that are choices of `ahub init` but not rows of the settings table. */
const NOT_ROWS: ReadonlySet<string> = new Set(["profile", "autonomy", "release-guard", "shadow"]);
const MAX_TRIES = 3;
const NOTHING = "nothing was written";
const yes = (text: string) => /^(y|yes)$/i.test(text.trim());
const word = (text: string) => text.trim().toLowerCase();

export interface InitQuestion {
  /** The `INIT_SETTINGS` id, or `profile`, `autonomy`, `release-guard`, `shadow` for the four choices that are not rows. */
  id: string;
  label: string;
  choices: string;
  /** The default in brackets: what an empty answer keeps. */
  shown: string;
  /** Reads an answer into the value to put in the answers, or throws a reason that names the allowed values. */
  read(text: string): unknown;
}

const onOff = (id: string, label: string, shown: "on" | "off"): InitQuestion => ({
  id, label, choices: "on|off", shown,
  read: text => { const w = word(text); if (["on", "y", "yes", "true"].includes(w)) return true; if (["off", "n", "no", "false"].includes(w)) return false; throw new Error("answer on or off"); },
});
const oneOf = (id: string, label: string, values: readonly string[], shown: string): InitQuestion => ({
  id, label, choices: values.join("|"), shown,
  read: text => { const w = word(text); if (values.includes(w)) return w; throw new Error(`answer one of ${values.join(", ")}`); },
});

export interface InitQuestionContext {
  /** The agent set `ahub setup` chose on this machine (the default shown for the agents question), or `undefined` for the shipped default. */
  machineAgents?: readonly string[];
  /** Project packs a profile answer may name besides the shipped profiles. */
  packs?: readonly string[];
  /** Shadow history is offered only for a folder with no Git work tree. */
  shadowAvailable?: boolean;
}

/**
 * The questions, in the order of the spec's table: profile, agents, specs, spec review, SDLC, coordination, memory, snapshots, each adapter's enable switch, machine autonomy, release
 * guard and shadow history. A settings row is asked only while `INIT_SETTINGS` has it, and a row the table gains is caught by the test that compares the two.
 */
export function initQuestions(context: InitQuestionContext = {}): InitQuestion[] {
  const ids = new Set(INIT_SETTINGS.map(row => row.id));
  const packs = context.packs ?? [];
  const profile: InitQuestion = {
    id: "profile", label: "Profile", choices: [...PROFILE_NAMES, ...packs].join("|"), shown: "dev",
    read: text => { const w = text.trim(); if ((PROFILE_NAMES as readonly string[]).includes(w) || packs.includes(w)) return w; throw new Error(`answer one of ${[...PROFILE_NAMES, ...packs].join(", ")}`); },
  };
  const agents: InitQuestion = {
    id: "start.agents", label: "Agents ahub up starts", choices: `${START_AGENTS_ALLOWED.join(",")} as a comma list, or none`, shown: (context.machineAgents ?? START_AGENTS_DEFAULT).join(", ") || "none",
    read: text => INIT_SETTINGS.find(row => row.id === "start.agents")!.parse(text.trim().toLowerCase()),
  };
  const switches = INIT_SETTINGS.filter(row => row.id.endsWith(".enabled") && !["specs.enabled", "memory.enabled", "snapshots.enabled"].includes(row.id));
  const all: InitQuestion[] = [
    profile,
    agents,
    onOff("specs.enabled", "Design specs and their freshness checks", "on"),
    oneOf("specs.review", "Spec review mode", SPEC_REVIEW_MODES, "report"),
    oneOf("sdlc.mode", "SDLC mode", SDLC_MODES, "off"),
    oneOf("coordination", "Coordination", COORDINATION_MODES, "advisory"),
    onOff("memory.enabled", "Shared memory", "on"),
    onOff("snapshots.enabled", "Per-turn snapshots", "on"),
    ...switches.map(row => onOff(row.id, row.describe.charAt(0).toUpperCase() + row.describe.slice(1), "off")),
    oneOf("autonomy", "Machine autonomy preset", AUTONOMY_CHOICES, "inherit"),
    onOff("release-guard", "Release guard (AGENTS.md block and pre-push hook)", "off"),
    ...(context.shadowAvailable ? [onOff("shadow", "Shadow history (a folder with no Git work tree)", "off")] : []),
  ];
  return all.filter(question => NOT_ROWS.has(question.id) || ids.has(question.id));
}

/** The question line: `label (a|b|c) [default]: `. */
export const questionLine = (question: InitQuestion): string => `${question.label} (${question.choices}) [${question.shown}]: `;

/**
 * Asks every question, then the confirmation. `preview` turns the answers into the lines of the plan; the caller runs the same planner `--dry-run` runs, so what is shown is what is
 * written, and a throw from it (a custom hooks path under the release guard, a config the loader refuses) ends the prompt with its message and no write.
 */
export async function runInitPrompt(ports: InitPromptPorts, context: InitQuestionContext, preview: (answers: InitAnswers) => string[]): Promise<InitPromptResult> {
  const answers: InitAnswers = { request: { values: {} }, shadow: false, releaseGuard: false };
  ports.print("ahub init: press Enter to keep the default in brackets. N at the end, Ctrl-C or Ctrl-D writes nothing.");
  for (const question of initQuestions(context)) {
    let settled = false;
    for (let attempt = 0; attempt < MAX_TRIES && !settled; attempt++) {
      const answer = await ports.ask(questionLine(question));
      if (answer === null) return { ok: false, reason: "interrupted", message: NOTHING };
      if (!answer.trim()) { settled = true; break; }                       // Enter: the default, and nothing is set for this question
      try {
        const value = question.read(answer);
        if (question.id === "profile") answers.profile = value as string;
        else if (question.id === "autonomy") answers.request.autonomy = value as typeof AUTONOMY_CHOICES[number];
        else if (question.id === "release-guard") answers.releaseGuard = value as boolean;
        else if (question.id === "shadow") answers.shadow = value as boolean;
        else answers.request.values[question.id] = value;
        settled = true;
      } catch (error) { ports.print(`  ${(error as Error).message}; asking again`); }
    }
    if (!settled) return { ok: false, reason: "refused", message: `no valid answer for "${question.label}" after ${MAX_TRIES} tries, so ${NOTHING}; run ahub init again, or pass the setting as a flag` };
  }
  let lines: string[];
  try { lines = preview(answers); } catch (error) { return { ok: false, reason: "refused", message: `${(error as Error).message}` }; }
  ports.print(lines.length ? `This will be written:\n${lines.join("\n")}` : "Nothing differs from the defaults; the project gets the shipped configuration.");
  const confirm = await ports.ask("Write this? [y/N]: ");
  if (confirm === null) return { ok: false, reason: "interrupted", message: NOTHING };
  if (!yes(confirm)) return { ok: false, reason: "declined", message: NOTHING };
  return { ok: true, answers };
}

/** The rows of the plan in the words `ahub init --dry-run` prints, so the prompt and the preview cannot disagree. */
export const settingLines = (rows: readonly InitSettingRow[]): string[] =>
  rows.map(row => `  ${row.key}: ${row.from === undefined ? "(not set)" : JSON.stringify(row.from)} -> ${JSON.stringify(row.to)} (${row.file})`);

/**
 * Whether a run is offered the prompt: a person (the console role, not a delegated peer or a live test) at a terminal (stdin and stdout), on a new project, with no flag of any kind
 * that sets something and no `--yes`. Every other run gets defaults plus its flags and is never asked anything.
 */
export function promptGate(input: { newProject: boolean; flagGiven: boolean; yes: boolean; dryRun: boolean; stdinIsTTY: boolean; stdoutIsTTY: boolean; role: string; delegated: boolean; liveTest: boolean }): boolean {
  return input.newProject && !input.flagGiven && !input.yes && !input.dryRun && input.stdinIsTTY && input.stdoutIsTTY && input.role === "console" && !input.delegated && !input.liveTest;
}
