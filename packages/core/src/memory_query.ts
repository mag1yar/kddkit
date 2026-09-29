import Database from 'better-sqlite3';
import { controllerDb, type ControllerHandle } from './controller.js';
import { KddError } from './errors.js';
import { shape, integer } from './execution.js';
import { CAPS, capText } from './caps.js';
import { sanitizeQuery } from './recall.js';
import { selectMemory, memoryReadOptions, safeMemoryText,
  type MemoryView, type MemoryRecord, type MemoryHit, type MemoryReadOptions,
  type MemoryRecallOptions } from './memory.js';

export function memoryEntry(handle: ControllerHandle, view: MemoryView, entryId: string, revision?: number): MemoryRecord {
  const db = controllerDb(handle);
  if (revision !== undefined) integer(revision);
  return db.transaction(() => selectMemory(db,view,{candidates:true,withdrawn:true},entryId,revision ?? null)[0])();
}
export function memoryHistory(handle: ControllerHandle, view: MemoryView, entryId: string): MemoryRecord[] {
  const db = controllerDb(handle);
  return db.transaction(() => selectMemory(db,view,{candidates:true,withdrawn:true},entryId))();
}
export function listMemory(handle: ControllerHandle, view: MemoryView, options: MemoryReadOptions = {}): MemoryRecord[] {
  const db = controllerDb(handle);
  return db.transaction(() => selectMemory(db,view,options))();
}
export function memoryRules(handle: ControllerHandle, view: MemoryView): MemoryRecord[] {
  const db = controllerDb(handle);
  return db.transaction(() => selectMemory(db,view).filter(record=>record.kind==='rule'))();
}
export function queryMemoryDb(db: Database.Database, view: MemoryView, query: string,
  options: MemoryRecallOptions = {}): MemoryHit[] {
  shape(options,[],['k','candidates','withdrawn']);
  const readOptions = {candidates:options.candidates,withdrawn:options.withdrawn};
  memoryReadOptions(readOptions);
  const k = options.k === undefined ? CAPS.recallK : options.k; integer(k);
  if (k > CAPS.recallKMax) throw new KddError(`memory k must be 1..${CAPS.recallKMax}`);
  safeMemoryText(query,CAPS.bodyChars);
  const match = sanitizeQuery(query);
  if (!match) throw new KddError('memory query requires words');
  const eligible = selectMemory(db,view,readOptions);
  // ponytail: O(n) allowed records per query; use isolated partitions only after measured corpus cost.
  const corpus = new Database(':memory:');
  try {
    corpus.exec("CREATE VIRTUAL TABLE hits USING fts5(ref UNINDEXED,title,body,tokenize='unicode61 remove_diacritics 2')");
    const insert = corpus.prepare('INSERT INTO hits(ref,title,body) VALUES(?,?,?)');
    corpus.transaction(() => { for (const row of eligible) insert.run(row.entryId,row.title,row.body); })();
    const hits = corpus.prepare(`SELECT ref,title,snippet(hits,2,'','','...',${CAPS.recallSnippetTokens}) snippet
      FROM hits WHERE hits MATCH ? ORDER BY bm25(hits,0,3.0,1.0),ref LIMIT ?`).all(match,k) as {ref:string;title:string;snippet:string}[];
    const records = new Map(eligible.map(row=>[row.entryId,row]));
    return hits.map(hit => {
      const row = records.get(hit.ref)!;
      return { ref:{projectId:row.scope.projectId,entryId:row.entryId,revision:row.revision},
        hash:row.hash,kind:row.kind,status:row.status,effectiveStatus:row.effectiveStatus,
        title:capText(hit.title,CAPS.recallTitleChars),snippet:hit.snippet,source:row.source,
        scope:row.scope,applicability:row.applicability };
    });
  } finally { corpus.close(); }
}
export function recallMemory(handle: ControllerHandle, view: MemoryView, query: string,
  options: MemoryRecallOptions = {}): MemoryHit[] {
  const db = controllerDb(handle);
  return db.transaction(() => queryMemoryDb(db,view,query,options))();
}
