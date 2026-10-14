import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPet, type PetView } from "../cli/pet.ts";
import { CHARACTERS, type CharacterId } from "./characters.ts";
import { loadPetConfig, type PetConfig } from "./config.ts";
import { petPixels } from "./pixels.ts";
import { processLiveness, processSignature } from "../pi/process-signature.ts";

export const PET_WINDOW_UNSUPPORTED = "The floating pet window is supported only on macOS; use ahub pet in this terminal.";
export type WindowView = { offline: true } | { state: NonNullable<PetView["summary"]>["state"]; act: number; watch: number; character: CharacterId; blink: boolean; frame: ReturnType<typeof petPixels> };

/** No ids, task text, paths or notices leave the existing readPet projection. */
export function windowView(view: PetView, config: PetConfig, now = Date.now()): WindowView {
  if (view.unavailable || !view.summary) return { offline: true };
  const { state, act, watch } = view.summary;
  const character = config.character ?? "stai";
  const pose = state === "waiting" && config.blink && Math.floor(now / 1000) % 2 ? "waitingBlink" : state;
  return { state, act, watch, character, blink: config.blink, frame: petPixels(CHARACTERS[character].frames.blocks[pose].full) };
}

export function writePetView(stateDir: string, view: WindowView): void {
  const temporary = join(stateDir, `pet-view.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(view), { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(stateDir, "pet-view.json"));
  } finally { rmSync(temporary, { force: true }); }
}

interface WindowOwner { pid: number; signature: string; token: string; ready?: boolean }
const ownerPath = (stateDir: string) => join(stateDir, "pet-window.pid");
function readOwner(stateDir: string): WindowOwner | undefined {
  try {
    const row = JSON.parse(readFileSync(ownerPath(stateDir), "utf8"));
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.signature !== "string" || !/^[a-f0-9]{64}$/.test(row.signature) || typeof row.token !== "string") throw new Error();
    return row;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Cannot confirm the pet window owner; pidfile retained.");
  }
}
function removeOwner(stateDir: string, token: string): void {
  if (readOwner(stateDir)?.token === token) rmSync(ownerPath(stateDir));
}

/** Exclusive creation, including during startup; stale owners require an explicit --close. */
export function claimPetWindow(stateDir: string): { owner: WindowOwner; release(): void } | undefined {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const signature = processSignature(process.pid);
  if (!signature) throw new Error("Cannot confirm the pet window process identity.");
  const owner: WindowOwner = { pid: process.pid, signature, token: randomUUID() };
  try { writeFileSync(ownerPath(stateDir), JSON.stringify(owner), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = readOwner(stateDir);
    if (prior && processLiveness(prior.pid, prior.signature) === "live") return;
    throw new Error("Pet window owner is stale or unconfirmed; run ahub pet --window --close before starting it.");
  }
  return { owner, release: () => removeOwner(stateDir, owner.token) };
}

export function petWindowArgv(projectDir: string): string[] {
  return [process.execPath, join(import.meta.dir, "../cli/main.js"), "--project", projectDir];
}

/** Launch the host from the authorized CLI; never wait on or open the real JXA in tests. */
export async function startPetWindow(stateDir: string, projectDir: string, platform: string = process.platform): Promise<string> {
  if (platform !== "darwin") return PET_WINDOW_UNSUPPORTED;
  const prior = readOwner(stateDir);
  if (prior) {
    if (processLiveness(prior.pid, prior.signature) === "live" && prior.ready) return "Pet window is already running.";
    throw new Error("Pet window owner is starting, stale or unconfirmed; use --close before retrying.");
  }
  const child = spawn(process.execPath, [join(import.meta.dir, "window.ts"), stateDir, projectDir], { detached: true, stdio: "ignore" });
  child.unref();
  let failed = false;
  child.on("error", () => { failed = true; });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !failed) {
    const owner = readOwner(stateDir);
    if (owner?.ready && processLiveness(owner.pid, owner.signature) === "live") return "Pet window started.";
    if (child.exitCode !== null || child.signalCode !== null) break;
    await Bun.sleep(50);
  }
  throw new Error("Pet window startup was not confirmed; use --close before retrying.");
}

export async function closePetWindow(stateDir: string, platform: string = process.platform): Promise<string> {
  if (platform !== "darwin") return PET_WINDOW_UNSUPPORTED;
  const owner = readOwner(stateDir);
  if (!owner) return "Pet window is not running.";
  const live = processLiveness(owner.pid, owner.signature);
  if (live === "unknown") throw new Error("Cannot confirm the pet window owner; nothing was stopped.");
  if (live === "live") {
    process.kill(owner.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && processLiveness(owner.pid, owner.signature) !== "gone") await Bun.sleep(50);
    if (processLiveness(owner.pid, owner.signature) !== "gone") throw new Error("Pet window stop was not confirmed; pidfile retained.");
  }
  removeOwner(stateDir, owner.token);
  return "Pet window closed.";
}

export interface PetWindowHostOptions {
  read?: () => PetView;
  config?: () => PetConfig;
  // Injectable child argv for process-level lifecycle tests; the CLI never accepts it.
  childArgv?: string[];
}
export async function runPetWindowHost(stateDir: string, projectDir: string, options: PetWindowHostOptions = {}): Promise<void> {
  const claim = claimPetWindow(stateDir);
  if (!claim) return;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const refresh = () => {
    let config: PetConfig;
    try { config = (options.config ?? (() => loadPetConfig(projectDir)))(); }
    catch { config = { enabled: true, blink: true, bell: false }; }
    const view = (options.read ?? (() => readPet(stateDir)))();
    writePetView(stateDir, windowView(view, config));
  };
  const stop = () => { if (timer) clearInterval(timer); child?.kill("SIGTERM"); };
  try {
    refresh();
    child = Bun.spawn(options.childArgv ?? ["/usr/bin/osascript", "-l", "JavaScript", join(import.meta.dir, "window.jxa.js"), join(stateDir, "pet-view.json"), join(import.meta.dir, "window.html"), JSON.stringify(petWindowArgv(projectDir))], { cwd: projectDir, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    timer = setInterval(() => { try { refresh(); } catch { stop(); } }, 1000);
    // The child posts this file only once its panel and page have loaded.
    const readyFile = join(stateDir, `pet-window-ready-${child.pid}`);
    const readyDeadline = Date.now() + 4000;
    while (!existsSync(readyFile) && child.exitCode === null && Date.now() < readyDeadline) await Bun.sleep(50);
    if (existsSync(readyFile)) {
      rmSync(readyFile);
      const temporary = join(stateDir, `pet-owner.${claim.owner.token}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify({ ...claim.owner, ready: true }), { flag: "wx", mode: 0o600 });
        renameSync(temporary, ownerPath(stateDir));
      } finally { rmSync(temporary, { force: true }); }
    } else stop();
    await child.exited;
  } finally {
    if (timer) clearInterval(timer);
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
    claim.release();
  }
}

if (import.meta.main) {
  const [stateDir, projectDir] = process.argv.slice(2);
  if (!stateDir || !projectDir || process.platform !== "darwin") process.exit(1);
  try { await runPetWindowHost(stateDir, projectDir); } catch { process.exitCode = 1; }
}
