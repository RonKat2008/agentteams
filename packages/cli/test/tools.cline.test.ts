import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { clineAdapter, clineSettingsPaths } from '../src/tools/cline.js';
import { getAdapter } from '../src/tools/registry.js';
import { makeTestCli, type TestCli } from './helpers.js';

let t: TestCli;
let cred: Credential;
let cliSettings: string;

beforeEach(() => {
  t = makeTestCli();
  cliSettings = join(t.deps.homedir, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
  cred = { repoPath: t.deps.cwd, tool: 'cline', hubUrl: 'http://h', teamName: 'dev-squad', agentName: 'a', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => t.cleanup());

describe('cline install', () => {
  it('is a registered tier-mcp adapter', () => {
    expect(getAdapter('cline')).toBe(clineAdapter);
    expect(clineAdapter.tier).toBe('mcp');
  });

  it('writes CLI settings (never creates VS Code storage) and the rules file', async () => {
    const r = await clineAdapter.install(t.deps, cred);
    const entry = JSON.parse(readFileSync(cliSettings, 'utf8')).mcpServers.agentteams;
    expect(entry.args.slice(-5)).toEqual(['mcp', '--tool', 'cline', '--repo', t.deps.cwd]);
    expect(entry.disabled).toBe(false);
    expect(readFileSync(join(t.deps.cwd, '.clinerules/agentteams.md'), 'utf8')).toContain('dev-squad');
    expect(readFileSync(cliSettings, 'utf8')).not.toContain('at_SECRET');
    expect(existsSync(join(t.deps.homedir, 'Library'))).toBe(false);
    expect(existsSync(join(t.deps.homedir, '.config'))).toBe(false);
    expect(r.warnings.every((w) => !w.includes('not valid'))).toBe(true);
  });

  it('honours CLINE_MCP_SETTINGS_PATH and also writes the VS Code extension file when its storage exists', async () => {
    const override = join(t.root, 'custom', 'settings.json');
    t.deps.env = { CLINE_MCP_SETTINGS_PATH: override, XDG_CONFIG_HOME: join(t.root, 'xdg'), APPDATA: join(t.root, 'appdata') };
    const userDir = process.platform === 'darwin' ? join(t.deps.homedir, 'Library', 'Application Support', 'Code', 'User')
      : process.platform === 'win32' ? join(t.root, 'appdata', 'Code', 'User') : join(t.root, 'xdg', 'Code', 'User');
    const storage = join(userDir, 'globalStorage', 'saoudrizwan.claude-dev');
    expect(await clineSettingsPaths(t.deps)).toEqual([override]);
    mkdirSync(storage, { recursive: true });
    expect(await clineSettingsPaths(t.deps)).toEqual([override, join(storage, 'settings', 'cline_mcp_settings.json')]);
    mkdirSync(join(storage, 'settings'), { recursive: true });
    writeFileSync(join(storage, 'settings', 'cline_mcp_settings.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
    await clineAdapter.install(t.deps, cred);
    expect(existsSync(override)).toBe(true);
    const ext = JSON.parse(readFileSync(join(storage, 'settings', 'cline_mcp_settings.json'), 'utf8'));
    expect(ext.mcpServers.mine).toEqual({ command: 'x' });
    expect(ext.mcpServers.agentteams).toBeDefined();
  });

  it('is idempotent', async () => {
    await clineAdapter.install(t.deps, cred);
    const first = [readFileSync(cliSettings, 'utf8'), readFileSync(join(t.deps.cwd, '.clinerules/agentteams.md'), 'utf8')];
    await clineAdapter.install(t.deps, cred);
    expect([readFileSync(cliSettings, 'utf8'), readFileSync(join(t.deps.cwd, '.clinerules/agentteams.md'), 'utf8')]).toEqual(first);
  });

  it('malformed settings JSON: warning, untouched, no .bak', async () => {
    mkdirSync(join(cliSettings, '..'), { recursive: true });
    writeFileSync(cliSettings, '[oops');
    const r = await clineAdapter.install(t.deps, cred);
    expect(readFileSync(cliSettings, 'utf8')).toBe('[oops');
    expect(existsSync(`${cliSettings}.bak`)).toBe(false);
    expect(r.warnings.some((w) => w.includes('not valid JSON'))).toBe(true);
  });

  it('keeps user servers and writes a .bak once', async () => {
    mkdirSync(join(cliSettings, '..'), { recursive: true });
    const orig = JSON.stringify({ mcpServers: { mine: { command: 'x' } } });
    writeFileSync(cliSettings, orig);
    await clineAdapter.install(t.deps, cred);
    expect(JSON.parse(readFileSync(cliSettings, 'utf8')).mcpServers.mine).toEqual({ command: 'x' });
    expect(readFileSync(`${cliSettings}.bak`, 'utf8')).toBe(orig);
  });
});
