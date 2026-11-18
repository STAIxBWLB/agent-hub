import { parseSimpleShell } from "./read-only-shell.ts";

/** Short branch names from host evidence, never from the permission request. */
export interface TaskShellBinding { branch: string; defaultBranch: string }
export interface TaskShellCommand {
  kind: "check" | "build" | "test" | "add" | "commit" | "push" | "pr-view" | "pr-checks" | "pr-create";
  program: "scripts/check.sh" | "bun" | "git" | "gh";
  argv: readonly string[];
  /** Original literal path operands. The host must guard them under its verified execution root. */
  paths: readonly string[];
}

export function shortBranch(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)
    && value !== "HEAD" && !value.startsWith("refs/") && !value.includes("..") && !value.includes("//")
    && !value.endsWith("/") && !value.endsWith(".")
    && value.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"));
}

function literalPath(value: string): boolean {
  if (!value || value.length > 512 || value.startsWith("-") || !/^[A-Za-z0-9_./-]+$/.test(value)) return false;
  const relative = value.startsWith("./") ? value.slice(2) : value;
  return !relative.startsWith("-") && relative.split("/").every(part => !!part && part !== "." && part !== ".."
    && ![".git", ".agenthub"].includes(part.toLowerCase()));
}

const data = (value: string | undefined, limit: number): value is string =>
  typeof value === "string" && value.length <= limit && !!value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);

export function taskShellBindingValid(binding: TaskShellBinding): boolean {
  return !!binding && shortBranch(binding.branch) && shortBranch(binding.defaultBranch)
    && ![binding.defaultBranch.toLowerCase(), "main", "master"].includes(binding.branch.toLowerCase());
}

/**
 * Lexical data only: this does not authorize execution, bind a task, resolve a program or read Git/files.
 * The caller supplies authoritative native cwd/environment, current child/task/worktree/branch evidence and
 * action/privacy policy, then guards every returned path and executable before answering the native prompt.
 * Quoted punctuation is data only in commit messages and PR title/body values; path/ref operands stay plain.
 */
export function taskShellCommand(command: unknown, binding: TaskShellBinding): TaskShellCommand | undefined {
  if (!taskShellBindingValid(binding)) return undefined;
  const parsed = parseSimpleShell(command);
  if (!parsed) return undefined;
  const argv = parsed.words;
  const result = (kind: TaskShellCommand["kind"], program: TaskShellCommand["program"], paths: readonly string[] = []): TaskShellCommand =>
    ({ kind, program, argv: [...argv], paths: [...paths] });
  if (argv.length === 2 && argv[0] === "scripts/check.sh" && argv[1] === "--changed") return result("check", "scripts/check.sh", ["scripts/check.sh"]);
  if (argv[0] === "bun") {
    if (argv.length === 3 && argv[1] === "run" && argv[2] === "build") return result("build", "bun");
    const paths = argv.slice(2);
    if (argv[1] === "test" && paths.length >= 1 && paths.length <= 16 && paths.every(path => {
      const relative = path.startsWith("./") ? path.slice(2) : path;
      return literalPath(path) && relative.startsWith("test/") && /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.test\.ts$/.test(relative.split("/").at(-1)!);
    })) return result("test", "bun", paths);
    return undefined;
  }
  if (argv[0] === "git") {
    if (argv[1] === "add") {
      const paths = argv.slice(argv[2] === "--" ? 3 : 2);
      if (paths.length >= 1 && paths.length <= 64 && paths.every(literalPath)) return result("add", "git", paths);
    }
    if (argv.length === 4 && argv[1] === "commit" && argv[2] === "-m" && data(argv[3], 1000)) return result("commit", "git");
    if (argv[1] === "push" && (argv.length === 4 && argv[2] === "origin" && argv[3] === binding.branch
      || argv.length === 5 && argv[2] === "-u" && argv[3] === "origin" && argv[4] === binding.branch)) return result("push", "git");
    return undefined;
  }
  if (argv[0] !== "gh" || argv[1] !== "pr") return undefined;
  if (argv.length === 4 && argv[3] === binding.branch) {
    if (argv[2] === "view") return result("pr-view", "gh");
    if (argv[2] === "checks") return result("pr-checks", "gh");
  }
  if (argv[2] !== "create" || argv.length !== 11) return undefined;
  const allowed = new Set(["--base", "--head", "--title", "--body", "--body-file"]), flags = new Map<string, string>();
  for (let index = 3; index < argv.length; index += 2) {
    const flag = argv[index]!, value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || flags.has(flag)) return undefined;
    flags.set(flag, value);
  }
  if (flags.get("--base") !== binding.defaultBranch || flags.get("--head") !== binding.branch || !data(flags.get("--title"), 1000)) return undefined;
  if (flags.has("--body") === flags.has("--body-file")) return undefined;
  if (flags.has("--body")) return data(flags.get("--body"), 3000) ? result("pr-create", "gh") : undefined;
  const file = flags.get("--body-file")!;
  return literalPath(file) ? result("pr-create", "gh", [file]) : undefined;
}

export interface ShellWriteClass { kind: "write" | "read" | "unknown"; targets: string[] }

const SINK = /^(?:\/dev\/(?:null|stdout|stderr|tty)|&\d+|-)$/;
const unq = (w: string) => w.replace(/^(['"])(.*)\1$/, "$2");

/** Words of one simple command, quotes kept whole (a quoted `>` is not a redirection). */
function words(cmd: string): string[] | undefined {
  const out: string[] = [];
  let cur = "", q = "";
  for (const c of cmd) {
    if (q) { cur += c; if (c === q) q = ""; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (/\s/.test(c)) { if (cur) out.push(cur), (cur = ""); continue; }
    if (c === "`" || c === "$") return undefined; // substitution: not guessed
    if (c === ">" && cur && !/^\d+$/.test(cur) && !/[>&]$/.test(cur)) { out.push(cur); cur = ""; } // `echo hi>f`: the redirection is its own word
    cur += c;
  }
  if (q) return undefined;
  if (cur) out.push(cur);
  return out;
}

const CODE_RUNNER = /(?:^|[\s|;&(])(?:sh|bash|zsh|dash|ksh|python[\d.]*|node|bun|deno|ruby|perl|php)(?:\s|$)/;

/**
 * One quote-aware pass: split only at unquoted newline, `;`, `&&`, `||` and `|`, and find `<<WORD` only outside quotes.
 * A heredoc body is data and is skipped, unless its start line runs a shell or interpreter (then it is code) or it
 * never ends: both are unknown. Unbalanced quotes are unknown too.
 */
function segment(command: string): { parts: string[]; unknown: boolean } {
  const parts: string[] = [];
  let cur = "", q = "", unknown = false, lineStart = 0;
  const heredocs: { word: string; strip: boolean }[] = [];
  const push = () => { if (cur.trim()) parts.push(cur); cur = ""; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (q) {
      cur += c;
      if (c === "\\" && q === '"' && i + 1 < command.length) cur += command[++i]!;
      else if (c === q) q = "";
      continue;
    }
    if (c === "\\" && i + 1 < command.length) { cur += c + command[++i]!; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = /^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(command.slice(i));
      if (m) { heredocs.push({ word: (m[2] ?? m[3] ?? m[4])!, strip: m[1] === "-" }); cur += " "; i += m[0].length - 1; continue; }
      unknown = true; cur += c; continue;
    }
    if (c === "\n") {
      const line = command.slice(lineStart, i);
      push();
      if (heredocs.length) {
        if (CODE_RUNNER.test(line)) unknown = true;
        for (const h of heredocs) {
          let ended = false;
          while (i + 1 < command.length) {
            const end = command.indexOf("\n", i + 1);
            const text = command.slice(i + 1, end < 0 ? command.length : end);
            i = end < 0 ? command.length : end;
            if ((h.strip ? text.replace(/^\t+/, "") : text) === h.word) { ended = true; break; }
          }
          if (!ended) unknown = true;
        }
        heredocs.length = 0;
      }
      lineStart = i + 1;
      continue;
    }
    if (c === ";") { push(); continue; }
    if ((c === "&" || c === "|") && command[i + 1] === c) { push(); i++; continue; }
    if (c === "|") { push(); continue; }
    cur += c;
  }
  if (q) unknown = true;
  if (heredocs.length) { unknown = true; if (CODE_RUNNER.test(command.slice(lineStart))) unknown = true; }
  push();
  return { parts, unknown };
}

/**
 * Pure classifier of in-place shell writes (#1556 T1, observation only). A write is named only when certain;
 * anything it cannot parse is unknown, never a guess. Targets under /tmp or /dev sinks are not worktree writes.
 */
export function classifyShellWrite(command: string): ShellWriteClass {
  const targets: string[] = [];
  const seg = segment(command);
  let unknown = seg.unknown;
  for (const part of seg.parts) {
    const w = words(part);
    if (!w) { unknown = true; continue; }
    for (let i = 0; i < w.length; i++) {
      const m = /^(\d*)(>>?|&>>?)(.*)$/.exec(w[i]!);
      if (!m || w[i]!.startsWith("'") || w[i]!.startsWith('"')) continue;
      const t = unq(m[3] || w[++i] || "");
      if (!t || SINK.test(t) || /^>?&\d*$/.test(m[3] ?? "") || /^&/.test(t)) continue;
      targets.push(t);
    }
    const args = w.filter((x) => !/^\d*(>>?|&>>?)/.test(x));
    const head = args[0] === "sudo" || args[0] === "env" ? args.slice(1) : args;
    const [c, ...rest] = head;
    const files = rest.filter((x) => !x.startsWith("-")).map(unq);
    if (!c) continue;
    if (c === "sed" && rest.some((x) => /^-[a-zA-Z]*i/.test(x) || x.startsWith("--in-place"))) {
      // -e/-f/--expression make every positional a file; an unusual suffix form is not guessed: unknown, never a wrong target.
      if (rest.some((x) => /^-[a-zA-Z]*[ef]/.test(x) || x.startsWith("--expression") || x.startsWith("--file"))) unknown = true;
      else targets.push(...files.filter((x) => x !== "").slice(1));
    }
    else if (c === "perl" && rest.some((x) => /^-[a-zA-Z]*i/.test(x))) targets.push(...files.slice(1));
    else if (c === "awk" && rest.includes("inplace") && rest.includes("-i")) targets.push(...files.slice(1).filter((x) => x !== "inplace"));
    else if (c === "tee") targets.push(...files);
    else if (c === "dd") { for (const x of rest) if (x.startsWith("of=")) targets.push(unq(x.slice(3))); }
    else if (c === "cp" || c === "mv" || c === "install") { if (files.length) targets.push(files[files.length - 1]!); }
    else if (c === "patch") targets.push(...files);
    else if (c === "git" && rest[0] === "apply" && !rest.includes("--check")) targets.push("(git apply)");
    else if (/^(python3?|node|bun|ruby|perl)$/.test(c) && rest.some((x) => x === "-c" || x === "-e")) {
      if (/write_text|write\(|writeFile|fs\.write|open\([^)]*['"][wa]|File\.write/.test(part)) unknown = true;
    }
  }
  const real = targets.filter((t) => !/^\/(?:tmp|private\/tmp|var\/folders)\//.test(t));
  if (real.length) return { kind: "write", targets: real };
  return { kind: unknown ? "unknown" : "read", targets: [] };
}
