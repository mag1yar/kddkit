import Database from 'better-sqlite3';

declare const CAPS: {
    readonly boardRows: 8;
    readonly listRows: 20;
    readonly statusRows: 5;
    readonly statusBytes: 2048;
    readonly statusEvents: 5;
    readonly titleChars: 50;
    readonly blockReasonChars: 40;
    readonly bodyChars: 8192;
    readonly comments: 20;
    readonly commentChars: 500;
    readonly events: 10;
    readonly files: 20;
    readonly fileDescChars: 200;
    readonly fileNameChars: 100;
    readonly recallK: 10;
    readonly recallKMax: 50;
    readonly recallSnippetTokens: 12;
    readonly recallBytes: 4096;
    readonly recallTitleChars: 60;
    readonly trackDescChars: 200;
    readonly fileBytes: number;
    readonly agentFieldChars: 4096;
    readonly agentDetailItems: 64;
    readonly agentDetailBytes: 65536;
    readonly agentEventDays: 7;
    readonly agentPruneBatch: 5000;
};
declare function capText(s: string, n: number): string;

declare const now: () => number;
declare const MIGRATIONS: string[];
declare function openDb(dbPath: string, projectPath?: string): Database.Database;
declare function checkpointWal(db: Database.Database): void;
declare function closeDb(db: Database.Database): void;
declare function projectPathOf(db: Database.Database): string | null;
declare function projectToplevelOf(db: Database.Database): string | null;
declare function setProjectToplevel(db: Database.Database, toplevel: string): void;

declare class KddError extends Error {
}
declare function logError(db: Database.Database, source: string, message: string): void;

declare const kddHome: () => string;
declare function resolveDbPath(cwd?: string): {
    dbPath: string;
    projectPath: string;
};
declare function resolveDecisionsDir(cwd?: string): string;
declare function resolveToplevel(cwd?: string): string;
declare function listProjects(): {
    dbPath: string;
    projectPath: string;
    autoTickEnabled: boolean;
}[];

type Status = 'backlog' | 'new' | 'in_progress' | 'review' | 'done';
declare const STATUSES: Status[];
type Priority = 'low' | 'medium' | 'high' | 'urgent';
declare const PRIORITIES: Priority[];
type Kind = 'feature' | 'bug' | 'chore' | 'research';
declare const KINDS: Kind[];
type Actor = {
    type: 'user' | 'ai';
    id?: string;
};
declare const TRANSITIONS: Record<Status, Status[]>;
declare const authorOf: (a: Actor) => string;
/**
 * Личность агента из окружения. Общая для CLI и MCP: в одной сессии оба пути обязаны писаться
 * одним автором, иначе гейт «сдал — не принимаешь» обходится сменой транспорта, а две разные
 * сессии под общим id ловят ложный запрет.
 * KDD_SESSION — явное слово (его ставят tick/worker), дальше метки самого Claude Code. Без них
 * id нет, актор безымянный (`ai:?`) и неотличим от другого такого же — на этом сравнении держится
 * ещё и fence по lease, поэтому pid сессии берём как последнюю зацепку, а не как первую.
 */
declare function agentId(): string | undefined;
/**
 * @param submittedBy автор последнего перехода в review (`authorOf`), null — если его не было
 */
declare function checkMove(from: Status, to: Status, actor: Actor, reason?: string, openCriteria?: number, claimedBy?: string | null, submittedBy?: string | null): {
    ok: true;
} | {
    ok: false;
    error: string;
};

interface Task {
    id: number;
    title: string;
    body: string | null;
    status: Status;
    blocked: 0 | 1;
    block_reason: string | null;
    priority: Priority;
    area: string | null;
    kind: Kind;
    track_id: number | null;
    claimed_by: string | null;
    claim_expires: number | null;
    failed_attempts: number;
    position: number;
    archived_at: number | null;
    created_at: number;
    updated_at: number;
}
interface TaskListRow extends Task {
    ready: 0 | 1;
    criteria_checked: number;
    criteria_total: number;
}
interface Track {
    id: number;
    name: string;
    description: string | null;
    status: 'active' | 'done';
    created_at: number;
}
interface Criterion {
    id: number;
    task_id: number;
    text: string;
    checked_at: number | null;
    position: number;
    created_at: number;
}
interface Comment {
    id: number;
    task_id: number;
    author: string;
    body: string;
    created_at: number;
}
interface FileRow {
    id: number;
    task_id: number;
    sha256: string;
    ext: string;
    original_name: string;
    mime_type: string | null;
    size_bytes: number;
    description: string | null;
    created_at: number;
}
interface EventRow {
    id: number;
    task_id: number | null;
    actor_type: 'user' | 'ai';
    actor_id: string | null;
    action: string;
    detail: string | null;
    created_at: number;
    parent_id: number | null;
    type: string | null;
    level: 'info' | 'warn' | 'error';
}

declare function appendEvent(db: Database.Database, taskId: number | null, actor: Actor, action: string, detail?: object, opts?: {
    parent_id?: number;
    type?: string;
    level?: 'info' | 'warn' | 'error';
}): number;
declare function mustGetTask(db: Database.Database, id: number): Task;
declare const BUG_BODY_TEMPLATE = "## Steps\n\n## Expected\n\n## Actual\n";
declare function addTask(db: Database.Database, input: {
    title: string;
    body?: string;
    priority?: Priority;
    area?: string;
    track_id?: number;
    criteria?: string[];
    kind?: Kind;
}, actor: Actor): Task;
declare function editTask(db: Database.Database, id: number, patch: {
    title?: string;
    body?: string;
    priority?: Priority;
    area?: string;
    track_id?: number | null;
    kind?: Kind;
}, actor: Actor): Task;
declare function commentTask(db: Database.Database, id: number, body: string, actor: Actor): Comment;
declare function moveTask(db: Database.Database, id: number, to: string, actor: Actor, reason?: string): Task;
declare function placeTask(db: Database.Database, id: number, to: string, orderedIds: number[], actor: Actor): Task;
declare function blockTask(db: Database.Database, id: number, reason: string, actor: Actor): Task;
declare function unblockTask(db: Database.Database, id: number, actor: Actor): Task;
declare function linkTasks(db: Database.Database, fromId: number, toId: number, kind: string, actor: Actor): void;
declare function archiveTask(db: Database.Database, id: number, actor: Actor): Task;
declare function unarchiveTask(db: Database.Database, id: number, actor: Actor): Task;

declare function listCriteria(db: Database.Database, taskId: number): Criterion[];
declare function addCriterion(db: Database.Database, taskId: number, text: string, actor: Actor): Criterion;
declare function setCriterionChecked(db: Database.Database, taskId: number, id: number, checked: boolean, actor: Actor): Criterion;
declare function removeCriterion(db: Database.Database, taskId: number, id: number, actor: Actor): void;

declare const isInlineMime: (m: string | null) => boolean;
declare const filesDir: (dbPath: string) => string;
declare const filePath: (dbPath: string, f: FileRow) => string;
declare function listFiles(db: Database.Database, taskId: number): FileRow[];
declare function getFile(db: Database.Database, id: number): FileRow | undefined;
declare function attachFile(db: Database.Database, dbPath: string, taskId: number, srcPath: string, opts: {
    description?: string;
}, actor: Actor): FileRow;
declare function detachFile(db: Database.Database, dbPath: string, fileId: number, actor: Actor): void;

declare function mustGetTrack(db: Database.Database, id: number): Track;
declare function createTrack(db: Database.Database, input: {
    name: string;
    description?: string;
}): Track;
declare function editTrack(db: Database.Database, id: number, patch: {
    name?: string;
    description?: string;
    status?: 'active' | 'done';
}): Track;
declare function deleteTrack(db: Database.Database, id: number): void;
declare function listTracks(db: Database.Database, opts?: {
    status?: 'active' | 'done';
}): (Track & {
    open_tasks: number;
})[];

interface DecisionInput {
    title: string;
    decision?: string;
    rationale?: string;
    alternatives?: string;
    outcome?: string;
    supersedes?: string;
    body?: string;
}
interface ParsedDecision {
    title: string;
    created: string;
    status: string;
    supersededBy: string;
    indexBody: string;
    hash: string;
}
declare function slugify(title: string): string;
declare function contentHash(title: string, body: string): string;
declare function renderDecisionBody(input: DecisionInput): string;
declare function renderDecisionMd(input: DecisionInput, created: string): string;
declare function parseDecisionMd(raw: string): ParsedDecision;
declare function addDecision(db: Database.Database, decisionsDir: string, input: DecisionInput): {
    slug: string;
    path: string;
    created: boolean;
};

declare function syncIndex(db: Database.Database, decisionsDir: string): void;
interface RecallHit {
    kind: 'decision' | 'task';
    ref: string;
    title: string;
    snippet: string;
    superseded_by: string;
    status: string | null;
}
declare function sanitizeQuery(q: string): string;
declare function recall(db: Database.Database, decisionsDir: string, query: string, opts?: {
    k?: number;
    kind?: 'decision' | 'task';
}): RecallHit[];
declare function rebuild(db: Database.Database, decisionsDir: string): {
    decisions: number;
    tasks: number;
};

declare const PRIORITY_ORDER = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";
declare function boardData(db: Database.Database, f?: {
    area?: string;
    status?: Status;
    archived?: boolean;
    track_id?: number;
    ready?: boolean;
    kind?: Kind;
}): Record<Status, TaskListRow[]>;
declare function taskDetail(db: Database.Database, id: number): {
    task: Task;
    criteria: Criterion[];
    comments: Comment[];
    events: EventRow[];
    links: {
        id: number;
        title: string;
        kind: string;
    }[];
    files: (FileRow & {
        path: string;
    })[];
    agent_runs_total: number;
};
interface TaskDetailCapped {
    task: Task;
    criteria: Criterion[];
    comments: Comment[];
    comments_total: number;
    events: EventRow[];
    events_total: number;
    links: {
        id: number;
        title: string;
        kind: string;
    }[];
    files: (FileRow & {
        path: string;
    })[];
    files_total: number;
}
declare function taskDetailCapped(db: Database.Database, id: number): TaskDetailCapped;
declare function statusDigest(db: Database.Database): {
    in_progress: Task[];
    review: Task[];
    blocked: Task[];
    recent: EventRow[];
};
declare function exportBoard(db: Database.Database): {
    tasks: Task[];
    comments: Comment[];
    links: unknown[];
    events: EventRow[];
};
/**
 * Задачи, где работа выглядит законченной, а статус — нет: все критерии закрыты, задача
 * всё ещё в `in_progress`. `author` — тот, кто поставил ПОСЛЕДНЮЮ галку (формат `authorOf`).
 *
 * Адресат именно он, а не тот, кто перевёл задачу в работу: в работу её чаще ставит человек
 * на доске, а потом просит сделать — по такому признаку напоминание не пришло бы никому.
 * Факт берём из журнала, а не из отдельной колонки: он уже записан и одинаков для всех путей
 * (CLI, MCP, доска).
 *
 * Задача под чужим ai-lease не возвращается: `checkMove` откажет такому актору («lease lost»),
 * и напоминание стоило бы ему хода на выяснение того, что двигать её нельзя. Условие держим
 * в тех же терминах, что и fence — user-held и незанятые задачи не трогаем.
 */
declare function unsubmitted(db: Database.Database, author: string): number[];

declare const DEFAULT_TTL: number;
declare const MAX_FAILED_ATTEMPTS = 3;
declare function recordFailedAttempt(db: Database.Database, id: number, actor: Actor, reason: string): void;
declare function releaseClaim(db: Database.Database, id: number, actor: Actor, reason: string): void;
interface ReclaimedLease {
    id: number;
    claimed_by: string | null;
}
type KillOutcome = 'gone' | 'absent' | 'stuck';
type KillFn = (taskIds: number[]) => Map<number, KillOutcome>;
declare function expiredLeases(db: Database.Database): ReclaimedLease[];
declare function reclaimExpired(db: Database.Database, opts?: {
    except?: ReadonlySet<number>;
}): ReclaimedLease[];
interface ReapResult {
    reclaimed: ReclaimedLease[];
    killed: number;
    stuck: number;
}
declare function reapExpired(db: Database.Database, kill?: KillFn): ReapResult;
interface StopResult {
    killed: number;
    released: number;
    stuck: number;
}
declare function stopWorkers(db: Database.Database, kill?: KillFn): StopResult;
declare function claimTask(db: Database.Database, id: number, actor: Actor, ttl?: number, opts?: {
    kill?: KillFn;
}): {
    ok: true;
    task: Task;
} | {
    ok: false;
    error: string;
};
declare function claimNext(db: Database.Database, actor: Actor, ttl?: number, opts?: {
    reclaim?: boolean;
    kill?: KillFn;
}): Task | null;
declare function renewClaim(db: Database.Database, id: number, actor: Actor, ttl?: number, opts?: {
    log?: boolean;
}): {
    ok: true;
    task: Task;
} | {
    ok: false;
    error: string;
};

interface TickResult {
    reclaimed: number;
    killed: number;
    stuck: number;
    spawned: number;
    active: number;
}
type SpawnFn = (taskId: number, workerId: string, projectDir: string) => void;
declare function tick(db: Database.Database, opts: {
    maxWorkers: number;
    ttl: number;
    projectDir: string;
    spawn: SpawnFn;
    kill?: KillFn;
}): TickResult;

type AgentEventKind = 'run_start' | 'text' | 'tool_start' | 'tool_finish' | 'error' | 'run_end';
interface AgentEvent {
    id: number;
    task_id: number;
    worker_id: string;
    kind: AgentEventKind;
    name: string | null;
    detail: string | null;
    created_at: number;
}
interface ParsedEvent {
    kind: AgentEventKind;
    name?: string;
    detail?: object;
}
declare function parseClaudeStreamLine(line: string): ParsedEvent[];
declare function redact(s: string): string;
declare function capDetail(detail: object): string;
declare function appendAgentEvent(db: Database.Database, taskId: number, workerId: string, kind: AgentEventKind, opts?: {
    name?: string;
    detail?: object;
}): number;
declare function pruneAgentEvents(db: Database.Database, days?: 7, opts?: {
    force?: boolean;
}): number;
declare function listAgentEvents(db: Database.Database, taskId: number, opts?: {
    sinceId?: number;
    limit?: number;
}): AgentEvent[];
declare function lastAgentEventKind(db: Database.Database, taskId: number, workerId: string): AgentEventKind | null;
interface RunResult {
    before: string;
    after: string;
    committed: boolean;
}
declare function runProduced(db: Database.Database, taskId: number): RunResult | null;

declare function worktreePath(dbPath: string, taskId: number, title: string): string;
declare function headCommit(repoRoot: string): string;
declare function taskBranchHead(repoRoot: string, taskId: number): string | null;
declare function ensureWorktree(repoRoot: string, dbPath: string, taskId: number, title: string): string;
declare function sweepWorktrees(db: Database.Database, repoRoot: string, isBusy?: (taskId: number) => boolean): number;

/** Версия kdd. Все пакеты бампаются в локстепе (bumpp --all), поэтому версия core — общая. */
declare function kddVersion(): string;
/**
 * Разбор `repository.url`. Суффикс `.git` снимаем отдельным шагом, а не запретом точек
 * в имени: имя репозитория точки содержать может (`acme/kddkit.dev.git`), и запрет резал
 * его до `kddkit` — форк уходил в вечный 404 ровно в том сценарии, ради которого слаг
 * вообще выводится из package.json.
 */
declare function parseRepoUrl(url: string): {
    owner: string;
    repo: string;
} | null;
/** Слаг выводим из package.json, а не хардкодим: форк не должен поллить апстрим. */
declare function repoSlug(): {
    owner: string;
    repo: string;
} | null;
/**
 * >0 если a новее b. Хватает MAJOR.MINOR.PATCH[-PRERELEASE] — полный semver не нужен,
 * зависимость ради этого не тянем.
 */
declare function compareVersions(a: string, b: string): number;
interface Release {
    version: string;
    url: string;
    body: string;
    publishedAt: string;
    prerelease: boolean;
}
interface ReleaseInfo {
    current: string;
    latest: string | null;
    hasUpdate: boolean;
    releases: Release[];
    repoUrl: string | null;
    error: string | null;
}
/** Только для тестов: сбросить кэш между кейсами. */
declare function _resetCache(): void;
/** Только для тестов: момент истечения кэша — чтобы проверять, каким TTL накрыт кейс. */
declare function _cacheUntil(): number | null;
/**
 * Список релизов с GitHub + вывод «есть ли апдейт». Никогда не бросает: любой отказ
 * сводится к error-строке, current при этом на месте (читается локально).
 *
 * Кэш в памяти обязателен, а не желателен: лимит GitHub без токена — 60 запросов в час
 * на IP, а UI открыт постоянно. Ошибку кэшируем тоже, иначе ретраи выжигают лимит быстрее
 * успехов. fetch пробрасывается параметром — так тесты идут без сети.
 */
declare function releaseInfo(opts?: {
    fetch?: typeof globalThis.fetch;
}): Promise<ReleaseInfo>;

declare const TICK_INTERVALS: readonly [30, 60, 300, 900];
declare const MAX_WORKERS_CAP = 10;
interface AutoTick {
    enabled: boolean;
    intervalSec: number;
    maxWorkers: number;
}
interface TickRun {
    at: number;
    reclaimed: number;
    killed: number;
    stuck: number;
    spawned: number;
    active: number;
    reaped: number;
    skipped?: boolean;
    error?: string;
}
declare function getAutoTick(db: Database.Database): AutoTick;
declare function setAutoTick(db: Database.Database, patch: Partial<AutoTick>): AutoTick;
declare function getLastRun(db: Database.Database): TickRun | null;
declare function setLastRun(db: Database.Database, run: TickRun): void;
declare function maxWorkers(db: Database.Database): number;
declare const maxWorkersEnvLocked: () => boolean;
/**
 * Дедуп Stop-напоминаний (#119): одно напоминание на задачу за сессию. `Stop` срабатывает на
 * каждом ходу, и хук, повторяющий одно и то же, читается как шум.
 *
 * Строка одна на всю базу, но внутри — список пар session/ids, а не одна пара: store keyed по
 * git-common-dir, так что все воркеры одного репо делят этот `meta`-ключ. Одна пара на всех
 * значила бы, что вторая параллельная сессия при каждом ходе стирает дедуп первой — и обе
 * напоминают на каждом ходу вечно, ровно тот шум, для которого дедуп существует. Список с
 * потолком в MAX_REMINDED_SESSIONS держит строку одной и ограниченной без отдельной таблицы.
 */
declare function getReminded(db: Database.Database, session: string): number[];
declare function setReminded(db: Database.Database, session: string, ids: number[]): void;

export { type Actor, type AgentEvent, type AgentEventKind, type AutoTick, BUG_BODY_TEMPLATE, CAPS, type Comment, type Criterion, DEFAULT_TTL, type DecisionInput, type EventRow, type FileRow, KINDS, KddError, type KillFn, type KillOutcome, type Kind, MAX_FAILED_ATTEMPTS, MAX_WORKERS_CAP, MIGRATIONS, PRIORITIES, PRIORITY_ORDER, type ParsedDecision, type ParsedEvent, type Priority, type ReapResult, type RecallHit, type ReclaimedLease, type Release, type ReleaseInfo, type RunResult, STATUSES, type SpawnFn, type Status, type StopResult, TICK_INTERVALS, TRANSITIONS, type Task, type TaskDetailCapped, type TaskListRow, type TickResult, type TickRun, type Track, _cacheUntil, _resetCache, addCriterion, addDecision, addTask, agentId, appendAgentEvent, appendEvent, archiveTask, attachFile, authorOf, blockTask, boardData, capDetail, capText, checkMove, checkpointWal, claimNext, claimTask, closeDb, commentTask, compareVersions, contentHash, createTrack, deleteTrack, detachFile, editTask, editTrack, ensureWorktree, expiredLeases, exportBoard, filePath, filesDir, getAutoTick, getFile, getLastRun, getReminded, headCommit, isInlineMime, kddHome, kddVersion, lastAgentEventKind, linkTasks, listAgentEvents, listCriteria, listFiles, listProjects, listTracks, logError, maxWorkers, maxWorkersEnvLocked, moveTask, mustGetTask, mustGetTrack, now, openDb, parseClaudeStreamLine, parseDecisionMd, parseRepoUrl, placeTask, projectPathOf, projectToplevelOf, pruneAgentEvents, reapExpired, rebuild, recall, reclaimExpired, recordFailedAttempt, redact, releaseClaim, releaseInfo, removeCriterion, renderDecisionBody, renderDecisionMd, renewClaim, repoSlug, resolveDbPath, resolveDecisionsDir, resolveToplevel, runProduced, sanitizeQuery, setAutoTick, setCriterionChecked, setLastRun, setProjectToplevel, setReminded, slugify, statusDigest, stopWorkers, sweepWorktrees, syncIndex, taskBranchHead, taskDetail, taskDetailCapped, tick, unarchiveTask, unblockTask, unsubmitted, worktreePath };
