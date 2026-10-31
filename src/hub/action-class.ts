import { basename, isAbsolute, relative, resolve } from "node:path";

export const ACTION_CLASSES = ["publish", "external-write", "destroy", "install"] as const;
export type ActionClass = typeof ACTION_CLASSES[number];

const SHELL_TOOLS = new Set(["bash", "shell", "shell_command", "exec_command", "run_shell_command"]);
const LIMIT = 16_384;
/** `nested`: the commands of each substitution in the segment (`$(...)`, a backtick). They run in a subshell, so their `cd` never moves the outer cwd. */
type Command = { words: string[]; outputs: string[]; nested?: Command[][]; /** A redirect of any kind (`>`, `>>`, `<`, `>|`): its target is not recorded as a word, so a caller that needs to know whether the command writes anything must count it. */ redirected?: true };

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
 * The expansion that starts at `text[at]` (a `$` or a backtick): where it ends, the command texts it runs (`inners`: `$(...)` and a backtick
 * run their text; `${...}` runs only the substitutions nested in its parameter text, never the text itself), and `drop` for a `$"` that only
 * opens a quote. Undefined for a `$` that is a literal dollar. An expansion that never closes ends at the end of the text.
 */
function expansion(text: string, at: number, quoted: boolean, nest = 0): { end: number; inners: string[]; drop?: true } | undefined {
  if (text[at] === "`") {
    for (let i = at + 1; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "`") return { end: i + 1, inners: [text.slice(at + 1, i)] };
    }
    return { end: text.length, inners: [] };
  }
  const next = text[at + 1];
  if (next === "(") {
    const end = matching(text, at + 1);
    return end < 0 ? { end: text.length, inners: [] } : { end, inners: [text.slice(at + 2, end - 1)] };
  }
  if (next === "{") {                                       // parameter text is data: only the substitutions inside it run
    const end = matching(text, at + 1);
    const body = end < 0 ? text.slice(at + 2) : text.slice(at + 2, end - 1), inners: string[] = [];
    for (let i = 0; i < body.length && nest < 4; i++) {
      if (body[i] === "\\") { i++; continue; }
      if (body[i] !== "$" && body[i] !== "`") continue;
      const inner = expansion(body, i, false, nest + 1);
      if (inner) { inners.push(...inner.inners); i = inner.end - 1; }
    }
    return { end: end < 0 ? text.length : end, inners };
  }
  if (next === "'") {                                       // $'...': ANSI-C quoting, whose escapes build the word
    for (let i = at + 2; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === "'") return { end: i + 1, inners: [] }; }
    return { end: text.length, inners: [] };
  }
  if (next === '"') return quoted ? undefined : { end: at + 1, inners: [], drop: true };
  if (next !== undefined && /[A-Za-z_]/.test(next)) { let end = at + 2; while (end < text.length && /[A-Za-z0-9_]/.test(text[end]!)) end++; return { end, inners: [] }; }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return { end: at + 2, inners: [] };
  return undefined;
}

/** Shell words, literal where they can be read. An expansion becomes an opaque word and the commands it runs are read too; unsupported syntax discards only its unfinished segment. */
function commands(text: string, nest = 0): Command[] | undefined {
  if (text.length > LIMIT || text.includes("\0") || !segmentLimit(text)) return;
  const result: Command[] = [];
  let words: string[] = [], outputs: string[] = [], word = "", active = false, quote = "";
  let redirect: false | "overwrite" | "skip" = false, redirected = false;
  const flush = () => {
    if (!active) return;
    if (redirect === "overwrite") outputs.push(word);
    else if (!redirect) words.push(word);
    word = ""; active = false; redirect = false;
  };
  let nested: Command[][] = [];
  const finish = () => { flush(); if (words.length || outputs.length || nested.length) result.push({ words, outputs, ...(nested.length ? { nested } : {}), ...(redirected ? { redirected: true as const } : {}) }); words = []; outputs = []; nested = []; redirected = false; };
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
      if (nest < 4) for (const text of found.inners) { const inner = commands(text, nest + 1); if (inner?.length) nested.push(inner); }
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
      redirected = true;
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

/**
 * #999 T3, the floor policy: what the classifier needs to tell an ordinary branch push or own-repository pull request from a release-grade one.
 * The classifier stays pure, so the host supplies these facts. A fact that is missing is unknown, and unknown keeps the strictest class (#762).
 * Without a `FloorFacts` argument nothing here runs and every class is exactly what it was before the floor existed.
 */
export interface FloorFacts {
  /** The default branch from the authoritative remote read. Without it every push still asks. */
  defaultBranch?: string;
  /** The project's own GitHub repository, `owner/name`. Without it a `--repo` flag still asks. */
  repository?: string;
  /** Whether a local tag of that name exists in `cwd`: `false` only when git proved there is none. */
  refIsTag?: (name: string, cwd: string) => boolean | undefined;
  /** The branch checked out in `cwd`, or undefined when detached or unknown. */
  currentBranch?: (cwd: string) => string | undefined;
  /** Whether `cwd` is inside the project's own git repository (its top level is the execution root), so `origin` and `gh` mean the project's remote. `true` only when proven: a nested clone has another `origin`. */
  inOwnRepository?: (cwd: string) => boolean | undefined;
  /**
   * Whether a plain `git push origin <branch>` from `cwd` can only write the project's own repository and only the named branch: every effective push URL of `origin`
   * (`remote.origin.pushurl`, `url.*.pushInsteadOf`) is the project's repository, and no configuration can add refs to the push (`push.followTags`, `push.pushOption`,
   * `remote.origin.push`, `remote.origin.mirror`), and the hub's own environment overrides none of it. `true` only when proven.
   */
  pushIsOwn?: (cwd: string) => boolean | undefined;
  /**
   * Whether `gh` run in `cwd` with no `--repo` resolves to the project's own repository: the checkout has no remote but `origin`, its `gh-resolved` marker does not name another
   * repository, and neither `GH_REPO` nor `GH_HOST` is set in the hub's environment. `true` only when proven.
   */
  ghDefaultIsOwn?: (cwd: string) => boolean | undefined;
}
/** The only `git push` options the floor lets through. Force, delete, tags, mirror, prune, no-verify, push options and another repository all ask. */
const FLOOR_PUSH_LONG = new Set(["--set-upstream", "--quiet", "--verbose", "--dry-run", "--porcelain", "--atomic", "--progress", "--no-progress"]);
const FLOOR_PUSH_SHORT = "uqvn";
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const plainBranch = (name: string): boolean => BRANCH_NAME.test(name) && !name.includes("..") && !name.includes("//") && !name.endsWith("/") && !name.endsWith(".lock") && name !== "HEAD";
const isDefaultBranch = (name: string, floor: FloorFacts): boolean => ["main", "master", floor.defaultBranch ?? ""].some(known => known !== "" && known.toLowerCase() === name.toLowerCase());
/** Every candidate cwd is a known directory inside the execution root: `cd /elsewhere`, `cd $X` and `cd ~` leave the floor. */
const withinRoot = (root: string, cwd: string[]): boolean => isAbsolute(root) && cwd.length > 0 && cwd.every(at => at !== "" && !outside(".", root, at));
/** One push refspec is an ordinary branch push: literal, unforced, a non-default branch that git cannot read as a tag or another ref type. */
function floorRefspec(spec: string, cwd: string[], floor: FloorFacts): boolean {
  if (!floor.defaultBranch || spec.startsWith("+") || spec.startsWith("-") || opaque(spec)) return false;
  const parts = spec.split(":");
  if (parts.length > 2 || parts.some(part => part === "")) return false;       // `:branch` deletes, and `x:` or `a:b:c` is no refspec
  const [src, dst] = parts as [string, string | undefined];
  const target = dst ?? src;
  const names: Array<{ name: string; qualified: boolean }> = [];
  if (dst === undefined && src === "HEAD") {
    for (const at of cwd) { const branch = floor.currentBranch?.(at); if (!branch) return false; names.push({ name: branch, qualified: true }); }
  } else {
    const qualified = target.startsWith("refs/heads/");
    if (target.startsWith("refs/") && !qualified) return false;                 // refs/tags/, refs/notes/, refs/pull/ ...
    names.push({ name: qualified ? target.slice("refs/heads/".length) : target, qualified });
  }
  for (const { name, qualified } of names) {
    if (!plainBranch(name) || isDefaultBranch(name, floor)) return false;
    if (qualified) continue;
    // Git reads `heads/main` as refs/heads/main and `tags/v1` as a tag, and a bare name that is also a tag is ambiguous: only a proven non-tag passes.
    if (["heads", "tags", "remotes", "refs"].includes(name.split("/")[0]!)) return false;
    if (cwd.some(at => floor.refIsTag?.(name, at) !== false)) return false;
  }
  // `src:dst` with an unqualified dst takes its type from src: a source that may be a tag would push a tag. A qualified source is the ref it names (`refs/tags/v1` is a tag, never probed
  // as a branch called `refs/tags/v1`), and a bare source with a ref-type prefix (`tags/v1`, `heads/x`, `remotes/...`) is not a plain branch name either.
  if (dst !== undefined && src !== "HEAD" && (!dst.startsWith("refs/") || src.startsWith("refs/"))) {
    if (src.startsWith("refs/")) { if (!src.startsWith("refs/heads/") || !plainBranch(src.slice("refs/heads/".length))) return false; }
    else if (!plainBranch(src) || ["heads", "tags", "remotes", "refs"].includes(src.split("/")[0]!) || cwd.some(at => floor.refIsTag?.(src, at) !== false)) return false;
  }
  return true;
}
/** `git push` the floor does not ask about: an unforced push of non-default branches to `origin`, from inside the execution root. */
function floorPush(globals: string[], args: string[], root: string, cwd: string[], floor: FloorFacts): boolean {
  if (!withinRoot(root, cwd) || cwd.some(at => floor.inOwnRepository?.(at) !== true || floor.pushIsOwn?.(at) !== true)) return false;
  let at = cwd;                                                                 // where git runs: `-C dir` moves it, and the tag and branch reads follow
  let moved = false;
  for (let i = 0; i < globals.length; i++) {
    const option = globals[i]!;
    if (["--no-pager", "-P", "-p", "--paginate", "--no-optional-locks"].includes(option)) continue;
    if (option !== "-C" || moved) return false;                                 // -c, --git-dir, --work-tree and the rest can point `origin` anywhere
    const dir = globals[++i];
    if (!dir || opaque(dir) || cwd.some(from => outside(dir, root, from))) return false;
    at = cwd.map(from => resolve(from, dir));
    if (at.some(where => floor.inOwnRepository?.(where) !== true || floor.pushIsOwn?.(where) !== true)) return false;   // `-C` into a nested clone reaches that clone's origin
    moved = true;
  }
  const operands: string[] = [];
  let literal = false;
  for (const arg of args) {
    if (opaque(arg)) return false;
    if (!literal && arg === "--") { literal = true; continue; }
    if (!literal && arg.startsWith("--")) { if (!FLOOR_PUSH_LONG.has(arg)) return false; continue; }
    if (!literal && /^-[^-]/.test(arg)) { if (![...arg.slice(1)].every(flag => FLOOR_PUSH_SHORT.includes(flag))) return false; continue; }
    operands.push(arg);
  }
  const [remote, ...specs] = operands;
  // A bare `git push` or `git push origin` follows push.default and may reach the default branch: it keeps asking.
  return remote === "origin" && specs.length > 0 && specs.every(spec => floorRefspec(spec, at, floor));
}
/**
 * The options of each `gh pr` subcommand the floor knows, with their arity: a value belongs to its option and never names a repository (a `--body` that holds a pull request URL is text, not a selector).
 * An option not listed here is unknown, and an unknown option keeps the call asking: it may take a value the floor would then misread as a positional or a selector.
 * `-R` and `--repo` are handled apart. Sources: `gh pr create|comment|review|merge --help`.
 */
const GH_PR_OPTIONS: Readonly<Record<string, { readonly flags: readonly string[]; readonly values: readonly string[] }>> = {
  comment: { flags: ["-e", "--editor", "-w", "--web", "--edit-last", "--delete-last", "--create-if-none", "--yes"], values: ["-b", "--body", "-F", "--body-file"] },
  create: { flags: ["-d", "--draft", "--dry-run", "-f", "--fill", "--fill-first", "--fill-verbose", "-w", "--web", "--no-maintainer-edit"],
    values: ["-a", "--assignee", "-B", "--base", "-b", "--body", "-F", "--body-file", "-H", "--head", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "-t", "--title", "--recover"] },
  review: { flags: ["-a", "--approve", "-c", "--comment", "-r", "--request-changes"], values: ["-b", "--body", "-F", "--body-file"] },
  merge: { flags: ["--auto", "-d", "--delete-branch", "--disable-auto", "-m", "--merge", "-r", "--rebase", "-s", "--squash"], values: ["-A", "--author-email", "-b", "--body", "-F", "--body-file", "--match-head-commit", "-t", "--subject"] },
};
/** `gh pr create|comment|review|merge` the floor does not ask about: the project's own repository, never an admin merge, never a foreign URL. */
function floorPullRequest(sub: string, args: string[], root: string, cwd: string[], floor: FloorFacts): boolean {
  const own = floor.repository?.toLowerCase(), options = GH_PR_OPTIONS[sub];
  if (!own || !options || !withinRoot(root, cwd) || cwd.some(at => floor.inOwnRepository?.(at) !== true)) return false;   // an unknown repository is not the project's own
  const sameRepository = (value: string | undefined): boolean => !!value && !opaque(value) && value.toLowerCase() === own;
  let explicit = false;                                                          // the call names the project's own repository itself, so gh's default and GH_REPO do not matter
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (opaque(arg) || arg === "--admin" || arg.startsWith("--admin=")) return false;
    if (arg === "-R" || arg === "--repo") { if (!sameRepository(args[++i])) return false; explicit = true; continue; }
    if (arg.startsWith("--repo=")) { if (!sameRepository(arg.slice("--repo=".length))) return false; explicit = true; continue; }
    if (/^-R./.test(arg)) { if (!sameRepository(arg.slice(2))) return false; explicit = true; continue; }
    if (arg.startsWith("-")) {
      const [name] = arg.split("=", 1) as [string], inline = arg.includes("=");
      if (options.values.includes(name)) {
        // The value is the option's: never a selector. But an expansion or a glob in it can become several words, one of them a real `-R`/`--repo`, so it is judged before it is skipped.
        const value = inline ? arg.slice(name.length + 1) : args[i + 1];
        if (value === undefined || opaque(value) || globby(value)) return false;
        if (!inline) i++;
        continue;
      }
      if (options.flags.includes(arg)) continue;
      return false;                                                                // `--`, a cluster, an option the floor does not know: unknown is strict
    }
    // A positional: a pull request number or branch, or a URL, which can be another repository's.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(arg)) {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[0-9]+\/?$/.exec(arg);
      if (!sameRepository(match?.[1])) return false;
      explicit = true;
    }
  }
  // With no selector gh picks its own default (`gh repo set-default`, another remote, GH_REPO): only a proven own default passes.
  return explicit || cwd.every(at => floor.ghDefaultIsOwn?.(at) === true);
}

/**
 * Commands that cannot change what the floor's facts were read from (git configuration, the checked-out branch, remotes, gh's default repository, the environment). A command
 * earlier on the same line that is anything else ends the floor for the rest of that line: the facts were read before it ran.
 */
const FLOOR_INERT_GIT = new Set(["add", "commit", "status", "diff", "log", "show", "rm", "mv", "blame", "ls-files", "rev-parse", "describe", "shortlog"]);
/** Every `find` primary that writes a file or runs a command: `-fprintf` and the other `-f*` actions create or truncate a named file (`.git/config` included), the `-exec` family runs code, `-delete` removes. */
const FIND_WRITERS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
/**
 * A glob character: the shell may expand an unquoted one into several words, so the value is not the one it looks like.
 * ponytail: the tokenizer drops quote state, so a quoted `--body "why?"` or a markdown `* item` is judged like an unquoted glob and asks. Ceiling: a prose body with `*`, `?` or `[`
 * asks even where the shell would not expand it. Upgrade path: have `commands` mark a word that held an unquoted glob character, then test that mark here.
 */
const globby = (word: string): boolean => /[*?[]/.test(word);
const FLOOR_INERT_PROGRAMS = new Set(["echo", "printf", "true", "false", ":", "ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep", "test", "[", "sleep", "cd", "diff", "stat", "file", "tree", "find"]);
function floorInert(command: Command, root: string, cwd: string[], floor: FloorFacts): boolean {
  if (command.outputs.length > 0 || command.redirected || command.nested?.length) return false;   // any redirect may write .git/config (`>>` is not an output of the destroy rule); a substitution runs commands of its own
  if (unwrapped(command.words).length !== command.words.length) return false;   // `env X=1 ...`, `sudo`, `VAR=x cmd`
  const [name, ...args] = command.words;
  if (!name || opaque(name) || command.words.some(opaque)) return false;
  const program = basename(name);
  if (program === "git") {
    const heads = commandHeads(args, ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"], ["-P", "-p", "--no-pager", "--paginate", "--literal-pathspecs", "--bare", "--no-optional-locks", "--no-replace-objects"], ["push"]);
    if (heads.length !== 1 || args.includes("-c") || args.some(arg => arg.startsWith("--config-env"))) return false;
    // A push the floor itself lets through only writes remote refs and, with `-u`, this branch's upstream: none of what the floor reads (push destination, tag and push settings, the default repository).
    if (heads[0]!.name === "push") return floorPush(args.slice(0, args.length - heads[0]!.args.length - 1), heads[0]!.args, root, cwd, floor);
    return FLOOR_INERT_GIT.has(heads[0]!.name);
  }
  return FLOOR_INERT_PROGRAMS.has(program) && !(program === "find" && args.some(arg => FIND_WRITERS.has(arg) || /^-f(?:print|ls)/.test(arg))) && !(program === "rg" && args.some(arg => arg === "--pre" || arg.startsWith("--pre=")));
}

function sequence(parsed: Command[], root: string, initial: string[], found: Set<ActionClass>, depth = 0, floor?: FloorFacts): void {
  const cwd = new Set(initial);
  let facts = floor;
  for (const command of parsed) {
    classify(command, root, [...cwd], found, depth, facts);
    if (facts && !floorInert(command, root, [...cwd], facts)) facts = undefined;
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
function classify(command: Command, root: string, cwd: string[], found: Set<ActionClass>, depth = 0, floor?: FloorFacts): void {
  for (const group of command.nested ?? []) sequence(group, root, cwd, found, depth, floor);   // a substitution's own cwd state; only its classes come back
  // The floor applies only to a bare command: `env X=1 git push`, `GIT_SSH_COMMAND=... git push`, `sudo`, `timeout`, `if` and the other wrappers `unwrapped` peels can redirect or re-time a push the floor cannot read.
  const bare = floor !== undefined && unwrapped(command.words).length === command.words.length;
  const words = unwrapped(command.words);
  const program = basename(words.shift() ?? "");
  if (["sh", "bash", "zsh"].includes(program) && depth < 2) {
    const shell = [...words];
    while (["--noprofile", "--norc"].includes(shell[0] ?? "")) shell.shift();
    const mode = shell.shift();
    if (mode && /^-[A-Za-z]*c[A-Za-z]*$/.test(mode)) {
      if (shell[0] === "--") shell.shift();
      const nested = shell[0] === undefined ? undefined : commands(shell[0].replaceAll(OPAQUE, "$_"));
      // A wrapped shell (`env GH_REPO=x sh -c '...'`) runs its text under whatever the wrapper set: the floor's authority does not reach inside it.
      if (nested) sequence(nested, root, cwd, found, depth + 1, bare ? floor : undefined);
    }
  }
  if (command.outputs.some(p => cwd.some(at => outside(p, root, at)))) found.add("destroy");
  if (program === "git") {
    const heads = commandHeads(words, ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"],
      ["-P", "-p", "--no-pager", "--paginate", "--literal-pathspecs", "--bare", "--no-optional-locks", "--no-replace-objects"], ["push", "reset", "clean", "branch"]);
    if (heads.some(head => opaque(head.name))) { found.add("publish"); found.add("destroy"); }   // `git $CMD`: the strictest classes git reaches (#762)
    for (const { name: sub, args } of heads) {
      if (sub === "push" && !(bare && floorPush(words.slice(0, words.length - args.length - 1), args, root, cwd, floor!))) found.add("publish");
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
    if (["issue", "pr", "gist"].includes(words[0] ?? "") && ["create", "comment", "edit", "close", "reopen", "merge", "review", "delete"].includes(words[1] ?? "")) {
      // Floor: a pull request in the project's own repository is ordinary work. Issues, gists, edits, closes and deletes keep asking.
      const ordinary = bare && words[0] === "pr" && ["create", "comment", "review", "merge"].includes(words[1]!) && floorPullRequest(words[1]!, words.slice(2), root, cwd, floor!);
      if (!ordinary) found.add("external-write");
    }
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
export function classifyAction(tool: string, args: unknown, executionRoot: string, floor?: FloorFacts): ActionClass[] {
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
  if (tool.toLowerCase() === "git" && boundedArgv(input.args)) classify({ words: ["git", ...input.args], outputs: [] }, executionRoot, [cwd], found, 0, floor);
  if (SHELL_TOOLS.has(tool.toLowerCase())) {
    const raw = input.command ?? input.cmd;
    if (typeof raw === "string") {
      const parsed = commands(raw);
      if (parsed) sequence(parsed, executionRoot, [cwd], found, 0, floor);
    } else if (boundedArgv(raw)) {
      classify({ words: raw, outputs: [] }, executionRoot, [cwd], found, 0, floor);
    }
  }
  return ACTION_CLASSES.filter(value => found.has(value));
}
