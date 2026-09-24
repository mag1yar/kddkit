import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'integrations', 'codex-plugin');
const copies = [
  ['packages/core/dist/index.js', 'runtime/core.js'],
  ['packages/mcp/dist/main.js', 'runtime/mcp.js'],
  ['skills/kdd/SKILL.md', 'skills/kdd/SKILL.md'],
  ['skills/kdd-update/SKILL.md', 'skills/kdd-update/SKILL.md'],
];
const generatedDirs = ['runtime', 'skills/kdd', 'skills/kdd-update'];
const check = process.argv.includes('--check');
let bad = false;

for (const [source, target] of copies) {
  const from = join(root, source);
  const to = join(plugin, target);
  const current = existsSync(to) ? readFileSync(to) : undefined;
  if (!existsSync(from) || !current || !readFileSync(from).equals(current)) {
    if (check) { console.error(`stale Codex artifact: ${target}`); bad = true; }
    else { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to); }
  }
}

for (const entry of readdirSync(plugin, { recursive: true })) {
  const file = join(plugin, entry);
  const pluginPath = relative(plugin, file);
  if (lstatSync(file).isSymbolicLink()) { console.error(`symlink in Codex plugin: ${pluginPath}`); bad = true; }
  if (pluginPath === 'node_modules' || pluginPath.startsWith('node_modules/')) {
    console.error('node_modules must not be committed in Codex plugin'); bad = true;
  }
}

for (const dir of generatedDirs) {
  const absolute = join(plugin, dir);
  for (const entry of existsSync(absolute) ? readdirSync(absolute, { recursive: true }) : []) {
    const file = join(absolute, entry);
    const pluginPath = relative(plugin, file);
    if (!copies.some(([, target]) => target === pluginPath)) {
      console.error(`unexpected generated Codex artifact: ${pluginPath}`); bad = true;
    }
  }
}
if (bad) process.exitCode = 1;
