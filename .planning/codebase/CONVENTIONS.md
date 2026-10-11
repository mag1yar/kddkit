# Coding Conventions

**Analysis Date:** 2026-07-21

## Naming Patterns

**Files:**
- TypeScript sources: lowercase with hyphens (e.g., `db.ts`, `task-dialog.tsx`)
- React components: PascalCase matching component name (e.g., `Board.tsx`, `TaskDialog.tsx`)
- Test files: `*.test.ts` or `*.spec.ts` co-located with source
- Export index files: `index.ts` using barrel exports (e.g., `packages/core/src/index.ts` re-exports all public types)

**Functions:**
- camelCase for all functions (e.g., `addTask`, `renderAge`, `handleMove`, `makeEnv`)
- Helper functions: private functions prefixed with underscore (e.g., `_openCriteria`, `_nextPosition`)
- React components: PascalCase (e.g., `Board`, `Column`, `TaskCard`, `NewTaskDialog`)
- Event handlers: `on` prefix for callbacks (e.g., `onMove`, `onOpen`, `onValueChange`)

**Variables:**
- camelCase for all variables and parameters
- Single-letter abbreviations widely used in local scope: `t` (task), `db` (database), `d` (detail), `c` (criterion/comment), `e` (event), `s` (status), `ts` (timestamp)
- Parameters use full names when not obvious from context (e.g., `taskId`, `actor`, `detail`)

**Types and Interfaces:**
- PascalCase for all type/interface names (e.g., `Task`, `Status`, `Priority`, `Actor`, `Comment`)
- Union types for discriminated results: `{ ok: true } | { ok: false; error: string }` (see `packages/core/src/state.ts:checkMove`)
- Type exports use `type` keyword explicitly: `type Status = 'backlog' | 'new' | ...`

**Constants:**
- UPPER_SNAKE_CASE for enum-like arrays and constant objects: `STATUSES`, `PRIORITIES`, `TRANSITIONS`, `MIGRATIONS`, `CAPS` (capability limits)
- These constants are defined near their usage, typically in module scope
- Examples: `packages/core/src/state.ts` defines `STATUSES: Status[]`, `PRIORITIES: Priority[]`, `TRANSITIONS: Record<Status, Status[]>`

## Code Style

**Formatting:**
- No explicit formatter configured (no `.eslintrc`, `.prettierrc`, or `biome.json` found)
- Hand-written formatting follows consistent patterns across the codebase
- Consistent indentation (2 spaces)
- Line length: practical, no hard limit observed but typically under 100 characters

**Linting:**
- TypeScript compiler is primary lint tool (strict mode enforced)
- tsconfig.json settings at root: `packages/core/tsconfig.json` extends `../../tsconfig.base.json`
- Strict mode enabled: `"strict": true` in base config
- ESM modules required: `"type": "module"` in all package.json files
- Target: ES2022 with NodeNext module resolution

**Module System:**
- ES modules exclusively: `import`/`export` syntax required
- `.js` extensions required in import paths for ESM interop (e.g., `'./db.js'`, `'./handlers.js'`)
- `import type` used for type-only imports to enable tree-shaking

## Import Organization

**Order:**
1. Node.js built-ins: `import { join } from 'node:path'` (node:sqlite is loaded only inside `db.ts`, via `createRequire`)
2. External packages: `import { Command } from 'commander'`
3. Local monorepo packages: `import { addTask, openDb } from '@kddkit/core'`
4. Local relative imports: `import { renderAge } from './render.js'`
5. Type imports grouped separately if multiple: `import type { Task, Status } from '@kddkit/core'`

Example from `packages/cli/src/index.ts`:
```typescript
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { KddError, addTask, ... } from '@kddkit/core';
import { projectPool, startUi } from '@kddkit/ui';
import { fail, getActor, ... } from './context.js';
import { renderBoard, ... } from './render.js';
```

**Path Aliases:**
- Vite/React paths: `@/` resolves to `src/web/` in UI package (used in components: `import { cn } from '@/lib/utils'`)
- Workspace imports: `@kddkit/core`, `@kddkit/cli`, `@kddkit/ui`, `@kddkit/mcp` for cross-package dependencies

## Error Handling

**Pattern:**
- Custom error class `KddError` extends `Error` (defined in `packages/core/src/errors.ts`)
- Validation errors use `throw new KddError('message')` immediately at function entry
- Database operations wrapped in `db.transaction()` to ensure atomic updates
- CLI error handling: `run()` wrapper catches errors and calls `fail()` helper

Example from `packages/core/src/ops.ts`:
```typescript
export function addTask(db: Database.Database, input: {...}, actor: Actor): Task {
  if (!input.title.trim()) throw new KddError('title must not be empty');
  if (input.criteria?.some((c) => !c.trim())) {
    throw new KddError('criterion text must not be empty');
  }
  return db.transaction(() => { /* body */ })();
}
```

Example from `packages/cli/src/index.ts`:
```typescript
function run(json: boolean, fn: () => void): void {
  try { fn(); } catch (e) {
    fail(e instanceof KddError ? e.message : String(e), json);
  }
}
```

**Result Types (for multi-case returns):**
- Use discriminated unions for operations that may succeed or fail
- Pattern: `{ ok: true } | { ok: false; error: string }`
- Example in `packages/core/src/state.ts:checkMove()`:
```typescript
export function checkMove(...): { ok: true } | { ok: false; error: string } {
  if (from === to) return { ok: false, error: `task is already in ${to}` };
  if (actor.type === 'user') return { ok: true };
  // ... more checks
}
```

## Logging

**Framework:** No logging framework — direct console output

**Patterns:**
- CLI uses `console.log()` for standard output
- JSON output via `JSON.stringify(obj)` when `--json` flag used
- Errors sent to stderr via `fail()` helper function in `packages/cli/src/context.ts`
- Database errors logged to `errors` table via `logError(db, source, message)` in `packages/core/src/errors.ts`
- Comments explain intent when non-obvious

## Comments

**When to Comment:**
- Explain **why** (business logic, constraints), not **what** (the code is self-documenting)
- Explain gates and business rules (e.g., acceptance criteria check before AI can move to review)
- Mark non-obvious heuristics or transitions

Example from `packages/cli/src/render.ts`:
```typescript
// id в строке — чтобы агент мог check/uncheck без --json
return cs.map((c) => `  [${c.checked_at ? 'x' : ' '}] ${c.id}. ${c.text}`).join('\n');
```

Example from `packages/core/src/ops.ts`:
```typescript
// Неотмеченные критерии приёмки — гейт ai-перехода в review
function openCriteria(db: Database.Database, taskId: number): number { ... }
```

**Comment Language:** Mix of Russian and English — Russian used for domain concepts and business logic, English for code mechanics

**JSDoc/TSDoc:**
- Not consistently used; type signatures are self-documenting via TypeScript strict mode
- Function parameters documented in type signatures rather than JSDoc

## Function Design

**Size:**
- Prefer small, single-responsibility functions
- Database operations: typically 10-30 lines including transaction wrapper
- Rendering functions: 20-40 lines, split helpers for columns/sections
- UI components: 40-80 lines, extract sub-components as private functions when exceeding this

**Parameters:**
- Explicit parameters preferred over options objects for simple cases (≤2 params)
- Options objects for >2 params or optional fields: `{ title?: string; area?: string; track_id?: number }`
- Database handle always first parameter: `function moveTask(db: Database.Database, ...)`
- Actor always required for state-changing operations: `actor: Actor`

**Return Values:**
- Prefer exact types over `any` or `unknown`
- Return the modified/created entity (not just id) for user feedback
- Database operations typically return the full record: `export function addTask(...): Task`
- Rendering functions return strings for CLI, components return JSX for web

**Guard Clauses:**
- Early returns for validation at function entry:
```typescript
if (!input.title.trim()) throw new KddError('title must not be empty');
```
- Transaction wrapping only applied after validation passes

## Module Design

**Exports:**
- Barrel files (`index.ts`) re-export public API only
- Internal helpers (prefixed with `_` or descriptive names) not exported
- Example: `packages/core/src/index.ts` exports from `db.js`, `types.js`, `ops.js`, etc.

**Barrel Files:**
- `packages/core/src/index.ts` re-exports all public types and functions
- Used in monorepo: `import { Task, addTask, openDb } from '@kddkit/core'`
- Consumers never import from nested paths (enforced by barrel exports)

**Single Responsibility:**
- Database operations isolated in `db.ts` (schema, migrations), `ops.ts` (CRUD), `queries.ts` (reads)
- UI rendering: separate `render.ts` for CLI text formatting, separate component files for React
- Handler layer: `handlers.ts` in MCP adapts core functions to handler signatures

## File Organization

**Source tree structure — packages/core:**
- `src/db.ts` — Database schema, migrations, initialization
- `src/types.ts` — Type and interface definitions (Task, Comment, Event, etc.)
- `src/state.ts` — State machine (statuses, priorities, transitions, validation)
- `src/errors.ts` — Error class and logging
- `src/ops.ts` — Operations (CRUD: add, edit, move, delete)
- `src/queries.ts` — Read-only queries (board, detail, recall)
- `src/paths.ts` — Path resolution for database and decisions
- `src/index.ts` — Barrel export

**Source tree structure — packages/cli:**
- `src/index.ts` — Command definitions (using commander.js)
- `src/context.ts` — Environment/argument parsing, error handling
- `src/render.ts` — Text formatting and output rendering

**Source tree structure — packages/ui:**
- `src/server.ts` — Hono HTTP server
- `src/web/App.tsx` — Main React component tree
- `src/web/components/` — React components (Board, TaskDialog, etc.)
- `src/web/components/ui/` — Shadcn UI primitives (badge, dialog, tabs)
- `src/web/components/reui/` — Custom Kanban component using dnd-kit

---

*Convention analysis: 2026-07-21*
