interface Token { kind: "word" | "string" | "punct"; value: string }
const forbiddenNames = new Set(["require", "createRequire", "eval", "Function"]);
const globalNames = new Set(["globalThis", "global", "self", "window"]);
const regexAfterWords = new Set(["return", "throw", "case", "delete", "typeof", "void", "yield", "await", "in", "of", "else", "do"]);
const regexAfterPunctuation = new Set(["=", "(", "[", "{", ":", ",", ";", "!", "?", "&&", "||", "??", "=>", "+", "-", "*", "%", "&", "|", "^", "~", "<", ">"]);
const fail = (): never => { throw new Error("external adapter: module source scan refused (details withheld)"); };

/** Lex normalized JS, retaining literal tokens only for direct computed global/member access. */
function tokensOf(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const controlParens: boolean[] = [];
  let regexAllowed = true;
  const push = (kind: Token["kind"], value: string) => {
    const previous = tokens.at(-1);
    if (kind === "punct" && value === "(") controlParens.push(previous?.kind === "word" && ["if", "while", "for", "with", "switch", "catch"].includes(previous.value));
    const controlEnd = kind === "punct" && value === ")" ? controlParens.pop() === true : false;
    tokens.push({ kind, value });
    regexAllowed = controlEnd || (kind === "word" ? regexAfterWords.has(value) : kind === "punct" && regexAfterPunctuation.has(value));
  };
  const wordStart = (char: string) => /[$_\p{ID_Start}]/u.test(char);
  const wordPart = (char: string) => /[$_\p{ID_Continue}]/u.test(char);
  const quoted = (quote: string) => {
    index++;
    let value = "";
    while (index < source.length) {
      const char = source[index++]!;
      if (char === quote) { push("string", value); return; }
      if (char === "\\") {
        const escaped = source[index++];
        // Unknown escapes are not a proof of a statically named member. Transform normally canonicalizes them.
        value += escaped === quote || escaped === "\\" ? escaped : "?";
      } else value += char;
    }
    fail();
  };
  const regex = () => {
    index++;
    let characterClass = false;
    while (index < source.length) {
      const char = source[index++]!;
      if (char === "\\") { index++; continue; }
      if (char === "[") characterClass = true;
      else if (char === "]") characterClass = false;
      else if (char === "/" && !characterClass) {
        while (index < source.length && /[a-z]/i.test(source[index]!)) index++;
        push("string", "");
        return;
      }
    }
    fail();
  };
  const template = (depth: number) => {
    if (depth > 128) fail();
    index++;
    let text = "";
    while (index < source.length) {
      const char = source[index]!;
      if (source.charCodeAt(index) === 96) { index++; push("string", text); return; }
      if (char === "\\") { index += 2; text += "?"; continue; }
      if (char === "$" && source[index + 1] === "{") {
        push("string", text); text = ""; index += 2;
        push("punct", "(");
        code(true, depth + 1);
        push("punct", ")");
      } else { text += char; index++; }
    }
    fail();
  };
  const code = (stopAtBrace: boolean, depth: number) => {
    if (depth > 128) fail();
    let braces = 0;
    while (index < source.length) {
      const char = source[index]!, next = source[index + 1];
      if (/\s/u.test(char)) { index++; continue; }
      if (char === "/" && next === "/") {
        index += 2; while (index < source.length && source[index] !== "\n") index++;
        continue;
      }
      if (char === "/" && next === "*") {
        const end = source.indexOf("*/", index + 2);
        if (end < 0) fail(); index = end + 2; continue;
      }
      if (char === "'" || char === '"') { quoted(char); continue; }
      if (source.charCodeAt(index) === 96) { template(depth + 1); continue; }
      if (char === "}" && stopAtBrace && braces === 0) { index++; return; }
      if (char === "{") braces++;
      if (char === "}") braces--;
      if (char === "/" && regexAllowed) { regex(); continue; }
      if (wordStart(char)) {
        const start = index++;
        while (index < source.length && wordPart(source[index]!)) index++;
        push("word", source.slice(start, index)); continue;
      }
      const pair = char + (next ?? "");
      if (["=>", "&&", "||", "??", "++", "--", "?."].includes(pair)) { push("punct", pair); index += 2; }
      else { push("punct", char); index++; }
    }
    if (stopAtBrace) fail();
  };
  code(false, 0);
  return tokens;
}

/**
 * Conservative ESM dependency/code-loading inspection, not a sandbox or proof against obfuscated privileged code.
 * Literal messages/comments are inert. Direct code-loading names are refused even when aliased or shadowed.
 */
export function scanModuleSource(source: string): readonly Bun.Import[] {
  try {
    const transpiler = new Bun.Transpiler({ loader: "js", minifyWhitespace: true });
    const imports = transpiler.scanImports(source);
    if (imports.some(record => ["dynamic-import", "require-call", "require-resolve"].includes(record.kind))) fail();
    const tokens = tokensOf(transpiler.transformSync(source));
    for (const [index, token] of tokens.entries()) {
      if (token.kind === "word" && forbiddenNames.has(token.value)) fail();
      if (token.kind === "word" && token.value === "import" && tokens[index + 1]?.value === "(") fail();
      if (token.kind === "string" && forbiddenNames.has(token.value) && tokens[index - 1]?.value === "[" && tokens[index + 1]?.value === "]") {
        const owner = tokens[index - 2];
        const importMeta = owner?.value === "meta" && tokens[index - 3]?.value === "." && tokens[index - 4]?.value === "import";
        if (owner?.kind === "word" && globalNames.has(owner.value) || importMeta) fail();
      }
    }
    return Object.freeze(imports.map(record => Object.freeze({ ...record })));
  } catch { return fail(); }
}
