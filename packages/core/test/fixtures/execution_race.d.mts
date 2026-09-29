import type { ReserveWorkItemInput, reviseWorkItem, MemoryWriteInput } from '../../src/index.js';
export type RaceRequest = { op: 'reserve'; input: ReserveWorkItemInput } |
  { op: 'revise'; input: Parameters<typeof reviseWorkItem>[1] } | {op:'memory';input:MemoryWriteInput};
export interface RaceOutcome { ok: boolean; error?: string; value?: unknown }
export function runRace(dbPath: string, requests: readonly [RaceRequest, RaceRequest]): Promise<RaceOutcome[]>;
export function crashMemoryWrite(dbPath:string,input:MemoryWriteInput):Promise<void>;
