import { HUB, type Envelope } from "./envelope.ts";
import { detectSignals, type Routing } from "./routing.ts";
import { matchesPolicy } from "./path-policy.ts";
import { looksSecret, type PromotionScreen } from "@staix/agent-mem";
import { nodePath, pathCandidates } from "@staix/agent-mem";

/**
 * Whether a note is about a path the `pii.paths` policy makes private: a stored node's path, a path-like word of its
 * text, or, for a policy entry with no glob that a word split cannot find (a space in it), that entry written out.
 */
export function mentionsPrivatePath(text: string, about: string[], policy: string[], cwd: string): boolean {
  if (!policy.length) return false;
  const nfc = (v: string) => v.normalize("NFC"), body = nfc(text), entries = policy.map(nfc);
  const paths = [...about.map(nodePath), ...pathCandidates(body)].filter((p): p is string => p !== undefined).map(nfc);
  if (paths.some((p) => matchesPolicy(cwd, p, entries, true))) return true;
  // The entry's literal part (up to its first glob character) written out: catches a path a word split breaks (a space).
  return entries.some((entry) => { const lit = entry.replace(/^\.\//, "").split(/[*?[\]{}]/)[0]!.replace(/\/+$/, ""); return /[/\s]/.test(lit) && body.includes(lit); });
}

/**
 * Notes whose title, text, nodes, task key or project key match the PII patterns of `routing`, or that are about a path
 * the project's `pii.paths` (`policy`) makes private, left out: what may go to a model.
 */
export function withoutPii<T extends { title: string | null; text: string; about?: string[]; task?: string | null; project?: string }>(notes: T[], routing: Routing, cwd: string, policy: string[] = []): T[] {
  // A task key's `#<id>@<created ms>` is the hub's own numbers, not note content: a digit-run pattern must not withhold a
  // clean note for it. The project part of the key stays screened.
  const keyText = (k: string) => k.replace(/#\d+(?:@\d+)?$/, "");
  return notes.filter((v) => !mentionsPrivatePath(`${v.title ?? ""}\n${v.text}`, v.about ?? [], policy, cwd) && !detectSignals({ title: v.title ?? "",
    detail: [v.text, ...(v.about ?? []).map((n) => n.startsWith("task:") ? keyText(n) : n), keyText(v.task ?? ""), v.project ?? ""].join("\n"), refs: {} }, routing, cwd).includes("pii"));
}

/**
 * The promotion screen for one project: another project's notes are left to that project's own processes; this one's
 * move only when no secret, PII pattern or private path (`policy()`, read when asked) is in them.
 */
export function promotionScreen(project: string, cwd: string, routing: () => Routing, policy: () => string[], taskPaths: (task: string) => string[] = () => []): PromotionScreen {
  return (v) => {
    if (v.project !== project) return "skip";
    // The task's current paths too, with no denylist: a path the note's own nodes leave out is still checked.
    const screened = { ...v, about: [...v.about, ...(v.task ? taskPaths(v.task) : []).map((p) => `path:${p}`)] };
    return looksSecret(`${v.title ?? ""}\n${v.text}`) || !withoutPii([screened], routing(), cwd, policy()).length ? "keep" : "promote";
  };
}


/** Host-only review capsules retain bodies for recipients, never observer sinks or capture. */
export function isTrustedReviewPackage(env: Envelope): boolean {
  return env.from === HUB && env.kind === "review" && typeof env.refs?.reviewPackage === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(env.refs.reviewPackage);
}

/** Only structured review carriers are excluded; ordinary review tool capture stays unchanged. */
export function reviewCaptureExcluded(tool: string, args: string): boolean {
  const name = tool.replace(/^mcp__[^ ]+__/, "");
  if (["review_comment_put", "review_comment_delete", "review_comment_send", "review_blob"].includes(name)) return true;
  if (name !== "hub_review") return false;
  try {
    const input: unknown = JSON.parse(args);
    return !!input && typeof input === "object" && "findings" in input && Array.isArray(input.findings)
      && input.findings.some(finding => !!finding && typeof finding === "object" && Object.hasOwn(finding, "anchor"));
  } catch { return false; }
}


/** reviewResponse is stamped by Bus from delivered-parent provenance, never peer refs. */
export function isReviewObserverExcluded(env: Envelope): boolean {
  return isTrustedReviewPackage(env) || env.from !== HUB && env.from !== "user" && (env.kind === "chat" || env.kind === "status")
    && typeof env.refs?.reviewResponse === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(env.refs.reviewResponse);
}
