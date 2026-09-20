/** Validate option-like tokens without discarding message text before the separator. */
export function freeText(words: string[], usage: string): string {
  const end = words.indexOf("--");
  const before = end === -1 ? words : words.slice(0, end);
  const flag = before.find((a) => a.startsWith("--"));
  if (flag) throw new Error(`the message would absorb the flag "${flag}"; put it after "--" to send it as text; usage: ${usage}`);
  return (end === -1 ? words : [...before, ...words.slice(end + 1)]).join(" ");
}
