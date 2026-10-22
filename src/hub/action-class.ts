import { basename, isAbsolute, relative, resolve } from "node:path";

export const ACTION_CLASSES = ["publish", "external-write", "destroy", "install"] as const;
export type ActionClass = typeof ACTION_CLASSES[number];

const SHELL_TOOLS = new Set(["bash", "shell", "shell_command", "exec_command", "run_shell_command"]);
const LIMIT = 16_384;
type Command = { words: string[]; outputs: string[] };

/** Bound the whole input before accepting any prefix, including unsupported suffixes. */
function segmentLimit(text: string): boolean {
  let quote = "", count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (quote === c) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#" && (i === 0 || /[ \t\r\n;]/.test(text[i - 1]!))) {
      while (i < text.length && text[i] !== "\n") i++;
    }
    if (i < text.length && ";|&\n".includes(text[i]!)) {
      // FD duplication is an operator, not another command.
      if (text[i] === "&" && [">", "<"].includes(text[i - 1] ?? "")) continue;
      if (++count > 64) return false;
      if ((c === "|" || c === "&") && text[i + 1] === c) i++;
    }
  }
  return true;
}

/** Literal shell words only; unsupported syntax discards only its unfinished segment. */
function commands(text: string): Command[] | undefined {
  if (text.length > LIMIT || text.includes("\0") || !segmentLimit(text)) return;
  const result: Command[] = [];
  let words: string[] = [], outputs: string[] = [], word = "", active = false, quote = "";
  let redirect: false | "overwrite" | "skip" = false;
  const flush = () => {
    if (!active) return;
    if (redirect === "overwrite") outputs.push(word);
    else if (!redirect) words.push(word);
    word = ""; active = false; redirect = false;
  };
  const finish = () => { flush(); if (words.length || outputs.length) result.push({ words, outputs }); words = []; outputs = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") { if (c === "'") quote = ""; else word += c; continue; }
    if (c === "\\") {
      const next = text[++i];
      if (next === undefined) return result;
      if (quote === '"' && !['$', '`', '"', "\\", "\n"].includes(next)) word += "\\";
      if (next !== "\n") word += next;
      active = true; continue;
    }
    if (c === "$" || c === "`") return result;
    if (quote) { if (c === quote) quote = ""; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === "#" && !active) { while (i < text.length && text[i] !== "\n") i++; finish(); continue; }
    if ("(){}".includes(c)) {
      if (redirect && !active) return result;
      finish(); continue;
    }
    if (c === ">" || c === "<") {
      if (redirect && !active) return result;
      if (redirect) flush();
      if (c === "<" && text[i + 1] === "<") return result;
      if (active && /^\d+$/.test(word)) { word = ""; active = false; } else flush();
      if (text[i + 1] === "&") {
        const duplicate = text.slice(i + 2).match(/^(?:\d+|-)(?=$|[ \t\r\n;|&(){}<>])/);
        if (!duplicate) return result;
        i += 1 + duplicate[0].length; continue;
      }
      redirect = c === "<" || text[i + 1] === ">" ? "skip" : "overwrite";
      if (text[i + 1] === ">" || text[i + 1] === "|") i++;
      continue;
    }
    if (/[ \t\r]/.test(c)) { flush(); continue; }
    if (";|&\n".includes(c)) {
      if (redirect && !active) return result;
      finish();
      if (text[i + 1] === c && (c === "|" || c === "&")) i++;
      continue;
    }
    word += c; active = true;
    if (words.length + outputs.length > 256) return result;
  }
  if (quote || (redirect && !active)) return result;
  finish();
  return result;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function outside(target: string, root: string, cwd: string): boolean {
  if (!isAbsolute(root) || !target || /[$`]/.test(target)) return false;
  if (target.startsWith("~") || !cwd && !isAbsolute(target)) return true;
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
/** Peel only known transparent argv wrappers; no aliases or executable discovery. */
function unwrapped(input: string[]): string[] {
  const words = [...input];
  for (let step = 0; step < 32; step++) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
    const name = basename(words[0] ?? "");
    if (["!", "if", "then", "elif", "else"].includes(name)) { words.shift(); continue; }
    if (["fi", "do", "done"].includes(name)) return [];
    if (!["sudo", "time", "timeout", "nohup", "exec", "xargs", "nice", "env", "command"].includes(name)) return words;
    words.shift();
    const values: Record<string, string[]> = {
      sudo: ["-u", "-g", "-h", "-p", "-C", "-T", "--user", "--group", "--host", "--prompt"],
      time: ["-f", "-o", "--format", "--output"],
      timeout: ["-s", "-k", "--signal", "--kill-after"],
      exec: ["-a"], xargs: ["-n", "-P", "-I", "-L", "-s", "-E", "-d", "--max-args", "--max-procs", "--replace", "--delimiter"],
      nice: ["-n", "--adjustment"], env: ["-u", "--unset"],
    };
    while (words[0]?.startsWith("-")) {
      const flag = words.shift()!;
      if (flag === "--") break;
      if (name === "command" && (flag === "-v" || flag === "-V")) return [];
      if ((values[name] ?? []).includes(flag)) { if (!words.length) return []; words.shift(); }
      else if (flag.startsWith("--") && !flag.includes("=") && !["--ignore-environment", "--foreground", "--preserve-status", "--no-run-if-empty", "--verbose"].includes(flag)) return [];
    }
    if (name === "timeout") {
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(words.shift() ?? "")) return [];
    }
  }
  return [];
}

/** Scan curl options once: data, headers and other option values never become options. */
function curlWrites(input: string[]): boolean {
  const longValues = new Set([
    "request", "data", "data-ascii", "data-binary", "data-raw", "data-urlencode", "json", "form", "form-string", "upload-file",
    "url-query", "header", "proxy-header", "output", "output-dir", "user-agent", "user", "proxy-user", "cookie", "cookie-jar", "referer", "url",
    "resolve", "connect-to", "config", "cacert", "capath", "cert", "cert-type", "key", "key-type", "pass", "proxy", "preproxy",
    "interface", "max-time", "connect-timeout", "limit-rate", "range", "request-target", "unix-socket", "abstract-unix-socket",
    "write-out", "trace", "trace-ascii", "dump-header", "stderr", "netrc-file", "ftp-method", "ftp-port", "oauth2-bearer",
    "proxy-cacert", "proxy-cert", "proxy-key", "socks5", "socks5-hostname", "retry", "retry-delay", "retry-max-time", "local-port",
  ]);
  let method: string | undefined, data = false, upload = false, get = false, head = false, uncertain = false, writeMethod = false;
  const booleanOptions = new Set(["get", "head", "compressed", "location", "insecure", "silent", "show-error", "fail", "fail-with-body", "globoff", "verbose", "include", "remote-name", "path-as-is", "create-dirs", "progress-meter", "progress-bar", "http1.1", "http2", "http3"]);
  // An unknown option may consume a following read-looking token. It cannot erase known write evidence.
  const writes = () => uncertain && (data || upload || writeMethod) || (method !== undefined ? !["GET", "HEAD"].includes(method.toUpperCase()) : !head && (upload || data && !get));
  for (let i = 0; i < input.length; i++) {
    const arg = input[i]!;
    if (arg === "--") break;
    if (arg === "--next" || arg === "-:") {
      if (writes()) return true;
      method = undefined; data = upload = get = head = uncertain = writeMethod = false;
      continue;
    }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      const name = arg.slice(2, equal < 0 ? undefined : equal);
      if (name === "get" || name === "no-get") get = name === "get";
      else if (name === "head" || name === "no-head") head = name === "head";
      if (!longValues.has(name)) { if (!booleanOptions.has(name.replace(/^no-/, ""))) uncertain = true; continue; }
      const value = equal < 0 ? input[++i] : arg.slice(equal + 1);
      if (value === undefined) continue;
      if (name === "request") { method = value; writeMethod ||= !["GET", "HEAD"].includes(value.toUpperCase()); }
      else if (name === "upload-file") upload = true;
      else if (name === "json" || name.startsWith("data") || name === "form" || name === "form-string") data = true;
      continue;
    }
    if (!/^-[^-]/.test(arg)) continue;
    for (let at = 1; at < arg.length; at++) {
      const flag = arg[at]!;
      if (flag === "G") get = true;
      if (flag === "I") head = true;
      // These short options consume the rest of this word, or the next whole word.
      if (!"XdFTHoAuUbecrxEKPmCwDQztYy".includes(flag)) continue;
      const value = arg.slice(at + 1) || input[++i];
      if (value !== undefined) {
        if (flag === "X") { method = value; writeMethod ||= !["GET", "HEAD"].includes(value.toUpperCase()); }
        else if (flag === "d" || flag === "F") data = true;
        else if (flag === "T") upload = true;
      }
      break;
    }
  }
  return writes();
}

function sequence(parsed: Command[], root: string, initial: string[], found: Set<ActionClass>, depth = 0): void {
  const cwd = new Set(initial);
  for (const command of parsed) {
    classify(command, root, [...cwd], found, depth);
    const [program, ...args] = unwrapped(command.words);
    const target = args[0] === "--" ? args[1] : args[0];
    // Retain both outcomes: cd may fail, or be in a pipeline/conditional branch.
    if (program === "cd" && (!target || target.startsWith("~"))) {
      if (!cwd.has("") && cwd.size >= 128) cwd.delete(cwd.values().next().value!);
      cwd.add("");
    }
    else if (program === "cd" && target && !target.startsWith("-") && !"$`*?[]".split("").some(c => target.includes(c))) {
      for (const current of [...cwd]) {
        if (cwd.size >= 128) break;
        cwd.add(current || isAbsolute(target) ? resolve(current, target) : "");
      }
    }
  }
}
function classify(command: Command, root: string, cwd: string[], found: Set<ActionClass>, depth = 0): void {
  const words = unwrapped(command.words);
  const program = basename(words.shift() ?? "");
  if (["sh", "bash", "zsh"].includes(program) && depth < 2) {
    const shell = [...words];
    while (["--noprofile", "--norc"].includes(shell[0] ?? "")) shell.shift();
    const mode = shell.shift();
    if (mode && /^-[A-Za-z]*c[A-Za-z]*$/.test(mode)) {
      if (shell[0] === "--") shell.shift();
      const nested = shell[0] === undefined ? undefined : commands(shell[0]);
      if (nested) sequence(nested, root, cwd, found, depth + 1);
    }
  }
  if (command.outputs.some(p => cwd.some(at => outside(p, root, at)))) found.add("destroy");
  if (program === "git") {
    while (words[0]?.startsWith("-")) {
      const flag = words.shift();
      if (flag === "-C" || flag === "-c" || flag === "--git-dir" || flag === "--work-tree") words.shift();
      else if (!flag?.startsWith("--git-dir=") && !flag?.startsWith("--work-tree=") && flag !== "--no-pager" && flag !== "-P" && flag !== "--literal-pathspecs") return;
    }
    const sub = words.shift();
    if (sub === "push") found.add("publish");
    if (sub === "reset" && words.some(w => w === "--hard" || w.startsWith("--hard="))) found.add("destroy");
    if (sub === "clean" && flags(words, "f") && flags(words, "d") && flags(words, "x")) found.add("destroy");
    if (sub === "branch" && (flags(words, "D") || words.includes("--delete") && words.includes("--force"))) found.add("destroy");
  }
  if (["npm", "cargo", "pnpm", "yarn", "bun"].includes(program)) {
    const args = [...words];
    while (args[0]?.startsWith("-")) {
      const flag = args.shift()!;
      if (["--registry", "--filter", "--prefix", "--cwd", "--dir"].includes(flag)) args.shift();
      if (flag === "--") break;
    }
    if (program === "yarn" && args[0] === "npm") args.shift();
    const sub = args[0];
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
  if (program === "curl" && curlWrites(words)) found.add("external-write");
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
 * Home targets are conservatively outside without resolving a personal home.
 * Unsupported segments retain only preceding complete commands.
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
  const cwd = typeof location === "string" && location.startsWith("~") ? "" : typeof location === "string" && location.length <= LIMIT && !/[$`]/.test(location) ? resolve(executionRoot, location) : executionRoot;
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
