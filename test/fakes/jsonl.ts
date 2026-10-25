// A fake writes its call log a moment after creating the file, and a last line
// can be read mid-write. The piece after the final "\n" is "" or unfinished,
// so it is dropped; only whole lines are parsed.
export function completeJsonLines(text: string): unknown[] {
  const lines = text.split("\n");
  lines.pop();
  return lines.filter((line) => line !== "").map((line) => JSON.parse(line));
}
