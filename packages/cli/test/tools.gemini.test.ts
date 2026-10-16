import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { geminiDialect, installGemini } from '../src/tools/gemini.js';
import { getAdapter } from '../src/tools/registry.js';
import { makeTestCli, type TestCli } from './helpers.js';

const excludeLines = (p: string): string[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n') : []);

let t: TestCli;
let repo: string;
let cred: Credential;
const CLI = "'/usr/bin/node' '/opt/x/dist/bin.js'";
const ARGV = { command: '/usr/bin/node', args: ['/opt/x/dist/bin.js'] };
const opts = { cli: CLI, argv: ARGV };
const settingsPath = () => join(repo, '.gemini', 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));

beforeEach(() => {
  t = makeTestCli();
  repo = t.deps.cwd;
  const base = t.deps.exec;
  t.deps.exec = (cmd, args, o) =>
    cmd === 'git' && args.includes('--git-path')
      ? Promise.resolve({ code: 0, stdout: `${join(repo, '.git', args[args.length - 1]!)}\n`, stderr: '' })
      : base(cmd, args, o);
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  cred = { repoPath: repo, tool: 'gemini', hubUrl: 'http://127.0.0.1:4747', teamName: 'dev-squad', agentName: 'ronit-gemini', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => t.cleanup());

describe('gemini install', () => {
  it('is registered as a full adapter', () => {
    expect(getAdapter('gemini').tier).toBe('full');
    expect(getAdapter('gemini').dialect).toBe(geminiDialect);
  });

  it('fresh install writes MCP, four native-event hooks, GEMINI.md and a git exclude, without the key', async () => {
    const report = await installGemini(t.deps, cred, opts);
    expect(report.warnings).toEqual([]);
    const s = readSettings();
    expect(s.mcpServers.agentteams).toEqual({
      command: '/usr/bin/node', args: ['/opt/x/dist/bin.js', 'mcp', '--tool', 'gemini', '--repo', repo],
    });
    expect(Object.keys(s.hooks).sort()).toEqual(['AfterAgent', 'AfterTool', 'BeforeAgent', 'SessionStart']);
    expect(s.hooks.AfterAgent[0].hooks[0]).toEqual({
      type: 'command', command: `${CLI} hook stop --tool gemini --agentteams-managed`, timeout: 10000,
    });
    expect(s.hooks.BeforeAgent[0].hooks[0].command).toContain('hook user-prompt-submit --tool gemini');
    expect(readFileSync(join(repo, 'GEMINI.md'), 'utf8')).toContain('agentteams:start');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.gemini/settings.json');
    expect(readFileSync(settingsPath(), 'utf8')).not.toContain('at_SECRET');
  });

  it('reinstall is byte-identical', async () => {
    await installGemini(t.deps, cred, opts);
    const first = readFileSync(settingsPath(), 'utf8');
    const md = readFileSync(join(repo, 'GEMINI.md'), 'utf8');
    const ex = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    await installGemini(t.deps, cred, opts);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(first);
    expect(readFileSync(join(repo, 'GEMINI.md'), 'utf8')).toBe(md);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe(ex);
  });

  it('preserves user mcpServers, hooks and settings, and does not exclude a pre-existing file', async () => {
    mkdirSync(join(repo, '.gemini'));
    const user = {
      theme: 'dark',
      mcpServers: { other: { command: 'x', args: ['1'] } },
      hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'say done' }] }], Notification: [{ hooks: [] }] },
    };
    writeFileSync(settingsPath(), JSON.stringify(user));
    await installGemini(t.deps, cred, opts);
    await installGemini(t.deps, cred, opts);
    const s = readSettings();
    expect(s.theme).toBe('dark');
    expect(s.mcpServers.other).toEqual(user.mcpServers.other);
    expect(s.mcpServers.agentteams).toBeDefined();
    expect(s.hooks.Notification).toEqual(user.hooks.Notification);
    expect(s.hooks.AfterAgent).toHaveLength(2);
    expect(s.hooks.AfterAgent[0].hooks[0].command).toBe('say done');
    expect(JSON.parse(readFileSync(`${settingsPath()}.bak`, 'utf8'))).toEqual(user);
    // The user's pre-existing file is not hidden from git; only our backup is.
    expect(excludeLines(join(repo, '.git', 'info', 'exclude'))).not.toContain('.gemini/settings.json');
    expect(excludeLines(join(repo, '.git', 'info', 'exclude'))).toContain('.gemini/settings.json.bak');
  });

  it('refuses malformed JSON with a warning and leaves the file untouched', async () => {
    mkdirSync(join(repo, '.gemini'));
    writeFileSync(settingsPath(), '{ "mcpServers": ');
    const report = await installGemini(t.deps, cred, opts);
    expect(report.warnings.join('\n')).toContain('.gemini/settings.json is not valid JSON');
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{ "mcpServers": ');
    expect(existsSync(`${settingsPath()}.bak`)).toBe(false);
  });
});

describe('gemini dialect', () => {
  it('renders context with the native event name', () => {
    expect(geminiDialect.render({ type: 'context', event: 'session-start', text: 'hi' }, {}).stdout)
      .toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' } }));
    const name = (event: 'post-tool-use' | 'user-prompt-submit'): string =>
      JSON.parse(geminiDialect.render({ type: 'context', event, text: 'x' }, {}).stdout).hookSpecificOutput.hookEventName;
    expect(name('post-tool-use')).toBe('AfterTool');
    expect(name('user-prompt-submit')).toBe('BeforeAgent');
  });
  it('renders block as decision deny and none as empty', () => {
    expect(geminiDialect.render({ type: 'block', text: 'finish' }, {})).toEqual({ stdout: JSON.stringify({ decision: 'deny', reason: 'finish' }), exitCode: 0 });
    expect(geminiDialect.render({ type: 'none' }, {})).toEqual({ stdout: '', exitCode: 0 });
  });
  it('detects the stop loop guard and reads cwd', () => {
    expect(geminiDialect.isStopLoop({ stop_hook_active: true })).toBe(true);
    expect(geminiDialect.isStopLoop({ stop_hook_active: false })).toBe(false);
    expect(geminiDialect.readCwd({ cwd: '/r' })).toBe('/r');
  });
});
