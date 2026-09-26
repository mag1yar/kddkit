import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, addTask, addCriterion, linkTasks, claimTask, syncIndex, resolveDbPath, ensureWorktree, checkMove } from '../../../packages/core/dist/index.js';

const root = mkdtempSync('/private/tmp/kdd-orchestration-check-');
const repo = join(root, 'repo');
mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
git('init');
git('-c', 'user.name=Analysis', '-c', 'user.email=analysis@example.invalid', 'commit', '--allow-empty', '-m', 'analysis baseline');
const store = join(root, 'store', 'kdd.db');
const db = openDb(store);
const wt = ensureWorktree(repo, store, 1, 'analysis');
assert.equal(resolveDbPath(repo).dbPath, resolveDbPath(wt).dbPath);
console.log('PASS: linked worktree resolves the same project database');

const user = { type: 'user' };
const dep = addTask(db, { title: 'unfinished dependency' }, user);
const task = addTask(db, { title: 'dependent work' }, user);
addCriterion(db, task.id, 'result is verified', user);
linkTasks(db, task.id, dep.id, 'depends_on', user);
assert.equal(claimTask(db, task.id, { type: 'ai', id: 'analysis' }).ok, true);
console.log('CONFIRMED: depends_on link does not prevent claiming a task');

const a = join(root, 'decisions-a');
const b = join(root, 'decisions-b');
mkdirSync(a); mkdirSync(b);
writeFileSync(join(a, 'only-a.md'), '# Only branch A\n\nBranch-specific decision');
syncIndex(db, a);
assert.ok(db.prepare('SELECT slug FROM decisions WHERE slug = ?').get('only-a'));
syncIndex(db, b);
assert.equal(db.prepare('SELECT slug FROM decisions WHERE slug = ?').get('only-a'), undefined);
console.log('CONFIRMED: indexing another worktree removes absent decisions from the shared index');

assert.equal(checkMove('review', 'done', { type: 'ai', id: 'other-reviewer' }, undefined, 0, null, 'ai:author').ok, true);
assert.equal(checkMove('in_progress', 'done', { type: 'ai', id: 'analysis' }, 'claimed user approval', 2, 'ai:someone-else').ok, true);
console.log('CONFIRMED: another agent can accept; a reason string bypasses AI transition gates');
db.close();
console.log(`Disposable reproduction: ${root}`);
