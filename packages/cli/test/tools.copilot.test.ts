import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { isManagedHookCommand } from '../src/install/hooksConfig.js';
import { installCopilot, installCopilotForWorktree } from '../src/install/copilot.js';
import { copilotDialect } from '../src/tools/copilotDialect.js';
import { getAdapter } from '../src/tools/registry.js';
import { makeTestCli, type TestCli } from './helpers.js';

const CLI = "'/usr/bin/node' '/opt/x/dist/bin.js'";
const ARGV = { command: '/usr/bin/node', args: ['/opt/x/dist/bin.js'] };
const OPTS = { cli: CLI, argv: ARGV };

let t: TestCli;
let repo: string;
let exclude: string;
let cred: Credential;
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8');
const json = (rel: string): any => JSON.parse(read(rel));

beforeEach(() => {
  t = makeTestCli();
  repo = t.deps.cwd;
  exclude = join(repo, '.git', 'info', 'exclude');
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  t.deps.exec = async () => ({ code: 0, stdout: `${exclude}\n`, stderr: '' });
  cred = { repoPath: repo, tool: 'copilot', hubUrl: 'http://127.0.0.1:4747', teamName: 'dev-squad', agentName: 'ronit-copilot', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => t.cleanup());

describe('installCopilot fresh install', () => {
  it('writes hooks, both MCP configs and both instruction files without the api key', async () => {
    const report = await installCopilot(t.deps, cred, OPTS);
    expect(report.tool).toBe('copilot');
    expect(report.warnings).toEqual([]);

    const hooks = json('.github/hooks/agentteams.json');
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks).sort()).toEqual(['PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    const stop = hooks.hooks.Stop;
    expect(stop).toHaveLength(1);
    expect(stop[0].type).toBe('command');
    expect(stop[0].command).toBe(`${CLI} hook stop --tool copilot --agentteams-managed`);

    expect(json('.github/mcp.json').mcpServers.agentteams).toEqual({
      type: 'local', command: ARGV.command, tools: ['*'],
      args: [...ARGV.args, 'mcp', '--tool', 'copilot', '--repo', repo],
    });
    expect(json('.vscode/mcp.json').servers.agentteams).toEqual({
      type: 'stdio', command: ARGV.command,
      args: [...ARGV.args, 'mcp', '--tool', 'copilot', '--repo', repo],
    });
    expect(json('.vscode/mcp.json').mcpServers).toBeUndefined();

    for (const f of ['.github/copilot-instructions.md', 'AGENTS.md']) {
      expect(read(f)).toContain('<!-- agentteams:start -->');
      expect(read(f)).toContain('dev-squad');
    }
    for (const f of ['.github/hooks/agentteams.json', '.github/mcp.json', '.vscode/mcp.json', '.github/copilot-instructions.md', 'AGENTS.md']) {
      expect(read(f)).not.toContain('at_SECRET');
    }
  });

  it('git-excludes files with absolute paths but not the committable instruction files', async () => {
    await installCopilot(t.deps, cred, OPTS);
    const lines = readFileSync(exclude, 'utf8').split('\n');
    expect(lines).toEqual(expect.arrayContaining(['.github/hooks/agentteams.json', '.github/mcp.json', '.vscode/mcp.json']));
    expect(lines).not.toContain('.github/copilot-instructions.md');
    expect(lines).not.toContain('AGENTS.md');
    for (const f of ['.github/copilot-instructions.md', 'AGENTS.md']) expect(read(f)).not.toContain(repo);
  });

  it('is idempotent: a second install leaves every file byte-identical', async () => {
    await installCopilot(t.deps, cred, OPTS);
    const files = ['.github/hooks/agentteams.json', '.github/mcp.json', '.vscode/mcp.json', '.github/copilot-instructions.md', 'AGENTS.md'];
    const first = files.map(read);
    const excludeFirst = readFileSync(exclude, 'utf8');
    await installCopilot(t.deps, cred, OPTS);
    expect(files.map(read)).toEqual(first);
    expect(readFileSync(exclude, 'utf8')).toBe(excludeFirst);
    expect(existsSync(join(repo, '.github/hooks/agentteams.json.bak'))).toBe(false);
  });

  it('works outside a git repo (no exclude, no warning)', async () => {
    t.deps.exec = async () => ({ code: 128, stdout: '', stderr: 'not a git repo' });
    const report = await installCopilot(t.deps, cred, OPTS);
    expect(report.warnings).toEqual([]);
  });
});

describe('user entries preserved', () => {
  it('keeps user hooks and MCP servers, replacing only the managed entries on reinstall', async () => {
    mkdirSync(join(repo, '.github/hooks'), { recursive: true });
    mkdirSync(join(repo, '.vscode'), { recursive: true });
    writeFileSync(join(repo, '.github/hooks/agentteams.json'), JSON.stringify({
      version: 1,
      hooks: { Stop: [{ type: 'command', command: 'say done' }], PreToolUse: [{ type: 'command', command: './check.sh' }] },
    }));
    writeFileSync(join(repo, '.github/mcp.json'), JSON.stringify({ mcpServers: { mine: { type: 'local', command: 'x' } } }));
    writeFileSync(join(repo, '.vscode/mcp.json'), JSON.stringify({ inputs: [{ id: 'k' }], servers: { mine: { type: 'stdio', command: 'y' } } }));

    await installCopilot(t.deps, cred, OPTS);
    await installCopilot(t.deps, cred, { ...OPTS, cli: "'/other/node' '/other/bin.js'" });

    const hooks = json('.github/hooks/agentteams.json').hooks;
    expect(hooks.PreToolUse).toEqual([{ type: 'command', command: './check.sh' }]);
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop[0]).toEqual({ type: 'command', command: 'say done' });
    expect(hooks.Stop[1].command).toContain('/other/bin.js');
    expect(hooks.Stop.filter((h: any) => isManagedHookCommand(h.command))).toHaveLength(1);

    expect(json('.github/mcp.json').mcpServers.mine).toEqual({ type: 'local', command: 'x' });
    expect(json('.github/mcp.json').mcpServers.agentteams).toBeDefined();
    expect(json('.vscode/mcp.json').servers.mine).toEqual({ type: 'stdio', command: 'y' });
    expect(json('.vscode/mcp.json').inputs).toEqual([{ id: 'k' }]);
    expect(json('.vscode/mcp.json').servers.agentteams).toBeDefined();
  });

  it('keeps user text around the managed instruction block', async () => {
    mkdirSync(join(repo, '.github'), { recursive: true });
    writeFileSync(join(repo, '.github/copilot-instructions.md'), '# Mine\nuse tabs\n');
    await installCopilot(t.deps, cred, OPTS);
    const md = read('.github/copilot-instructions.md');
    expect(md.startsWith('# Mine\nuse tabs\n')).toBe(true);
    expect(md).toContain('<!-- agentteams:end -->');
  });
});

describe('malformed config', () => {
  it('warns and leaves malformed files untouched while still handling the others', async () => {
    mkdirSync(join(repo, '.github/hooks'), { recursive: true });
    mkdirSync(join(repo, '.vscode'), { recursive: true });
    writeFileSync(join(repo, '.github/hooks/agentteams.json'), '{ nope');
    writeFileSync(join(repo, '.vscode/mcp.json'), '[1,2]');
    writeFileSync(join(repo, '.github/mcp.json'), JSON.stringify({ mcpServers: 'bad' }));

    const report = await installCopilot(t.deps, cred, OPTS);
    expect(report.warnings).toHaveLength(3);
    expect(report.warnings.join('\n')).toMatch(/\.github\/hooks\/agentteams\.json/);
    expect(report.warnings.join('\n')).toMatch(/\.vscode\/mcp\.json/);
    expect(report.warnings.join('\n')).toMatch(/\.github\/mcp\.json/);
    expect(read('.github/hooks/agentteams.json')).toBe('{ nope');
    expect(read('.vscode/mcp.json')).toBe('[1,2]');
    expect(json('.github/mcp.json')).toEqual({ mcpServers: 'bad' });
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(true);
  });

  it('refuses a hooks file whose event value is not an array', async () => {
    mkdirSync(join(repo, '.github/hooks'), { recursive: true });
    writeFileSync(join(repo, '.github/hooks/agentteams.json'), JSON.stringify({ hooks: { Stop: 'x' } }));
    const report = await installCopilot(t.deps, cred, OPTS);
    expect(report.warnings.some((w) => w.includes('agentteams.json'))).toBe(true);
    expect(json('.github/hooks/agentteams.json')).toEqual({ hooks: { Stop: 'x' } });
  });
});

describe('worktree install', () => {
  it('writes config into the worktree pointing --repo at it, without instruction files', async () => {
    const wt = join(t.root, 'wt');
    mkdirSync(wt, { recursive: true });
    const report = await installCopilotForWorktree(t.deps, cred, wt, OPTS);
    expect(report.warnings).toEqual([]);
    const mcp = JSON.parse(readFileSync(join(wt, '.github/mcp.json'), 'utf8'));
    expect(mcp.mcpServers.agentteams.args.slice(-2)).toEqual(['--repo', wt]);
    expect(existsSync(join(wt, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(wt, '.github/hooks/agentteams.json'))).toBe(true);
  });
  it('is exposed through the registry', () => {
    const a = getAdapter('copilot');
    expect(a.kind).toBe('copilot');
    expect(a.tier).toBe('full');
    expect(typeof a.installForWorktree).toBe('function');
    expect(a.dialect).toBe(copilotDialect);
  });
});

describe('copilot dialect', () => {
  it('context: emits CLI top-level and VS Code hookSpecificOutput forms', () => {
    const out = copilotDialect.render({ type: 'context', event: 'session-start', text: 'hi' }, {});
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      additionalContext: 'hi',
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' },
    });
    const post = JSON.parse(copilotDialect.render({ type: 'context', event: 'post-tool-use', text: 'x' }, {}).stdout);
    expect(post.hookSpecificOutput.hookEventName).toBe('PostToolUse');
  });
  it('block: decision block with reason in both forms', () => {
    expect(JSON.parse(copilotDialect.render({ type: 'block', text: 'do it' }, {}).stdout)).toEqual({
      decision: 'block', reason: 'do it',
      hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason: 'do it' },
    });
  });
  it('none: empty stdout, exit 0', () => {
    expect(copilotDialect.render({ type: 'none' }, {})).toEqual({ stdout: '', exitCode: 0 });
  });
  it('stop loop guard honours stop_hook_active and loop_count; cwd from input', () => {
    expect(copilotDialect.isStopLoop({ stop_hook_active: true })).toBe(true);
    expect(copilotDialect.isStopLoop({ stop_hook_active: false })).toBe(false);
    expect(copilotDialect.isStopLoop({})).toBe(false);
    expect(copilotDialect.readCwd({ cwd: '/w' })).toBe('/w');
    expect(copilotDialect.readCwd({})).toBeUndefined();
  });
});
