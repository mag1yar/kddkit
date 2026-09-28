import type { ReserveWorkItemInput, reviseWorkItem } from '../../src/index.js';
export type RaceRequest = { op: 'reserve'; input: ReserveWorkItemInput } |
  { op: 'revise'; input: Parameters<typeof reviseWorkItem>[1] };
export interface RaceOutcome { ok: boolean; error?: string; value?: unknown }
export function runRace(dbPath: string, requests: readonly [RaceRequest, RaceRequest]): Promise<RaceOutcome[]>;
