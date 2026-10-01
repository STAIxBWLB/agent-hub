import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realPath } from "../hub/project.ts";
import { denyRegexes, sbplString } from "./deny.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const OUTPUT_CAP = 20_000;

export const sandboxAvailable = () => process.platform === "darwin" && existsSync(SANDBOX_EXEC);

const q = sbplString;

/**
 * Seatbelt profile for everything the local worker executes (bash, git). Path checks cannot scope a shell,
 * so the kernel does: writes only under cwd and temp, no reads of credential stores or denylisted files,
 * no network unless asked. In SBPL the last matching rule wins, so the denies come last.
 */
/** Toolchains and git identity: the only parts of the home directory a sandboxed command may read besides the project. */
const HOME_READABLE = [".bun", ".cargo", ".rustup", ".local", ".npm", ".cache", ".pyenv", ".nvm", ".deno", "go", ".gitconfig", ".config/git", "Library/Caches", ".volta", ".asdf", ".nodenv", ".rbenv", ".sdkman", "Library/Application Support/fnm", "Library/pnpm"];

/**
 * Public CA bundles: the name denies (`*.pem` for keys) also match these, and TLS needs them once network is on.
 * Allowed after the denies, by exact path.
 */
const CA_BUNDLES = ["/private/etc/ssl/cert.pem", "/opt/homebrew/etc/ca-certificates/cert.pem", "/opt/homebrew/etc/openssl@3/cert.pem", "/usr/local/etc/ca-certificates/cert.pem", "/usr/local/etc/openssl@3/cert.pem"];

/**
 * The selected Xcode or Command Line Tools dir: the `/usr/bin` shims (git, clang, make, python3) run what is in it.
 * Inside an app bundle that is the whole `Contents`: its tools load frameworks from `SharedFrameworks` next to it.
 */
function developerDir(): string | undefined {
  const out = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
  let dir = out.status === 0 ? out.stdout.trim() : "";
  // Seatbelt matches real paths: an Xcode selected through a symlink (`Xcode.app` -> `Xcode-26.0.app`) needs its target.
  try { dir = dir && realPath(dir); } catch { /* gone since it was selected: nothing the shims could run either */ }
  return dir ? dir.replace(/(\.app\/Contents)\/Developer\/?$/, "$1") : undefined;
}

/** A submodule or worktree keeps its git dir outside the project; git needs it, minus the parts that execute or reconfigure. */
function externalGitDirs(root: string): string[] {
  const out = spawnSync("git", ["-C", root, "rev-parse", "--absolute-git-dir", "--git-common-dir"], { encoding: "utf8" });
  if (out.status !== 0) return [];
  const dirs = out.stdout.trim().split("\n").map((d) => resolve(root, d));
  return [...new Set(dirs)].filter((d) => !d.startsWith(`${root}/`));
}

/** The system directories a deny-default profile lets commands read and run from: dyld, frameworks, toolchains. */
const SYSTEM_READABLE = ["/usr", "/bin", "/sbin", "/System", "/Library", "/opt", "/private/etc", "/private/var/db/timezone", "/private/var/db/dyld"];
/**
 * Directory lookups (users, groups), logging and notifications; plus name resolution and TLS trust when network is on.
 * No brokers that act outside the sandbox: LaunchServices would let `open` start a browser with network, and
 * SecurityServer would answer Keychain queries the credential-path denies are there to stop.
 */
const MACH_SERVICES = ["com.apple.system.opendirectoryd.libinfo", "com.apple.system.DirectoryService.libinfo_v1", "com.apple.system.logger", "com.apple.system.notification_center"];
const NETWORK_MACH_SERVICES = ["com.apple.dnssd.service", "com.apple.trustd", "com.apple.trustd.agent", "com.apple.networkd"];

/**
 * `base` "deny" (issue #39) starts from `(deny default)` and allows only what commands need: running and reading the
 * system, toolchain and project directories, writing the project and temp. "allow" is the profile of 0.9 and earlier,
 * kept for one release behind `local.sandbox: "allow-default"`. The denies at the end apply to both.
 */
export function profile(cwd: string, network: boolean, readAllow: string[] = [], deny: string[] = [], base: "deny" | "allow" = "deny"): string {
  const home = homedir();
  const inHome = (p: string) => (p.startsWith("~/") ? join(home, p.slice(2)) : p);
  const root = realPath(cwd);
  const tmp = realPath(tmpdir());
  const gitDirs = externalGitDirs(root);
  const creds = [".ssh", ".aws", ".gnupg", ".config/gh", ".config/gcloud", ".kube", ".docker", ".netrc", ".npmrc", ".omniroute", ".claude", ".codex", ".kimi-code", "Library/Keychains"];
  const dev = developerDir();
  const readable = [root, ...HOME_READABLE.map((p) => join(home, p)), ...readAllow.map(inHome), ...gitDirs, ...(dev ? [dev] : [])];
  const subpaths = (paths: string[]) => paths.map((p) => `(subpath ${q(p)})`).join(" ");
  const globals = (names: string[]) => names.map((n) => `(global-name ${q(n)})`).join(" ");
  const start = base === "deny"
    ? [
        "(deny default)",
        "(allow process-fork)",
        // Runs from the system, toolchain and project directories only; a script runs through an allowed interpreter.
        // The user's temp dir and /private/tmp are shared with every other process: each command gets its own (#63).
        `(allow process-exec ${subpaths([...SYSTEM_READABLE, ...readable])})`,
        "(allow signal (target same-sandbox))",
        "(allow process-info* (target same-sandbox))",
        "(allow sysctl-read)",
        `(allow mach-lookup ${globals([...MACH_SERVICES, ...(network ? NETWORK_MACH_SERVICES : [])])})`,
        '(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata (ipc-posix-name "apple.shm.notification_center"))',
        "(allow file-read-metadata)",
        `(allow file-read* (literal "/") ${subpaths([...SYSTEM_READABLE, "/dev"])} ${subpaths(readable)})`,
        '(allow file-ioctl (regex #"^/dev/"))',
        ...(network ? ["(allow network*)"] : []),
      ]
    : [
        "(allow default)",
        ...(network ? [] : ["(deny network*)"]),
        // Home is default-deny for reads: whatever a command reads can end up in the model's answer, and that answer
        // is shared with agents that run on cloud subscriptions (~/.claude.json, app tokens, browser profiles ...).
        `(deny file-read* (subpath ${q(home)}))`,
        `(allow file-read-metadata (subpath ${q(home)}))`,
        `(allow file-read* ${subpaths(readable)})`,
      ];
  const places = `${creds.map((c) => `(subpath ${q(join(home, c))})`).join(" ")} ${denyRegexes(root, deny, false).join(" ")}`;
  return [
    "(version 1)",
    ...start,
    "(deny file-write*)",
    `(allow file-write* (subpath ${q(root)}) ${base === "deny" ? "" : `(subpath ${q(tmp)}) (subpath "/private/tmp") `}(regex #"^/dev/") ${gitDirs.map((d) => `(subpath ${q(d)})`).join(" ")})`,
    // Inside cwd: nothing that runs later outside the sandbox, nothing that reconfigures the hub.
    `(deny file-write* (subpath ${q(join(root, ".agenthub"))}) ${[join(root, ".git"), ...gitDirs].map((d) => `(subpath ${q(join(d, "hooks"))}) (literal ${q(join(d, "config"))})`).join(" ")})`,
    `(deny file-read* file-write* ${creds.map((c) => `(subpath ${q(join(home, c))})`).join(" ")})`,
    `(deny file-read* file-write* ${denyRegexes(root, deny).join(" ")})`,
    // Python's own CA bundle (certifi, which pip vendors too): pip, requests and httpx read it instead of the system's (#64).
    // The last match wins: the denied places come again after it, so it overrides only the `.pem` name rule.
    ...(network ? [`(allow file-read* ${CA_BUNDLES.map((p) => `(literal ${q(p)})`).join(" ")} (regex ${q("/certifi/cacert\\.pem$")}))`, `(deny file-read* file-write* ${places})`] : []),
  ].join("\n");
}

export interface ExecResult {
  code: number | null;
  output: string;
}

/** Run argv under seatbelt with a scrubbed environment. Never runs unsandboxed: no sandbox, no exec. */
export function sandboxedExec(argv: string[], opts: { cwd: string; profile: string; timeoutMs?: number }): Promise<ExecResult> {
  if (!sandboxAvailable()) return Promise.resolve({ code: null, output: "error: command execution needs macOS sandbox-exec and is disabled on this host" });
  return new Promise((resolve) => {
    // A temp dir of its own (#63): the user's is shared with every other process, and what a command reads can reach
    // an answer shown to cloud peers. Allowed after the profile's denies, and gone when the command ends.
    const own = realPath(mkdtempSync(join(tmpdir(), "ahub-cmd-")));
    const sandbox = `${opts.profile}\n(allow file-read* file-write* process-exec (subpath ${q(own)}))`;
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: process.env.LANG ?? "en_US.UTF-8", TERM: "dumb", TMPDIR: `${own}/` };
    // Own process group: a timeout has to take the grandchildren too, or they keep the pipes open and the project writable.
    const child = spawn(SANDBOX_EXEC, ["-p", sandbox, ...argv], { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    const take = (d: Buffer) => {
      if (output.length < OUTPUT_CAP) output += d.toString();
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    // Best effort, never in the way of the result: a command can mark its files immutable (`chflags uchg`), and then
    // the plain remove throws. What still fails is left to the OS temp cleanup.
    const dropOwn = () => {
      try { rmSync(own, { recursive: true, force: true }); } catch {
        try { spawnSync("chflags", ["-R", "nouchg", own]); rmSync(own, { recursive: true, force: true }); } catch { /* left behind */ }
      }
    };
    const timer = setTimeout(killGroup, opts.timeoutMs ?? 120_000);
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      dropOwn();
      const clipped = output.length >= OUTPUT_CAP ? `${output.slice(0, OUTPUT_CAP)}\n(output truncated)` : output;
      resolve({ code, output: signal ? `${clipped}\n(killed: ${signal}, timeout?)` : clipped });
    };
    child.on("error", (e) => (done || ((done = true), dropOwn(), resolve({ code: null, output: `error: ${e.message}` }))));
    child.on("close", finish);
    // `close` waits for every holder of the pipes; after `exit` give stragglers a moment, then stop waiting and reap them.
    child.on("exit", (code, signal) => setTimeout(() => (killGroup(), finish(code, signal)), 500).unref());
  });
}
