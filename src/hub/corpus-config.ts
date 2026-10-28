// agent-hub #510 (hub task #331): the `corpus` config block. Pure on purpose: it is read by the config schema, which the Claude channel bundle reaches, so it
// imports nothing that touches the file system. The index and the vault refusal are in `corpus.ts`.

export const MAX_CORPUS_ROOTS = 16;
export const MAX_CORPUS_PATH_CHARS = 1024;

export interface CorpusConfig { paths: string[] }

/** Why a path is not accepted, or undefined. A path is absolute or project-relative; `~` is never expanded, so what the person typed is what is read. */
export function corpusPathProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return "a corpus path is a non-empty string";
  if (value.length > MAX_CORPUS_PATH_CHARS) return `a corpus path is at most ${MAX_CORPUS_PATH_CHARS} characters`;
  if (/[\x00-\x1f\x7f]/.test(value)) return "a corpus path has no control characters";
  if (value.startsWith("~")) return "write the absolute path: ~ is not expanded";
  if (value !== value.trim()) return "a corpus path has no leading or trailing spaces";
  return undefined;
}

/** The checked block. `corpus.paths` names read-only folders of plain notes; nothing here reads the disk (the vault check does, per index refresh). */
export function corpusConfig(input: unknown): CorpusConfig {
  if (input === undefined) return { paths: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("corpus must be an object");
  const block = input as Record<string, unknown>;
  for (const key of Object.keys(block)) if (key !== "paths") throw new Error(`corpus.${key}: unknown key`);
  if (block.paths === undefined) return { paths: [] };
  if (!Array.isArray(block.paths) || block.paths.length > MAX_CORPUS_ROOTS) throw new Error(`corpus.paths takes a list of at most ${MAX_CORPUS_ROOTS} folders`);
  const out: string[] = [];
  block.paths.forEach((path, index) => {
    const problem = corpusPathProblem(path);
    if (problem) throw new Error(`corpus.paths[${index}]: ${problem}`);
    if (!out.includes(path as string)) out.push(path as string);
  });
  return { paths: out };
}
