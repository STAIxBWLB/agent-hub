import { basename, isAbsolute, relative, resolve } from "node:path";

export const ACTION_CLASSES = ["publish", "external-write", "destroy", "install"] as const;
export type ActionClass = typeof ACTION_CLASSES[number];

const SHELL_TOOLS = new Set(["bash", "shell", "shell_command", "exec_command", "run_shell_command"]);
const LIMIT = 16_384;
type Command = { words: string[]; outputs: string[] };

/** Literal shell words only. No evaluation, expansion, or filesystem access. */
function commands(text: string): Command[] | undefined {
  if (text.length > LIMIT || text.includes("\0")) return;
  const result: Command[] = [];
  let words: string[] = [], outputs: string[] = [], word = "", active = false, quote = "";
  let redirect: false | "overwrite" | "append" = false;
  const flush = () => {
    if (!active) return;
    if (redirect === "overwrite") outputs.push(word);
    else if (!redirect) words.push(word);
    word = ""; active = false; redirect = false;
  };
  const finish = () => { flush(); if (words.length || outputs.length) result.push({ words, outputs }); words = []; outputs = []; };
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") { if (c === "'") quote = ""; else word += c; continue; }
    if (c === "\\") {
      const next = text[++i];
      if (next === undefined) return;
      if (quote === '"' && !['$', '`', '"', "\\", "\n"].includes(next)) word += "\\";
      if (next !== "\n") word += next;
      active = true; continue;
    }
    if (c === "$" || c === "`") return;
    if (quote) { if (c === quote) quote = ""; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === "#" && !active) { while (i < text.length && text[i] !== "\n") i++; finish(); continue; }
    if ("(){}<>".includes(c)) {
      // ponytail: only plain output redirection; expansion/heredoc/control syntax needs a shell AST before support.
      if (c !== ">" || text[i + 1] === "&") return;
      if (active && /^\d+$/.test(word)) { word = ""; active = false; } else flush();
      redirect = text[i + 1] === ">" ? "append" : "overwrite";
      if (redirect === "append") i++;
      if (text[i + 1] === "|") i++; continue;
    }
    if (/[ \t\r]/.test(c)) { flush(); continue; }
    if (";|&\n".includes(c)) {
      if (redirect) return;
      finish();
      if (text[i + 1] === c && (c === "|" || c === "&")) i++;
      if (++count > 64) return;
      continue;
    }
    word += c; active = true;
    if (words.length + outputs.length > 256) return;
  }
  if (quote || redirect) return;
  finish();
  return result;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function outside(target: string, root: string, cwd: string): boolean {
  if (!isAbsolute(root) || !target || /[$`~]/.test(target)) return false;
  const rel = relative(resolve(root), resolve(cwd, target));
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}
function flags(words: string[], letter: string): boolean {
  const end = words.indexOf("--");
  return words.slice(0, end < 0 ? undefined : end).some(w => /^-[^-]/.test(w) && w.slice(1).includes(letter));
}
function operands(words: string[]): string[] {
  const end = words.indexOf("--");
  return end < 0 ? words.filter(w => !w.startsWith("-")) : [...words.slice(0, end).filter(w => !w.startsWith("-")), ...words.slice(end + 1)];
}
function option(words: string[], short: string, long: string): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") break;
    if (w === short || w === long) return words[i + 1];
    if (w.startsWith(`${long}=`)) return w.slice(long.length + 1);
    if (w.startsWith(short) && w.length > short.length) return w.slice(short.length);
  }
  return;
}
function sequence(parsed: Command[], root: string, initial: string[], found: Set<ActionClass>, depth = 0): void {
  const cwd = new Set(initial);
  for (const command of parsed) {
    classify(command, root, [...cwd], found, depth);
    const [program, ...args] = command.words;
    const target = args[0] === "--" ? args[1] : args[0];
    // Retain both outcomes: cd may fail, or be in a pipeline/conditional branch.
    if (program === "cd" && target && !target.startsWith("-") && !"$`~*?[]".split("").some(c => target.includes(c))) {
      for (const current of [...cwd]) {
        if (cwd.size >= 128) break;
        cwd.add(resolve(current, target));
      }
    }
  }
}
function classify(command: Command, root: string, cwd: string[], found: Set<ActionClass>, depth = 0): void {
  let words = [...command.words];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  if (words[0] === "env" || words[0] === "command") { words.shift(); while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift(); }
  const program = basename(words.shift() ?? "");
  if (["sh", "bash", "zsh"].includes(program) && ["-c", "-lc"].includes(words[0] ?? "") && words[1] && depth < 2) {
    const nested = commands(words[1]);
    if (nested) sequence(nested, root, cwd, found, depth + 1);
  }
  if (command.outputs.some(p => cwd.some(at => outside(p, root, at)))) found.add("destroy");
  if (program === "git") {
    while (words[0]?.startsWith("-")) {
      const flag = words.shift();
      if (flag === "-C" || flag === "-c" || flag === "--git-dir" || flag === "--work-tree") words.shift();
      else if (!flag?.startsWith("--git-dir=") && !flag?.startsWith("--work-tree=") && flag !== "--no-pager" && flag !== "--literal-pathspecs") return;
    }
    const sub = words.shift();
    if (sub === "push") found.add("publish");
    if (sub === "reset" && words.some(w => w === "--hard" || w.startsWith("--hard="))) found.add("destroy");
    if (sub === "clean" && flags(words, "f") && flags(words, "d") && flags(words, "x")) found.add("destroy");
    if (sub === "branch" && (flags(words, "D") || words.includes("--delete") && words.includes("--force"))) found.add("destroy");
  }
  if (["npm", "cargo", "pnpm", "yarn", "bun"].includes(program)) {
    const sub = words.find(w => !w.startsWith("-"));
    if (sub === "publish") found.add("publish");
    const global = words.includes("--global") || flags(words, "g");
    if ((program === "cargo" && sub === "install") || (["install", "i", "add"].includes(sub ?? "") && global) || (program === "yarn" && words[0] === "global" && words[1] === "add")) found.add("install");
  }
  if (program === "pipx" && words[0] === "install" || program === "brew" && ["install", "reinstall"].includes(words[0] ?? "") || ["pip", "pip3"].includes(program) && words[0] === "install" && words.includes("--user")) found.add("install");
  if (program === "gh") {
    if (words[0] === "release" && ["create", "upload", "edit", "delete"].includes(words[1] ?? "")) found.add("publish");
    if (["issue", "pr", "gist"].includes(words[0] ?? "") && ["create", "comment", "edit", "close", "reopen", "merge", "review", "delete"].includes(words[1] ?? "")) found.add("external-write");
    if (words[0] === "api") {
      const method = option(words, "-X", "--method");
      const field = words.some(w => w === "-f" || w === "-F" || w.startsWith("-f") || w.startsWith("-F") || w === "--input" || w.startsWith("--input=") || w.startsWith("--field") || w.startsWith("--raw-field"));
      if (method ? !["GET", "HEAD"].includes(method.toUpperCase()) : field) found.add("external-write");
    }
  }
  if (program === "curl") {
    const method = option(words, "-X", "--request");
    if (method ? !["GET", "HEAD"].includes(method.toUpperCase()) : !words.includes("--get") && !words.includes("-G") && words.some(w => /^--(?:data|json|form|upload-file)(?:[=-]|$)/.test(w) || /^-[dFT].*/.test(w))) found.add("external-write");
  }
  if (["http", "https"].includes(program) && words.some(w => /^(?:POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)$/.test(w))) found.add("external-write");
  if (["mail", "mailx", "sendmail"].includes(program) && operands(words).length > 0) found.add("external-write");
  if (["slack", "telegram", "discord"].includes(program) && words.some(w => ["send", "post", "chat.postMessage"].includes(w))) found.add("external-write");
  if (program === "rm" && (flags(words, "r") || flags(words, "R") || words.includes("--recursive")) && operands(words).some(p => cwd.some(at => outside(p, root, at)))) found.add("destroy");
  if (["cp", "mv"].includes(program) && (flags(words, "f") || words.includes("--force"))) {
    const target = option(words, "-t", "--target-directory") ?? operands(words).at(-1);
    if (target && cwd.some(at => outside(target, root, at))) found.add("destroy");
  }
}

/** Adds information only; an empty result always retains the native permission policy.
 * ponytail: literal bounded shell/argv forms only; aliases, functions, expansion,
 * interpreter programs and symlink targets need a richer observed contract.
 * Literal cd retains both success/failure cwd candidates (at most 128); it may
 * overclassify a later relative write and is not a shell control-flow proof.
 */
export function classifyAction(tool: string, args: unknown, executionRoot: string): ActionClass[] {
  if (typeof tool !== "string" || tool.length > 128 || typeof executionRoot !== "string" || executionRoot.length > LIMIT) return [];
  if (typeof args === "string") {
    if (args.length > LIMIT) return [];
    try { args = JSON.parse(args) as unknown; } catch { args = { command: args }; }
  }
  const input = object(args);
  if (!input) return [];
  const found = new Set<ActionClass>();
  if (["http", "http_request", "fetch"].includes(tool.toLowerCase()) && typeof input.method === "string" && /^[A-Za-z]+$/.test(input.method) && !["GET", "HEAD"].includes(input.method.toUpperCase())) found.add("external-write");
  const boundedArgv = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(w => typeof w === "string" && w.length <= LIMIT) && value.join("").length <= LIMIT;
  const location = input.cwd ?? input.workdir;
  const cwd = typeof location === "string" && location.length <= LIMIT && !/[$`~]/.test(location) ? resolve(executionRoot, location) : executionRoot;
  if (tool.toLowerCase() === "git" && boundedArgv(input.args)) classify({ words: ["git", ...input.args], outputs: [] }, executionRoot, [cwd], found);
  if (SHELL_TOOLS.has(tool.toLowerCase())) {
    const raw = input.command ?? input.cmd;
    if (typeof raw === "string") {
      const parsed = commands(raw);
      if (parsed) sequence(parsed, executionRoot, [cwd], found);
    } else if (boundedArgv(raw)) {
      classify({ words: raw, outputs: [] }, executionRoot, [cwd], found);
    }
  }
  return ACTION_CLASSES.filter(value => found.has(value));
}
