import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.name, '@staix/agent-hub');
assert.notEqual(manifest.private, true);
assert.equal(manifest.publishConfig?.access, 'public');
assert.deepEqual(manifest.bin, { ahub: 'src/cli/main.js', 'agent-hub': 'src/cli/main.js' });

function tree(directory) {
  return readdirSync(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      assert(!entry.isSymbolicLink(), `Runtime tree contains a symlink: ${path}`);
      return entry.isDirectory() ? tree(path) : [path];
    });
}

// Compare the complete runtime tree, including dotfiles, against npm's own pack list.
const expected = new Set([
  'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md',
  ...['src', 'templates', 'plugins', '.claude-plugin'].flatMap(tree),
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
  'src/cli/main.js', 'src/cli/main.ts', 'src/cli/statusline-tee.ts',
  '.claude-plugin/marketplace.json', 'plugins/agent-hub/server.js',
  'plugins/agent-hub/.claude-plugin/plugin.json', 'plugins/agent-hub/.mcp.json',
  'templates/CLAUDE.block.md', 'templates/AGENTS.block.md',
  'templates/config.json', 'templates/routing.toml',
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
console.log(`package: OK (${actual.size} files, ${manifest.name}@${manifest.version})`);
