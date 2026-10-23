/** What a number is (#285 AC6): the provider's own ratio, tokens the hub counted against a ceiling a person set, or a value a person fed. */
export type WindowKind = "native" | "count" | "manual";
export interface KindedWindow { id: string; source?: string; kind?: WindowKind }
/**
 * The one place a window is classified. A reader that names its kind wins; an untagged window is the hub count when it is the `tokens` window,
 * a person's when its source is `ahub budget set`, and the provider's otherwise.
 */
export function windowKind(w: KindedWindow): WindowKind {
  if (w.kind) return w.kind;
  if (w.id === "tokens") return "count";
  if (w.source === "ahub budget set") return "manual";
  return "native";
}
