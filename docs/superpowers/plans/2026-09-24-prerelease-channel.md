# Stable and Next Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish previews without moving npm `latest`, and let `kdd update --next` and plain `kdd update` select and verify the chosen channel for every eligible installed component.

**Architecture:** Core selects published stable and `next` Releases and decides whether a version move is allowed. Release scripts publish with an explicit dist-tag and keep remote ref changes behind observed publication checks. The CLI preflights the target, then updates npm, Claude, and Codex independently; each plugin manager owns its own ref change and rollback.

**Tech Stack:** Node.js >=22, TypeScript/ESM, pnpm 11, Commander, Vitest, `smol-toml` for read-only Codex config parsing.

**Spec:** `docs/superpowers/specs/2026-09-24-prerelease-channel-design.md` (approved at `890895b`).

## Global Constraints

- `master` and npm `latest` are stable; `next` and npm `next` carry `X.Y.Z-next.N`. Versions in public packages and both plugin manifests remain in lockstep.
- Plain `kdd update` selects stable; only an explicit `--next` selects preview. The background notice stays stable-only.
- **Version rule from the owner's plan review:** within one channel, update only to a higher version. A lower version is allowed on a preview-to-stable channel switch. A stable installation must never move to an older preview, even with `--next`. An equal version may still require changing a plugin marketplace ref back to `master`.
- The selected GitHub Release and the matching npm dist-tag must agree before changing any component. Install exact versions, never a moving npm tag.
- Keep #23's same-Node npm ownership, unknown-source opt-in, scoped plugin ownership, missing-component, non-TTY approval, and post-install verification rules.
- A valid CLI receipt is continuing consent to replace an unknown-source CLI at the same path/root/version, including a later local tarball of that version. Document its location and deletion as revocation.
- A ref switch must preserve the previous manager source and restore the original plugin state on failure. Never pass Claude `-y` or directly edit client config/cache to switch refs.
- Run release probes only against disposable state. Do not publish to npm, push Git refs, or alter the developer's installed plugins while implementing this plan.
- Commit locally with one-line conventional subjects; do not push.

## File Map

| File | Responsibility |
| --- | --- |
| `packages/core/src/release.ts`, `packages/core/test/release.test.ts` | Strict channel versions, ordering, Release selection, fresh explicit read, move decision |
| `scripts/release-next.mjs`, `scripts/publish-next.mjs`, `scripts/test-next-release.mjs`, `package.json` | Preview preparation, guarded `--tag next` publish, reproducible guard checks |
| `packages/cli/src/update.ts`, `packages/cli/test/update.test.ts` | Shared Runner/results, npm CLI receipt and ownership, target preflight |
| `packages/cli/src/update-claude.ts`, `packages/cli/test/update-claude.test.ts` | Scoped Claude marketplace switch and rollback |
| `packages/cli/src/update-codex.ts`, `packages/cli/test/update-codex.test.ts` | Read-only TOML inspection, Codex marketplace switch and rollback |
| `packages/cli/src/index.ts`, `packages/cli/test/update.test.ts` | `--next` command wiring, all-component reporting and exit status |
| `packages/cli/package.json`, `pnpm-lock.yaml` | Direct `smol-toml` runtime dependency, patched version >=1.7.1 |
| `skills/kdd-update/SKILL.md`, `packages/cli/README.md`, `README.md`, `RELEASING.md`, `CLAUDE.md` | User and agent channel contract, receipt consent and release procedure |
| `packages/cli/dist/*`, `packages/core/dist/*`, `integrations/codex-plugin/runtime/core.js`, `integrations/codex-plugin/skills/kdd-update/SKILL.md` | Tracked build and Codex sync outputs |

## Review Focus

1. Installed `next.10`, published target `next.9`: report the installed version as ahead; never run a manager install. Task 1 pins the decision and Tasks 3–5 pin the callers.
2. Installed stable `1.0.0`, stale preview target `1.0.0-next.9`: report no newer preview and leave npm and both marketplaces untouched. Tasks 1 and 6 test this.
3. Installed stable target version but marketplace still points at `next`: switch only that plugin ref to `master` and verify the same installed version. Tasks 4 and 5 test this.
4. Claude has an ineligible plugin scope or multiple marketplace declarations: skip a ref switch that would uninstall another project's plugin. Task 4 tests this.
5. Codex config is malformed or its user declaration disagrees with CLI JSON: skip before removal, retaining source/ref/sparse paths and installed plugin. Task 5 tests this.

---

### Task 1: Core release selection and version-move rule

**Files:** Modify `packages/core/src/release.ts`, `packages/core/test/release.test.ts`.

**Interfaces:** Produce `UpdateChannel = 'stable' | 'next'`, `versionChannel(version: string): UpdateChannel | null`, `updateDisposition(current: string, target: string, channel: UpdateChannel): 'install' | 'current' | 'ahead'`, and `ReleaseInfo.next: string | null`. Extend `releaseInfo({ fetch?, fresh? })`; its existing `latest`, `hasUpdate`, and `releases` remain stable-compatible for UI and notifier.

- [ ] **Step 1: Add failing table tests** for `next.10 > next.9`, stable versus same-core preview, preview-to-stable downgrade, stable-to-older-preview rejection, same-channel downgrade rejection, equal versions, and an unknown `rc` suffix that can upgrade but cannot downgrade.

```ts
expect(compareVersions('1.0.0-next.10', '1.0.0-next.9')).toBeGreaterThan(0);
expect(updateDisposition('1.0.0-next.10', '1.0.0-next.9', 'next')).toBe('ahead');
expect(updateDisposition('1.0.0-next.10', '0.9.0', 'stable')).toBe('install');
expect(updateDisposition('1.0.0', '1.0.0-next.9', 'next')).toBe('ahead');
expect(updateDisposition('1.0.0', '0.9.0', 'stable')).toBe('ahead');
```

- [ ] **Step 2: Add failing Release tests** with existing `ghStub`: only published `-next.N` rows qualify for `next`; a stable tag incorrectly marked prerelease and a preview tag incorrectly marked stable qualify for neither opposite channel. Simulate ten preview rows followed by a stable `/releases/latest` response and assert stable remains discoverable. Call twice, then `fresh: true`, and assert one more network request.

```ts
expect(info.latest).toBe('0.9.0');
expect(info.next).toBe('1.0.0-next.10');
expect(await releaseInfo({ fetch: fetchImpl, fresh: true })).toMatchObject({ latest: '0.9.0' });
```

- [ ] **Step 3: Run red**, then implement strict `X.Y.Z`/`X.Y.Z-next.N` filtering and numeric prerelease segment comparison. Retain existing tolerance for older `compareVersions` callers. `updateDisposition` returns `current` for equality; `install` for a higher target in the same channel or a preview-to-stable switch; and `ahead` for any lower same-channel target or stable-to-older-preview. For an unfamiliar installed prerelease suffix, allow only an increase. `releaseInfo({fresh:true})` bypasses the memory cache; if the first page has no valid stable row, consult `/releases/latest`, but reject a suffix or inconsistent prerelease metadata there too.

```ts
if (versionChannel(target) !== channel) return 'ahead';
if (current === target) return 'current';
const comparison = compareVersions(current, target);
if (versionChannel(current) === 'next' && channel === 'stable') return 'install';
return comparison < 0 ? 'install' : 'ahead';
```

```sh
pnpm --filter @kddkit/core exec vitest run test/release.test.ts
pnpm --filter @kddkit/core typecheck
```

- [ ] **Step 4: Run green and commit.** Expected: all release tests and core typecheck pass; `hasUpdate` and the notifier still use stable `latest`.

```sh
git add packages/core/src/release.ts packages/core/test/release.test.ts
git commit -m "feat(core): select stable and next releases"
```

### Task 2: Guarded preview release path

**Files:** Create `scripts/release-next.mjs`, `scripts/publish-next.mjs`, `scripts/test-next-release.mjs`; modify `package.json`, `RELEASING.md`, `CLAUDE.md`.

**Interfaces:** Produce `pnpm release:next` (local version/tag/notes only) and `pnpm release:next:publish` (npm publish and dist-tag verification only). The owner later pushes the reviewed tag, verifies GitHub Release `prerelease: true`, then advances remote `next` as documented.

- [ ] **Step 1: Add a disposable release-script check.** In `scripts/test-next-release.mjs`, create a temporary git workspace and run the scripts with controlled command executables on its PATH. Assert wrong branch, non-`-next.N` version, and mismatched lockstep manifests stop before publish; the publish invocation includes `-r publish --tag next --no-git-checks`; a changed `latest` or missing `next` tag fails even if pnpm exits zero. Check a retry where pnpm skips an already published package. The test must not contact the real npm registry or push.

```js
assert.deepEqual(publishArgs.slice(0, 5), ['-r', 'publish', '--tag', 'next', '--no-git-checks']);
assert.equal(after['@kddkit/cli'].latest, before['@kddkit/cli'].latest);
assert.equal(after['@kddkit/cli'].next, previewVersion);
```

- [ ] **Step 2: Run red**, then implement `release:next` using the existing bumpp file list and build/test/typecheck/Codex gates. Check branch `next` and lockstep manifests before bumpp; invoke the exact argument list below, then confirm its local tag and version match `X.Y.Z-next.N`. The script prints the changelog preview. No script in this step pushes or publishes.

```js
const files = ['package.json', 'packages/*/package.json', '.claude-plugin/plugin.json',
  'integrations/codex-plugin/.codex-plugin/plugin.json'];
const gates = 'pnpm build && pnpm test && pnpm typecheck && pnpm test:codex-plugin';
const args = ['exec', 'bumpp', ...files, '--release', 'prerelease', '--preid', 'next',
  '--all', '--no-push', '--execute', gates];
const notesArgs = ['-y', 'changelogithub@14', '--dry']; // invoke with npx after bumpp succeeds
```

```json
{
  "release:next": "node scripts/release-next.mjs",
  "release:next:publish": "node scripts/publish-next.mjs"
}
```

- [ ] **Step 3: Implement `publish-next`** with preflight for branch `next`, clean tree, existing matching local tag, and lockstep public package/plugin versions. Read `latest` for `@kddkit/core`, `@kddkit/cli`, and `@kddkit/ui`; execute `pnpm -r publish --tag next --no-git-checks`; reread each package's `latest` and `next` tags. Fail if any `latest` moved or any `next` differs, including a skipped publish on retry. Do not auto-retag a previously published version.

```js
const tagsArgs = (name) => ['view', name, 'dist-tags', '--json', '--registry=https://registry.npmjs.org'];
const publishArgs = ['-r', 'publish', '--tag', 'next', '--no-git-checks'];
// spawnSync('npm', tagsArgs(name)); spawnSync('pnpm', publishArgs);
// Re-read all three packages' tags before reporting success.
```

- [ ] **Step 4: Document the owner's sequence** in `RELEASING.md`: preview, review, publish, inspect tags, push only the reviewed tag, verify GitHub Release is published and prerelease, then fast-forward remote `next` to that commit. Include stable promotion to `master` and `latest`; update `CLAUDE.md`'s short release summary. Keep existing stable scripts unchanged.

```sh
node scripts/test-next-release.mjs
pnpm -r publish --dry-run --tag next --no-git-checks
```

Expected: disposable checks pass; dry run shows `next` without a real publish. Commit the script, tests, docs, and package change.

```sh
git add package.json scripts/release-next.mjs scripts/publish-next.mjs scripts/test-next-release.mjs RELEASING.md CLAUDE.md
git commit -m "feat(release): add guarded next publication"
```

### Task 3: CLI receipt, channel move, and target preflight

**Files:** Modify `packages/cli/src/update.ts`, `packages/cli/test/update.test.ts`.

**Interfaces:** Consume `UpdateChannel`, `updateDisposition`, and `compareVersions` from core. Change `updateCli(target, channel, run, cliFile, nodePath, replaceUnknownSource?)`. Produce `preflightTarget(target: string, channel: UpdateChannel, run: Runner): string | null` (`null` means npm dist-tag agrees). Store receipt at `<kddHome()>/update-cli-receipt.json` with `{cliPath,npmRoot,version,channel}`.

- [ ] **Step 1: Add failing tests** for `next.10` → `next.9` and stable → older preview (no install), `next.10` → stable `0.9.0` (install exact version), missing/invalid receipt (unknown-source skip), valid receipt (unknown-source install), and a later local tarball of the same version/path/root (install under documented continuing consent). Keep known `file:`/nonregistry source and symlink guards. Use a temporary `KDD_HOME`; assert a failed npm install or mismatched PATH version writes no receipt.

```ts
expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath).status).toBe('updated');
expect(updateCli('1.0.0-next.9', 'next', run, runningBundle, nodePath).status).toBe('current');
expect(readFileSync(join(home, 'update-cli-receipt.json'), 'utf8')).toContain('"channel":"stable"');
```

- [ ] **Step 2: Add failing preflight tests** for `npm view @kddkit/cli dist-tags --json --registry=https://registry.npmjs.org`, including malformed output, missing tag, and mismatch. `preflightTarget` must return a reason before any manager call.

```ts
expect(preflightTarget('1.0.0-next.2', 'next', run)).toBeNull();
expect(preflightTarget('1.0.0-next.3', 'next', run)).toContain('next');
```

- [ ] **Step 3: Run red**, then implement receipt read/write with bounded JSON validation and atomic mode-`0600` write/rename. Check npm ownership and explicit nonregistry source before trusting the receipt. Match the real running bundle path, npm root, and installed version; the channel field records consent history but a legitimate switch may change it. Refresh only after exact `kdd --version` verification. A receipt write failure after installation is a reported failure with the observed installed version.

```ts
const receiptMatches = receipt?.cliPath === realpathSync(cliFile)
  && receipt.npmRoot === npmRoot && receipt.version === current;
if (source === undefined && !receiptMatches && !replaceUnknownSource)
  return { name: 'cli', status: 'skipped', detail: 'unknown npm source; pass --replace-cli-from-registry' };
```

```sh
pnpm --filter @kddkit/cli exec vitest run test/update.test.ts
pnpm --filter @kddkit/cli typecheck
```

- [ ] **Step 4: Run green and commit.** Expected: CLI ownership tests still pass; no same-channel downgrade; preview-to-stable succeeds only when other #23 guards permit it.

```sh
git add packages/cli/src/update.ts packages/cli/test/update.test.ts
git commit -m "feat(cli): guard channel updates with receipt"
```

### Task 4: Claude ref switch with plugin restoration

**Files:** Create `packages/cli/src/update-claude.ts`, `packages/cli/test/update-claude.test.ts`; modify `packages/cli/src/update.ts`, `packages/cli/test/update.test.ts` to move existing Claude code without changing its public behavior.

**Interfaces:** Export `updateClaude(target: string, channel: UpdateChannel, run: Runner, cwd: string): ComponentResult[]`; import shared `Runner`/`ComponentResult` from `update.ts`. Inspect `claude plugin list --json`, `claude plugin marketplace list --json`, and `extraKnownMarketplaces.kddkit` in the user/project/local settings JSON. Accept only the expected Git repository and one editable declaration scope.

- [ ] **Step 1: Add failing tests** for same-ref update, `@master` ↔ `@next` switch, equal-version wrong-ref correction, removed plugin reinstallation, target add failure, target install failure, approval-required failure without `-y`, rollback of original ref/version/scope/enabled state, and a rollback failure that reports the saved source. Include multiple declaration scopes or an installed other-project plugin and assert no `remove` call. Keep #23 absent/managed/local skips.

```ts
expect(calls).toContainEqual(['claude', ['plugin', 'marketplace', 'remove', 'kddkit', '--scope', 'user']]);
expect(calls).toContainEqual(['claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', 'user']]);
expect(calls.some(([, args]) => args.includes('-y'))).toBe(false);
```

- [ ] **Step 2: Run red**, then implement ref inspection and preflight. Preserve `github` shorthand versus Git URL transport and append `@next`/`@master` versus `#next`/`#master` accordingly. Before removal, verify the target Git ref and its marketplace/plugin manifests in a disposable shallow checkout. Reject ambiguous scopes, unsupported source, or any installed kddkit scope that this invocation does not own.

- [ ] **Step 3: Implement manager mutation and rollback.** If ref already matches, use scoped `marketplace update` and `plugin update`; otherwise save source/ref/declaration scope plus every affected plugin's version/scope/enabled state, then run `marketplace remove --scope`, `marketplace add <same-source-new-ref> --scope`, `plugin install --scope`, and `plugin disable --scope` if previously disabled. Reinspect exact ref, version, scope, and enabled state. On failure after removal, remove a partial target if present, add saved source/ref, reinstall, restore enabled state, and verify the original state; report both errors if rollback also fails.

```ts
run('claude', ['plugin', 'marketplace', 'remove', 'kddkit', '--scope', declarationScope], cwd);
run('claude', ['plugin', 'marketplace', 'add', targetSource, '--scope', declarationScope], cwd);
run('claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', pluginScope], cwd);
```

```sh
pnpm --filter @kddkit/cli exec vitest run test/update-claude.test.ts test/update.test.ts
pnpm --filter @kddkit/cli typecheck
```

- [ ] **Step 4: Run green and commit.** In a temporary `CLAUDE_CONFIG_DIR`, exercise real Claude CLI against a disposable Git marketplace: switch ref, observe installed plugin, force a target-add failure, and verify rollback. Never use the developer's Claude settings.

```sh
git add packages/cli/src/update.ts packages/cli/src/update-claude.ts packages/cli/test/update.test.ts packages/cli/test/update-claude.test.ts
git commit -m "feat(cli): switch Claude plugin channel safely"
```

### Task 5: Codex ref switch with source-preserving rollback

**Files:** Create `packages/cli/src/update-codex.ts`, `packages/cli/test/update-codex.test.ts`; modify `packages/cli/src/update.ts`, `packages/cli/test/update.test.ts`, `packages/cli/package.json`, `pnpm-lock.yaml` to move existing Codex code and add a direct TOML parser.

**Interfaces:** Export `updateCodex(target: string, channel: UpdateChannel, run: Runner): ComponentResult` and `readCodexSource(configFile: string): {source: string; ref?: string; sparsePaths: string[]} | null`. Read only `${CODEX_HOME ?? ~/.codex}/config.toml` with `smol-toml` >=1.7.1; require `[marketplaces.kddkit]` with `source_type = "git"`, `source`, optional `ref_name`, and optional `sparse_paths`. Cross-check the source with `codex plugin marketplace list --json` and plugin ownership with `codex plugin list --json`.

- [ ] **Step 1: Add failing tests** for a quoted TOML marketplace key, escaped source URL, optional/unset ref, multiple sparse paths, malformed TOML, user config missing while CLI lists a managed marketplace, and config/CLI source mismatch. No failed inspection may call `marketplace remove`. Also test equal-version wrong-ref correction, preview-to-stable downgrade, same-channel downgrade skip, target-add/install failure, exact source/ref/sparse rollback, and inability to restore the original version.

```ts
expect(readCodexSource(configFile)).toEqual({
  source: 'https://github.com/mag1yar/kddkit.git', ref: 'next',
  sparsePaths: ['.agents/plugins', 'integrations/codex-plugin'],
});
expect(calls).toContainEqual(['codex', [
  'plugin', 'marketplace', 'add', 'https://github.com/mag1yar/kddkit.git',
  '--ref', 'master', '--sparse', '.agents/plugins', '--sparse', 'integrations/codex-plugin',
]]);
```

- [ ] **Step 2: Run red**, then add `smol-toml` as a direct CLI runtime dependency and implement read-only parsing/validation. Read `ref_name` and `sparse_paths` from Codex's config, not from its list JSON. Preflight the target Git ref and manifests before removal; preserve the exact original URL and sparse paths. Skip local, managed, unrelated, missing, or ambiguous sources.

```sh
pnpm --filter @kddkit/cli add 'smol-toml@^1.7.2'
```

```ts
import { parse } from 'smol-toml';
const doc = parse(readFileSync(configFile, 'utf8'));
const marketplaces = doc.marketplaces;
if (!marketplaces || typeof marketplaces !== 'object') return null;
const source = (marketplaces as Record<string, unknown>).kddkit;
```

- [ ] **Step 3: Implement switch and rollback** with Codex's `plugin marketplace remove/add --ref/--sparse`. Reinspect after add; run `plugin add kddkit@kddkit` only if the target plugin was not installed at the exact version. If anything fails, remove partial target, re-add saved URL/ref/sparse paths, reinstall when needed, and verify source and original installed version/enabled state. Report critical rollback failure and saved recovery details; never write Codex config/cache directly.

```ts
const addArgs = ['plugin', 'marketplace', 'add', saved.source, '--ref', targetRef,
  ...saved.sparsePaths.flatMap((path) => ['--sparse', path])];
run('codex', ['plugin', 'marketplace', 'remove', 'kddkit']);
run('codex', addArgs);
```

```sh
pnpm --filter @kddkit/cli exec vitest run test/update-codex.test.ts test/update.test.ts
pnpm --filter @kddkit/cli typecheck
```

- [ ] **Step 4: Run green and commit.** Exercise `codex plugin marketplace add/remove` in a temporary `CODEX_HOME` with a disposable Git marketplace over a supported transport; observe same-name ref refusal, switch, and rollback. Keep the user's local kddkit marketplace untouched.

```sh
git add packages/cli/src/update.ts packages/cli/src/update-codex.ts packages/cli/test/update.test.ts packages/cli/test/update-codex.test.ts packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): switch Codex plugin channel safely"
```

### Task 6: Command, agent guidance, docs, and built-product verification

**Files:** Modify `packages/cli/src/index.ts`, `packages/cli/test/update.test.ts`, `skills/kdd-update/SKILL.md`, `packages/cli/README.md`, `README.md`; regenerate `packages/core/dist/*`, `packages/cli/dist/*`, and Codex synced artifacts.

**Interfaces:** Consume `ReleaseInfo.latest/next`, `releaseInfo({fresh:true})`, `preflightTarget`, `updateCli`, `updateClaude`, and `updateCodex`. Produce `kdd update [--next] [--replace-cli-from-registry]` with a nonzero exit if target preflight or any component fails.

- [ ] **Step 1: Add failing built-command tests** with a temporary fetch preloader and fake client executables. Assert `--next` selects only a published `next` release, plain update selects stable and can switch from higher-numbered preview, missing/mismatched npm tag prevents all three manager mutations, one component failure does not suppress the other two, and stable-to-stale-preview leaves all components untouched. Assert `update --help` explains `--next`, unknown-source consent, receipt path, and revocation.

```ts
expect(next.stdout).toContain('1.0.0-next.2');
expect(stable.stdout).toContain('0.9.0');
expect(failedPreflight.status).toBe(1);
expect(managerCalls).toEqual([]);
```

- [ ] **Step 2: Run red**, then wire the command. Fetch `releaseInfo({fresh:true})`, choose `next` or `latest`, reject `--next` globally when its preview version is not above the current stable Release, call npm dist-tag preflight once before manager work, and pass the channel to all three updaters. Preserve per-component results and restart notice. If no published target or old preview is ineligible, fail with a specific reason without falling back to the other channel.

```ts
const channel: UpdateChannel = o.next ? 'next' : 'stable';
const release = await releaseInfo({ fresh: true });
const target = channel === 'next' ? release.next : release.latest;
if (channel === 'next' && target && release.latest
  && compareVersions(target, release.latest) <= 0) { process.exitCode = 1; return; }
if (!target || preflightTarget(target, channel, runCommand)) { process.exitCode = 1; return; }
```

- [ ] **Step 3: Update agent and user guidance.** The skill passes `--next` only after an explicit user request and reports that Git plugin subscription persists until plain `kdd update`; its no-CLI fallback must not silently switch channels. Document exact receipt path and deletion, same-version tarball consequence, preview/stable commands, explicit `@master` pin for new stable Git plugin installs, and per-client restart in CLI/root READMEs. Refresh the Codex skill copy through the existing sync script.

- [ ] **Step 4: Verify built behavior and commit.** Build before tests because CLI tests execute `dist/index.js`. Run full tests and typecheck, built `--help`, release-script check, and artifact sync check. Observe target/ref/rollback behavior in disposable npm prefix, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME`; record exact versions and manager output in #71. Do not run a real publish or push.

```sh
pnpm build
pnpm test
pnpm typecheck
pnpm test:codex-plugin
node scripts/sync-codex-plugin.mjs --check
node packages/cli/dist/index.js update --help
node scripts/test-next-release.mjs
git diff --check
```

```sh
git add packages/cli/src/index.ts packages/cli/test/update.test.ts skills/kdd-update/SKILL.md packages/cli/README.md README.md packages/core/dist packages/cli/dist integrations/codex-plugin/runtime/core.js integrations/codex-plugin/skills/kdd-update/SKILL.md
git commit -m "feat(cli): expose explicit next channel"
```

## Execution Handoff

Implement in task order. After every task, inspect the changed files and run its focused check before committing. Before acceptance, verify the two #71 criteria with observed release-script output and built CLI behavior, record the evidence on #71, and submit the task for review; only the owner closes it.
