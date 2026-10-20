import { HELP } from "./help.ts";

/** An option's value: a fixed list, a path, free text, or none (a flag). */
type Value = readonly string[] | "path" | "text" | null;
interface Node { children: Set<string>; options: Map<string, Value>; equals: Set<string> }

/** Printed instead of candidates when the shell should complete file names. */
export const FILES = "__files__";
const WORD = /^[a-z][a-z0-9-]*$/;
const ALTERNATION = /^[a-z][a-z0-9-]*(\|[a-z][a-z0-9-]*)*$/;

/** Split at spaces outside brackets; a bracket group stays one token. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let depth = 0, current = "";
  for (const ch of text) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === " " && depth === 0) { if (current) out.push(current); current = ""; } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** Split at ` | ` outside brackets: `ahub sdlc status [task] | explain <task>` has two alternatives. */
function alternatives(text: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") depth++;
    if (text[i] === "]") depth--;
    if (depth === 0 && text.startsWith(" | ", i)) { out.push(text.slice(start, i)); start = i + 3; i += 2; }
  }
  return [...out, text.slice(start)];
}

/**
 * A value spec: `a|b|<iso>` offers the literals a and b; an upper-case word (`N`) is a placeholder. Inside angle
 * brackets the words are placeholders (`<path|id>` is a path, `<id|node>` free text), except a list of three or more
 * (`<blue|teal|violet|ochre>`) and the keywords none and inherit.
 */
// ponytail: the keyword list is what help uses today; a new keyword inside <> needs adding here.
function value(spec: string): Value {
  if (spec.startsWith("<")) {
    const parts = spec.slice(1, -1).split("|");
    if (parts.length >= 3) return parts;
    if (/path|dir|file/.test(spec)) return "path";
    const keywords = parts.filter(part => part === "none" || part === "inherit");
    return keywords.length ? keywords : "text";
  }
  const literal = spec.split("|").filter(part => /^[a-z0-9][\w.-]*$/.test(part));
  if (literal.length) return literal;
  return /path|dir|file/.test(spec) ? "path" : "text";
}

/** Options in a token group: `--flag`, `--name <value>`, `--name a|b`, `--name=a|b`; a group never lends its value to another. */
function options(group: string[], into: Node): void {
  for (let i = 0; i < group.length; i++) {
    const token = group[i]!;
    if (token.startsWith("[")) { options(tokens(token.slice(1, -1)), into); continue; }
    const eq = /^(--?[a-zA-Z][\w-]*)=(.+)$/.exec(token);
    if (eq) { into.options.set(eq[1]!, value(eq[2]!)); into.equals.add(eq[1]!); continue; }
    if (!/^--?[a-zA-Z][\w-]*$/.test(token)) continue;
    const next = group[i + 1];
    if (next !== undefined && !next.startsWith("-") && !next.startsWith("[") && next !== "|") { into.options.set(token, value(next)); i++; }
    else if (!into.options.has(token)) into.options.set(token, null);
  }
}

let table: Map<string, Node> | undefined;
/** The completion table, read from the `ahub help` entries so it cannot drift from what help documents. */
export function completionTable(): Map<string, Node> {
  if (table) return table;
  const nodes = new Map<string, Node>();
  const node = (path: readonly string[]) => {
    const key = path.join(" ");
    let found = nodes.get(key);
    if (!found) { found = { children: new Set(), options: new Map(), equals: new Set() }; nodes.set(key, found); }
    if (path.length) node(path.slice(0, -1)).children.add(path.at(-1)!);
    return found;
  };
  const root = node([]);
  root.options.set("--project", "path").set("--live-test", null).set("--help", null).set("-h", null);
  for (const { usage } of HELP) {
    if (usage.includes("<command>")) continue; // the global --project and --live-test forms, set above
    let parent: string[] = [];
    alternatives(usage.replace(/^ahub /, "")).forEach((alt, index) => {
      const parts = tokens(alt);
      if (parts[0]?.startsWith("-")) { options(parts, index ? node(parent.slice(0, -1)) : root); return; }
      let prefixes: string[][] = [index ? parent.slice(0, -1) : []];
      let i = 0;
      for (; i < parts.length && ALTERNATION.test(parts[i]!); i++) prefixes = prefixes.flatMap(prefix => parts[i]!.split("|").map(word => [...prefix, word]));
      const sub = parts[i]?.match(/^\[([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)+)\]$/);
      for (const path of prefixes) {
        const target = node(path);
        if (sub) for (const word of sub[1]!.split("|")) node([...path, word]);
        options(parts.slice(i), target);
      }
      parent = prefixes[0]!;
    });
  }
  return (table = nodes);
}

/** Candidates for the last word, given every word after `ahub`. Static: no daemon, project or network. */
export function completeWords(words: readonly string[]): string[] {
  const nodes = completionTable(), root = nodes.get("")!;
  const cur = words.at(-1) ?? "";
  const path: string[] = [];
  let pending: Value | undefined;
  let positional = false; // after a positional argument no subcommand can follow
  const optionOf = (name: string) => nodes.get(path.join(" "))?.options.get(name) ?? root.options.get(name);
  for (const word of words.slice(0, -1)) {
    if (pending !== undefined) { pending = undefined; continue; }
    if (word.startsWith("-")) { const kind = optionOf(word); if (kind && !word.includes("=")) pending = kind; continue; }
    if (!positional && nodes.get(path.join(" "))?.children.has(word)) path.push(word);
    else positional = true;
  }
  const values = (kind: Value, prefix = "") => kind === "path" ? [FILES] : Array.isArray(kind) ? kind.map(v => prefix + v) : [];
  if (pending !== undefined) return values(pending).filter(v => v === FILES || v.startsWith(cur));
  const eq = /^(--?[\w-]+)=/.exec(cur);
  if (eq) return values(optionOf(eq[1]!) ?? null, eq[0]).filter(v => v === FILES || v.startsWith(cur));
  const here = nodes.get(path.join(" "))!;
  // An option documented as `--name=value` is offered as `--name=`; the shell adds no space after it.
  const opts = [...new Set([...here.options.keys(), ...(path.length ? [] : root.options.keys())])].map(o => here.equals.has(o) ? `${o}=` : o);
  const children = positional ? [] : [...here.children];
  const candidates = cur.startsWith("-") ? opts : [...children, ...(cur && children.length ? [] : opts)];
  const matched = candidates.filter(c => c.startsWith(cur)).sort();
  return matched.length || cur.startsWith("-") || children.length ? matched : [FILES];
}

const SCRIPTS: Record<string, string> = {
  zsh: `#compdef ahub
# ahub zsh completion: candidates come from \`ahub __complete\`, read from ahub's own help entries.
_ahub() {
  local -a c
  c=("\${(@f)$(ahub __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  c=(\${c:#})
  if [[ "\${c[1]}" == ${FILES} ]]; then _files; return; fi
  compadd -Q -S '' -- \${(M)c:#*=}
  compadd -Q -- \${c:#*=}
}
compdef _ahub ahub
`,
  bash: `# ahub bash completion: candidates come from \`ahub __complete\`, read from ahub's own help entries.
_ahub() {
  local IFS=$'\\n' cur=\${COMP_WORDS[COMP_CWORD]}
  local c=($(ahub __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
  if [ "\${c[0]}" = ${FILES} ]; then COMPREPLY=($(compgen -f -- "$cur")); else COMPREPLY=("\${c[@]}"); fi
  case "\${COMPREPLY[*]}" in *=) compopt -o nospace 2>/dev/null ;; esac
}
complete -o default -F _ahub ahub
`,
  fish: `# ahub fish completion: candidates come from \`ahub __complete\`, read from ahub's own help entries.
function __ahub_complete
    set -l cur (commandline -ct)
    # "$cur" keeps an empty current word as an argument: Tab after a space completes the next word
    set -l out (ahub __complete -- (commandline -opc)[2..-1] "$cur" 2>/dev/null)
    if test "$out[1]" = ${FILES}
        __fish_complete_path (commandline -ct)
    else
        printf '%s\\n' $out
    end
end
complete -c ahub -f -a '(__ahub_complete)'
`,
};

export const COMPLETION_SHELLS = Object.keys(SCRIPTS);
/** The script for one shell, or undefined for a shell ahub does not support. */
export function completionScript(shell: string | undefined): string | undefined {
  return shell === undefined ? undefined : SCRIPTS[shell];
}
