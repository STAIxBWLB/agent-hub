import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.name, '@staix/agent-hub');
assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['@staix/agent-mem'], 'Only the first-party memory core may be a runtime dependency');
assert.match(manifest.dependencies['@staix/agent-mem'], /^\d+\.\d+\.\d+$/, 'The memory core must use an exact published version');
assert.notEqual(manifest.private, true);
assert.equal(manifest.publishConfig?.access, 'public');
assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), ['./adapter', './conformance', './ui-plugin'], 'Only the reviewed adapter, conformance and acon plugin entry points may be public');
assert.equal(manifest.exports?.['./adapter'], './src/adapters/public.ts');
assert.equal(manifest.exports?.['./conformance'], './src/adapters/conformance/index.ts');
assert.equal(manifest.exports?.['./ui-plugin'], './src/ui/plugin.ts'); // #935: the agent-console plugin
assert.deepEqual(manifest.bin, { ahub: 'src/cli/main.js', 'agent-hub': 'src/cli/main.js' });

function tree(directory) {
  return readdirSync(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      assert(!entry.isSymbolicLink(), `Runtime tree contains a symlink: ${path}`);
      return entry.isDirectory() ? tree(path) : [path];
    });
}

// Compare runtime assets and the public operating guides against npm's own pack list.
const expected = new Set([
  'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'scripts/check-docs.mjs',
  ...['src', 'templates', 'plugins', '.claude-plugin', 'docs', 'LICENSES'].flatMap(tree),
]);
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}));
assert.equal(pack.name, manifest.name);
assert.equal(pack.version, manifest.version);
const actual = new Set(pack.files.map((file) => file.path));
for (const path of [
  ...expected,
  'src/pet/window.ts', 'src/pet/window.jxa.js', 'src/pet/window.html',
  'src/cli/main.js', 'src/cli/main.ts', 'src/cli/statusline-tee.ts',
  '.claude-plugin/marketplace.json', 'plugins/agent-hub/server.js',
  'plugins/agent-hub/.claude-plugin/plugin.json', 'plugins/agent-hub/.mcp.json',
  'templates/AGENTS.block.md',
  'templates/roles/NOTICE.md', 'plugins/agent-hub/ROLE-NOTICE.md',
  'templates/config.json', 'templates/routing.toml',
  'docs/operations.md', 'docs/quickstart.md',
]) {
  assert(actual.has(path), `npm package is missing runtime file: ${path}`);
}
for (const path of actual) {
  assert(expected.has(path), `Unexpected npm package file: ${path}`);
  assert(!/(^|\/)(test|tests|__tests__|\.github|node_modules|\.git)(\/|$)/.test(path),
    `Development files must not ship: ${path}`);
  assert(!/(^|\/)(\.env(?:\..*)?|\.npmrc|\.DS_Store)$|\.(?:test|spec)\.[^/]+$|\.(?:tgz|log)$/.test(path),
    `Unwanted npm package file: ${path}`);
}
// Nothing published may name an internal host (issue #74). The message gives the place, never the address:
// CI logs are public too.
// A sentence may end right after an address ("on <address>."): only a digit, or a dot followed by a digit,
// continues a dotted number.
const privateV4 = /(?<!\d\.?)(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?!\.?\d)/;
for (const path of actual) {
  readFileSync(join(root, path), 'utf8').split('\n').forEach((line, i) => {
    assert(!privateV4.test(line), `Private IPv4 address in a published file: ${path}:${i + 1}`);
  });
}
console.log(`package: OK (${actual.size} files, ${manifest.name}@${manifest.version})`);
