# Self-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `kdd update`, a cached CLI update notice, and a shared agent skill that update installed kddkit components without claiming success until their versions are verified.

**Architecture:** Reuse `@kddkit/core` for release discovery and version comparison. A short-lived detached Node process refreshes a user-level notice cache; the explicit command runs npm, Claude, and Codex managers in sequence through fixed argument arrays. Each manager returns a component result so failure in one does not hide the others.

**Tech Stack:** Node.js >=22, TypeScript, Commander, tsup, Vitest, existing `@kddkit/core`. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-23-self-update-design.md`

## Global Constraints

- Use stable GitHub Releases from `releaseInfo()`; no npm-latest fetch or `--next` channel in this task.
- `kdd update` works outside a Git repository and never opens a KDD board.
- Never install an absent component or replace a source checkout, `npx` run, linked CLI, or local Codex marketplace.
- Invoke managers with executable + argument arrays. Never construct a shell command.
- In non-TTY Claude runs, never pass `-y` to accept a changed marketplace command.
- Verify versions after npm, Claude, and Codex report success; a zero exit code alone does not mean `updated`.
- Keep the notice off JSON/agent/worker/CI/help/version/update invocations and off stdout.
- Commit locally with one-line subjects; do not push.

## File Map

| File | Responsibility |
| --- | --- |
| `packages/cli/src/update-notifier.ts` | Cache validation, eligibility, notice, detached check scheduling |
| `packages/cli/src/update-check-worker.ts` | Fetch `releaseInfo()`, atomically write cache, exit silently |
| `packages/cli/src/update.ts` | Same-Node npm ownership check, Claude/Codex updates, component results |
| `packages/cli/src/index.ts` | Register `update`, render results, await Commander, start notice |
| `packages/cli/package.json` | Bundle the worker entry alongside `index.ts` |
| `packages/cli/test/update-notifier.test.ts` | Notice and cache behavior |
| `packages/cli/test/update.test.ts` | Manager calls, command wiring, scopes, failure and version verification |
| `packages/cli/test/run.ts` | Disable background checks in unrelated CLI tests |
| `skills/kdd-update/SKILL.md` | Agent invocation and incomplete-update reporting |
| `scripts/sync-codex-plugin.mjs` | Copy/check the new skill for Codex |
| `packages/cli/README.md`, `README.md` | Document the command, notice, and restart |
| `packages/cli/dist/*`, `integrations/codex-plugin/skills/kdd-update/SKILL.md` | Tracked build and sync artifacts |

## Review Focus

1. **Wrong Node or npm prefix:** skip the CLI with a precise reason; Task 2 tests a running bundle outside npm's reported global root.
2. **Successful npm writes another `kdd`:** report failure with observed version; Task 2 tests a stale PATH command after successful install.
3. **Claude command approval in non-TTY:** never pass `-y`; Task 3 tests refusal and the interactive command in the result.
4. **Codex Git marketplace reports plugin source `local`:** use `marketplaceSource.sourceType`; Task 3 tests refresh both with and without a later `plugin add`.
5. **Corrupt cache or offline check:** normal CLI still exits promptly with intact stdout; Task 1 tests malformed JSON and a failed child refresh.

---

### Task 1: Cached, nonblocking CLI notice

**Files:**
- Create: `packages/cli/src/update-notifier.ts`
- Create: `packages/cli/src/update-check-worker.ts`
- Create: `packages/cli/test/update-notifier.test.ts`
- Modify: `packages/cli/package.json`
- Generated after build: `packages/cli/dist/update-check-worker.js`

**Interfaces:**
- Consumes: `kddHome()`, `kddVersion()`, `compareVersions()`, `releaseInfo()` from `@kddkit/core`.
- Produces: `UpdateCache = {latest: string | null; checkedAt: number}`, `readUpdateCache(path: string): UpdateCache | null`, `shouldRefresh(cache: UpdateCache | null, now: number): boolean`, `eligible(argv: string[], env: NodeJS.ProcessEnv): boolean`, and `noticeOnStartup(argv?: string[], env?: NodeJS.ProcessEnv): void`; worker reads/writes `<kddHome()>/update-check.json`.

- [ ] **Step 1: Write failing cache and eligibility tests.** In `update-notifier.test.ts`, use `mkdtempSync` and `KDD_HOME` to test fresh newer cache, equal/older cache, malformed JSON, 24-hour success expiry, five-minute failure retry, and skip arguments/env. A fake `spawn` records whether a check was scheduled. Assert the notice is one stderr line and JSON invocation prints none.

```ts
expect(readUpdateCache(cacheFile)).toEqual({ latest: '0.9.0', checkedAt: now - 1_000 });
expect(shouldRefresh({ latest: '0.9.0', checkedAt: now - 1_000 }, now)).toBe(false);
expect(shouldRefresh({ latest: null, checkedAt: now - 5 * 60_000 }, now)).toBe(true);
expect(eligible(['show', '1', '--json'], { CI: '' })).toBe(false);
```

- [ ] **Step 2: Run the new test red.**

```sh
pnpm --filter @kddkit/cli exec vitest run test/update-notifier.test.ts
```

Expected: missing exported functions or module.

- [ ] **Step 3: Implement the smallest cache and worker.** Export the four named helpers above. `noticeOnStartup` reads cache synchronously and returns without awaiting a stale-cache refresh. The worker calls `releaseInfo()`; it writes `latest` on success or `null` on failure through a same-directory temporary file and `renameSync`. Use `spawn(process.execPath, [absoluteWorkerPath], {detached: true, stdio: 'ignore'})` plus `unref()`. Attach an `error` listener so notification failure never fails a board command. The spec permits concurrent checks, so the caller needs no placeholder or lock. Skip `--json`, agent markers, `worker`, `update`, npm exec (`npm_command=exec`), CI, `NO_UPDATE_NOTIFIER`, help and version.

```ts
const ttl = cache?.latest ? 24 * 60 * 60_000 : 5 * 60_000;
if (cache?.latest && compareVersions(cache.latest, kddVersion()) > 0)
  process.stderr.write(`kdd: v${cache.latest} available; run kdd update\n`);
if (!cache || Date.now() - cache.checkedAt >= ttl) scheduleDetachedCheck(cacheFile);
```

- [ ] **Step 4: Add the second tsup entry, run green and build.** Set `build` to `tsup src/index.ts src/update-check-worker.ts --format esm --clean`. Assert the built worker exists and `dist/index.js` still runs `--version`.

```sh
pnpm --filter @kddkit/cli exec vitest run test/update-notifier.test.ts
pnpm --filter @kddkit/cli build
node packages/cli/dist/index.js --version
```

- [ ] **Step 5: Commit the source, test, package script and generated worker.**

```sh
git add packages/cli/src/update-notifier.ts packages/cli/src/update-check-worker.ts packages/cli/test/update-notifier.test.ts packages/cli/package.json packages/cli/dist
git commit -m "feat(cli): cache background update checks"
```

### Task 2: Update only the npm-owned CLI

**Files:**
- Create: `packages/cli/src/update.ts`
- Create: `packages/cli/test/update.test.ts`

**Interfaces:**
- Consumes: `compareVersions()`, `kddVersion()` from core; `latest: string` from the caller.
- Produces: `ComponentResult = {name: 'cli' | 'claude' | 'codex'; status: 'updated' | 'current' | 'skipped' | 'failed'; detail: string}`, `Runner = (file: string, args: string[], cwd?: string) => {status: number | null; stdout: string; stderr: string; error?: Error}`, `runCommand: Runner`, and `updateCli(latest: string, run: Runner, cliFile: string, nodePath: string): ComponentResult`.

- [ ] **Step 1: Write failing ownership and post-install tests.** Use a temporary npm root with a real `@kddkit/cli/dist/index.js` fixture and stub `Runner` responses. Cover owned registry install, `file:` resolution, symlinked package, other root/prefix, absent npm bundled with Node, successful npm install followed by old `kdd --version`, and successful new version. Assert the install uses `nodePath` with the npm CLI script as its first argument.

```ts
expect(updateCli('0.9.0', run, runningBundle, nodePath)).toMatchObject({
  name: 'cli', status: 'failed', detail: expect.stringContaining('kdd --version'),
});
expect(calls).toContainEqual([nodePath, [npmCliPath, 'install', '-g', '@kddkit/cli@0.9.0']]);
```

- [ ] **Step 2: Run the test red.**

```sh
pnpm --filter @kddkit/cli exec vitest run test/update.test.ts
```

Expected: `updateCli` is missing.

- [ ] **Step 3: Implement npm ownership and version check.** Locate the npm CLI next to `process.execPath` or its `realpathSync` target (same layout already used in `integrations/codex-plugin/hooks/smart-install.mjs`). Ask that script for `root -g` and `ls -g @kddkit/cli --json --long`. Reject a symlinked package, a dependency row with `resolved` beginning `file:`, and a `cliFile` whose real path differs from `<npm root>/@kddkit/cli/dist/index.js`. `runCommand` uses `spawnSync` with fixed argument arrays and a bounded timeout; distinguish `ENOENT` from a nonzero manager exit. If already current, return `current`. Otherwise install through the same Node/npm pair, then run PATH `kdd --version`. Return `updated` only for the release version.

```ts
if (realpathSync(cliFile) !== realpathSync(join(npmRoot, '@kddkit/cli/dist/index.js')))
  return { name: 'cli', status: 'skipped', detail: 'another npm prefix owns this kdd' };
const installed = run(nodePath, [npmCli, 'install', '-g', `@kddkit/cli@${latest}`]);
const invoked = run('kdd', ['--version']);
if (installed.status !== 0 || invoked.stdout.trim() !== latest)
  return { name: 'cli', status: 'failed', detail: `kdd --version: ${invoked.stdout.trim()}` };
```

- [ ] **Step 4: Run green and type-check.**

```sh
pnpm --filter @kddkit/cli exec vitest run test/update.test.ts
pnpm --filter @kddkit/cli typecheck
```

- [ ] **Step 5: Commit the CLI updater and tests.**

```sh
git add packages/cli/src/update.ts packages/cli/test/update.test.ts
git commit -m "feat(cli): verify npm-owned self-update"
```

### Task 3: Update installed Claude and Codex plugins

**Files:**
- Modify: `packages/cli/src/update.ts`
- Modify: `packages/cli/test/update.test.ts`

**Interfaces:**
- Consumes: `Runner`, `ComponentResult`, `latest` from Task 2.
- Produces: `updateClaude(latest: string, run: Runner, cwd: string): ComponentResult[]` and `updateCodex(latest: string, run: Runner): ComponentResult`.

- [ ] **Step 1: Write failing manager tests.** Give `claude plugin list --json` fixtures with `id: 'kddkit@kddkit'` in user, matching project, unrelated project, and managed scopes; assert only eligible older rows are updated and reread, and outside a Git repo only user scope qualifies. Simulate approval-required stderr in non-TTY and assert no call includes `-y`; the result is `failed` with the interactive command in `detail`. Give `codex plugin list --json` a row with `pluginId: 'kddkit@kddkit'`, Git `marketplaceSource`, and plugin `source: {source: 'local'}`; assert marketplace upgrade runs, `add` is skipped when refresh updates the version, `add` runs when refresh leaves it old, and an unchanged final version fails. A genuinely local marketplace is skipped. A missing host executable is skipped; malformed JSON is failed.

```ts
expect(updateCodex('0.9.0', run)).toMatchObject({ name: 'codex', status: 'updated' });
expect(calls).toContainEqual(['codex', ['plugin', 'marketplace', 'upgrade', 'kddkit']]);
expect(calls.some(([, args]) => args.includes('-y'))).toBe(false);
```

- [ ] **Step 2: Run the expanded test red.**

```sh
pnpm --filter @kddkit/cli exec vitest run test/update.test.ts
```

Expected: plugin update functions are missing.

- [ ] **Step 3: Implement Claude and Codex flows.** Use JSON from the installed CLIs and validate the relevant row shape before reading versions. Claude: match `id === 'kddkit@kddkit'`, allow user scope plus project/local entries for the current repo, skip managed, refresh marketplace with `claude plugin marketplace update kddkit`, run `claude plugin update kddkit@kddkit --scope <scope>` without `-y`, reread the list, and include the scoped interactive command when approval blocks it. Codex: match `pluginId === 'kddkit@kddkit'`, use `marketplaceSource.sourceType`, refresh Git marketplace, reread installed version, conditionally `plugin add`, reread again. Do not mutate a genuinely local marketplace. An absent plugin produces a `skipped` result rather than disappearing from the report.

```ts
run('codex', ['plugin', 'marketplace', 'upgrade', 'kddkit']);
let current = installedCodexVersion(run('codex', ['plugin', 'list', '--json']));
if (compareVersions(current, latest) < 0) {
  run('codex', ['plugin', 'add', 'kddkit@kddkit']);
  current = installedCodexVersion(run('codex', ['plugin', 'list', '--json']));
}
run('claude', ['plugin', 'marketplace', 'update', 'kddkit']);
run('claude', ['plugin', 'update', 'kddkit@kddkit', '--scope', scope]);
// Read `claude plugin list --json` again; only the observed target version is success.
```

- [ ] **Step 4: Run green and type-check.**

```sh
pnpm --filter @kddkit/cli exec vitest run test/update.test.ts
pnpm --filter @kddkit/cli typecheck
```

- [ ] **Step 5: Commit the plugin flows.**

```sh
git add packages/cli/src/update.ts packages/cli/test/update.test.ts
git commit -m "feat(cli): update installed Claude and Codex plugins"
```

### Task 4: Expose command and agent skill; verify the built product

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/README.md`
- Modify: `README.md`
- Modify: `scripts/sync-codex-plugin.mjs`
- Create: `skills/kdd-update/SKILL.md`
- Modify: `packages/cli/test/update.test.ts`
- Modify: `packages/cli/test/run.ts`
- Generated: `packages/cli/dist/index.js`, `integrations/codex-plugin/skills/kdd-update/SKILL.md`

**Interfaces:**
- Consumes: `noticeOnStartup()`, `updateCli()`, `updateClaude()`, `updateCodex()`, `releaseInfo()`.
- Produces: `kdd update` command and Claude `/kddkit:kdd-update` / Codex `$kddkit:kdd-update` skill.

- [ ] **Step 1: Add a failing command-level test.** Set `NO_UPDATE_NOTIFIER: '1'` in the shared `makeEnv()` test helper, then override it with an empty value for this test. Use a temporary `KDD_HOME` and `KDD_DB`. Execute built `kdd --help` and `kdd status --json`; assert update appears in help and JSON parses without a notice. Use a temporary `NODE_OPTIONS=--import=<fixture>` preloader to make `fetch` return a stable fake release. Execute a cache-miss `kdd status` and assert it exits promptly; wait briefly for the detached checker to write `update-check.json`, then execute `kdd status` again and assert exactly one notice on stderr. For update failure, fake manager executables on a temporary PATH return controlled JSON/errors; assert nonzero exit with the failed component's name and results for the other components, without touching real installations.

```ts
const human = spawnSync(process.execPath, [BIN, 'status'], { env: fixtureEnv, encoding: 'utf8' });
expect(human.stderr).toContain('kdd: v0.9.0 available; run kdd update'); // after worker wrote cache
const json = spawnSync(process.execPath, [BIN, 'status', '--json'], { env: fixtureEnv, encoding: 'utf8' });
expect(() => JSON.parse(json.stdout)).not.toThrow();
// In makeEnv(): NO_UPDATE_NOTIFIER: '1'; override with '' only in this integration case.
```

- [ ] **Step 2: Run the command-level test red.**

```sh
pnpm --filter @kddkit/cli build
pnpm --filter @kddkit/cli exec vitest run test/update.test.ts
```

Expected: `update` missing from help or notice absent.

- [ ] **Step 3: Wire the command.** In `index.ts`, call `noticeOnStartup()` before parsing, add `program.command('update')` with an async action that calls `releaseInfo()`, refuses missing stable release, runs all three component updates, prints one result per component, and sets nonzero `process.exitCode` if any failed. Use `await program.parseAsync()` so update completes before process exit. Add one README table row and a short update section; add a root README link to the command.

```ts
program.command('update').description('update installed kddkit components')
  .action(async () => {
    const info = await releaseInfo();
    if (info.error || !info.latest) { console.error(info.error ?? 'no stable release'); process.exitCode = 1; return; }
    const results = [...updateClaude(info.latest, runCommand, process.cwd()),
      updateCodex(info.latest, runCommand), updateCli(info.latest, runCommand, fileURLToPath(import.meta.url), process.execPath)];
    for (const result of results) console.log(`${result.name}: ${result.status} — ${result.detail}`);
    if (results.some((result) => result.name !== 'cli' && result.status === 'updated'))
      console.log('Restart Claude Code or Codex to load updated plugins.');
    if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
  });
noticeOnStartup();
await program.parseAsync();
```

- [ ] **Step 4: Add and sync the skill.** The skill directs agents to call `kdd update` when available, otherwise the current client's plugin manager, and to report partial failure/interactive approval/restart. Extend the sync script's `copies` with `['skills/kdd-update/SKILL.md', 'skills/kdd-update/SKILL.md']` and `generatedDirs` with `skills/kdd-update`.

```md
---
name: kdd-update
description: Update installed kddkit CLI and client plugins on request.
---

Run `kdd update` if the CLI is present. Report each component result.
If the CLI is absent, inspect only this client's installed kddkit plugin. Say the CLI and other client were not checked.
For Claude, inspect `claude plugin list --json`; skip absent/managed or other-project scopes. Refresh with `claude plugin marketplace update kddkit`, update older eligible scopes with `claude plugin update kddkit@kddkit --scope <scope>`, and verify through the list again. Never pass `-y`; if interactive approval is required, report incomplete and give that exact scoped command.
For Codex, inspect `codex plugin list --json`; only a Git `marketplaceSource.sourceType` may be refreshed with `codex plugin marketplace upgrade kddkit`. Inspect the version again, run `codex plugin add kddkit@kddkit` only if still old, then verify the final version. Skip local marketplaces.
Tell the user to restart Claude Code or Codex after a plugin update.
```

- [ ] **Step 5: Run the required checks and observe the result.** Build before tests because existing CLI tests execute `dist/index.js`. Compare `kdd --help` with the README command table, and verify copied artifacts.

```sh
pnpm --filter @kddkit/cli build
pnpm --filter @kddkit/cli typecheck
pnpm --filter @kddkit/cli test
pnpm --filter @kddkit/core test
node scripts/sync-codex-plugin.mjs
node scripts/sync-codex-plugin.mjs --check
pnpm test:codex-plugin
node packages/cli/dist/index.js --help
claude plugin validate .
git diff --check
```

Expected: all checks pass; the CLI table contains the `update` row; the generated Codex skill matches its source.

- [ ] **Step 6: Commit the integration, then report measured evidence to #23.** Check criteria 27–29 only after their behaviors are observed, move the task to `review`, and leave `done` for the owner's explicit instruction.

```sh
git add packages/cli/src/index.ts packages/cli/test/update.test.ts packages/cli/test/run.ts packages/cli/README.md README.md scripts/sync-codex-plugin.mjs skills/kdd-update/SKILL.md packages/cli/dist integrations/codex-plugin/skills/kdd-update/SKILL.md
git commit -m "feat(cli): expose self-update to users and agents"
git show --check --oneline HEAD
```
