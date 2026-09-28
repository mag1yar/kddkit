import Database from 'better-sqlite3';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CAPS, MIGRATIONS, openRunContext, runOperations, readRunContext, submitRunReport, requestRunQuestion, type RunContext } from '@kddkit/core';

export function createRunServer(context: RunContext): McpServer {
  const server = new McpServer({ name: 'kdd-run', version: '0.1.0' });
  const granted = runOperations(context);
  const body = z.object({ body: z.string().min(1).max(CAPS.agentFieldChars) }).strict();
  const annotations = { destructiveHint: false, openWorldHint: false };
  const result = (fn: () => unknown) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(fn()) }] }; }
    catch { return { content: [{ type: 'text' as const, text: 'run operation denied' }], isError: true }; }
  };
  if (granted.includes('get_context')) server.registerTool('get_context', {
    description: 'Read this run’s task context', inputSchema: z.object({}).strict(),
    annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
  }, async () => result(() => readRunContext(context)));
  if (granted.includes('submit_report')) server.registerTool('submit_report', {
    description: 'Record an untrusted report for this run', inputSchema: body,
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
  }, async ({ body }) => result(() => ({ eventId: submitRunReport(context, body) })));
  if (granted.includes('request_question')) server.registerTool('request_question', {
    description: 'Record an untrusted question for this run', inputSchema: body,
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
  }, async ({ body }) => result(() => ({ eventId: requestRunQuestion(context, body) })));
  return server;
}

export async function startRunServer(configPath: string): Promise<void> {
  let db: Database.Database | undefined;
  try {
    if (!isAbsolute(configPath)) throw new Error();
    const stat = lstatSync(configPath);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error();
    const config = z.object({ dbPath: z.string().refine(isAbsolute), token: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
      .parse(JSON.parse(readFileSync(configPath, 'utf8')));
    db = new Database(config.dbPath, { fileMustExist: true });
    if (db.pragma('user_version', { simple: true }) !== MIGRATIONS.length) throw new Error();
    db.pragma('foreign_keys=ON'); db.pragma('busy_timeout=5000');
    const server = createRunServer(openRunContext(db, config.token));
    const connection = db; server.server.onclose = () => { if (connection.open) connection.close(); };
    await server.connect(new StdioServerTransport());
  } catch { db?.close(); throw new Error('run broker startup denied'); }
}
