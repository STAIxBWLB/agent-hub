/** Bounded Markdown [@key] and BibTeX entry-key example check, no fetching or model verdict. */
export function citationKeys(markdown: string, bibliography: string): { cited: string[]; missing: string[] } {
  if (Buffer.byteLength(markdown) > 256 * 1024 || Buffer.byteLength(bibliography) > 4 * 1024 * 1024) throw new Error("citation inputs exceed example check limits");
  const known = new Set([...bibliography.matchAll(/@[a-zA-Z]+\s*\{\s*([^,\s{}]+)\s*,/g)].map(m => m[1]!));
  const cited = [...new Set([...markdown.matchAll(/\[@[A-Za-z0-9_:./-]+(?:\s*;\s*@[A-Za-z0-9_:./-]+)*\]/g)].flatMap(m => [...m[0].matchAll(/@([A-Za-z0-9_:./-]+)/g)].map(k => k[1]!)))].sort();
  return { cited, missing: cited.filter(key => !known.has(key)) };
}
