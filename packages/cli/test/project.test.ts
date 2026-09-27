import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BIN } from './run.js';

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root=mkdtempSync(join(tmpdir(),'kdd-project-cli-'));
  env={...process.env,KDD_HOME:join(root,'home'),KDD_DB:undefined,KDD_DECISIONS_DIR:undefined,
    KDD_ACTOR:'',CLAUDECODE:'',CODEX_SESSION_ID:'',CODEX_THREAD_ID:'',NO_UPDATE_NOTIFIER:'1'};
});
afterEach(() => rmSync(root,{recursive:true,force:true}));
function git(cwd: string,...args: string[]) {
  return execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
}
function repo(name: string) {
  const path=join(root,name);mkdirSync(path);
  git(path,'init');
  git(path,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','seed');
  return path;
}
function cli(cwd: string,...args: string[]) {
  return JSON.parse(execFileSync(process.execPath,[BIN,...args],{cwd,env,encoding:'utf8',stdio:'pipe'}));
}
it('binds a clone/worktree and protects source decisions during backend recall',() => {
  const source=repo('source');
  const project=cli(source,'project','show','--json');
  const task=cli(source,'add','shared','--json');
  const decision=cli(source,'decide','Original','--decision','primarytoken','--source-task',String(task.id),'--json');
  const clone=join(root,'clone');git(root,'clone','--no-hardlinks',source,clone);
  cli(source,'project','bind',clone,'--repo',project.project.primary_repo_id,'--kind','managed','--json');
  const wt=join(root,'worktree');git(clone,'worktree','add','-b','worker',wt);
  expect(cli(wt,'project','show','--json').project.project_id).toBe(project.project.project_id);
  cli(wt,'comment',String(task.id),'from clone','--json');
  expect(cli(source,'show',String(task.id),'--json').comments[0].body).toBe('from clone');
  const backend=repo('backend');
  cli(source,'project','add-repo',backend,'--purpose','backend','--access','context_only','--json');
  const before=cli(source,'export');
  expect(cli(backend,'recall','primarytoken','--kind','decision','--json')).toHaveLength(1);
  const dir=join(backend,'.planning','decisions');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,`${decision.slug}.md`),'# Conflict\n\nforeign');
  expect(cli(backend,'recall','primarytoken','--kind','decision','--json')).toHaveLength(1);
  expect(cli(backend,'export').decisions).toEqual(before.decisions);
  expect(readFileSync(decision.path,'utf8')).toContain('primarytoken');
  expect(cli(source,'project','show','--json').bindings).toHaveLength(3);
},30_000);

it('does not create an unknown target store for project mutations',() => {
  const source=repo('source');
  env.KDD_DB=join(root,'unknown.db');
  expect(() => cli(source,'project','add-repo',repo('backend'),'--purpose','backend','--access','context_only','--json')).toThrow();
  expect(existsSync(env.KDD_DB)).toBe(false);
});
