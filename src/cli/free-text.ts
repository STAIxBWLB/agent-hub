/** Validate option-like tokens without discarding message text before the separator. */
export function freeText(words: string[], usage: string): string {
  const end = words.indexOf("--");
  const before = end === -1 ? words : words.slice(0, end);
  const flag = before.find((a) => a.startsWith("--"));
  if (flag) throw new Error(`the message would absorb the flag "${flag}"; put it after "--" to send it as text; usage: ${usage}`);
  return (end === -1 ? words : [...before, ...words.slice(end + 1)]).join(" ");
}

/**
 * #1433: the first word of a write command's free text that reads as an option the command does not know: it starts with `--`, or is `-h`. Words after a lone `--` are text, as in `freeText`.
 * A command that takes its flags out first passes what is left.
 */
export function unknownOption(words: readonly string[]): string | undefined {
  const end = words.indexOf("--");
  return (end === -1 ? words : words.slice(0, end)).find(word => word.startsWith("--") || word === "-h");
}

/** The text words with the lone `--` separator removed. */
export function withoutSeparator(words: readonly string[]): string[] {
  const end = words.indexOf("--");
  return end === -1 ? [...words] : [...words.slice(0, end), ...words.slice(end + 1)];
}

/** The refusal for an option-like word where a write command wanted text, said before anything is filed. */
export function unknownOptionRefusal(word: string, command: string, usage: string | undefined): string {
  return `unknown option ${JSON.stringify(word)} for ${command}; nothing was filed. Put "--" before text that starts with dashes${usage ? `. Usage: ${usage}` : ""}`;
}
