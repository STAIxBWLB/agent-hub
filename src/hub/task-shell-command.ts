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
