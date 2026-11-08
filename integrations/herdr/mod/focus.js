// Related-terminal matching (#1199 H2). Pure: no host call, no timer, no import. It decides, from the facts `hc get --json` reports about ONE terminal, whether that terminal is a running
// `ahub console` for the selected project. It keeps only the foreground argv and cwd of that reading: the terminal's screen, title, labels and environment are never looked at.
//
// Observed on this Mac (herdr-core 0.1.18, isolated session): a console typed into a Herdr shell reports foreground argv `["bun", "<path>/ahub", ("--project", X,) "console"]`, a finished terminal has no
// `foreground`, and an unknown address is `not_found`. Anything that does not match exactly is "not a related console", which is a safe answer: the person gets Open console instead.

export const MAX_TERMINALS = 50;
/** Flags `ahub console` accepts after the word `console` (help.ts). Anything else is not matched, so `console --something-new` is never guessed at. */
const CONSOLE_FLAGS = new Set(["--panels", "--no-pet"]);
const base = p => String(p).split("/").filter(Boolean).pop() ?? "";
const text = v => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v);

/** The ahub program: `ahub` itself, or a runtime followed by a script named `ahub`. Returns the index of the first argument after it, or -1. */
function afterProgram(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(text)) return -1;
  if (base(argv[0]) === "ahub") return 1;
  if (["bun", "node"].includes(base(argv[0])) && argv.length > 1 && base(argv[1]) === "ahub") return 2;
  return -1;
}

/**
 * Does this foreground process look like `ahub [--project <root|id>] console [--panels] [--no-pet] [--color=...]`, and for which project?
 * - `--project` must be an absolute path equal to the selected root, or exactly the selected id;
 * - with no `--project`, ahub resolves the project from the cwd, so the cwd must be exactly the selected root (a subfolder could be a different, nested project);
 * - nothing else is accepted, and every argument must be printable text.
 */
export function matchConsole(foreground, selection) {
  if (!foreground || typeof foreground !== "object" || !text(foreground.cwd)) return false;
  const argv = foreground.argv, start = afterProgram(argv);
  if (start < 0) return false;
  let i = start, project = null;
  if (argv[i] === "--project") { if (i + 1 >= argv.length) return false; project = argv[i + 1]; i += 2; }
  if (argv[i] !== "console") return false;
  for (let j = i + 1; j < argv.length; j++) if (!CONSOLE_FLAGS.has(argv[j]) && !/^--color=(auto|always|never)$/.test(argv[j])) return false;
  if (project !== null) return project === selection.root || project === selection.id;
  return foreground.cwd === selection.root;
}

/** The part of a terminal row (`hc ls`, as `terminals()` gives it) this entry reads: an address, whether it is live, and Herdr's own status word. */
export function terminalRow(row) {
  if (!row || typeof row !== "object" || !text(row.address) || row.address.length > 64) return null;
  const status = row.status === "working" || row.status === "blocked" || row.status === "done" || row.status === "idle" ? row.status : null;
  return { address: row.address, live: row.state === "live", herdr: status };
}
