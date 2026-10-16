import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolKind } from '@agentteams/shared';
import { allAdapters, getAdapter, orderedToolKinds } from '../src/tools/registry.js';
import { claudeDialect, codexDialect } from '../src/tools/dialects.js';
import { upsertJsonConfig } from '../src/tools/jsonConfig.js';
import { addToGitExclude } from '../src/tools/gitExclude.js';
import { runInstallers } from '../src/commands/install.js';
import { hookCommand, MANAGED_MARKER } from '../src/install/hooksConfig.js';
import { makeTestCli, type TestCli } from './helpers.js';

describe('registry', () => {
  it('has an adapter for every ToolKind with matching kind, label and tier', () => {
    for (const kind of ToolKind.options) {
      const a = getAdapter(kind);
      expect(a.kind).toBe(kind);
      expect(a.label.length).toBeGreaterThan(0);
      expect(['full', 'mcp']).toContain(a.tier);
      expect(typeof a.dialect.render).toBe('function');
    }
    expect(allAdapters()).toHaveLength(ToolKind.options.length);
  });
  it('orders claude then codex first and covers all kinds', () => {
    const order = orderedToolKinds();
    expect(order.slice(0, 2)).toEqual(['claude', 'codex']);
    expect([...order].sort()).toEqual([...ToolKind.options].sort());
  });
});

describe('dialects', () => {
  const ctx = { type: 'context', event: 'post-tool-use', text: 'hi' } as const;
  it("claude and codex render today's hookSpecificOutput JSON", () => {
    for (const d of [claudeDialect, codexDialect]) {
      expect(d.render(ctx, {})).toEqual({
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'hi' } }), exitCode: 0,
      });
      expect(d.render({ type: 'block', text: 'do it' }, {})).toEqual({ stdout: JSON.stringify({ decision: 'block', reason: 'do it' }), exitCode: 0 });
      expect(d.render({ type: 'none' }, {})).toEqual({ stdout: '', exitCode: 0 });
    }
  });
  it('readCwd and isStopLoop', () => {
    expect(claudeDialect.readCwd({ cwd: '/a' })).toBe('/a');
    expect(claudeDialect.readCwd({})).toBeUndefined();
    expect(claudeDialect.isStopLoop({ stop_hook_active: true })).toBe(true);
    expect(claudeDialect.isStopLoop({ loop_count: 1 })).toBe(true);
    expect(claudeDialect.isStopLoop({})).toBe(false);
  });
});

describe('hookCommand', () => {
  it('builds the neutral hook command with the managed marker', () => {
    expect(hookCommand('agentteams', 'stop', 'cursor')).toBe(`agentteams hook stop --tool cursor ${MANAGED_MARKER}`);
  });
});

let t: TestCli;
beforeEach(() => { t = makeTestCli(); });
afterEach(() => t.cleanup());

describe('placeholder adapters', () => {
  it('runInstallers warns for a tool with no installer yet', async () => {
    const report = await runInstallers(t.deps, {
      repoPath: t.deps.cwd, tool: 'roo', hubUrl: 'http://x', teamName: 't', agentName: 'a', apiKey: 'k', createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(report.tool).toBe('roo');
    expect(report.warnings).toContain('no installer for tool "roo" yet');
  });
});

describe('upsertJsonConfig', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'at-json-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const add = (c: Record<string, unknown>) => ({ ...c, mine: 1 });

  it('creates missing file (and parent dirs) without a backup', async () => {
    const p = join(dir, 'a', 'b.json');
    expect(await upsertJsonConfig(p, add)).toBe('created');
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ mine: 1 });
    expect(readdirSync(join(dir, 'a'))).toEqual(['b.json']);
  });
  it('is idempotent and byte-identical on rerun', async () => {
    const p = join(dir, 'c.json');
    writeFileSync(p, '{"user":true}');
    expect(await upsertJsonConfig(p, add)).toBe('updated');
    const first = readFileSync(p, 'utf8');
    expect(await upsertJsonConfig(p, add)).toBe('unchanged');
    expect(readFileSync(p, 'utf8')).toBe(first);
    expect(JSON.parse(first)).toEqual({ user: true, mine: 1 });
  });
  it('writes .bak once, with the original content', async () => {
    const p = join(dir, 'd.json');
    writeFileSync(p, '{"user":true}');
    await upsertJsonConfig(p, add);
    await upsertJsonConfig(p, (c) => ({ ...c, more: 2 }));
    expect(readFileSync(`${p}.bak`, 'utf8')).toBe('{"user":true}');
  });
  it('refuses malformed or non-object JSON and leaves the file alone', async () => {
    for (const bad of ['{nope', '[1]', '"s"']) {
      const p = join(dir, 'e.json');
      writeFileSync(p, bad);
      expect(await upsertJsonConfig(p, add)).toBe('invalid');
      expect(readFileSync(p, 'utf8')).toBe(bad);
    }
    expect(readdirSync(dir).some((f) => f.endsWith('.bak'))).toBe(false);
  });
  it('treats an empty file as {}', async () => {
    const p = join(dir, 'f.json');
    writeFileSync(p, '  \n');
    expect(await upsertJsonConfig(p, add)).toBe('updated');
  });
});

describe('addToGitExclude', () => {
  it('appends once and ignores non-git dirs', async () => {
    const repo = t.deps.cwd;
    const exclude = join(repo, '.git', 'info', 'exclude');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    const deps = { exec: async () => ({ code: 0, stdout: `${exclude}\n`, stderr: '' }) };
    expect(await addToGitExclude(deps, repo, '.cursor/mcp.json')).toBeNull();
    expect(await addToGitExclude(deps, repo, '.cursor/mcp.json')).toBeNull();
    expect(readFileSync(exclude, 'utf8').match(/\.cursor\/mcp\.json/g)).toHaveLength(1);
    const none = { exec: async () => ({ code: 128, stdout: '', stderr: 'not a git repo' }) };
    expect(await addToGitExclude(none, repo, 'x')).toBeNull();
  });
});
