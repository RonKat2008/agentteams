import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolKind } from '@agentteams/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { isManagedMcpEntry, mcpEntryRepo, setMcpEntry } from '../src/tools/jsonConfig.js';
import { getAdapter } from '../src/tools/registry.js';
import { makeTestCli, type TestCli } from './helpers.js';

let t: TestCli;
let exclude: string;
const credFor = (tool: ToolKind, repoPath = t.deps.cwd): Credential => ({
  repoPath, tool, hubUrl: 'http://h', teamName: 'dev-squad', agentName: 'a', apiKey: 'at_SECRET', createdAt: 'x',
});

beforeEach(() => {
  t = makeTestCli();
  exclude = join(t.deps.cwd, '.git', 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  t.deps.exec = async () => ({ code: 0, stdout: `${exclude}\n`, stderr: '' });
});
afterEach(() => t.cleanup());

/** Every adapter-written JSON file that holds an "agentteams" MCP entry: [tool, file (home: or repo-relative), key]. */
const CASES: Array<[ToolKind, string, string]> = [
  ['cursor', '.cursor/mcp.json', 'mcpServers'],
  ['gemini', '.gemini/settings.json', 'mcpServers'],
  ['droid', '.factory/mcp.json', 'mcpServers'],
  ['copilot', '.github/mcp.json', 'mcpServers'],
  ['copilot', '.vscode/mcp.json', 'servers'],
  ['opencode', 'opencode.json', 'mcp'],
  ['roo', '.roo/mcp.json', 'mcpServers'],
  ['cline', 'home:.cline/data/settings/cline_mcp_settings.json', 'mcpServers'],
  ['windsurf', 'home:.config/devin/mcp_config.json', 'mcpServers'],
];

const abs = (f: string): string => (f.startsWith('home:') ? join(t.deps.homedir, f.slice(5)) : join(t.deps.cwd, f));
const seed = (f: string, text: string): void => {
  mkdirSync(dirname(abs(f)), { recursive: true });
  writeFileSync(abs(f), text);
};

describe.each(CASES)('%s %s', (tool, file, key) => {
  it('non-object sub-value: refuses with a warning, file byte-identical, no .bak', async () => {
    const text = JSON.stringify({ [key]: ['user-value'], keep: 1 });
    seed(file, text);
    const r = await getAdapter(tool).install(t.deps, credFor(tool));
    expect(readFileSync(abs(file), 'utf8')).toBe(text);
    expect(existsSync(`${abs(file)}.bak`)).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/unexpected shape.*left untouched/);
  });

  it('user-owned "agentteams" entry: kept, warned, never overwritten', async () => {
    const mine = { command: 'my-own-server', args: ['--port', '1'] };
    const text = JSON.stringify({ [key]: { agentteams: mine } });
    seed(file, text);
    const r = await getAdapter(tool).install(t.deps, credFor(tool));
    expect(JSON.parse(readFileSync(abs(file), 'utf8'))[key].agentteams).toEqual(mine);
    if (tool !== 'gemini') expect(readFileSync(abs(file), 'utf8')).toBe(text); // gemini still gets its hooks
    expect(r.warnings.join('\n')).toContain(`"${key}.agentteams" is user-defined`);
  });

  it('managed entry from an older install is replaced', async () => {
    const old = { command: '/old/node', args: ['/old/dist/bin.js', 'mcp', '--tool', tool, '--repo', t.deps.cwd] };
    seed(file, JSON.stringify({ [key]: { agentteams: old } }));
    await getAdapter(tool).install(t.deps, credFor(tool));
    expect(JSON.parse(readFileSync(abs(file), 'utf8'))[key].agentteams).not.toEqual(old);
  });
});

const REPO_CASES = CASES.filter(([, f]) => !f.startsWith('home:'));
const excludeLines = (): string[] => (existsSync(exclude) ? readFileSync(exclude, 'utf8').split('\n') : []);

describe.each(REPO_CASES)('git-exclude policy: %s %s', (tool, file, key) => {
  it('a pre-existing user file is warned about, not excluded; its .bak is excluded', async () => {
    seed(file, JSON.stringify({ [key]: { mine: { command: 'x' } } }));
    const r = await getAdapter(tool).install(t.deps, credFor(tool));
    expect(excludeLines()).not.toContain(file);
    expect(excludeLines()).toContain(`${file}.bak`);
    expect(r.warnings).toContain(`${file} already existed; the agentteams entry contains machine-specific paths, do not commit it`);
  });

  it('a file we created is excluded and re-installs do not warn', async () => {
    await getAdapter(tool).install(t.deps, credFor(tool));
    expect(excludeLines()).toContain(file);
    const again = await getAdapter(tool).install(t.deps, credFor(tool));
    expect(again.warnings).toEqual([]);
  });
});

describe.each([
  ['cline', '~/.cline/data/settings/cline_mcp_settings.json'],
  ['windsurf', '~/.config/devin/mcp_config.json'],
] as Array<[ToolKind, string]>)('global single-entry config: %s', (tool, shown) => {
  it('warns when the managed entry is repointed from another repo, and only then', async () => {
    const other = join(t.root, 'repo-b');
    mkdirSync(other, { recursive: true });
    const first = await getAdapter(tool).install(t.deps, credFor(tool));
    expect(first.warnings.filter((w) => w.includes('pointing at'))).toEqual([]);
    const same = await getAdapter(tool).install(t.deps, credFor(tool));
    expect(same.warnings.filter((w) => w.includes('pointing at'))).toEqual([]);
    const moved = await getAdapter(tool).install(t.deps, credFor(tool, other));
    expect(moved.warnings).toContain(
      `${shown}: agentteams MCP was pointing at ${t.deps.cwd}; it now points at ${other} (this agent supports one agentteams repo at a time)`,
    );
  });
});

describe('gemini hooks shape', () => {
  it('non-object "hooks" leaves settings.json untouched with a warning', async () => {
    const text = JSON.stringify({ hooks: 'nope' });
    seed('.gemini/settings.json', text);
    const r = await getAdapter('gemini').install(t.deps, credFor('gemini'));
    expect(readFileSync(abs('.gemini/settings.json'), 'utf8')).toBe(text);
    expect(r.warnings.join('\n')).toMatch(/unexpected shape/);
  });
});

describe('MCP entry helpers', () => {
  it('isManagedMcpEntry: true only when argv runs our proxy ("mcp" then "--tool")', () => {
    expect(isManagedMcpEntry({ command: 'node', args: ['/x/bin.js', 'mcp', '--tool', 'cursor'] })).toBe(true);
    expect(isManagedMcpEntry({ type: 'local', command: ['node', '/x/bin.js', 'mcp', '--tool', 'opencode'] })).toBe(true);
    expect(isManagedMcpEntry({ command: 'agentteams', args: ['mcp', '--tool', 'roo'] })).toBe(true);
    expect(isManagedMcpEntry({ command: 'npx', args: ['some-mcp', '--tool'] })).toBe(false);
    expect(isManagedMcpEntry({ url: 'https://x' })).toBe(false);
    expect(isManagedMcpEntry('str')).toBe(false);
  });
  it('mcpEntryRepo reads --repo', () => {
    expect(mcpEntryRepo({ command: 'n', args: ['b', 'mcp', '--tool', 'cline', '--repo', '/a'] })).toBe('/a');
    expect(mcpEntryRepo({ command: 'n', args: ['b', 'mcp', '--tool', 'cline'] })).toBeUndefined();
  });
  it('setMcpEntry is pure and keeps other servers', () => {
    const cfg = { mcpServers: { mine: { command: 'x' } }, other: 1 };
    const next = setMcpEntry(cfg, 'mcpServers', { command: 'n', args: ['mcp', '--tool', 'x'] });
    expect(cfg).toEqual({ mcpServers: { mine: { command: 'x' } }, other: 1 });
    expect(next).toEqual({ mcpServers: { mine: { command: 'x' }, agentteams: { command: 'n', args: ['mcp', '--tool', 'x'] } }, other: 1 });
  });
});
