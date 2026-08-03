import type Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  CAPS, KddError, logError, openDb, resolveDbPath, resolveDecisionsDir,
  PRIORITIES, STATUSES, KINDS, type Actor, type Status, type Kind,
} from '@kddkit/core';
import * as h from './handlers.js';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): Result => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

function guard(db: Database.Database, fn: () => unknown): Result {
  try {
    return ok(fn());
  } catch (e) {
    if (e instanceof KddError) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
    try { logError(db, 'mcp', String(e)); } catch { /* logging is best-effort */ }
    return { content: [{ type: 'text', text: 'internal error' }], isError: true };
  }
}

// zod's z.enum needs a non-empty tuple; the core arrays are validated at runtime.
const statusEnum = z.enum(STATUSES as [Status, ...Status[]]);
const priorityEnum = z.enum(PRIORITIES as [string, ...string[]]);
const kindEnum = z.enum(KINDS as [Kind, ...Kind[]]);

export function createServer(db: Database.Database, dir: string, actor: Actor): McpServer {
  const server = new McpServer({ name: 'kdd', version: '0.1.0' });

  server.registerTool('get_task',
    {
      description: `Task with links, last ${CAPS.comments} comments and last ${CAPS.events} `
        + 'events (comments_total/events_total show the full counts); '
        + 'full=true returns the complete uncapped history',
      inputSchema: { id: z.number().int().positive(), full: z.boolean().optional() },
    },
    async ({ id, full }) => guard(db, () => h.getTask(db, id, full)));

  server.registerTool('list_tasks',
    {
      description: 'Compact board rows in tasks, grouped by status (no body), top '
        + `${CAPS.listRows} per status; each row has kind (feature|bug|chore|research), `
        + 'ready (takeable now) and criteria {checked,total}; '
        + 'an omitted map names truncated columns — narrow with status/kind/track_id/area/ready',
      inputSchema: {
        status: statusEnum.optional(), area: z.string().optional(),
        kind: kindEnum.optional(),
        track_id: z.number().int().positive().optional(),
        ready: z.boolean().optional(),
      },
    },
    async (a) => guard(db, () => h.listTasks(db, a)));

  server.registerTool('list_tracks',
    {
      description: 'Tracks with their "use when…" description and status. Route new tasks '
        + 'to an active track matching the current branch/worktree; status=done marks a '
        + 'finished body of work (kept for context, not a routing target)',
      inputSchema: {},
    },
    async () => guard(db, () => h.listTracksTool(db)));

  server.registerTool('recall',
    {
      description: `FTS5 search over decisions and tasks, top-k (k 1..${CAPS.recallKMax})`,
      inputSchema: {
        query: z.string(),
        k: z.number().int().min(1).max(CAPS.recallKMax).optional(),
        kind: z.enum(['decision', 'task']).optional(),
      },
    },
    async ({ query, k, kind }) => guard(db, () => h.recallTool(db, dir, query, { k, kind })));

  server.registerTool('update_task',
    {
      description: 'Edit, move and/or comment a single task (actor=ai)',
      inputSchema: {
        id: z.number().int().positive(),
        edit: z.object({
          title: z.string().optional(), body: z.string().optional(),
          priority: priorityEnum.optional(), kind: kindEnum.optional(),
          area: z.string().optional(),
          track_id: z.number().int().positive().nullable().optional(),
        }).optional(),
        move: z.object({ to: statusEnum, reason: z.string().optional() }).optional(),
        comment: z.string().optional(),
      },
    },
    async (a) => guard(db, () => h.updateTask(db, a as h.UpdateInput, actor)));

  return server;
}

export async function startServer(): Promise<void> {
  const { dbPath, projectPath } = resolveDbPath();
  const db = openDb(dbPath, projectPath);
  const dir = resolveDecisionsDir();
  const actor: Actor = { type: 'ai', id: process.env.KDD_SESSION ?? 'mcp' };
  await createServer(db, dir, actor).connect(new StdioServerTransport());
}
