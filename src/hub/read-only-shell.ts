/** Lexical data only. A successful parse grants no permission and proves no program read-only. */
export interface SimpleShellWords {
  words: readonly string[];
  /** Syntax-looking characters survived as quoted/escaped data; the grant policy must decide whether to accept them. */
  quotedMeta: boolean;
}
export const READ_ONLY_SHELL_LIMITS = { characters: 4000, words: 128 } as const;
const ACTIVE = ";|&<>`$(){}*?[]~#";

/** One bounded literal command, without active operators or expansion. Never executes or resolves any word. */
export function parseSimpleShell(command: unknown): SimpleShellWords | undefined {
  if (typeof command !== "string" || command.length > READ_ONLY_SHELL_LIMITS.characters
    || command.includes("\n") || command.includes("\r") || command.includes("\0")) return undefined;
  const words: string[] = [];
  let word = "", started = false, quote: "" | "'" | '"' = "", quotedMeta = false;
  const append = (character: string, literal = false) => {
    word += character;
    started = true;
    if (literal && (ACTIVE.includes(character) || character === "\\")) quotedMeta = true;
  };
  const finish = () => {
    if (!started) return true;
    words.push(word);
    word = ""; started = false;
    return words.length <= READ_ONLY_SHELL_LIMITS.words;
  };
  for (let i = 0; i < command.length; i++) {
    const character = command[i]!;
    if (quote === "'") {
      if (character === "'") quote = "";
      else append(character, true);
      continue;
    }
    if (quote === '"') {
      if (character === '"') { quote = ""; continue; }
      if (character === "$" || character === "`") return undefined;
      if (character === "\\") {
        const next = command[i + 1];
        if (next === undefined) return undefined;
        // Inside Bash double quotes, other backslashes remain literal bytes.
        if (next === "$" || next === "`" || next === '"' || next === "\\") { append(next, true); i++; }
        else append(character, true);
      } else append(character, true);
      continue;
    }
    if (character === " " || character === "\t") { if (!finish()) return undefined; continue; }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (character === "\\") {
      const next = command[++i];
      if (next === undefined) return undefined;
      append(next, true);
      continue;
    }
    if (ACTIVE.includes(character)) return undefined;
    append(character);
  }
  if (quote || !finish() || !words.length) return undefined;
  if (/^[A-Za-z_][A-Za-z0-9_]*[+]?=/.test(words[0]!)) return undefined;
  return { words, quotedMeta };
}
