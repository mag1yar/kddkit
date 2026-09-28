import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KddError } from './errors.js';
import { observeCodexNative } from './codex_native_probe.js';

function directory(path: string): string {
  try {
    if (!isAbsolute(path) || !lstatSync(path).isDirectory()) throw new Error('not a real directory');
    return realpathSync(path);
  } catch (error) {
    throw new KddError(`native root unavailable: ${path}: ${(error as Error).message}`);
  }
}

/** A successful scan is not a launch permit: start/resume must scan again under the controller lock. */
export function assertWritableRoots(roots: readonly string[]): readonly string[] {
  if (!roots.length) throw new KddError('native writable roots are unknown');
  const canonical = [...new Set(roots.map(directory))];
  function scan(path: string): void {
    const before = lstatSync(path);
    if (!before.isDirectory()) {
      // lstat checks the link inode, never its foreign target (including dangling symlinks).
      if (before.nlink > 1) throw new KddError(`native hardlink in writable root: ${path}`);
      return;
    }
    for (const name of readdirSync(path)) scan(join(path, name));
    const after = lstatSync(path);
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new KddError(`native root changed during scan: ${path}`);
    }
  }
  try {
    for (const root of canonical) scan(root);
  } catch (error) {
    if (error instanceof KddError) throw error;
    throw new KddError(`native root scan incomplete: ${(error as Error).message}`);
  }
  return canonical;
}

/** Trusted controller filesystem/config mutations must use this same protected project directory. */
export async function withNativeControllerLock<T>(controlDir: string, action: () => T | Promise<T>): Promise<T> {
  const lock = join(directory(controlDir), 'native-launch.lock');
  // ponytail: one project-wide lock; finer locks only if controller throughput requires them.
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new KddError('native controller busy; stale locks require trusted recovery');
    throw new KddError(`native controller lock unavailable: ${(error as Error).message}`);
  }
  const identity = lstatSync(lock);
  try { return await action(); }
  finally {
    const current = lstatSync(lock);
    if (identity.dev !== current.dev || identity.ino !== current.ino || !current.isDirectory()) {
      throw new KddError('native controller lock replaced; trusted recovery required');
    }
    rmdirSync(lock);
  }
}

export interface NativeLaunchInput {
  controlDir: string;
  writableRoots: readonly string[];
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  phase: 'start' | 'resume';
  verified?: VerifiedCodexPackage;
}

export function inside(parent: string, path: string): boolean {
  const suffix = relative(parent, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/** Trusted-host primitive; the runtime adapter must bind its arguments to the verified native package. */
export async function spawnCheckedNative(input: NativeLaunchInput): Promise<ChildProcess> {
  const { executable, cwd, phase, verified } = input;
  const args = [...input.args];
  const env = { ...input.env };
  const roots = [...input.writableRoots];
  if (phase !== 'start' && phase !== 'resume') throw new KddError('unknown native launch phase');
  const controlDir = directory(input.controlDir);
  const canonical = roots.map(directory);
  if (canonical.some(root => inside(root, controlDir))) throw new KddError('native control directory is writable');
  return withNativeControllerLock(controlDir, () => {
    if (verified !== undefined) {
      assertVerifiedCodexPackage(verified);
      if (executable !== verified.executable || cwd !== verified.cwd || controlDir !== verified.controlDir
        || JSON.stringify(env) !== JSON.stringify(verified.env)
        || JSON.stringify(canonical) !== JSON.stringify([verified.scratchDir, ...(verified.writableRoot ? [verified.writableRoot] : [])])
        || args.length !== verified.argv.length + 1 || verified.argv.some((arg, i) => args[i] !== arg)) {
        throw new KddError('native launch differs from verified package');
      }
    }
    // Bind the roots again after lock acquisition; no caller callback/await occurs between this scan and spawn.
    if (roots.some((root, index) => directory(root) !== canonical[index])) throw new KddError('native root binding changed');
    assertWritableRoots(canonical);
    const child = spawn(executable, args, { cwd: resolve(cwd), env, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise<ChildProcess>((resolveChild, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.removeListener('error', reject); resolveChild(child); });
    });
  });
}

export interface CodexPermissionInput {
  executable: string; cwd: string; controlDir: string; model: string;
  readableRoots: readonly string[]; writableRoot?: string; scratchDir: string;
  protectedPaths: readonly string[];
  brokerConfigPath?: string; brokerEntryPath?: string;
}
export interface NativeProbeResult {
  caseId: string; tool: string; outcome: 'allowed' | 'denied' | 'inconclusive';
  executed: boolean; unchangedProtectedBytes: boolean;
}
export interface CodexBrokerBinding { configPath: string; entryPath: string; dbPath: string; nodePath: string }
export function codexBrokerBinding(configPath: string, entryPath: string): CodexBrokerBinding {
  try {
    for (const path of [configPath, entryPath]) {
      if (!isAbsolute(path) || !lstatSync(path).isFile() || lstatSync(path).nlink !== 1) throw new KddError('native broker binding unavailable');
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    if ((lstatSync(configPath).mode & 0o777) !== 0o600 || !config || Array.isArray(config)
      || Object.keys(config).sort().join(',') !== 'dbPath,token'
      || typeof config.dbPath !== 'string' || !isAbsolute(config.dbPath) || realpathSync(config.dbPath) !== config.dbPath
      || typeof config.token !== 'string' || !/^[0-9a-f]{64}$/.test(config.token)) throw new KddError('native broker config denied');
    for (const path of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
      try { if (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1) throw new KddError('native store alias denied'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path === config.dbPath) throw error; }
    }
    return { configPath: realpathSync(configPath), entryPath: realpathSync(entryPath), dbPath: config.dbPath, nodePath: realpathSync(process.execPath) };
  } catch (error) {
    if (error instanceof KddError) throw error;
    throw new KddError('native broker binding unavailable');
  }
}
export interface VerifiedCodexPackage {
  readonly executable: string; readonly version: string; readonly cwd: string;
  readonly controlDir: string; readonly readableRoots: readonly string[];
  readonly writableRoot?: string; readonly scratchDir: string; readonly protectedPaths: readonly string[];
  readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>>;
  readonly configHash: string; readonly results: readonly NativeProbeResult[];
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const verifiedPackages = new WeakMap<object, { stamp: string; snapshot: () => string }>();

/** Internal shared template; only preflight can register a verified package. */
export function closedCodexCatalog(model: string): string {
  return JSON.stringify({ models: [{
    slug: model, display_name: model, description: 'Managed coding tools',
    base_instructions: 'Follow the supplied task instructions.', supported_reasoning_levels: [],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0,
    availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: 'freeform', truncation_policy: { mode: 'tokens', limit: 10000 },
    experimental_supported_tools: [], tool_mode: 'direct', multi_agent_version: 'disabled',
  }] });
}

export function fixedCodexConfig(filesystem: Record<string, 'read' | 'write' | 'deny'>, catalogPath: string, broker?: CodexBrokerBinding): string[] {
  const table = Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
  return [
    'model_provider="openai"',
    `model_catalog_json=${JSON.stringify(catalogPath)}`,
    'approval_policy="never"', 'default_permissions="kdd_probe"',
    `permissions.kdd_probe.filesystem={${table}}`, 'permissions.kdd_probe.network.enabled=false',
    'web_search="disabled"', 'project_doc_max_bytes=0', 'tools.experimental_request_user_input.enabled=false',
    'shell_environment_policy.inherit="none"',
    ...(broker ? [`mcp_servers={kdd_run={command=${JSON.stringify(broker.nodePath)},args=${JSON.stringify([broker.entryPath, '--config', broker.configPath])},enabled=true,required=true,env_vars=[],default_tools_approval_mode="auto",startup_timeout_sec=10.0,tool_timeout_sec=10.0,enabled_tools=["get_context","submit_report","request_question"]}}`] : []),
    'features={apply_patch_freeform=true,unified_exec=true,enable_request_compression=false,plugins=false,apps=false,connectors=false,enable_mcp_apps=false,codex_apps_mcp_2026_07_28=false,multi_agent=false,multi_agent_v2=false,multi_agent_mode=false,agent_message_board=false,computer_use=false,browser_use=false,browser_use_external=false,browser_use_full_cdp_access=false,in_app_browser=false,hooks=false,codex_hooks=false,plugin_hooks=false,shell_snapshot=false,shell_snapshot_v2=false,responses_websockets=false,responses_websockets_v2=false,skip_host_skill_discovery=true,skill_search=false,skill_mcp_dependency_install=false,goals=false,view_image=false,image_generation=false,imagegenext=false,js_repl=false,js_repl_tools_only=false,code_mode=false,code_mode_host=false,code_mode_only=false,memories=false,memory_tool=false,external_agent_memory_import=false,standalone_web_search=false,web_search=false,web_search_cached=false,web_search_request=false,search_tool=false,tool_search=false,tool_search_always_defer_mcp_tools=false,remote_models=false,remote_control=false,remote_plugin=false,daemon_auto_start=false,request_permissions=false,request_permissions_tool=false,request_rule=false,tool_call_mcp_elicitation=false,default_mode_request_user_input=false,api_key_model_discovery=false}',
  ];
}

export function fixedCodexArguments(cwd: string, model: string, config: readonly string[]): string[] {
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral', '--skip-git-repo-check', '--json', '-C', cwd, '-m', model];
  for (const override of config) args.push('-c', override);
  return [...args, '--']; // The adapter appends exactly one positional prompt, never late flags.
}

function assertNoProjectConfig(roots: readonly string[]): void {
  const ignoredUser = process.env.HOME ? resolve(process.env.HOME, '.codex/config.toml') : undefined;
  for (const root of roots) {
    for (let dir = root;; dir = dirname(dir)) {
      const config = join(dir, '.codex/config.toml');
      if (config !== ignoredUser) {
        try { lstatSync(config); throw new KddError('native project config overlay unsupported'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (dirname(dir) === dir) break;
    }
  }
}

export function assertVerifiedCodexPackage(packet: unknown): asserts packet is VerifiedCodexPackage {
  const binding = typeof packet === 'object' && packet !== null ? verifiedPackages.get(packet) : undefined;
  if (!binding) throw new KddError('unverified native package');
  try {
    if (binding.snapshot() !== binding.stamp) throw new KddError('native package binding changed');
  } catch { throw new KddError('native package binding changed or unavailable'); }
}

export async function preflightCodex(input: CodexPermissionInput): Promise<VerifiedCodexPackage> {
  // Capture caller data before the asynchronous real-tool proof.
  const cwd = directory(input.cwd); const scratchDir = directory(input.scratchDir);
  const controlDir = directory(input.controlDir);
  const executable = realpathSync(input.executable);
  const runtimeDir = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const readableRoots = [...new Set(input.readableRoots.map(directory))];
  const writableRoot = input.writableRoot ? directory(input.writableRoot) : undefined;
  if ((input.brokerConfigPath === undefined) !== (input.brokerEntryPath === undefined)) throw new KddError('incomplete native broker binding');
  const broker = input.brokerConfigPath === undefined ? undefined : codexBrokerBinding(input.brokerConfigPath, input.brokerEntryPath!);
  const protectedPaths = [...new Set([...input.protectedPaths, controlDir,
    ...(broker ? [broker.configPath, broker.entryPath, dirname(broker.dbPath)] : [])].map(path => {
    if (!isAbsolute(path)) throw new KddError('native protected path must be absolute');
    return realpathSync(path);
  }))];
  const model = input.model;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(model)) throw new KddError('unsupported Codex model identifier');
  if (!readableRoots.includes(cwd) || (writableRoot && writableRoot !== cwd)) throw new KddError('unsupported Codex workspace scope');
  const writableRoots = [scratchDir, ...(writableRoot ? [writableRoot] : [])];
  const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
  if (readableRoots.some(root => overlaps(root, scratchDir))
    || writableRoots.some(root => [...protectedPaths, runtimeDir, executable].some(path => overlaps(root, path)))) throw new KddError('native root/control/runtime overlap');
  assertNoProjectConfig([cwd]);
  if (process.platform !== 'darwin') throw new KddError('unsupported Codex host');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
  if (version !== 'codex-cli 0.157.0') throw new KddError('unsupported Codex version');
  const resolveGitMetadata = () => [...new Set(readableRoots.flatMap(root => [join(root, '.git'), ...['--absolute-git-dir', '--git-common-dir']
    .map(flag => realpathSync(execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', '--path-format=absolute', flag], { encoding: 'utf8' }).trim()))]))];
  const gitMetadata = resolveGitMetadata();
  const filesystem: Record<string, 'read' | 'write' | 'deny'> = { ':minimal': 'read' };
  for (const path of readableRoots) filesystem[path] = 'read';
  for (const path of writableRoots) filesystem[path] = 'write';
  for (const path of protectedPaths) filesystem[path] = 'deny';
  for (const path of [...gitMetadata, join(cwd, '.codex')]) filesystem[path] = 'read';
  const catalog = closedCodexCatalog(model);
  const catalogPath = join(controlDir, `codex-catalog-${digest(catalog)}.json`);
  filesystem[catalogPath] = 'deny';
  const argv = Object.freeze(fixedCodexArguments(cwd, model, fixedCodexConfig(filesystem, catalogPath, broker)));
  if (!process.env.HOME) throw new KddError('Codex home unavailable');
  const env = Object.freeze({ HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', TMPDIR: scratchDir, LANG: 'en_US.UTF-8' });
  return withNativeControllerLock(controlDir, async () => {
    assertWritableRoots(writableRoots);
    if (existsSync(catalogPath)) {
      if (lstatSync(catalogPath).isSymbolicLink() || readFileSync(catalogPath, 'utf8') !== catalog) throw new KddError('native catalog binding changed');
    } else writeFileSync(catalogPath, catalog, { mode: 0o600, flag: 'wx' });
    const snapshot = () => {
      assertNoProjectConfig([cwd]);
      assertWritableRoots(writableRoots);
      if (JSON.stringify(resolveGitMetadata()) !== JSON.stringify(gitMetadata)) throw new KddError('native Git binding changed');
      const catalogStat = lstatSync(catalogPath);
      if (!catalogStat.isFile() || catalogStat.nlink !== 1) throw new KddError('native catalog binding alias');
      const currentBroker = broker ? codexBrokerBinding(broker.configPath, broker.entryPath) : undefined;
      const identities = [...new Set([cwd, controlDir, ...readableRoots, ...writableRoots, ...protectedPaths, ...gitMetadata,
        ...(broker ? [broker.dbPath, broker.nodePath] : [])])].map(path => {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new KddError('native binding alias');
        return [path, stat.dev, stat.ino];
      });
      return digest(JSON.stringify({ identities, argv, env, executable, version,
        gitPointers: gitMetadata.filter(path => lstatSync(path).isFile()).map(path => [path, digest(readFileSync(path))]),
        executableHash: digest(readFileSync(executable)), catalogHash: digest(readFileSync(catalogPath)),
        broker: currentBroker, brokerEntryHash: broker ? digest(readFileSync(broker.entryPath)) : undefined,
        nodeHash: broker ? digest(readFileSync(broker.nodePath)) : undefined,
        runtimeHash: digest(readFileSync(fileURLToPath(import.meta.url))) }));
    };
    const stamp = snapshot();
    const evidence = await observeCodexNative(executable, false, model, broker);
    if (!evidence.applicable || evidence.rawDiagnostic || evidence.observations.length !== (broker ? 158 : 129)
      || evidence.executed !== evidence.observations.length) throw new KddError('Codex native enforcement unverified');
    if (snapshot() !== stamp) throw new KddError('native package binding changed during preflight');
    const results = Object.freeze(evidence.observations.filter(result => !result.control).map(result => Object.freeze({
      caseId: `${result.mode}:${result.caseId}`, tool: result.tool, outcome: result.outcome,
      executed: result.executed, unchangedProtectedBytes: result.unchangedProtectedBytes,
    })));
    const packet = Object.freeze({ executable, version, cwd, controlDir, readableRoots: Object.freeze(readableRoots),
      writableRoot, scratchDir, protectedPaths: Object.freeze(protectedPaths), argv, env, configHash: stamp, results });
    verifiedPackages.set(packet, { stamp, snapshot });
    return packet;
  });
}
