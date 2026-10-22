/**
 * Strip parentheses and arguments from a plan symbol name.
 * Section and source keys (`section ...`, `source ...`) are preserved unchanged.
 */
export function normalizePlanSymbol(name: string): string {
  if (typeof name !== "string") return "";
  if (name.startsWith("section ") || name.startsWith("source ")) return name;
  return name.replace(/\s*\(.*$/, "").trim();
}

/**
 * Compare two plan symbols for overlap (#682 phase 1b).
 * - Section and source keys must match exactly.
 * - Otherwise, names are compared by their last segment; when both names are qualified
 *   (e.g. `A.run` vs `B.run`), the qualifiers must match as well.
 */
export function symbolsOverlap(left: string, right: string): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.startsWith("section ") || left.startsWith("source ") || right.startsWith("section ") || right.startsWith("source ")) {
    return left === right;
  }
  const a = normalizePlanSymbol(left);
  const b = normalizePlanSymbol(right);
  if (!a || !b) return false;
  return a.includes(".") && b.includes(".") ? a === b : a.split(".").at(-1) === b.split(".").at(-1);
}
