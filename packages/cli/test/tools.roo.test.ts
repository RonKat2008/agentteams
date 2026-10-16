import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { getAdapter } from '../src/tools/registry.js';
import { rooAdapter } from '../src/tools/roo.js';
import { makeTestCli, type TestCli } from './helpers.js';

const excludeLines = (p: string): string[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n') : []);

let t: TestCli;
let cred: Credential;
let exclude: string;

beforeEach(() => {
  t = makeTestCli();
  exclude = join(t.root, 'exclude');
  t.deps.exec = async (_c, a) =>
    a.includes('--git-path') ? { code: 0, stdout: `${exclude}\n`, stderr: '' } : { code: 0, stdout: `${t.deps.cwd}\n`, stderr: '' };
  cred = { repoPath: t.deps.cwd, tool: 'roo', hubUrl: 'http://h', teamName: 'dev-squad', agentName: 'a', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => t.cleanup());

const f = (p: string): string => join(t.deps.cwd, p);

describe('roo install', () => {
  it('is a registered tier-mcp adapter', () => {
    expect(getAdapter('roo')).toBe(rooAdapter);
    expect(rooAdapter.tier).toBe('mcp');
  });

  it('writes .roo/mcp.json (stdio, --repo), rules file, git-excludes mcp.json, no api key', async () => {
    const r = await rooAdapter.install(t.deps, cred);
    expect(r.warnings).toEqual([]);
    const entry = JSON.parse(readFileSync(f('.roo/mcp.json'), 'utf8')).mcpServers.agentteams;
    expect(entry.args.slice(-5)).toEqual(['mcp', '--tool', 'roo', '--repo', t.deps.cwd]);
    expect(entry.disabled).toBe(false);
    expect(readFileSync(f('.roo/rules/agentteams.md'), 'utf8')).toContain('dev-squad');
    expect(readFileSync(exclude, 'utf8')).toContain('.roo/mcp.json');
    expect(readFileSync(f('.roo/mcp.json'), 'utf8')).not.toContain('at_SECRET');
  });

  it('is idempotent and preserves user servers', async () => {
    mkdirSync(f('.roo'), { recursive: true });
    writeFileSync(f('.roo/mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } }, other: 1 }));
    const r1 = await rooAdapter.install(t.deps, cred);
    expect(r1.warnings.some((w) => w.includes('machine-specific'))).toBe(true);
    const first = [readFileSync(f('.roo/mcp.json'), 'utf8'), readFileSync(f('.roo/rules/agentteams.md'), 'utf8')];
    await rooAdapter.install(t.deps, cred);
    expect([readFileSync(f('.roo/mcp.json'), 'utf8'), readFileSync(f('.roo/rules/agentteams.md'), 'utf8')]).toEqual(first);
    const cfg = JSON.parse(first[0] as string);
    expect(cfg.mcpServers.mine).toEqual({ command: 'x' });
    expect(cfg.other).toBe(1);
    // The user's pre-existing file is not hidden from git; only our backup is.
    expect(excludeLines(exclude)).not.toContain('.roo/mcp.json');
    expect(excludeLines(exclude)).toContain('.roo/mcp.json.bak');
  });

  it('malformed JSON: warns and leaves it untouched, still writes rules', async () => {
    mkdirSync(f('.roo'), { recursive: true });
    writeFileSync(f('.roo/mcp.json'), '{bad');
    const r = await rooAdapter.install(t.deps, cred);
    expect(readFileSync(f('.roo/mcp.json'), 'utf8')).toBe('{bad');
    expect(r.warnings.some((w) => w.includes('not valid JSON'))).toBe(true);
    expect(existsSync(f('.roo/rules/agentteams.md'))).toBe(true);
  });
});
