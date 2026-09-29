import Database from 'better-sqlite3';
import { ChildProcess } from 'node:child_process';

declare const CAPS: {
    readonly briefBytes: 4096;
    readonly boardRows: 8;
    readonly listRows: 20;
    readonly attentionRows: 20;
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
    readonly decisions: 20;
    readonly decisionSources: 20;
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

declare const MIGRATIONS: string[];

declare const now: () => number;
declare function openDb(dbPath: string, projectPath?: string, checkout?: string): Database.Database;
declare function checkpointWal(db: Database.Database): void;
declare function closeDb(db: Database.Database): void;
declare function projectPathOf(db: Database.Database): string | null;
declare function projectToplevelOf(db: Database.Database): string | null;
declare function setProjectToplevel(db: Database.Database, toplevel: string): void;

declare class KddError extends Error {
}
declare function logError(db: Database.Database, source: string, message: string): void;

declare const kddHome: () => string;
declare const storeIdentity: () => string;
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
declare const MAX_FAILED_ATTEMPTS = 3;
type Priority = 'low' | 'medium' | 'high' | 'urgent';
declare const PRIORITIES: Priority[];
type Kind = 'feature' | 'bug' | 'chore' | 'research';
declare const KINDS: Kind[];
interface ManualSession {
    client: 'claude' | 'codex';
    sessionId?: string;
    cwd: string;
}
type Actor = {
    type: 'user' | 'ai';
    id?: string;
    manualSession?: ManualSession;
};
declare function normalizeSessionId(raw: unknown): string | undefined;
declare function manualSessionFromEnv(cwd?: string): ManualSession | undefined;
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

type RepositoryAccess = 'context_only' | 'implementation';
type BindingKind = 'source' | 'managed';
interface ProjectRecord {
    project_id: string;
    primary_repo_id: string | null;
    legacy_decisions_dir: string | null;
    autonomy_enabled: boolean;
    default_execution_mode: 'manual' | 'orchestrated';
    created_at: number;
}
interface RepositoryRecord {
    repo_id: string;
    purpose: string;
    access: RepositoryAccess;
    remote: string | null;
    created_at: number;
}
interface RepositoryBinding {
    common_dir: string;
    repo_id: string;
    checkout_path: string;
    kind: BindingKind;
    created_at: number;
}
declare function projectOf(db: Database.Database): ProjectRecord;
declare function repositoriesOf(db: Database.Database): RepositoryRecord[];
declare function bindingsOf(db: Database.Database): RepositoryBinding[];
declare function canonicalCommonDir(cwd: string): string;
declare function canonicalProjectPath(path: string): string;
declare function lookupProjectStore(commonDir: string, home: string): {
    dbPath: string;
    projectPath: string;
} | undefined;
declare function initializeProjectStore(db: Database.Database, dbPath: string, home: string, projectPath?: string, checkout?: string, options?: {
    legacyUpgrade?: boolean;
    configuredDecisions?: string;
}): void;
declare function listProjectCheckouts(home: string): string[];
declare function bindRepository(db: Database.Database, dbPath: string, home: string, input: {
    cwd: string;
    repoId: string;
    kind: BindingKind;
}, actor: Actor): RepositoryBinding;
declare function addRepository(db: Database.Database, dbPath: string, home: string, input: {
    cwd: string;
    purpose: string;
    access: RepositoryAccess;
}, actor: Actor): {
    repository: RepositoryRecord;
    binding: RepositoryBinding;
};
declare function rebindRepository(db: Database.Database, dbPath: string, home: string, input: {
    fromCommonDir: string;
    cwd: string;
}, actor: Actor): RepositoryBinding;
declare function canSyncLegacyDecisions(db: Database.Database, decisionsDir: string): boolean;
declare function assertLegacyDecisionSource(db: Database.Database, decisionsDir: string): void;

interface ControllerHandle {
    readonly kind: 'controller';
}
declare function openController(db: Database.Database): ControllerHandle;

type ExecutionMode = 'manual' | 'orchestrated';
interface TaskRef {
    projectId: string;
    taskId: number;
}
interface AuthorityBinding {
    authorityId: string;
    runId: string;
    workItemId: string;
    generation: number;
}
type CreationSource = {
    kind: 'manual';
    sourceTask: TaskRef;
    instructionRef: string;
} | {
    kind: 'run';
    sourceTask: TaskRef;
    authority: AuthorityBinding;
    proposalEventId: number;
};
interface SubtaskDraft {
    key: string;
    title: string;
    body?: string;
    criteria: readonly string[];
    kind?: Kind;
    priority?: Priority;
    area?: string;
    trackId?: number;
    executionMode?: ExecutionMode;
}
interface CreateSubtasksInput {
    parent: TaskRef;
    expectedParentHash: string;
    source: CreationSource;
    children: readonly SubtaskDraft[];
}
declare function taskContractHash(handle: ControllerHandle, ref: TaskRef): string;
declare function createSubtasks(handle: ControllerHandle, input: CreateSubtasksInput): Record<string, Task>;
declare function listSubtasks(handle: ControllerHandle, parent: TaskRef): Task[];
type WorkItemKind = 'analysis' | 'architecture' | 'implementation' | 'check' | 'integration' | 'human_action' | 'curation';
type WorkItemState = 'pending' | 'ready' | 'running' | 'waiting_input' | 'retry_wait' | 'completed' | 'failed' | 'cancelled';
type DependencyKind = 'contract' | 'code' | 'merged' | 'readiness';
interface WorkItemRef {
    projectId: string;
    workItemId: string;
}
interface OwnershipRef extends WorkItemRef {
    revision: number;
    ownerId: string;
    fence: number;
}
interface OutputRequirement {
    key: string;
    kind: DependencyKind;
    required: boolean;
    version: string;
    checkRefs: readonly string[];
}
interface WorkItemDefinition {
    kind: WorkItemKind;
    repoId: string | null;
    sourceTasks: readonly TaskRef[];
    outputs: readonly OutputRequirement[];
}
type DependencyBinding = {
    kind: 'contract';
    repoId: string | null;
    version: string;
} | {
    kind: 'code';
    repoId: string;
    version: string;
    baseHead: string;
} | {
    kind: 'merged';
    repoId: string;
    version: string;
    target: string;
    baseHead: string;
} | {
    kind: 'readiness';
    repoId: string | null;
    version: string;
    resourceId: string;
    configHash: string;
    consumerScope: string;
    capabilities: readonly string[];
};
interface DependencyInput {
    key: string;
    producer: WorkItemRef;
    producerRevision: number;
    outputKey: string;
    binding: DependencyBinding;
    resultId?: string;
}
interface WorkItemRecord {
    ref: WorkItemRef;
    task: TaskRef;
    revision: number;
    state: WorkItemState;
    fence: number;
    definition: WorkItemDefinition;
    inputs: readonly {
        task: TaskRef;
        hash: string;
    }[];
    inputsHash: string;
    dependencies: readonly DependencyInput[];
}
interface WorkItemInput {
    task: TaskRef;
    definition: WorkItemDefinition;
    dependencies: readonly DependencyInput[];
}
interface SubtaskPlanInput extends CreateSubtasksInput {
    workItems: readonly {
        key: string;
        childKey: string;
        definition: WorkItemDefinition;
    }[];
    dependencies: readonly {
        consumerKey: string;
        key: string;
        producer: {
            localKey: string;
        } | {
            ref: WorkItemRef;
            revision: number;
        };
        outputKey: string;
        binding: DependencyBinding;
        resultId?: string;
    }[];
}
declare function createWorkItem(handle: ControllerHandle, input: WorkItemInput): WorkItemRecord;
declare function reviseWorkItem(handle: ControllerHandle, input: {
    ref: WorkItemRef;
    expectedRevision: number;
    definition: WorkItemDefinition;
    dependencies: readonly DependencyInput[];
}): WorkItemRecord;
declare function workItem(handle: ControllerHandle, ref: WorkItemRef): WorkItemRecord;
declare function taskWorkItems(handle: ControllerHandle, task: TaskRef): WorkItemRecord[];
declare function createSubtaskPlan(handle: ControllerHandle, input: SubtaskPlanInput): {
    tasks: Record<string, Task>;
    workItems: Record<string, WorkItemRecord>;
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
    parent_id: number | null;
    execution_mode: ExecutionMode;
    track_id: number | null;
    claimed_by: string | null;
    claim_expires: number | null;
    failed_attempts: number;
    position: number;
    archived_at: number | null;
    created_at: number;
    updated_at: number;
}
type AttentionReason = 'needs_input' | 'review_rework' | 'await_acceptance' | 'stale_in_progress';
interface AttentionItem {
    id: number;
    title: string;
    status: Status;
    reason: AttentionReason;
    block_reason: string | null;
    last_activity: number;
}
interface AttentionInbox {
    items: AttentionItem[];
    omitted: number;
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
    evidence: string | null;
    checked_by: string | null;
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
interface ManualProvenance {
    client: 'claude' | 'codex';
    session_id?: string;
    worktree?: string;
    branch?: string;
    head_commit?: string;
}
interface SessionHandoff {
    from_client: 'claude' | 'codex';
    from_session_id: string;
    to_client: 'claude' | 'codex';
    to_session_id: string;
    event_id: number;
    at: number;
}
interface DecisionSummary {
    slug: string;
    title: string;
    created: string | null;
    superseded_by: string | null;
}
interface DecisionSourceTask {
    id: number;
    title: string;
    status: Status;
    archived_at: number | null;
}
interface DecisionDetail extends DecisionSummary {
    path: string;
    status: string;
    body: string;
    source_tasks: DecisionSourceTask[];
}

declare function appendEvent(db: Database.Database, taskId: number | null, actor: Actor, action: string, detail?: object, opts?: {
    parent_id?: number;
    type?: string;
    level?: 'info' | 'warn' | 'error';
}): number;
declare function appendTaskMutationEvent(db: Database.Database, taskId: number, actor: Actor, action: string, detail?: object, opts?: {
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
declare function setCriterionChecked(db: Database.Database, taskId: number, id: number, checked: boolean, actor: Actor, evidence?: string): Criterion;
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
    sourceTasks?: number[];
}
interface ParsedDecision {
    title: string;
    created: string;
    status: string;
    supersededBy: string;
    indexBody: string;
    hash: string;
    sourceTasks: number[];
}
declare function slugify(title: string): string;
declare function contentHash(title: string, body: string): string;
declare function normalizeSourceTasks(ids?: number[]): number[];
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

type MemoryKind = 'fact' | 'decision' | 'rule' | 'candidate';
type MemoryStatus = 'active' | 'withdrawn';
interface MemoryScope {
    projectId: string;
    taskId: number | null;
}
interface MemoryApplicability {
    repoId: string | null;
    commit: string | null;
}
interface MemoryRepoVersion {
    repoId: string;
    checkoutPath: string;
    commit: string;
}
interface MemoryView {
    scope: MemoryScope;
    repositories: readonly MemoryRepoVersion[];
}
interface MemoryRevisionRef {
    projectId: string;
    entryId: string;
    revision: number;
}
interface MemoryAuthor {
    type: 'user' | 'ai';
    id: string | null;
}
type MemorySource = {
    kind: 'user';
    ref: string;
} | {
    kind: 'host';
    ref: string;
} | {
    kind: 'run';
    task: TaskRef;
    authority: AuthorityBinding;
    reportEventId: number;
} | {
    kind: 'git';
    repoId: string;
    commit: string;
    path: string;
    sha256: string;
    documentStatus: 'active' | 'superseded' | 'unknown' | null;
} | {
    kind: 'revision';
    ref: MemoryRevisionRef;
    hash: string;
};
interface MemoryDraft {
    scope: MemoryScope;
    applicability: MemoryApplicability;
    kind: MemoryKind;
    status: MemoryStatus;
    title: string;
    body: string;
    source: MemorySource;
    author: MemoryAuthor;
}
interface MemoryWriteInput extends MemoryDraft {
    commandId: string;
    entryId: string | null;
    expectedRevision: number;
}
type MemoryOperation = 'create' | 'revise' | 'withdraw' | 'accept' | 'import';
interface MemoryEvidenceRequest {
    operation: MemoryOperation;
    entryId: string | null;
    expectedRevision: number;
    origin: 'user' | 'host';
    scope: MemoryScope;
    applicability: MemoryApplicability;
    payloadHash: string;
    source: MemorySource;
}
interface MemoryEvidenceObservation {
    request: MemoryEvidenceRequest;
    origin: 'user' | 'host';
    verdict: 'pass' | 'fail' | 'inconclusive';
    observedAt: number;
    expiresAt: number | null;
}
interface MemoryObservers {
    observe?: (request: MemoryEvidenceRequest) => MemoryEvidenceObservation | null;
}
interface MemoryReceipt {
    entryId: string;
    revision: number;
    currentRevision: number;
    hash: string;
    created: boolean;
    effectiveStatus: MemoryStatus | 'superseded';
}
interface MemoryRecord extends MemoryDraft {
    entryId: string;
    revision: number;
    currentRevision: number;
    predecessor: number | null;
    hash: string;
    createdAt: number;
    evidence: readonly MemoryEvidenceObservation[];
    effectiveStatus: MemoryStatus | 'superseded';
}
interface MemoryReadOptions {
    candidates?: boolean;
    withdrawn?: boolean;
}
interface MemoryRecallOptions extends MemoryReadOptions {
    k?: number;
}
interface MemoryHit {
    ref: MemoryRevisionRef;
    hash: string;
    kind: MemoryKind;
    status: MemoryStatus;
    effectiveStatus: MemoryStatus | 'superseded';
    title: string;
    snippet: string;
    source: MemorySource;
    scope: MemoryScope;
    applicability: MemoryApplicability;
}
declare function writeMemory(handle: ControllerHandle, input: MemoryWriteInput, observers?: MemoryObservers): MemoryReceipt;

declare function memoryEntry(handle: ControllerHandle, view: MemoryView, entryId: string, revision?: number): MemoryRecord;
declare function memoryHistory(handle: ControllerHandle, view: MemoryView, entryId: string): MemoryRecord[];
declare function listMemory(handle: ControllerHandle, view: MemoryView, options?: MemoryReadOptions): MemoryRecord[];
declare function memoryRules(handle: ControllerHandle, view: MemoryView): MemoryRecord[];
declare function recallMemory(handle: ControllerHandle, view: MemoryView, query: string, options?: MemoryRecallOptions): MemoryHit[];

interface MemoryImportInput {
    commandId: string;
    scope: MemoryScope;
    applicability: MemoryApplicability;
    repoId: string;
    checkoutPath: string;
    commit: string;
    path: string;
    sha256: string;
    kind?: MemoryKind;
    status?: MemoryStatus;
    author: MemoryAuthor;
}
declare function importMemory(handle: ControllerHandle, input: MemoryImportInput, observers?: MemoryObservers): MemoryReceipt;

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
    decisions: DecisionSummary[];
    files: (FileRow & {
        path: string;
    })[];
    agent_runs_total: number;
    manual_provenance?: ManualProvenance;
    handoffs: SessionHandoff[];
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
    decisions: DecisionSummary[];
    decisions_total: number;
    files: (FileRow & {
        path: string;
    })[];
    files_total: number;
    manual_provenance?: ManualProvenance;
    handoffs: SessionHandoff[];
    handoffs_total: number;
}
declare function taskDetailCapped(db: Database.Database, id: number): TaskDetailCapped;
declare function syncedTaskDetail(db: Database.Database, decisionsDir: string, id: number, full: true): ReturnType<typeof taskDetail>;
declare function syncedTaskDetail(db: Database.Database, decisionsDir: string, id: number, full?: false): TaskDetailCapped;
declare function syncedTaskDetail(db: Database.Database, decisionsDir: string, id: number, full?: boolean): ReturnType<typeof taskDetail> | TaskDetailCapped;
declare function decisionDetail(db: Database.Database, decisionsDir: string, slug: string): DecisionDetail;
declare function statusDigest(db: Database.Database): {
    in_progress: Task[];
    review: Task[];
    blocked: Task[];
    recent: EventRow[];
};
declare function attentionData(db: Database.Database, nowSeconds: number): AttentionInbox;
declare function exportBoard(db: Database.Database, decisionsDir: string, opts?: {
    includeSensitive?: boolean;
}): {
    schema_version: 1;
    tasks: Omit<Task, "claimed_by" | "claim_expires" | "failed_attempts">[];
    tracks: Track[];
    criteria: Criterion[];
    comments: Comment[];
    task_links: {
        from_id: number;
        to_id: number;
        kind: string;
    }[];
    decisions: {
        source_task_ids: number[];
        body: string;
        slug: string;
        title: string;
        created: string | null;
        superseded_by: string | null;
    }[];
    events: {
        detail: string | null;
        id: number;
        task_id: number | null;
        actor_type: "user" | "ai";
        actor_id: string | null;
        action: string;
        created_at: number;
        parent_id: number | null;
        type: string | null;
        level: "info" | "warn" | "error";
    }[];
    files: FileRow[];
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
type UpdateChannel = 'stable' | 'next';
declare function versionChannel(version: string): UpdateChannel | null;
declare function updateDisposition(current: string, target: string, channel: UpdateChannel): 'install' | 'current' | 'ahead';
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
    next: string | null;
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
    fresh?: boolean;
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

interface BriefSection<T> {
    items: T[];
    omitted: number;
}
type NextAction = {
    kind: 'resolve_blocker' | 'start_work' | 'complete_criterion' | 'submit_review' | 'await_acceptance' | 'await_controller' | 'archived' | 'done';
    text: string;
    criterion_id?: number;
};
interface TaskBrief {
    task: {
        id: number;
        title: string;
        goal: string | null;
        status: Status;
        blocked: boolean;
        block_reason: string | null;
        priority: Priority;
        kind: Kind;
        area: string | null;
        archived_at: number | null;
        parent_id: number | null;
        execution_mode: ExecutionMode;
    };
    criteria: BriefSection<{
        id: number;
        text: string;
        checked_at: number | null;
        evidence?: string;
        checked_by?: string;
    }>;
    comments: BriefSection<{
        id: number;
        author: string;
        body: string;
        created_at: number;
    }>;
    events: BriefSection<{
        id: number;
        actor_type: 'user' | 'ai';
        actor_id?: string;
        action: string;
        detail?: string;
        created_at: number;
    }>;
    links: BriefSection<{
        id: number;
        title: string;
        kind: string;
    }>;
    decisions: BriefSection<{
        slug: string;
        title: string;
        created: string | null;
        superseded_by: string | null;
    }>;
    files: BriefSection<{
        id: number;
        name: string;
        mime_type: string | null;
        size_bytes: number;
        description: string | null;
        path: string;
    }>;
    manual_provenance?: ManualProvenance;
    handoffs: BriefSection<SessionHandoff>;
    provenance?: {
        worker_id?: string;
        session_id?: string;
        branch?: string;
        worktree?: string;
        before_commit?: string;
        after_commit?: string;
        error?: string;
    };
    worker_provenance_omitted?: boolean;
    next_action: NextAction;
    budget: {
        max_bytes: 4096;
    };
}
declare function taskBrief(db: Database.Database, decisionsDir: string, id: number): TaskBrief;

/** A successful scan is not a launch permit: start/resume must scan again under the controller lock. */
declare function assertWritableRoots(roots: readonly string[]): readonly string[];
/** Trusted controller filesystem/config mutations must use this same protected project directory. */
declare function withNativeControllerLock<T>(controlDir: string, action: () => T | Promise<T>): Promise<T>;
interface NativeLaunchInput {
    controlDir: string;
    writableRoots: readonly string[];
    executable: string;
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    phase: 'start' | 'resume';
    verified?: VerifiedCodexPackage;
}
/** Trusted-host primitive; the runtime adapter must bind its arguments to the verified native package. */
declare function spawnCheckedNative(input: NativeLaunchInput): Promise<ChildProcess>;
interface CodexPermissionInput {
    executable: string;
    cwd: string;
    controlDir: string;
    model: string;
    readableRoots: readonly string[];
    writableRoot?: string;
    scratchDir: string;
    protectedPaths: readonly string[];
    brokerConfigPath?: string;
    brokerEntryPath?: string;
}
interface NativeProbeResult {
    caseId: string;
    tool: string;
    outcome: 'allowed' | 'denied' | 'inconclusive';
    executed: boolean;
    unchangedProtectedBytes: boolean;
}
interface CodexBrokerBinding {
    configPath: string;
    entryPath: string;
    dbPath: string;
    nodePath: string;
}
interface VerifiedCodexPackage {
    readonly executable: string;
    readonly version: string;
    readonly cwd: string;
    readonly controlDir: string;
    readonly readableRoots: readonly string[];
    readonly writableRoot?: string;
    readonly scratchDir: string;
    readonly protectedPaths: readonly string[];
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly configHash: string;
    readonly results: readonly NativeProbeResult[];
}
declare function assertVerifiedCodexPackage(packet: unknown): asserts packet is VerifiedCodexPackage;
declare function preflightCodex(input: CodexPermissionInput): Promise<VerifiedCodexPackage>;

type ResultSource = {
    kind: 'manual';
    sourceTask: TaskRef;
    instructionRef: string;
} | {
    kind: 'owned';
    owner: OwnershipRef;
    authority?: AuthorityBinding;
    instructionRef: string;
};
interface PayloadBase {
    repoId: string | null;
    version: string;
    checkRefs: readonly string[];
}
type ResultPayload = (PayloadBase & {
    kind: 'contract';
    head: string | null;
    artifact: {
        path: string;
        sha256: string;
    };
}) | (PayloadBase & {
    kind: 'code';
    repoId: string;
    head: string;
    proofRef: string;
}) | (PayloadBase & {
    kind: 'merged';
    repoId: string;
    head: string;
    target: string;
    baseHead: string;
    acceptedResultId: string;
    userRef: string;
    receiptRef: string;
}) | (PayloadBase & {
    kind: 'readiness';
    resourceId: string;
    configHash: string;
    consumerScope: string;
    capabilities: readonly string[];
    userRef: string;
    probeRef: string;
    observedAt: number;
    expiresAt: number | null;
});
interface ResultBinding {
    producer: WorkItemRef;
    producerRevision: number;
    inputsHash: string;
    outputKey: string;
    kind: DependencyKind;
    version: string;
    repoId: string | null;
}
type EvidenceRequest = {
    kind: 'check';
    ref: string;
    binding: ResultBinding;
    payloadHash: string;
} | {
    kind: 'code_result';
    ref: string;
    binding: ResultBinding;
    head: string;
} | {
    kind: 'code_in_base';
    ref: string;
    binding: ResultBinding;
    head: string;
    baseHead: string;
} | {
    kind: 'merge_acceptance';
    ref: string;
    binding: ResultBinding;
    acceptedResultId: string;
} | {
    kind: 'merge_receipt';
    ref: string;
    binding: ResultBinding;
    acceptedResultId: string;
    target: string;
    baseHead: string;
    head: string;
} | {
    kind: 'readiness_confirmation';
    ref: string;
    binding: ResultBinding;
    resourceId: string;
} | {
    kind: 'readiness_probe';
    ref: string;
    binding: ResultBinding;
    resourceId: string;
    configHash: string;
    consumerScope: string;
    capabilities: readonly string[];
};
interface EvidenceObservation {
    request: EvidenceRequest;
    verdict: 'pass' | 'fail' | 'inconclusive';
    origin: 'host' | 'user';
    observedAt: number;
    expiresAt: number | null;
}
interface ResultObservers {
    observe?: (request: EvidenceRequest) => EvidenceObservation | null;
}
interface ResultRecord {
    id: string;
    commandId: string;
    binding: ResultBinding;
    payload: ResultPayload;
    source: ResultSource;
    inputResults: readonly {
        edgeKey: string;
        resultId: string;
    }[];
    invalidatedAt: number | null;
    invalidationReason: string | null;
    successorId: string | null;
}
interface PublishResultInput {
    commandId: string;
    producer: WorkItemRef;
    expectedRevision: number;
    outputKey: string;
    expectedResultId: string | null;
    payload: ResultPayload;
    source: ResultSource;
}
type DependencyReason = 'missing_output' | 'producer_not_completed' | 'failed' | 'cancelled' | 'stale_revision' | 'checks_not_passed' | 'base_missing_code' | 'merge_not_succeeded' | 'readiness_unconfirmed' | 'readiness_unverified' | 'readiness_expired' | 'scope_mismatch';
interface DependencyProjection {
    ref: WorkItemRef;
    revision: number;
    inputsCurrent: boolean;
    ready: boolean;
    edges: readonly ({
        key: string;
        producer: WorkItemRef;
        binding: DependencyBinding;
    } & ({
        satisfied: true;
        resultId: string;
        pinned: boolean;
    } | {
        satisfied: false;
        reason: DependencyReason;
        resultId: string | null;
    }))[];
}
declare function result(handle: ControllerHandle, resultId: string): ResultRecord;
declare function inspectDependencies(handle: ControllerHandle, ref: WorkItemRef, observers?: ResultObservers): DependencyProjection;
declare function resolveDependencies(handle: ControllerHandle, input: {
    ref: WorkItemRef;
    expectedRevision: number;
}, observers?: ResultObservers): DependencyProjection;
declare function publishResult(handle: ControllerHandle, input: PublishResultInput, observers?: ResultObservers): ResultRecord;
declare function invalidateResult(handle: ControllerHandle, input: {
    commandId: string;
    resultId: string;
    reason: string;
    successorId?: string;
}): ResultRecord;
declare function completeWorkItem(handle: ControllerHandle, input: {
    ref: WorkItemRef;
    expectedRevision: number;
    source: ResultSource;
}, observers?: ResultObservers): WorkItemRecord;
declare function setWorkItemWaiting(handle: ControllerHandle, input: {
    ref: WorkItemRef;
    expectedRevision: number;
    source: ResultSource;
}): WorkItemRecord;
declare function endWorkItem(handle: ControllerHandle, input: {
    ref: WorkItemRef;
    expectedRevision: number;
    source: ResultSource;
    state: 'failed' | 'cancelled';
}): WorkItemRecord;

interface RunInputOptions {
    maxBytes?: number;
    query?: string;
    k?: number;
}
interface RunInputRef {
    projectId: string;
    authorityId: string;
}
interface RequirementInput {
    task: TaskRef;
    parentId: number | null;
    hash: string;
    title: string;
    body: string | null;
    criteria: {
        id: number;
        text: string;
    }[];
}
type DependencyContextPayload = Exclude<ResultPayload, {
    kind: 'contract';
}> | Omit<Extract<ResultPayload, {
    kind: 'contract';
}>, 'artifact'>;
interface DependencyContextInput {
    edgeKey: string;
    resultId: string;
    payloadHash: string;
    binding: ResultBinding;
    payload: DependencyContextPayload;
    artifact?: {
        sha256: string;
        body: string;
    };
}
interface RunInputSections {
    schemaVersion: 1;
    authorityId: string;
    inputHash: string;
    createdAt: number;
    budget: {
        maxBytes: number;
        omittedRecords: number;
    };
    requirements: RequirementInput[];
    rules: MemoryRecord[];
    knowledge: MemoryRecord[];
    workItem: {
        ref: WorkItemRef;
        revision: number;
        inputsHash: string;
        definition: WorkItemDefinition;
    } | null;
    dependencies: DependencyContextInput[];
    repositories: {
        repoId: string;
        commit: string;
        write: boolean;
    }[];
    operations: RunOperation[];
    nativeConfigHash: string;
}
interface RunInputValidation {
    repositories: MemoryRepoVersion[];
    ownership: OwnershipRef | null;
    inputResults: {
        edgeKey: string;
        resultId: string;
    }[];
    artifacts: {
        resultId: string;
        path: string;
        sha256: string;
    }[];
}
interface RunInputSnapshot {
    authorityId: string;
    inputHash: string;
    createdAt: number;
    response: RunContextSnapshot & {
        inputs: RunInputSections;
    };
    validation: RunInputValidation;
}
declare function runInputSnapshot(handle: ControllerHandle, ref: RunInputRef): RunInputSnapshot;

type RunOperation = 'get_context' | 'submit_report' | 'request_question';
interface RunContext {
    readonly kind: 'run';
}
interface IssueRunInput {
    taskId: number;
    workItemId: string;
    runId: string;
    expectedGeneration: number;
    expiresAt: number;
    operations: readonly RunOperation[];
    repositories: readonly {
        repoId: string;
        checkoutPath: string;
        write: boolean;
    }[];
    native: VerifiedCodexPackage;
    ownership?: OwnershipRef;
    context?: RunInputOptions;
    contextObservers?: ResultObservers;
}
interface IssuedRunAuthority {
    authorityId: string;
    generation: number;
    token: string;
}
declare function assertLegacyTaskMutation(db: Database.Database, taskIds: readonly number[]): void;
declare function protectTask(handle: ControllerHandle, taskId: number): void;
declare function issueRunAuthority(handle: ControllerHandle, supplied: IssueRunInput): IssuedRunAuthority;
declare function revokeRunAuthority(handle: ControllerHandle, authorityId: string): void;
declare function assertRunAuthorityBinding(db: Database.Database, taskId: number, binding: AuthorityBinding): void;
declare function openRunContext(db: Database.Database, token: string): RunContext;
interface RunContextSnapshot {
    projectId: string;
    taskId: number;
    workItemId: string;
    runId: string;
    generation: number;
    task: {
        title: string;
        body: string | null;
        status: string;
    };
    criteria: {
        id: number;
        text: string;
        checked: boolean;
    }[];
    decisions: {
        slug: string;
        title: string;
    }[];
    inputs: RunInputSections;
}
declare function runOperations(context: RunContext): readonly RunOperation[];
declare function readRunContext(context: RunContext): RunContextSnapshot;
interface RunMemoryReadInput {
    entryId?: string;
    revision?: number;
    candidates?: boolean;
    withdrawn?: boolean;
}
declare function readRunMemory(context: RunContext, input?: RunMemoryReadInput): MemoryRecord[];
declare function recallRunMemory(context: RunContext, query: string, options?: MemoryRecallOptions): MemoryHit[];
declare function runMemoryRules(context: RunContext): MemoryRecord[];
declare const submitRunReport: (context: RunContext, body: string) => number;
declare const requestRunQuestion: (context: RunContext, body: string) => number;

interface NativeTool {
    name?: string;
    type: string;
    namespace?: string;
    tools?: NativeTool[];
}
interface NativeObservation extends NativeProbeResult {
    mode: 'readonly' | 'workspace';
    control: boolean;
    phase: 'start' | 'resume';
    exitCode: number | null;
    output: unknown;
    timedOut: boolean;
    providerError?: string;
    requests: unknown[];
    tools: NativeTool[];
    permissionHash: string;
    configHash: string;
    challengeHash?: string;
    protectedHashes: {
        path: string;
        before: string;
        after: string;
    }[];
    diagnostic?: string;
    failure?: string;
    matchedControl?: string;
}
interface NativeFailure {
    caseId?: string;
    mode?: string;
    reason?: string;
    failure?: string;
}
interface NativeRefusal {
    caseId: string;
    phase: 'start' | 'resume';
    outcome: 'denied';
    executed: false;
}
interface NetworkControl {
    caseId: string;
    role: string;
    exitCode: number;
    commandHash: string;
    output: string;
}
interface NativeEvidence {
    version: string;
    model: string;
    executableHash: string;
    scriptHash: string;
    guardHash: string;
    applicable: boolean;
    rawDiagnostic: boolean;
    preflight: NativeRefusal[];
    networkControls: NetworkControl[];
    attempted: number;
    executed: number;
    failures: NativeFailure[];
    observations: NativeObservation[];
    operations: readonly RunOperation[];
}
/** Actual Codex tools; the deterministic provider supplies model responses only. */
declare function observeCodexNative(executablePath: string, rawDiagnostic?: boolean, model?: string, broker?: CodexBrokerBinding, brokerOnly?: boolean): Promise<NativeEvidence>;

interface LaunchIntent {
    launchId: string;
    writerScopeId: string;
    authority?: AuthorityBinding;
}
interface OwnershipRecord {
    ref: OwnershipRef;
    mode: ExecutionMode;
    write: boolean;
    inputsHash: string;
    inputResults: readonly {
        edgeKey: string;
        resultId: string;
    }[];
    launchIntent: LaunchIntent | null;
    releasedAt: number | null;
}
interface ReserveWorkItemInput {
    ref: WorkItemRef;
    expectedRevision: number;
    expectedFence: number;
    expectedMode: ExecutionMode;
    ownerId: string;
    write: boolean;
}
interface HandoffRecord {
    id: string;
    commandId: string;
    task: TaskRef;
    expectedMode: ExecutionMode;
    targetMode: ExecutionMode;
    owners: readonly OwnershipRecord[];
    authorities: readonly AuthorityBinding[];
    receipt: HandoffReceipt | null;
}
interface HandoffReceipt {
    handoffId: string;
    task: TaskRef;
    mode: ExecutionMode;
    released: readonly OwnershipRef[];
    revokedAuthorityIds: readonly string[];
    stops: readonly ({
        owner: OwnershipRef;
        outcome: 'never_started';
    } | {
        owner: OwnershipRef;
        outcome: 'stopped';
        observationId: string;
        launchId: string;
        writerScopeId: string;
    })[];
}
interface StopObservation {
    observationId: string;
    owner: OwnershipRef;
    launchId: string;
    writerScopeId: string;
    observedAt: number;
    verdict: 'stopped' | 'live' | 'unknown';
    complete: boolean;
    writers: readonly {
        id: string;
        state: 'gone' | 'alive' | 'unknown';
    }[];
}
type StopObserver = (owner: OwnershipRecord) => Promise<StopObservation | null>;
type HandoffOutcome = {
    status: 'complete';
    receipt: HandoffReceipt;
} | {
    status: 'held';
    handoffId: string;
    reason: 'missing_observer' | 'observer_error' | 'unknown' | 'live' | 'stale_observation' | 'snapshot_changed';
};
declare function ownership(handle: ControllerHandle, ref: OwnershipRef): OwnershipRecord;
declare function reserveWorkItem(handle: ControllerHandle, input: ReserveWorkItemInput, observers?: ResultObservers): OwnershipRecord;
declare function recordLaunchIntent(handle: ControllerHandle, input: {
    owner: OwnershipRef;
    intent: LaunchIntent;
}): OwnershipRecord;
declare function handoff(handle: ControllerHandle, handoffId: string): HandoffRecord;
declare function beginHandoff(handle: ControllerHandle, input: {
    commandId: string;
    task: TaskRef;
    expectedMode: ExecutionMode;
    targetMode: ExecutionMode;
    expectedOwners: readonly OwnershipRef[];
}): HandoffRecord;
declare function finishHandoff(handle: ControllerHandle, input: {
    handoffId: string;
}, observer?: StopObserver): Promise<HandoffOutcome>;

type RunInputReason = 'requirements_changed' | 'membership_changed' | 'work_item_changed' | 'ownership_changed' | 'dependency_changed' | 'readiness_expired' | 'memory_changed' | 'rules_changed' | 'repository_changed' | 'snapshot_missing';
interface RunInputChange {
    reason: RunInputReason;
    taskId?: number;
    entryId?: string;
    resultId?: string;
    repoId?: string;
    previous?: Pick<MemoryRecord, 'revision' | 'hash'> | null;
    current?: Pick<MemoryRecord, 'revision' | 'hash'> | null;
}
type RunInputStatus = {
    status: 'current';
    authorityId: string;
    inputHash: string;
} | {
    status: 'update_required';
    authorityId: string;
    inputHash: string | null;
    changeHash: string;
    changes: RunInputChange[];
    eventId: number;
};
declare function checkRunInputs(handle: ControllerHandle, ref: RunInputRef): RunInputStatus;

export { type Actor, type AgentEvent, type AgentEventKind, type AttentionInbox, type AttentionItem, type AttentionReason, type AuthorityBinding, type AutoTick, BUG_BODY_TEMPLATE, type BindingKind, type BriefSection, CAPS, type CodexPermissionInput, type Comment, type ControllerHandle, type CreateSubtasksInput, type CreationSource, type Criterion, DEFAULT_TTL, type DecisionDetail, type DecisionInput, type DecisionSourceTask, type DecisionSummary, type DependencyBinding, type DependencyInput, type DependencyKind, type DependencyProjection, type DependencyReason, type EventRow, type EvidenceObservation, type EvidenceRequest, type ExecutionMode, type FileRow, type HandoffOutcome, type HandoffReceipt, type HandoffRecord, type IssueRunInput, type IssuedRunAuthority, KINDS, KddError, type KillFn, type KillOutcome, type Kind, type LaunchIntent, MAX_FAILED_ATTEMPTS, MAX_WORKERS_CAP, MIGRATIONS, type ManualProvenance, type ManualSession, type MemoryApplicability, type MemoryAuthor, type MemoryDraft, type MemoryEvidenceObservation, type MemoryEvidenceRequest, type MemoryHit, type MemoryImportInput, type MemoryKind, type MemoryObservers, type MemoryOperation, type MemoryReadOptions, type MemoryRecallOptions, type MemoryReceipt, type MemoryRecord, type MemoryRepoVersion, type MemoryRevisionRef, type MemoryScope, type MemorySource, type MemoryStatus, type MemoryView, type MemoryWriteInput, type NativeEvidence, type NativeLaunchInput, type NativeProbeResult, type NextAction, type OutputRequirement, type OwnershipRecord, type OwnershipRef, PRIORITIES, PRIORITY_ORDER, type ParsedDecision, type ParsedEvent, type Priority, type ProjectRecord, type PublishResultInput, type ReapResult, type RecallHit, type ReclaimedLease, type Release, type ReleaseInfo, type RepositoryAccess, type RepositoryBinding, type RepositoryRecord, type ReserveWorkItemInput, type ResultBinding, type ResultObservers, type ResultPayload, type ResultRecord, type ResultSource, type RunContext, type RunContextSnapshot, type RunInputChange, type RunInputOptions, type RunInputReason, type RunInputRef, type RunInputSections, type RunInputSnapshot, type RunInputStatus, type RunMemoryReadInput, type RunOperation, type RunResult, STATUSES, type SessionHandoff, type SpawnFn, type Status, type StopObservation, type StopObserver, type StopResult, type SubtaskDraft, type SubtaskPlanInput, TICK_INTERVALS, TRANSITIONS, type Task, type TaskBrief, type TaskDetailCapped, type TaskListRow, type TaskRef, type TickResult, type TickRun, type Track, type UpdateChannel, type VerifiedCodexPackage, type WorkItemDefinition, type WorkItemInput, type WorkItemKind, type WorkItemRecord, type WorkItemRef, type WorkItemState, _cacheUntil, _resetCache, addCriterion, addDecision, addRepository, addTask, agentId, appendAgentEvent, appendEvent, appendTaskMutationEvent, archiveTask, assertLegacyDecisionSource, assertLegacyTaskMutation, assertRunAuthorityBinding, assertVerifiedCodexPackage, assertWritableRoots, attachFile, attentionData, authorOf, beginHandoff, bindRepository, bindingsOf, blockTask, boardData, canSyncLegacyDecisions, canonicalCommonDir, canonicalProjectPath, capDetail, capText, checkMove, checkRunInputs, checkpointWal, claimNext, claimTask, closeDb, commentTask, compareVersions, completeWorkItem, contentHash, createSubtaskPlan, createSubtasks, createTrack, createWorkItem, decisionDetail, deleteTrack, detachFile, editTask, editTrack, endWorkItem, ensureWorktree, expiredLeases, exportBoard, filePath, filesDir, finishHandoff, getAutoTick, getFile, getLastRun, getReminded, handoff, headCommit, importMemory, initializeProjectStore, inspectDependencies, invalidateResult, isInlineMime, issueRunAuthority, kddHome, kddVersion, lastAgentEventKind, linkTasks, listAgentEvents, listCriteria, listFiles, listMemory, listProjectCheckouts, listProjects, listSubtasks, listTracks, logError, lookupProjectStore, manualSessionFromEnv, maxWorkers, maxWorkersEnvLocked, memoryEntry, memoryHistory, memoryRules, moveTask, mustGetTask, mustGetTrack, normalizeSessionId, normalizeSourceTasks, now, observeCodexNative, openController, openDb, openRunContext, ownership, parseClaudeStreamLine, parseDecisionMd, parseRepoUrl, placeTask, preflightCodex, projectOf, projectPathOf, projectToplevelOf, protectTask, pruneAgentEvents, publishResult, readRunContext, readRunMemory, reapExpired, rebindRepository, rebuild, recall, recallMemory, recallRunMemory, reclaimExpired, recordFailedAttempt, recordLaunchIntent, redact, releaseClaim, releaseInfo, removeCriterion, renderDecisionBody, renderDecisionMd, renewClaim, repoSlug, repositoriesOf, requestRunQuestion, reserveWorkItem, resolveDbPath, resolveDecisionsDir, resolveDependencies, resolveToplevel, result, reviseWorkItem, revokeRunAuthority, runInputSnapshot, runMemoryRules, runOperations, runProduced, sanitizeQuery, setAutoTick, setCriterionChecked, setLastRun, setProjectToplevel, setReminded, setWorkItemWaiting, slugify, spawnCheckedNative, statusDigest, stopWorkers, storeIdentity, submitRunReport, sweepWorktrees, syncIndex, syncedTaskDetail, taskBranchHead, taskBrief, taskContractHash, taskDetail, taskDetailCapped, taskWorkItems, tick, unarchiveTask, unblockTask, unsubmitted, updateDisposition, versionChannel, withNativeControllerLock, workItem, worktreePath, writeMemory };
