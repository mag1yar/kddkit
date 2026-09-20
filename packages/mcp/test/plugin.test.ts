import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('plugin files', () => {
  it('manifest names the plugin kddkit and registers the kdd server', () => {
    const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
    expect(manifest.name).toBe('kddkit');
    const kdd = manifest.mcpServers.kdd;
    expect(kdd.command).toBe('node');
    expect(kdd.args.join(' ')).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(kdd.args.join(' ')).toContain('packages/mcp/dist/main.js');
  });

  it('hooks.json wires SessionStart to both scripts', () => {
    const hooks = JSON.parse(read('hooks/hooks.json'));
    const cmd = hooks.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain('smart-install.mjs');
    expect(cmd).toContain('session-start.mjs');
  });

  it('hooks.json wires SubagentStart to the pointer script', () => {
    const hooks = JSON.parse(read('hooks/hooks.json'));
    const cmd = hooks.hooks.SubagentStart[0].hooks[0].command;
    expect(cmd).toContain('session-start.mjs');
    expect(cmd).not.toContain('smart-install.mjs');
  });

  it('skill declares the kdd contract with an Iron Law', () => {
    const skill = read('skills/kdd/SKILL.md');
    expect(skill).toMatch(/^name:\s*kdd/m);
    expect(skill).toMatch(/Iron Law/i);
  });

  it('ships a native Codex adapter without Claude path variables', () => {
    const plugin = 'integrations/codex-plugin';
    const manifest = JSON.parse(read(`${plugin}/.codex-plugin/plugin.json`));
    expect(manifest.hooks).toBe('./hooks/hooks.json');
    expect(manifest.mcpServers).toBe('./.mcp.json');
    expect(manifest.skills).toBe('./skills/');
    const mcp = JSON.parse(read(`${plugin}/.mcp.json`)).mcpServers.kdd;
    expect(mcp).toMatchObject({ type: 'stdio', command: 'node', args: ['./runtime/mcp.js'], cwd: '.' });
    const hooks = read(`${plugin}/hooks/hooks.json`);
    expect(hooks).toContain('${PLUGIN_ROOT}');
    expect(hooks).not.toContain('CLAUDE_PLUGIN_ROOT');
  });

  it('keeps the documented Codex selector aligned with both marketplaces', () => {
    const selector = read('README.md').match(/codex plugin add kddkit@([^\s`]+)/)?.[1];
    expect(selector).toBeTruthy();
    for (const path of ['.agents/plugins/marketplace.json', '.codex-plugin/marketplace.json']) {
      expect(JSON.parse(read(path)).name).toBe(selector);
    }
  });

  it('uses ComSpec for the Windows npm fallback', () => {
    const installer = read('integrations/codex-plugin/hooks/smart-install.mjs');
    expect(installer).toContain("process.env.ComSpec || 'cmd.exe'");
    expect(installer).toContain("['/d', '/s', '/c', 'npm.cmd ci --omit=dev']");
  });
});
