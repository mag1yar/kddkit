import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  agentId, CAPS, KddError, logError, manualSessionFromEnv, normalizeSessionId,
  listProjects, openDb, resolveDbPath, resolveDecisionsDir,
  PRIORITIES, STATUSES, KINDS, type Actor, type Status, type Kind,
} from '@kddkit/core';
import * as h from './handlers.js';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** База и каталог решений. Добывается лениво: см. startServer. */
export interface Ctx { db: Database.Database; dir: string }
type Meta = Record<string, unknown> | undefined;
type CtxFn = (meta?: Meta, project?: string) => Ctx;

const ok = (data: unknown): Result => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });

function guard(getCtx: CtxFn, meta: Meta, project: string | undefined, fn: (c: Ctx) => unknown): Result {
  // Раньше базу открывал startServer, и любая её проблема (не git-репо, чужая схема,
  // битый нативный модуль) убивала процесс ДО хендшейка: клиент показывал «disconnected»
  // и ни строчки причины — объяснить можно только то, что успело подключиться.
  let c: Ctx;
  try {
    c = getCtx(meta, project);
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
const projectField = z.string().min(1).optional()
  .describe('Absolute path inside the git repository; use list_projects to find known projects');

function knownProjects(): string[] {
  return listProjects().flatMap((p) => {
    try {
      const output = execFileSync('git', ['--git-dir', p.projectPath, 'worktree', 'list', '--porcelain'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return output.split(/\r?\n\r?\n/).filter((block) => !/^bare$/m.test(block))
        .map((block) => block.match(/^worktree (.+)$/m)?.[1])
        .filter((path): path is string => !!path)
        .filter((path) => {
          try { return resolveDbPath(path).dbPath === p.dbPath; } catch { return false; }
        });
    } catch { return []; } // stale or unavailable repository
  });
}

export function createServer(getCtx: CtxFn, actor?: Actor): McpServer {
  const server = new McpServer({ name: 'kdd', version: '0.1.0' });

  server.registerTool('get_task',
    {
      description: `Task with links, last ${CAPS.comments} comments and last ${CAPS.events} `
        + 'events (comments_total/events_total show the full counts); '
        + 'full=true returns the complete uncapped history; '
        + 'brief=true returns only the deterministic resume packet; brief and full are exclusive',
      inputSchema: {
        id: z.number().int().positive(),
        full: z.boolean().optional(),
        brief: z.boolean().optional(),
        project: projectField,
      },
    },
    async ({ id, full, brief, project }, extra) => guard(getCtx, extra._meta, project, (c) => {
      if (brief && full) throw new KddError('brief and full are mutually exclusive');
      return brief ? h.getTaskBrief(c.db, c.dir, id) : h.getTask(c.db, c.dir, id, full);
    }));

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
        project: projectField,
      },
    },
    async (a, extra) => guard(getCtx, extra._meta, a.project, (c) => h.listTasks(c.db, a)));

  server.registerTool('list_projects',
    {
      description: 'Absolute git worktree paths for known local KDD projects; '
        + 'pass one path as project to other tools',
      inputSchema: {},
    },
    async () => {
      try { return ok(knownProjects()); } catch (e) { return fail(String(e)); }
    });

  server.registerTool('list_tracks',
    {
      description: 'Tracks with their "use when…" description and status. Route new tasks '
        + 'to an active track matching the current branch/worktree; status=done marks a '
        + 'finished body of work (kept for context, not a routing target)',
      inputSchema: { project: projectField },
    },
    async ({ project }, extra) => guard(getCtx, extra._meta, project, (c) => h.listTracksTool(c.db)));

  server.registerTool('recall',
    {
      description: `FTS5 search over decisions and tasks, top-k (k 1..${CAPS.recallKMax})`,
      inputSchema: {
        query: z.string(),
        k: z.number().int().min(1).max(CAPS.recallKMax).optional(),
        kind: z.enum(['decision', 'task']).optional(),
        project: projectField,
      },
    },
    async ({ query, k, kind, project }, extra) => guard(
      getCtx, extra._meta, project, (c) => h.recallTool(c.db, c.dir, query, { k, kind }),
    ));

  server.registerTool('update_task',
    {
      description: 'Edit, move, comment and/or attach a file to a single task (actor=ai). '
        + 'A move may be refused (unchecked criteria, a task you submitted for review yourself) — '
        + 'the way through is move.reason, and only once the user has asked for it. '
        + 'attach.path is a path on this machine — download the file first if it lives elsewhere',
      inputSchema: {
        id: z.number().int().positive(),
        project: projectField,
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
    async (a, extra) => guard(getCtx, extra._meta, a.project, (c) => h.updateTask(
      c.db, a as h.UpdateInput, actor ?? mcpActor(extra._meta, a.project),
    )));

  return server;
}

/**
 * Ленивое подключение к базе. Кэшируем только успех: исправленный нативный модуль
 * или явный project позволяет повторить вызов без реконнекта.
 */
export function lazyCtx(): CtxFn {
  const contexts = new Map<string, Ctx>();
  return (meta, project) => {
    if (project && !isAbsolute(project)) throw new KddError('project must be an absolute repository path');
    if (project && (process.env.KDD_DB || process.env.KDD_DECISIONS_DIR)) {
      throw new KddError('project cannot be used with KDD_DB or KDD_DECISIONS_DIR overrides');
    }
    const cwd = project ?? mcpWorkspace(meta) ?? process.cwd();
    const cached = contexts.get(cwd);
    if (cached) return cached;
    // Сначала всё, что может бросить, не заняв ресурс: иначе упавший resolveDecisionsDir
    // оставлял бы открытое соединение, которое некому закрыть — и так на каждый вызов.
    let dbPath: string, projectPath: string;
    try {
      ({ dbPath, projectPath } = resolveDbPath(cwd));
    } catch (e) {
      if (e instanceof KddError && e.message.startsWith('not in a git repository')) {
        throw new KddError(`Cannot resolve KDD store: git found no repository at '${cwd}'. `
          + 'Use list_projects and pass project to the tool.');
      }
      throw e;
    }
    const dir = resolveDecisionsDir(cwd);
    const ctx = { db: openDb(dbPath, projectPath), dir };
    contexts.set(cwd, ctx);
    return ctx;
  };
}

const codexTurn = (meta?: Meta): Record<string, unknown> | undefined => {
  const raw = meta?.['x-codex-turn-metadata'];
  let turn: unknown = raw;
  if (typeof raw === 'string') {
    try { turn = JSON.parse(raw); } catch { turn = undefined; }
  }
  return turn && typeof turn === 'object' ? turn as Record<string, unknown> : undefined;
};

const mcpWorkspace = (meta?: Meta): string | undefined => {
  const workspaces = codexTurn(meta)?.workspaces;
  if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) return undefined;
  return Object.keys(workspaces).find(Boolean);
};

/**
 * Тот же id, что у CLI (`agentId`): один агент в одной сессии обязан писаться одним автором,
 * иначе «сдал через kdd — принял через MCP» проходит мимо гейта на самоприёмку. Экспортируется
 * ради теста — расхождение с CLI уже было баг.
 */
export const mcpActor = (meta?: Record<string, unknown>, project?: string): Actor => {
  const hasTurnMetadata = !!meta && Object.hasOwn(meta, 'x-codex-turn-metadata');
  const values = codexTurn(meta);
  const cwd = project ?? mcpWorkspace(meta) ?? process.cwd();
  const normalizedTurnId = normalizeSessionId(values?.session_id)
    ?? normalizeSessionId(values?.thread_id)
    ?? normalizeSessionId(values?.threadId);
  const manualSession = process.env.KDD_SESSION ? undefined
    : normalizedTurnId
      ? { client: 'codex' as const, sessionId: normalizedTurnId, cwd }
      : hasTurnMetadata ? { client: 'codex' as const, cwd } : manualSessionFromEnv(cwd);
  if (values) {
    const id = values.session_id ?? values.thread_id ?? values.threadId;
    if (typeof id === 'string' && id) {
      return { type: 'ai', id: 'codex:' + id, ...(manualSession ? { manualSession } : {}) };
    }
  }
  return { type: 'ai', id: agentId() ?? 'mcp', ...(manualSession ? { manualSession } : {}) };
};

export async function startServer(): Promise<void> {
  await createServer(lazyCtx()).connect(new StdioServerTransport());
}
