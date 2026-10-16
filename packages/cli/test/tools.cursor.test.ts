import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { runHook } from '../src/hooks.js';
import { cursorDialect, installCursor, installCursorForWorktree } from '../src/tools/cursor.js';
import { getAdapter } from '../src/tools/registry.js';
import { makeTestCli, type TestCli } from './helpers.js';

const CLI = "'/usr/bin/node' '/opt/x/dist/bin.js'";
const ARGV = { command: '/usr/bin/node', args: ['/opt/x/dist/bin.js'] };
let t: TestCli;
let gitDir: string;
let repo: string;
let exclude: string;
let cred: Credential;

beforeEach(() => {
  gitDir = mkdtempSync(join(tmpdir(), 'at-cursor-git-'));
  exclude = join(gitDir, 'info', 'exclude');
  t = makeTestCli({}, { 'git rev-parse --path-format=absolute --git-path info/exclude': { stdout: `${exclude}\n` } });
  repo = t.deps.cwd;
  cred = { repoPath: repo, tool: 'cursor', hubUrl: 'http://127.0.0.1:4747', teamName: 'dev-squad', agentName: 'a', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => {
  t.cleanup();
  rmSync(gitDir, { recursive: true, force: true });
});

const read = (p: string): string => readFileSync(join(repo, p), 'utf8');

describe('installCursor', () => {
  it('writes project mcp, hooks, rules and AGENTS.md without secrets', async () => {
    const report = await installCursor(t.deps, cred, { cli: CLI, argv: ARGV });
    expect(report.warnings).toEqual([]);
    const mcp = JSON.parse(read('.cursor/mcp.json'));
    expect(mcp.mcpServers.agentteams).toEqual({
      type: 'stdio', command: '/usr/bin/node', args: ['/opt/x/dist/bin.js', 'mcp', '--tool', 'cursor', '--repo', repo],
    });
    const hooks = JSON.parse(read('.cursor/hooks.json'));
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks).sort()).toEqual(['postToolUse', 'sessionStart', 'stop']);
    expect(hooks.hooks.stop[0].command).toBe(`${CLI} hook stop --tool cursor --agentteams-managed`);
    expect(hooks.hooks.sessionStart[0].command).toContain('hook session-start --tool cursor');
    expect(hooks.hooks.postToolUse[0].command).toContain('hook post-tool-use --tool cursor');
    expect(hooks.hooks.beforeSubmitPrompt).toBeUndefined();
    const rules = read('.cursor/rules/agentteams.mdc');
    expect(rules.startsWith('---\ndescription: agentteams multi-agent coordination\nalwaysApply: true\n---\n')).toBe(true);
    expect(rules).toContain('agentteams:start');
    expect(rules).toContain('dev-squad');
    expect(read('AGENTS.md')).toContain('agentteams:start');
    for (const p of ['.cursor/mcp.json', '.cursor/hooks.json', '.cursor/rules/agentteams.mdc', 'AGENTS.md']) {
      expect(read(p)).not.toContain('at_SECRET');
    }
  });

  it('git-excludes the files that embed absolute paths', async () => {
    await installCursor(t.deps, cred, { cli: CLI, argv: ARGV });
    const lines = readFileSync(exclude, 'utf8').split('\n');
    expect(lines).toContain('.cursor/mcp.json');
    expect(lines).toContain('.cursor/hooks.json');
    expect(lines).not.toContain('.cursor/rules/agentteams.mdc');
  });

  it('is byte-identical on re-install', async () => {
    await installCursor(t.deps, cred, { cli: CLI, argv: ARGV });
    const files = ['.cursor/mcp.json', '.cursor/hooks.json', '.cursor/rules/agentteams.mdc', 'AGENTS.md'];
    const first = files.map(read);
    const excludeFirst = readFileSync(exclude, 'utf8');
    await installCursor(t.deps, cred, { cli: CLI, argv: ARGV });
    expect(files.map(read)).toEqual(first);
    expect(readFileSync(exclude, 'utf8')).toBe(excludeFirst);
  });

  it("preserves the user's own servers and hooks, with a one-time backup", async () => {
    mkdirSync(join(repo, '.cursor'));
    const mcp = { mcpServers: { mine: { url: 'https://x' } }, extra: 1 };
    const hooks = { version: 1, hooks: { stop: [{ command: 'say done' }], afterFileEdit: [{ command: 'fmt' }] } };
    writeFileSync(join(repo, '.cursor/mcp.json'), JSON.stringify(mcp));
    writeFileSync(join(repo, '.cursor/hooks.json'), JSON.stringify(hooks));
    await installCursor(t.deps, cred, { cli: CLI, argv: ARGV });
    await installCursor(t.deps, cred, { cli: "'/other/node' '/other/bin.js'", argv: ARGV });
    const m = JSON.parse(read('.cursor/mcp.json'));
    expect(m.mcpServers.mine).toEqual({ url: 'https://x' });
    expect(m.extra).toBe(1);
    const h = JSON.parse(read('.cursor/hooks.json'));
    expect(h.hooks.afterFileEdit).toEqual([{ command: 'fmt' }]);
    expect(h.hooks.stop).toHaveLength(2);
    expect(h.hooks.stop[0]).toEqual({ command: 'say done' });
    expect(h.hooks.stop[1].command).toContain('/other/bin.js');
    expect(JSON.parse(read('.cursor/hooks.json.bak'))).toEqual(hooks);
    expect(JSON.parse(read('.cursor/mcp.json.bak'))).toEqual(mcp);
  });

  it('refuses malformed JSON with a warning and leaves the file untouched', async () => {
    mkdirSync(join(repo, '.cursor'));
    writeFileSync(join(repo, '.cursor/mcp.json'), '{ nope');
    writeFileSync(join(repo, '.cursor/hooks.json'), '[1]');
    const report = await installCursor(t.deps, cred, { cli: CLI, argv: ARGV });
    expect(read('.cursor/mcp.json')).toBe('{ nope');
    expect(read('.cursor/hooks.json')).toBe('[1]');
    expect(report.warnings.join('\n')).toContain('.cursor/mcp.json is not valid JSON');
    expect(report.warnings.join('\n')).toContain('.cursor/hooks.json is not valid JSON');
    expect(existsSync(join(repo, '.cursor/mcp.json.bak'))).toBe(false);
  });

  it('refuses unexpected shapes without touching the file', async () => {
    mkdirSync(join(repo, '.cursor'));
    const badMcp = JSON.stringify({ mcpServers: [] });
    const badHooks = JSON.stringify({ hooks: { stop: 'x' } });
    writeFileSync(join(repo, '.cursor/mcp.json'), badMcp);
    writeFileSync(join(repo, '.cursor/hooks.json'), badHooks);
    const report = await installCursor(t.deps, cred, { cli: CLI, argv: ARGV });
    expect(read('.cursor/mcp.json')).toBe(badMcp);
    expect(read('.cursor/hooks.json')).toBe(badHooks);
    expect(report.warnings).toHaveLength(2);
  });

  it('worktree install points --repo at the worktree and writes no rules', async () => {
    const wt = join(t.root, 'wt');
    mkdirSync(wt);
    await installCursorForWorktree(t.deps, cred, wt, { cli: CLI, argv: ARGV });
    const mcp = JSON.parse(readFileSync(join(wt, '.cursor/mcp.json'), 'utf8'));
    expect(mcp.mcpServers.agentteams.args.slice(-2)).toEqual(['--repo', wt]);
    expect(existsSync(join(wt, '.cursor/rules'))).toBe(false);
  });
});

describe('cursorDialect', () => {
  const ctx = (event: 'session-start' | 'user-prompt-submit' | 'post-tool-use' | 'stop') => ({ type: 'context' as const, event, text: 'hi' });
  it('context -> additional_context', () => {
    expect(cursorDialect.render(ctx('session-start'), {})).toEqual({ stdout: '{"additional_context":"hi"}', exitCode: 0 });
    expect(cursorDialect.render(ctx('post-tool-use'), {}).stdout).toBe('{"additional_context":"hi"}');
  });
  it('context from beforeSubmitPrompt is dropped (Cursor ignores it)', () => {
    expect(cursorDialect.render(ctx('user-prompt-submit'), {})).toEqual({ stdout: '', exitCode: 0 });
  });
  it('block -> followup_message, none -> empty', () => {
    expect(cursorDialect.render({ type: 'block', text: 'do x' }, {})).toEqual({ stdout: '{"followup_message":"do x"}', exitCode: 0 });
    expect(cursorDialect.render({ type: 'none' }, {})).toEqual({ stdout: '', exitCode: 0 });
  });
  it('reads cwd from workspace_roots, falling back to cwd', () => {
    expect(cursorDialect.readCwd({ workspace_roots: ['/a', '/b'], cwd: '/c' })).toBe('/a');
    expect(cursorDialect.readCwd({ cwd: '/c' })).toBe('/c');
    expect(cursorDialect.readCwd({ workspace_roots: [] })).toBeUndefined();
  });
  it('treats loop_count > 0 as a stop loop', () => {
    expect(cursorDialect.isStopLoop({ loop_count: 0 })).toBe(false);
    expect(cursorDialect.isStopLoop({ loop_count: 1 })).toBe(true);
    expect(cursorDialect.isStopLoop({})).toBe(false);
  });
  it('is registered for cursor', () => {
    expect(getAdapter('cursor').dialect).toBe(cursorDialect);
  });
});

describe('runHook with the cursor dialect', () => {
  it('stop with loop_count > 0 prints nothing', async () => {
    const r = await runHook('stop', JSON.stringify({ loop_count: 1, workspace_roots: [repo] }), 'cursor', t.deps);
    expect(r).toEqual({ stdout: '', exitCode: 0 });
  });
});
