// #1257: the one reader of `npm pack --dry-run --json` output. npm 11 prints a one-element array of the package entry; a different
// major may change that shape (npm 12 wrapped `npm view --json`, #1253), so an unexpected shape is refused with the cause and the
// command that names the npm in use, never a TypeError from a destructuring.
export function packEntry(stdout, npmVersion = 'unknown') {
  const expected = 'a JSON array of exactly one package entry with string name and version and a files array of { path } objects';
  const refuse = (got) => new Error(`npm pack --dry-run --json returned an unexpected shape (${got}; expected ${expected}); npm ${npmVersion} may print a different shape than the npm pinned in .github/workflows/check.yml (NPM_VERSION), so run \`npm --version\` and \`npm pack --dry-run --json\` to compare`);
  let value;
  try { value = JSON.parse(stdout); } catch { throw refuse('not JSON'); }
  if (!Array.isArray(value)) throw refuse(value === null ? 'null' : typeof value);
  if (value.length !== 1) throw refuse(`an array of ${value.length}`);
  const [entry] = value;
  if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.version !== 'string'
    || !Array.isArray(entry.files) || !entry.files.every((file) => file !== null && typeof file === 'object' && typeof file.path === 'string')) {
    throw refuse('one element of another form');
  }
  return entry;
}
