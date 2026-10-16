import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { getAdapter } from '../src/tools/registry.js';
import { installWindsurf, windsurfDialect, windsurfMcpPaths } from '../src/tools/windsurf.js';
import { makeTestCli, type TestCli } from './helpers.js';

const ARGV = { command: '/usr/bin/node', args: ['/opt/x/dist/bin.js'] };
let t: TestCli;
let repo: string;
let home: string;
let cred: Credential;

beforeEach(() => {
  t = makeTestCli();
  repo = t.deps.cwd;
  home = t.deps.homedir;
  cred = { repoPath: repo, tool: 'windsurf', hubUrl: 'http://127.0.0.1:4747', teamName: 'dev-squad', agentName: 'a', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => t.cleanup());

const devin = (): string => join(home, '.config', 'devin', 'mcp_config.json');
const legacy = (): string => join(home, '.codeium', 'windsurf', 'mcp_config.json');

describe('installWindsurf', () => {
  it('writes the devin MCP config (global, with --repo) and both rules files', async () => {
    const report = await installWindsurf(t.deps, cred, { argv: ARGV });
    expect(report.warnings).toEqual([]);
    expect(JSON.parse(readFileSync(devin(), 'utf8')).mcpServers.agentteams).toEqual({
      command: '/usr/bin/node', args: ['/opt/x/dist/bin.js', 'mcp', '--tool', 'windsurf', '--repo', repo],
    });
    expect(existsSync(legacy())).toBe(false);
    for (const dir of ['.devin', '.windsurf']) {
      const rules = readFileSync(join(repo, dir, 'rules', 'agentteams.md'), 'utf8');
      expect(rules.startsWith('---\ntrigger: always_on\n---\n')).toBe(true);
      expect(rules).toContain('agentteams:start');
      expect(rules).toContain('read_inbox');
      expect(rules).not.toContain('at_SECRET');
      expect(rules.length).toBeLessThan(12000);
    }
    expect(report.done.join('\n')).toContain('cannot inject context');
  });

  it('also writes the legacy codeium config when that install exists; honours XDG_CONFIG_HOME', async () => {
    mkdirSync(join(home, '.codeium', 'windsurf'), { recursive: true });
    await installWindsurf(t.deps, cred, { argv: ARGV });
    expect(existsSync(legacy())).toBe(true);
    expect(windsurfMcpPaths({ env: { XDG_CONFIG_HOME: '/x/cfg' }, homedir: home })).toEqual(['/x/cfg/devin/mcp_config.json', legacy()]);
  });

  it('is byte-identical on re-install and preserves user servers', async () => {
    mkdirSync(join(home, '.config', 'devin'), { recursive: true });
    const user = { mcpServers: { mine: { serverUrl: 'https://x' } } };
    writeFileSync(devin(), JSON.stringify(user));
    await installWindsurf(t.deps, cred, { argv: ARGV });
    const files = [devin(), join(repo, '.devin/rules/agentteams.md'), join(repo, '.windsurf/rules/agentteams.md')];
    const first = files.map((f) => readFileSync(f, 'utf8'));
    await installWindsurf(t.deps, cred, { argv: ARGV });
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(first);
    const cfg = JSON.parse(first[0]!);
    expect(cfg.mcpServers.mine).toEqual({ serverUrl: 'https://x' });
    expect(JSON.parse(readFileSync(`${devin()}.bak`, 'utf8'))).toEqual(user);
  });

  it('malformed config: warning, file untouched, rules still written', async () => {
    mkdirSync(join(home, '.config', 'devin'), { recursive: true });
    writeFileSync(devin(), '{ nope');
    const report = await installWindsurf(t.deps, cred, { argv: ARGV });
    expect(readFileSync(devin(), 'utf8')).toBe('{ nope');
    expect(report.warnings.join('\n')).toContain('mcp_config.json is not valid JSON');
    expect(existsSync(join(repo, '.devin/rules/agentteams.md'))).toBe(true);
  });
});

describe('windsurf adapter', () => {
  it('is tier mcp and its dialect never prints', () => {
    const a = getAdapter('windsurf');
    expect(a.tier).toBe('mcp');
    expect(a.installForWorktree).toBeUndefined();
    expect(windsurfDialect.render({ type: 'block', text: 'x' }, {})).toEqual({ stdout: '', exitCode: 0 });
    expect(windsurfDialect.render({ type: 'context', event: 'stop', text: 'x' }, {}).stdout).toBe('');
  });
});
