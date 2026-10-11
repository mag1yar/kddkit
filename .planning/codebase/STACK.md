# Technology Stack

**Analysis Date:** 2026-07-21

## Languages

**Primary:**
- TypeScript 5.9.3 - All source code (CLI, core library, MCP server, web UI)

**Runtime:** ES2022 target

## Runtime

**Environment:**
- Node.js ≥22 (specified in `package.json` engines field)

**Package Manager:**
- pnpm 11.0.9
- Lockfile: `pnpm-lock.yaml` (present)

## Frameworks

**Core:**
- Hono 4.9.0 - Web server framework for UI API (`packages/ui/src/server.ts`)
- React 19.2.7 - UI library for web interface (`packages/ui/src/web/`)
- @modelcontextprotocol/sdk 1.12.0 - MCP server for Claude integration (`packages/mcp/`)

**Testing:**
- vitest 4.1.10 - Test runner configured across all packages

**Build/Dev:**
- Turbo 2.10.5 - Monorepo orchestration (`turbo.json`)
- tsup 8.5.1 - TypeScript bundler for all packages
- Vite 8.1.4 - Frontend bundler and dev server (`packages/ui/vite.config.ts`)
- @vitejs/plugin-react 6.0.3 - React plugin for Vite

## Key Dependencies

**Database:**
- node:sqlite (built-in) - Embedded SQLite database for task storage (`packages/core/src/db.ts`)

**CLI:**
- commander 15.0.0 - Command-line argument parsing (`packages/cli/src/index.ts`)

**Web Server:**
- @hono/node-server 1.19.0 - Node.js server adapter for Hono

**UI Components & Styling:**
- @base-ui/react 1.6.0 - Headless UI components
- TailwindCSS 4.3.2 - Utility-first CSS framework
- @tailwindcss/vite 4.3.2 - Vite integration for TailwindCSS
- lucide-react 1.24.0 - SVG icon library
- sonner 2.0.7 - Toast notification system
- class-variance-authority 0.7.1 - Component variant management
- clsx 2.1.1 - Conditional className utility
- tailwind-merge 3.6.0 - TailwindCSS class merging
- react-markdown 10.1.0 - Markdown rendering in React

**Drag & Drop:**
- @dnd-kit/core 6.3.1 - Drag-and-drop primitives
- @dnd-kit/sortable 10.0.0 - Sortable list functionality for kanban board
- @dnd-kit/utilities 3.2.2 - Utility functions for dnd-kit

**Validation & Utilities:**
- zod 3.23.8 - TypeScript-first schema validation (used in MCP server for tool inputs)
- overtype 2.4.0 - Lightweight type system helper

**Version Management:**
- bumpp 11.1.0 - Automated version bumping for releases

## Configuration

**Environment:**
- Configuration via `process.env` variables:
  - `KDD_HOME` - Root directory for KDD data (defaults to `~/.kdd`)
  - `KDD_DB` - Override database path
  - `KDD_DECISIONS_DIR` - Override decisions directory path
  - `KDD_ACTOR` - Actor type for CLI operations (`user` or `ai`)
  - `KDD_SESSION` - Session ID for AI actor tracking
  - `NODE_ENV` - Runtime environment (development/production)

**Build:**
- `tsconfig.base.json` - Base TypeScript configuration
  - Target: ES2022
  - Module: NodeNext
  - Strict mode enabled
- `turbo.json` - Turbo build pipeline configuration (`build` depends on `^build`, `test` depends on `build`)
- Package-level configs:
  - `packages/cli/tsup.config.ts` - CLI build (ESM format)
  - `packages/core/tsup.config.ts` - Core build (ESM + type declarations)
  - `packages/mcp/tsup.config.ts` - MCP build (ESM, bundles sdk and zod)
  - `packages/ui/tsup.config.ts` - UI server build (ESM + types)
  - `packages/ui/vite.config.ts` - Frontend build (React + TailwindCSS, alias `@` to `src/web`)
  - `packages/ui/vitest.config.ts` - Test config (separate root from vite)

## Platform Requirements

**Development:**
- Node.js 22+ (tested on Ubuntu via CI, development on macOS/Linux/Windows)
- pnpm 11.0.9
- Git (required for db path resolution via `git rev-parse`)

**Production:**
- Node.js 22+
- Database: SQLite via built-in node:sqlite (no native addon)
- Disk space: Database stored in `~/.kdd/<project-hash>/kdd.db`

**Distribution:**
- Published to npm as scoped packages: `@kddkit/core`, `@kddkit/cli`, `@kddkit/ui`
- Claude plugin via plugin.json manifest: MCP server runs as stdio subprocess

---

*Stack analysis: 2026-07-21*
