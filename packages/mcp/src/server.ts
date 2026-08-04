import type Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  agentId, CAPS, KddError, logError, openDb, resolveDbPath, resolveDecisionsDir,
  PRIORITIES, STATUSES, KINDS, type Actor, type Status, type Kind,
} from '@kddkit/core';
import * as h from './handlers.js';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** База и каталог решений. Добывается лениво: см. startServer. */
export interface Ctx { db: Database.Database; dir: string }
type CtxFn = () => Ctx;

const ok = (data: unknown): Result => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });

function guard(getCtx: CtxFn, fn: (c: Ctx) => unknown): Result {
  // Раньше базу открывал startServer, и любая её проблема (не git-репо, чужая схема,
  // битый нативный модуль) убивала процесс ДО хендшейка: клиент показывал «disconnected»
  // и ни строчки причины — объяснить можно только то, что успело подключиться.
  let c: Ctx;
  try {
    c = getCtx();
  } catch (e) {
    return fail(e instanceof KddError ? e.message : String(e));
  }
  try {
    return ok(fn(c));
  } catch (e) {
    if (e instanceof KddError) return fail(e.message);
    try { logError(c.db, 'mcp', String(e)); } catch { /* logging is best-effort */ }
    return fail('internal error');
  }
}

// zod's z.enum needs a non-empty tuple; the core arrays are validated at runtime.
const statusEnum = z.enum(STATUSES as [Status, ...Status[]]);
const priorityEnum = z.enum(PRIORITIES as [string, ...string[]]);
const kindEnum = z.enum(KINDS as [Kind, ...Kind[]]);

export function createServer(getCtx: CtxFn, actor: Actor): McpServer {
  const server = new McpServer({ name: 'kdd', version: '0.1.0' });

  server.registerTool('get_task',
    {
      description: `Task with links, last ${CAPS.comments} comments and last ${CAPS.events} `
        + 'events (comments_total/events_total show the full counts); '
        + 'full=true returns the complete uncapped history',
      inputSchema: { id: z.number().int().positive(), full: z.boolean().optional() },
    },
    async ({ id, full }) => guard(getCtx, (c) => h.getTask(c.db, id, full)));

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
    async (a) => guard(getCtx, (c) => h.listTasks(c.db, a)));

  server.registerTool('list_tracks',
    {
      description: 'Tracks with their "use when…" description and status. Route new tasks '
        + 'to an active track matching the current branch/worktree; status=done marks a '
        + 'finished body of work (kept for context, not a routing target)',
      inputSchema: {},
    },
    async () => guard(getCtx, (c) => h.listTracksTool(c.db)));

  server.registerTool('recall',
    {
      description: `FTS5 search over decisions and tasks, top-k (k 1..${CAPS.recallKMax})`,
      inputSchema: {
        query: z.string(),
        k: z.number().int().min(1).max(CAPS.recallKMax).optional(),
        kind: z.enum(['decision', 'task']).optional(),
      },
    },
    async ({ query, k, kind }) => guard(getCtx, (c) => h.recallTool(c.db, c.dir, query, { k, kind })));

  server.registerTool('update_task',
    {
      description: 'Edit, move, comment and/or attach a file to a single task (actor=ai). '
        + 'A move may be refused (unchecked criteria, a task you submitted for review yourself) — '
        + 'the way through is move.reason, and only once the user has asked for it. '
        + 'attach.path is a path on this machine — download the file first if it lives elsewhere',
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
        attach: z.object({
          path: z.string(),
          description: z.string().optional()
            .describe('what is in the file — read by whoever has no picture'),
        }).optional(),
        detach: z.number().int().positive().optional()
          .describe('file id from get_task files[]'),
      },
    },
    async (a) => guard(getCtx, (c) => h.updateTask(c.db, a as h.UpdateInput, actor)));

  return server;
}

/**
 * Ленивое подключение к базе. Кэшируем только успех: если репо появится (клиент сменил cwd)
 * или нативный модуль пересоберут, следующий вызов инструмента поднимется сам, без реконнекта.
 */
export function lazyCtx(): CtxFn {
  let ctx: Ctx | null = null;
  return () => {
    if (ctx) return ctx;
    // Сначала всё, что может бросить, не заняв ресурс: иначе упавший resolveDecisionsDir
    // оставлял бы открытое соединение, которое некому закрыть — и так на каждый вызов.
    const dir = resolveDecisionsDir();
    const { dbPath, projectPath } = resolveDbPath();
    ctx = { db: openDb(dbPath, projectPath), dir };
    return ctx;
  };
}

/**
 * Тот же id, что у CLI (`agentId`): один агент в одной сессии обязан писаться одним автором,
 * иначе «сдал через kdd — принял через MCP» проходит мимо гейта на самоприёмку. Экспортируется
 * ради теста — расхождение с CLI уже было баг.
 */
export const mcpActor = (): Actor => ({ type: 'ai', id: agentId() ?? 'mcp' });

export async function startServer(): Promise<void> {
  await createServer(lazyCtx(), mcpActor()).connect(new StdioServerTransport());
}
