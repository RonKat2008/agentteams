import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { getAdapter } from '../src/tools/registry.js';
import { otherAdapter, otherMcpSnippet } from '../src/tools/other.js';
import { makeTestCli, type TestCli } from './helpers.js';

let t: TestCli;
let cred: Credential;
beforeEach(() => {
  t = makeTestCli();
  cred = { repoPath: t.deps.cwd, tool: 'other', hubUrl: 'http://h', teamName: 'dev-squad', agentName: 'a', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => t.cleanup());

describe('other install', () => {
  it('is registered and writes the AGENTS.md block', async () => {
    expect(getAdapter('other')).toBe(otherAdapter);
    await otherAdapter.install(t.deps, cred);
    const text = readFileSync(join(t.deps.cwd, 'AGENTS.md'), 'utf8');
    expect(text).toContain('agentteams:start');
    expect(text).toContain('dev-squad');
  });

  it('reports a parseable stdio snippet with --tool other --repo and no api key', async () => {
    const r = await otherAdapter.install(t.deps, cred);
    const line = r.done.find((d) => d.includes('"mcpServers"')) ?? '';
    const json = JSON.parse(line.slice(line.indexOf('{')));
    expect(json).toEqual(JSON.parse(otherMcpSnippet(t.deps.cwd)));
    expect(json.mcpServers.agentteams.args.slice(-5)).toEqual(['mcp', '--tool', 'other', '--repo', t.deps.cwd]);
    expect(JSON.stringify(r)).not.toContain('at_SECRET');
  });

  it('is idempotent and keeps user text in AGENTS.md', async () => {
    const p = join(t.deps.cwd, 'AGENTS.md');
    await otherAdapter.install(t.deps, cred);
    const first = readFileSync(p, 'utf8');
    await otherAdapter.install(t.deps, cred);
    expect(readFileSync(p, 'utf8')).toBe(first);
  });
});
