import { randomUUID } from 'node:crypto';
import * as core from '../src/index.js';

export function roleFixture(handle: core.ControllerHandle, access: 'read' | 'workspace-write' = 'workspace-write',
  operations: readonly core.RunOperation[] = ['get_context', 'submit_report', 'request_question']): core.RoleReceipt {
  return core.saveRoleRevision(handle, { expectedRevision: 0, commandId: randomUUID(), definition: {
    name: 'Fixture', prompt: 'Complete the scoped work.', runtime: 'codex', model: 'gpt-6-sol', effort: 'high',
    access, operations, skills: [],
  } });
}
