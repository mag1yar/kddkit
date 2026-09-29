import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../src/index.js';
import { canonical } from '../src/execution.js';
import { fixture } from './execution_fixture.js';
export { cleanupFixtures } from './execution_fixture.js';

export function fixtureHash(input: core.MemoryDraft): string {
  const { scope, applicability, kind, status, title, body, source, author } = input;
  return createHash('sha256').update(canonical({ scope, applicability, kind, status, title, body, source, author })).digest('hex');
}
export function memoryFixture() {
  const f = fixture(), scope: core.MemoryScope = { projectId: f.projectId, taskId: null };
  const draft = (kind: core.MemoryKind, body: string): core.MemoryWriteInput => ({
    commandId: randomUUID(), entryId: null, expectedRevision: 0, scope,
    applicability: { repoId: null, commit: null }, kind, status: 'active', title: body, body,
    source: { kind: kind === 'fact' ? 'host' : 'user', ref: 'fixture:explicit instruction' },
    author: { type: 'user', id: null },
  });
  // Fixture receipts attest these specific expected requests, never arbitrary incoming requests.
  const proof = (input: core.MemoryWriteInput, operation: core.MemoryOperation,
    origins: 'user' | 'host' | readonly ('user' | 'host')[]): core.MemoryObservers => {
    const observations = (typeof origins === 'string' ? [origins] : origins).map(origin => ({
      request: { operation, entryId: input.entryId, expectedRevision: input.expectedRevision, origin,
        scope: input.scope, applicability: input.applicability, payloadHash: fixtureHash(input), source: input.source },
      origin, verdict: 'pass' as const, observedAt: core.now(), expiresAt: null,
    }));
    const path = join(f.home, randomUUID() + '.receipt.json');
    writeFileSync(path, JSON.stringify(observations), { mode: 0o600 });
    return { observe: request => {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as core.MemoryEvidenceObservation[];
      return saved.find(observation => canonical(observation.request) === canonical(request)) ?? null;
    } };
  };
  const rows = () => ({
    entries: f.db.prepare('SELECT * FROM memory_entries ORDER BY id').all(),
    revisions: f.db.prepare('SELECT * FROM memory_revisions ORDER BY entry_id,revision').all(),
    events: f.db.prepare("SELECT * FROM events WHERE action LIKE 'memory_%' ORDER BY id").all(),
  });
  return { ...f, scope, view: { scope, repositories: [] } as core.MemoryView, draft, proof, rows };
}
