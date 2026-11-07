// #1268, #1273: the generated facts of the docs (version, install tag, Bun floor, pins) rendered between `<!-- facts:<name> -->` and `<!-- /facts:<name> -->`. One renderer, two callers:
// scripts/readme-facts.ts (the gate's check and `--write`) and release-prepare (which renders the blocks after the version bump so a release PR passes the gate with no manual step).
// Pure: it reads through `read` and returns the new text of each file, so a caller decides what to write.

/** The files that carry blocks. A listed file that does not exist is an error, never skipped: a moved README would otherwise stop being checked. */
export const FACT_FILES = ["README.md", "CONTRIBUTING.md", "docs/quickstart.md", "docs/operations.md"] as const;
const BLOCK = /<!-- facts:([a-z-]+) -->([\s\S]*?)<!-- \/facts:([a-z-]+) -->/g;

export interface FactSources { packageJson: string; bunVersion: string }
export interface FactDrift { file: string; name: string; found: string; wanted: string }
export interface RenderedFacts {
  /** The new text of every file whose blocks changed. */
  files: Record<string, string>;
  /** One entry per block that read something other than its source, in file order. */
  drift: FactDrift[];
  errors: string[];
}

/** The fact values, or the reason they cannot be read. */
export function factValues(sources: FactSources): { facts: Record<string, string> } | { error: string } {
  let pkg: { version?: string; engines?: { bun?: string }; dependencies?: Record<string, string> };
  try { pkg = JSON.parse(sources.packageJson); } catch { return { error: "package.json is not valid JSON" }; }
  const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(pkg.engines?.bun ?? "")?.[1], memoryPin = pkg.dependencies?.["@staix/agent-mem"];
  if (!floor || !memoryPin || !pkg.version) return { error: "package.json needs a version, engines.bun as `>=x.y.z` and an exact @staix/agent-mem dependency" };
  return { facts: {
    "bun-floor": floor,
    "bun-pinned": sources.bunVersion.trim(),
    "agent-mem-pin": memoryPin,
    "install-tag": `\n\`\`\`bash\nbun add -g github:STAIxBWLB/agent-hub#v${pkg.version}\nahub setup\n\`\`\`\n`,
  } };
}

/**
 * Renders every block of `files` from `sources`. `read` returns a file's text, or undefined when it does not exist.
 * `tolerant` (release-prepare, which runs in any checkout it is pointed at): a missing file is skipped and a checkout with no block at all renders nothing and is not an error. The gate (scripts/readme-facts.ts)
 * is strict, so a moved file or a lost block still fails there.
 */
export function renderFacts(read: (path: string) => string | undefined, sources: FactSources, files: readonly string[] = FACT_FILES, options: { tolerant?: boolean } = {}): RenderedFacts {
  const out: RenderedFacts = { files: {}, drift: [], errors: [] };
  if (options.tolerant && !files.some(file => /<!-- facts:[a-z-]+ -->/.test(read(file) ?? ""))) return out;
  const values = factValues(sources);
  if ("error" in values) { out.errors.push(values.error); return out; }
  const used = new Set<string>();
  for (const file of files) {
    const text = read(file);
    if (text === undefined) { if (!options.tolerant) out.errors.push(`${file} does not exist: restore it or drop it from FACT_FILES in scripts/lib/readme-facts.ts`); continue; }
    const next = text.replace(BLOCK, (block, name: string, body: string, close: string) => {
      const fact = values.facts[name];
      if (close !== name || fact === undefined) { out.errors.push(`${file}: block ${name} is unknown or closed as ${close}`); return block; }
      used.add(name);
      if (body !== fact) out.drift.push({ file, name, found: body.trim(), wanted: fact.trim() });
      return `<!-- facts:${name} -->${fact}<!-- /facts:${name} -->`;
    });
    if (next !== text) out.files[file] = next;
  }
  if (!options.tolerant) for (const name of Object.keys(values.facts)) if (!used.has(name)) out.errors.push(`facts:${name} is rendered nowhere: restore its block or drop it from factValues in scripts/lib/readme-facts.ts`);
  return out;
}
