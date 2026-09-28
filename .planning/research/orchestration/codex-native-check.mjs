// Actual tool execution is shared with the production preflight; JSON is measurement, not authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { observeCodexNative } from '../../../packages/core/dist/index.js';

for (const arg of process.argv.slice(2)) assert.ok(['--json', '--hardlink-only'].includes(arg), `unknown argument: ${arg}`);
const evidence = await observeCodexNative('/opt/homebrew/bin/codex', process.argv.includes('--hardlink-only'));
const scriptHash = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
process.stdout.write(JSON.stringify({ ...evidence, observerHash: evidence.scriptHash, scriptHash }, null, 2) + '\n');
if (!evidence.applicable) process.exitCode = 1;
