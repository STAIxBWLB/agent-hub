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

/**
 * An expansion (`$VAR`, `${...}`, `$(...)`, a backtick) stands in a word as this one character. The input itself may not contain it
 * (`commands` refuses a NUL), so a word has it only where the hub put it: the word's value is unknown (#762).
 */
const OPAQUE = "\0";
const opaque = (word: string | undefined): boolean => word !== undefined && word.includes(OPAQUE);

/** The index after the bracket that closes `text[at]` (`(` or `{`), quotes and nested expansions respected, or -1 when it never closes. */
function matching(text: string, at: number, nest = 0): number {
  if (nest > 16) return -1;
  const open = text[at]!, close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") { i++; continue; }
    if (c === "'") { const end = text.indexOf("'", i + 1); if (end < 0) return -1; i = end; continue; }
    if (c === "`") { const end = text.indexOf("`", i + 1); if (end < 0) return -1; i = end; continue; }
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "$" && (text[i + 1] === "(" || text[i + 1] === "{")) { const end = matching(text, i + 1, nest + 1); if (end < 0) return -1; i = end - 1; }
      }
      if (i >= text.length) return -1;
      continue;
    }
    if (c === "$" && (text[i + 1] === "(" || text[i + 1] === "{") && i + 1 !== at) { const end = matching(text, i + 1, nest + 1); if (end < 0) return -1; i = end - 1; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The expansion that starts at `text[at]` (a `$` or a backtick): where it ends, the command text it runs (`$(...)`, a backtick, and the
 * parameter text of `${...}`, which can hold one), and `drop` for a `$"` that only opens a quote. Undefined for a `$` that is a literal dollar.
 * An expansion that never closes ends at the end of the text.
 */
function expansion(text: string, at: number, quoted: boolean): { end: number; inner?: string; drop?: true } | undefined {
  if (text[at] === "`") {
    for (let i = at + 1; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "`") return { end: i + 1, inner: text.slice(at + 1, i) };
    }
    return { end: text.length };
  }
  const next = text[at + 1];
  if (next === "(" || next === "{") {
    const end = matching(text, at + 1);
    return end < 0 ? { end: text.length } : { end, inner: text.slice(at + 2, end - 1) };
  }
  if (next === "'") {                                       // $'...': ANSI-C quoting, whose escapes build the word
    for (let i = at + 2; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === "'") return { end: i + 1 }; }
    return { end: text.length };
  }
  if (next === '"') return quoted ? undefined : { end: at + 1, drop: true };
  if (next !== undefined && /[A-Za-z_]/.test(next)) { let end = at + 2; while (end < text.length && /[A-Za-z0-9_]/.test(text[end]!)) end++; return { end }; }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return { end: at + 2 };
  return undefined;
}

/** Shell words, literal where they can be read. An expansion becomes an opaque word and the commands it runs are read too; unsupported syntax discards only its unfinished segment. */
function commands(text: string, nest = 0): Command[] | undefined {
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
    if (c === "$" || c === "`") {
      const found = expansion(text, i, quote === '"');
      if (!found) { word += c; active = true; continue; }         // a lone `$` is a literal dollar
      if (found.inner !== undefined && nest < 4) { const inner = commands(found.inner, nest + 1); if (inner) result.push(...inner); }
      if (!found.drop) { word += OPAQUE; active = true; }
      i = found.end - 1; continue;
    }
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
/**
 * A word that starts with an expansion may expand to a dash word (`$OPTS` as `-rf`), so a class that depends on a flag counts it as that flag
 * (#762). Only the words before `--` can be options. A word that merely has an expansion later (`build/$X`, `--name=$X`) cannot start one.
 */
function mayBeFlag(words: readonly string[]): boolean {
  const end = words.indexOf("--");
  return words.slice(0, end < 0 ? undefined : end).some(w => w.startsWith(OPAQUE));
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
/** Known option values are opaque. Unknown prefix options retain every plausible action head. */
function commandHeads(words: string[], values: readonly string[], booleans: readonly string[], actions: readonly string[]): Array<{ name: string; args: string[] }> {
  const heads: Array<{ name: string; args: string[] }> = [];
  let uncertain = false, literal = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!literal && word === "--") { literal = true; continue; }
    if (!literal && word.startsWith("-")) {
      if (!uncertain && ["--help", "--version", "-h", "-V"].includes(word)) return [];
      if (values.includes(word)) { if (!uncertain) i++; continue; }
      if (values.some(key => key.startsWith("--") ? word.startsWith(`${key}=`) : word.startsWith(key) && word.length > key.length)) continue;
      if (!booleans.includes(word)) uncertain = true;
      continue;
    }
    if (!uncertain) return [{ name: word, args: words.slice(i + 1) }];
    if (actions.includes(word) || opaque(word)) heads.push({ name: word, args: words.slice(i + 1) });
  }
  return heads;
}

/** Exclude patterns and path operands cannot impersonate clean's force/dry-run options. */
function forcedClean(words: string[]): boolean {
  let force = false, dry = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") break;
    if (word === "--exclude") { i++; continue; }
    if (word.startsWith("--exclude=")) continue;
    if (word === "--force") force = true;
    else if (word === "--dry-run") dry = true;
    else if (/^-[^-]/.test(word)) {
      for (let at = 1; at < word.length; at++) {
        const flag = word[at]!;
        if (flag === "e") { if (at === word.length - 1) i++; break; }
        if (flag === "f") force = true;
        if (flag === "n") dry = true;
      }
    }
    else if (word.startsWith(OPAQUE)) force = true;   // an expansion may be `-f`; a literal dry run still wins (#762)
  }
  return force && !dry;
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
      const duration = words.shift() ?? "";
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(duration) && !opaque(duration)) return [];
    }
  }
  return [];
}

/**
 * Whether every definition of a GraphQL document is a read: a `query` (or shorthand `{...}`) or a `fragment`. Strings and comments are skipped, so
 * a keyword inside one counts for nothing. A `mutation`, a `subscription`, any other top-level word, unbalanced text or no operation is false:
 * unknown is never a read.
 */
function graphqlQueryOnly(text: string): boolean {
  const skipString = (at: number): number => {              // `at` is the opening quote; the index after the string, or -1 when it never ends
    // A block string ends at its first `"""`: GraphQL's escaped `\"""` ends it later, so a lexer that ends early only turns a read into a write (the strict direction).
    if (text.startsWith('"""', at)) { const end = text.indexOf('"""', at + 3); return end < 0 ? -1 : end + 3; }
    // GraphQL's line terminators are LF, CR and CRLF, and none may appear in a single-line string: ending early is the strict direction.
    for (let i = at + 1; i < text.length; i++) { if (text[i] === "\\") { i++; if (text[i] === "\n" || text[i] === "\r") return -1; } else if (text[i] === '"') return i + 1; else if (text[i] === "\n" || text[i] === "\r") return -1; }
    return -1;
  };
  const skipComment = (at: number): number => { let i = at; while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++; return i; };   // a comment ends at LF or CR (so also CRLF), never later than GraphQL ends it
  const closers: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const skipBlock = (at: number): number => {             // `at` is an opening bracket; the index after its matching close, or -1
    const close = closers[text[at]!]!;
    for (let i = at + 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === '"') { const end = skipString(i); if (end < 0) return -1; i = end - 1; }
      else if (c === "#") i = skipComment(i) - 1;
      else if (c in closers) { const end = skipBlock(i); if (end < 0) return -1; i = end - 1; }
      else if (c === "}" || c === ")" || c === "]") return c === close ? i + 1 : -1;
    }
    return -1;
  };
  let start = true, operations = 0;                          // `start`: the next token begins a top-level definition
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (/[\s,\uFEFF]/.test(c)) { i++; continue; }
    if (c === "#") { i = skipComment(i); continue; }
    if (c === "{") { const end = skipBlock(i); if (end < 0) return false; if (start) operations++; i = end; start = true; continue; }   // shorthand query, or the body that ends a definition
    if (c === "(") { if (start) return false; const end = skipBlock(i); if (end < 0) return false; i = end; continue; }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 256))?.[0];
    if (name) {
      if (start) { if (name === "query") operations++; else if (name !== "fragment") return false; start = false; }
      i += name.length; continue;
    }
    if (!start && (c === "@" || c === ":")) { i++; continue; }   // a directive, or `fragment X on Y`; nothing else is read at the top level
    return false;
  }
  return start && operations > 0;
}

/**
 * `gh api graphql` with fields (#756): undefined when the call does not name the graphql endpoint, true only for ONE literal `query` field whose
 * every operation is a read. A query from a file or stdin (`@file`, `--input`), a second `query` field, an option this does not know,
 * another positional and every unparsable document are false: the caller keeps them external-write.
 */
function ghGraphqlRead(words: string[]): boolean | undefined {
  const rest = words.slice(1);                                   // `words` is `api ...`
  if (!rest.includes("graphql")) return undefined;
  const fieldOptions = ["-f", "-F", "--field", "--raw-field"];
  const valued = ["-H", "--header", "--hostname", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview", "-X", "--method"];
  const booleans = ["--paginate", "--slurp", "--silent", "-i", "--include", "--verbose"];
  const positional: string[] = [], queries: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (word === "--" || !word.startsWith("-")) { positional.push(word); continue; }
    let field: string | undefined;
    if (fieldOptions.includes(word)) { field = rest[++i]; if (field === undefined) return false; }
    else if (word.startsWith("--field=") || word.startsWith("--raw-field=")) field = word.slice(word.indexOf("=") + 1);
    else if (/^-[fF][^=]/.test(word)) field = word.slice(2);
    else if (valued.includes(word)) { if (++i >= rest.length) return false; }
    else if (valued.some(key => key.startsWith("--") ? word.startsWith(`${key}=`) : /^-[HqtpX]./.test(word) && word.startsWith(key))) continue;
    else if (!booleans.includes(word)) return false;
    if (field !== undefined) {
      const eq = field.indexOf("=");
      if (eq < 0) return false;
      if (field.slice(0, eq) === "query") queries.push(field.slice(eq + 1));
    }
  }
  const method = option(rest, "-X", "--method");
  if (method !== undefined && method.toUpperCase() !== "POST") return false;
  const [query] = queries;
  if (queries.some(opaque)) return false;                                 // an expansion can close a brace or add an operation: unknown is never a read
  if (positional.length !== 1 || positional[0] !== "graphql" || queries.length !== 1 || query === undefined || query.startsWith("@")) return false;
  return graphqlQueryOnly(query);
}

/**
 * `gh api` with a word the hub cannot read where an option may stand (#762): an option name with an expansion in it, or a later operand that
 * starts with one (`gh api repos/o/r $FLAGS`, which can hold `-X POST`). The endpoint (the first operand) and the values of the known valued
 * options are data. Method, field and query values are judged by the ordinary rules, where an unknown method is never GET.
 */
function ghApiDynamic(words: string[]): boolean {
  const valued = ["-H", "--header", "--hostname", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview", "-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"];
  let operands = 0;
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") return words.slice(i + 1).some((w, n) => opaque(w) && operands + n > 0);
    if (word.startsWith("-")) { if (opaque(word)) return true; if (valued.includes(word)) i++; continue; }
    if (operands++ > 0 && word.startsWith(OPAQUE)) return true;
  }
  return false;
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
    if (program === "cd" && (!target || target.startsWith("~") || opaque(target))) {   // an unknown directory is an unknown cwd
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
      const nested = shell[0] === undefined ? undefined : commands(shell[0].replaceAll(OPAQUE, "$_"));
      if (nested) sequence(nested, root, cwd, found, depth + 1);
    }
  }
  if (command.outputs.some(p => cwd.some(at => outside(p, root, at)))) found.add("destroy");
  if (program === "git") {
    const heads = commandHeads(words, ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"],
      ["-P", "-p", "--no-pager", "--paginate", "--literal-pathspecs", "--bare", "--no-optional-locks", "--no-replace-objects"], ["push", "reset", "clean", "branch"]);
    if (heads.some(head => opaque(head.name))) { found.add("publish"); found.add("destroy"); }   // `git $CMD`: the strictest classes git reaches (#762)
    for (const { name: sub, args } of heads) {
      if (sub === "push") found.add("publish");
      if (sub === "reset" && (args.some(w => w === "--hard" || w.startsWith("--hard=")) || mayBeFlag(args))) found.add("destroy");
      if (sub === "clean" && forcedClean(args)) found.add("destroy");
      if (sub === "branch" && (flags(args, "D") || args.includes("--delete") && args.includes("--force") || mayBeFlag(args))) found.add("destroy");
    }
  }
  if (["npm", "cargo", "pnpm", "yarn", "bun"].includes(program)) {
    const valuesByProgram: Record<string, string[]> = {
      npm: ["--registry", "--prefix", "-C", "--cache", "--userconfig", "--globalconfig", "--loglevel", "--workspace", "-w"],
      pnpm: ["--registry", "--dir", "-C", "--filter", "-F", "--store-dir", "--reporter", "--loglevel"],
      yarn: ["--registry", "--cwd", "--cache-folder", "--mutex", "--use-yarnrc", "--modules-folder", "--network-concurrency", "--network-timeout"],
      cargo: ["--color", "--config", "--manifest-path", "--target-dir"],
      bun: ["--registry", "--cwd", "-C", "--filter", "-F", "--env-file", "--config", "-c", "--cache-dir"],
    };
    const values = valuesByProgram[program]!;
    const booleans = ["--global", "-g", "--offline", "--locked", "--frozen", "--silent", "--quiet", "-q", "--verbose", "-v"];
    const actions = ["publish", "install", "i", "add", "global", "npm"];
    const heads = commandHeads(words, values, booleans, actions);
    for (const head of heads) {
      const candidates = program === "yarn" && head.name === "npm" ? commandHeads(head.args, values, booleans, actions) : [head];
      for (const { name: sub, args } of candidates) {
        if (opaque(sub) && program !== "bun") { found.add("publish"); found.add("install"); }   // `npm $CMD`; bun runs a file by default, so its expansion is no subcommand (#762)
        if (sub === "publish") found.add("publish");
        const global = words.includes("--global") || flags(words, "g") || mayBeFlag(words);
        if ((program === "cargo" && sub === "install") || (["install", "i", "add"].includes(sub) && global) || (program === "yarn" && sub === "global" && args[0] === "add")) found.add("install");
      }
    }
  }
  if (program === "pipx" && words[0] === "install" || program === "brew" && ["install", "reinstall"].includes(words[0] ?? "") || ["pip", "pip3"].includes(program) && words[0] === "install" && words.includes("--user")) found.add("install");
  if (program === "gh") {
    if (words[0] === "release" && ["create", "upload", "edit", "delete"].includes(words[1] ?? "")) found.add("publish");
    if (["issue", "pr", "gist"].includes(words[0] ?? "") && ["create", "comment", "edit", "close", "reopen", "merge", "review", "delete"].includes(words[1] ?? "")) found.add("external-write");
    if (opaque(words[0])) { found.add("publish"); found.add("external-write"); }   // `gh $GROUP ...`: the strictest classes gh reaches (#762)
    else if (opaque(words[1]) && ["release"].includes(words[0] ?? "")) found.add("publish");
    else if (opaque(words[1]) && ["issue", "pr", "gist", "run", "workflow", "repo", "secret", "variable", "label"].includes(words[0] ?? "")) found.add("external-write");
    if (words[0] === "repo" && ["delete", "archive", "edit"].includes(words[1] ?? "") || ["secret", "variable"].includes(words[0] ?? "") && ["set", "delete"].includes(words[1] ?? "") || words[0] === "label" && ["create", "edit", "delete"].includes(words[1] ?? "")) found.add("external-write");
    if (words[0] === "run" && ["rerun", "cancel", "delete"].includes(words[1] ?? "") || words[0] === "workflow" && ["run", "enable", "disable"].includes(words[1] ?? "")) found.add("external-write");
    if (words[0] === "api" && ghGraphqlRead(words) !== true) {   // a GraphQL document of queries only is a read (#756); everything else keeps the REST rule
      const method = option(words, "-X", "--method");
      const field = words.some(w => w === "-f" || w === "-F" || w.startsWith("-f") || w.startsWith("-F") || w === "--input" || w.startsWith("--input=") || w.startsWith("--field") || w.startsWith("--raw-field"));
      if (method ? !["GET", "HEAD"].includes(method.toUpperCase()) : field || ghApiDynamic(words)) found.add("external-write");
    }
  }
  if (program === "curl" && curlWrites(words)) found.add("external-write");
  if (["http", "https"].includes(program) && words.some(w => /^(?:POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)$/.test(w))) found.add("external-write");
  if (["mail", "mailx", "sendmail"].includes(program) && operands(words).length > 0) found.add("external-write");
  if (["slack", "telegram", "discord"].includes(program) && words.some(w => ["send", "post", "chat.postMessage"].includes(w))) found.add("external-write");
  if (program === "rm" && (flags(words, "r") || flags(words, "R") || words.includes("--recursive") || operands(words).length > 1 && mayBeFlag(words)) && operands(words).some(p => opaque(p) /* an expansion may hold `..` or an absolute path (#762) */ || cwd.some(at => outside(p, root, at)))) found.add("destroy");
  if (["cp", "mv"].includes(program) && (flags(words, "f") || words.includes("--force") || words.length > 2 && mayBeFlag(words.slice(0, -1)))) {   // with two words the first cannot be a flag: `cp -f x` has no target
    const target = option(words, "-t", "--target-directory") ?? operands(words).at(-1);
    if (target && (opaque(target) || cwd.some(at => outside(target, root, at)))) found.add("destroy");
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
