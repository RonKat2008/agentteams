import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { installDroid } from '../src/tools/droid.js';
import { getAdapter } from '../src/tools/registry.js';
import { makeTestCli, type TestCli } from './helpers.js';

let t: TestCli;
let repo: string;
let cred: Credential;
const CLI = "'/usr/bin/node' '/opt/x/dist/bin.js'";
const ARGV = { command: '/usr/bin/node', args: ['/opt/x/dist/bin.js'] };
const opts = { cli: CLI, argv: ARGV };
const f = (name: string) => join(repo, '.factory', name);
const readJson = (name: string) => JSON.parse(readFileSync(f(name), 'utf8'));

beforeEach(() => {
  t = makeTestCli();
  repo = t.deps.cwd;
  const base = t.deps.exec;
  t.deps.exec = (cmd, args, o) =>
    cmd === 'git' && args.includes('--git-path')
      ? Promise.resolve({ code: 0, stdout: `${join(repo, '.git', args[args.length - 1]!)}\n`, stderr: '' })
      : base(cmd, args, o);
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  cred = { repoPath: repo, tool: 'droid', hubUrl: 'http://127.0.0.1:4747', teamName: 'dev-squad', agentName: 'ronit-droid', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => t.cleanup());

describe('droid install', () => {
  it('fresh install writes mcp.json, top-level-event hooks.json, AGENTS.md and excludes', async () => {
    const report = await installDroid(t.deps, cred, opts);
    expect(report.warnings).toEqual([]);
    expect(readJson('mcp.json').mcpServers.agentteams).toEqual({
      type: 'stdio', command: '/usr/bin/node', args: ['/opt/x/dist/bin.js', 'mcp', '--tool', 'droid', '--repo', repo],
    });
    const hooks = readJson('hooks.json');
    expect(hooks.hooks).toBeUndefined();
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: `${CLI} hook stop --tool droid --agentteams-managed`, timeout: 10 });
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toContain('agentteams:start');
    const ex = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(ex).toContain('.factory/mcp.json');
    expect(ex).toContain('.factory/hooks.json');
    expect(readFileSync(f('mcp.json'), 'utf8') + readFileSync(f('hooks.json'), 'utf8')).not.toContain('at_SECRET');
  });

  it('reinstall is byte-identical', async () => {
    await installDroid(t.deps, cred, opts);
    const snap = ['mcp.json', 'hooks.json'].map((n) => readFileSync(f(n), 'utf8'));
    const md = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const ex = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    await installDroid(t.deps, cred, opts);
    expect(['mcp.json', 'hooks.json'].map((n) => readFileSync(f(n), 'utf8'))).toEqual(snap);
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe(md);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe(ex);
  });

  it('preserves user MCP servers and hooks; does not exclude pre-existing files', async () => {
    mkdirSync(join(repo, '.factory'));
    const mcp = { mcpServers: { mine: { type: 'http', url: 'https://x' } } };
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [{ matcher: 'Execute', hooks: [] }] };
    writeFileSync(f('mcp.json'), JSON.stringify(mcp));
    writeFileSync(f('hooks.json'), JSON.stringify(hooks));
    await installDroid(t.deps, cred, opts);
    await installDroid(t.deps, cred, opts);
    expect(readJson('mcp.json').mcpServers.mine).toEqual(mcp.mcpServers.mine);
    expect(readJson('mcp.json').mcpServers.agentteams).toBeDefined();
    expect(readJson('hooks.json').PreToolUse).toEqual(hooks.PreToolUse);
    expect(readJson('hooks.json').Stop).toHaveLength(2);
    expect(readJson('hooks.json').Stop[0].hooks[0].command).toBe('say done');
    expect(JSON.parse(readFileSync(f('hooks.json.bak'), 'utf8'))).toEqual(hooks);
    expect(existsSync(join(repo, '.git', 'info', 'exclude'))).toBe(false);
  });

  it('refuses malformed JSON with warnings and leaves files untouched', async () => {
    mkdirSync(join(repo, '.factory'));
    writeFileSync(f('mcp.json'), '{ nope');
    writeFileSync(f('hooks.json'), '[1,2]');
    const report = await installDroid(t.deps, cred, opts);
    expect(report.warnings.join('\n')).toContain('.factory/mcp.json is not valid JSON');
    expect(report.warnings.join('\n')).toContain('.factory/hooks.json is not valid JSON');
    expect(readFileSync(f('mcp.json'), 'utf8')).toBe('{ nope');
    expect(readFileSync(f('hooks.json'), 'utf8')).toBe('[1,2]');
  });
});

describe('droid dialect', () => {
  const d = getAdapter('droid').dialect;
  it('uses the Claude-style contract', () => {
    expect(d.render({ type: 'context', event: 'session-start', text: 'hi' }, {}).stdout)
      .toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' } }));
    expect(d.render({ type: 'block', text: 'go' }, {}).stdout).toBe(JSON.stringify({ decision: 'block', reason: 'go' }));
    expect(d.render({ type: 'none' }, {})).toEqual({ stdout: '', exitCode: 0 });
  });
  it('guards the stop loop', () => {
    expect(d.isStopLoop({ stop_hook_active: true })).toBe(true);
    expect(d.isStopLoop({})).toBe(false);
  });
});
