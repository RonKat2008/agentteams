import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installClaude } from '../src/install/claude.js';
import { isManagedHookCommand, mergeManagedHooks } from '../src/install/hooksConfig.js';
import type { Credential } from '../src/credentials.js';
import { makeTestCli, type TestCli } from './helpers.js';

let t: TestCli;
let repo: string;
let cred: Credential;
const CLI = "'/usr/bin/node' '/x/agentteams/packages/cli/dist/bin.js'";

beforeEach(() => {
  t = makeTestCli({}, { claude: { code: 0 } });
  repo = t.deps.cwd;
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  cred = { repoPath: repo, tool: 'claude', hubUrl: 'http://127.0.0.1:4747', teamName: 'dev-squad', agentName: 'ronit-claude', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => t.cleanup());

describe('mergeManagedHooks', () => {
  it('adds the four events and keeps user hooks', () => {
    const user = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, model: 'x' };
    const merged = mergeManagedHooks(user, CLI, 'claude');
    expect(Object.keys(merged.hooks!).sort()).toEqual(['PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(merged.hooks!.Stop).toHaveLength(2);
    expect(merged.hooks!.Stop![0]!.hooks[0]!.command).toBe('say done');
    expect(merged.hooks!.Stop![1]!.hooks[0]).toEqual({ type: 'command', command: `${CLI} hook stop --tool claude`, timeout: 10 });
    expect((merged as { model: string }).model).toBe('x');
    expect(user.hooks.Stop).toHaveLength(1);
  });
  it('is idempotent', () => {
    const once = mergeManagedHooks({}, CLI, 'claude');
    expect(mergeManagedHooks(once, CLI, 'claude')).toEqual(once);
  });
  it('recognises managed commands', () => {
    expect(isManagedHookCommand(`${CLI} hook stop --tool codex`)).toBe(true);
    expect(isManagedHookCommand('say done')).toBe(false);
  });
});

describe('installClaude', () => {
  it('registers MCP via the claude CLI without leaking the key into files', async () => {
    const report = await installClaude(t.deps, cred, { cli: CLI });
    const add = t.calls.find((c) => c.cmd === 'claude' && c.args[1] === 'add')!;
    expect(add.args).toEqual(['mcp', 'add', '--transport', 'http', '--scope', 'local', 'agentteams', 'http://127.0.0.1:4747/mcp', '--header', 'Authorization: Bearer at_SECRET']);
    expect(add.cwd).toBe(repo);
    expect(report.warnings).toEqual([]);
    const settings = readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8');
    const claudeMd = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    expect(settings).toContain('hook session-start --tool claude');
    expect(settings).not.toContain('at_SECRET');
    expect(claudeMd).toContain('agentteams:start');
    expect(claudeMd).not.toContain('at_SECRET');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/settings.local.json');
  });

  it('is idempotent and preserves existing settings', async () => {
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    await installClaude(t.deps, cred, { cli: CLI });
    await installClaude(t.deps, cred, { cli: CLI });
    const s = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'));
    expect(s.permissions.allow).toEqual(['Bash(ls)']);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').match(/settings\.local\.json/g)).toHaveLength(1);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').match(/agentteams:start/g)).toHaveLength(1);
  });

  it('warns without the key when the claude CLI is missing', async () => {
    const t2 = makeTestCli({ cwd: repo });
    const report = await installClaude(t2.deps, cred, { cli: CLI });
    expect(report.warnings.join('\n')).toContain('claude mcp add --transport http --scope local agentteams');
    expect(report.warnings.join('\n')).not.toContain('at_SECRET');
    expect(existsSync(join(repo, '.claude', 'settings.local.json'))).toBe(true);
    t2.cleanup();
  });
});

describe('mergeManagedHooks with non-command handlers', () => {
  it('drops only the managed handler from a mixed group', () => {
    const cfg = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `${CLI} hook stop --tool claude` }, { type: 'prompt', prompt: 'x' }] }] } } as never;
    const merged = mergeManagedHooks(cfg, CLI, 'claude');
    expect(merged.hooks!.Stop![0]!.hooks).toEqual([{ type: 'prompt', prompt: 'x' }]);
    expect(merged.hooks!.Stop).toHaveLength(2);
  });
  it('keeps a lone non-command handler and tolerates a non-array event value', () => {
    const cfg = { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }], PostToolUse: 'oops' } } as never;
    const merged = mergeManagedHooks(cfg, CLI, 'claude');
    expect(merged.hooks!.Stop![0]!.hooks).toEqual([{ type: 'prompt', prompt: 'x' }]);
    expect((merged.hooks as Record<string, unknown>).PostToolUse).toBe('oops');
  });
});
