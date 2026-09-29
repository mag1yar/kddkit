import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, posix, isAbsolute } from 'node:path';
import { controllerDb, type ControllerHandle } from './controller.js';
import { KddError } from './errors.js';
import { CAPS } from './caps.js';
import { parseDecisionMd } from './decisions.js';
import { shape, digest } from './execution.js';
import { memoryCommit, memoryHex, memoryPrivatePath, safeMemoryText, writeMemoryDb,
  type MemoryScope, type MemoryApplicability, type MemoryKind, type MemoryStatus,
  type MemoryAuthor, type MemorySource, type MemoryWriteInput, type MemoryObservers,
  type MemoryReceipt } from './memory.js';

export interface MemoryImportInput {
  commandId:string; scope:MemoryScope; applicability:MemoryApplicability;
  repoId:string; checkoutPath:string; commit:string; path:string; sha256:string;
  kind?:MemoryKind; status?:MemoryStatus; author:MemoryAuthor;
}
export function readMemoryDocument(db: Database.Database,
  input: Pick<MemoryImportInput,'repoId'|'checkoutPath'|'commit'|'path'|'sha256'>):
  {title:string;body:string;source:Extract<MemorySource,{kind:'git'}>} {
  shape(input,['repoId','checkoutPath','commit','path','sha256']);
  safeMemoryText(input.path,CAPS.agentFieldChars); memoryHex(input.sha256,[64]);
  const path = input.path;
  if (isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(p=>!p || p==='.' || p==='..')
    || posix.normalize(path)!==path || memoryPrivatePath(path)) throw new KddError('private or invalid memory document path');
  const checkoutPath = memoryCommit(db,input.repoId,input.commit,input.checkoutPath);
  let bytes: Buffer;
  try {
    const options = {cwd:checkoutPath,stdio:'pipe' as const,maxBuffer:4*CAPS.bodyChars+4096};
    const listing = execFileSync('/usr/bin/git',['--no-replace-objects','--literal-pathspecs','ls-tree','--full-tree','-z',input.commit,'--',path],
      {...options,encoding:'utf8'}).split('\0').filter(Boolean);
    const match = listing.length===1 ? /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(listing[0]) : null;
    if (!match || match[3]!==path) throw new Error();
    // Read the verified blob object, never a working-tree path or a symlink target.
    bytes = execFileSync('/usr/bin/git',['--no-replace-objects','cat-file','blob',match[2]],options);
  } catch { throw new KddError('memory document blob unavailable'); }
  if (createHash('sha256').update(bytes).digest('hex')!==input.sha256) throw new KddError('memory document hash mismatch');
  let body:string;
  try { body=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); }
  catch { throw new KddError('memory document requires UTF-8 text'); }
  if (body.includes('\0')) throw new KddError('memory document requires text');
  safeMemoryText(body,CAPS.bodyChars);
  const normalized=body.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n'), parsed = parseDecisionMd(normalized+'\n');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)?.[1];
  const declaredStatus=frontmatter?.split('\n').filter(line=>line.startsWith('status:')).at(-1)?.slice(7).trim();
  const hasStatus = declaredStatus !== undefined;
  const legacy = /(?:^|\/)\.planning\/decisions\/.*\.md$/.test(path);
  const documentStatus = hasStatus || parsed.supersededBy || legacy ? declaredStatus==='superseded' || parsed.supersededBy
    ? 'superseded' : declaredStatus==='active' ? 'active' : 'unknown' : null;
  const title = parsed.title || basename(path); safeMemoryText(title,CAPS.agentFieldChars);
  return {title,body,source:{kind:'git',repoId:input.repoId,commit:input.commit,path,sha256:input.sha256,documentStatus}};
}
export function importMemory(handle: ControllerHandle, input: MemoryImportInput, observers: MemoryObservers = {}): MemoryReceipt {
  const db = controllerDb(handle);
  return db.transaction(() => {
    shape(input,['commandId','scope','applicability','repoId','checkoutPath','commit','path','sha256','author'],['kind','status']);
    const document = readMemoryDocument(db,{repoId:input.repoId,checkoutPath:input.checkoutPath,commit:input.commit,path:input.path,sha256:input.sha256});
    const kind = input.kind === undefined ? 'candidate' : input.kind;
    const status = input.status === undefined ? 'active' : input.status;
    if (status==='active' && (kind==='decision' || kind==='rule') && document.source.documentStatus !== null && document.source.documentStatus !== 'active') {
      throw new KddError('inactive legacy memory requires explicit candidate acceptance');
    }
    const draft:MemoryWriteInput={commandId:input.commandId,entryId:null,expectedRevision:0,scope:input.scope,applicability:input.applicability,
      kind,status,title:document.title,body:document.body,source:document.source,author:input.author};
    const importKey=digest({repoId:input.repoId,path:input.path,commit:input.commit,sha256:input.sha256,scope:input.scope,applicability:input.applicability});
    return writeMemoryDb(db,draft,observers,importKey);
  }).immediate();
}
