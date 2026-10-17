import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveCredential, type Credential } from '../src/credentials.js';
import { readableTeams } from '../src/commands/shared.js';
import { makeTestCli, type TestCli } from './helpers.js';

let t: TestCli;
let repo: string;
beforeEach(() => {
  t = makeTestCli();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'at-readable-')));
  mkdirSync(join(repo, '.git'));
  t.deps.cwd = repo;
});
afterEach(() => t.cleanup());

const cred = (over: Partial<Credential>): Credential => ({
  repoPath: repo, tool: 'claude', hubUrl: 'http://127.0.0.1:1', teamName: 'one',
  agentName: 'a-claude', apiKey: 'k', createdAt: '2026-01-01T00:00:00.000Z', ...over,
});

describe('readableTeams', () => {
  it("collapses a repo's agents on one team into a single entry listing them all", async () => {
    await saveCredential(t.deps, cred({}));
    await saveCredential(t.deps, cred({ tool: 'codex', agentName: 'a-codex' }));
    const teams = await readableTeams(t.deps);
    expect(teams).toHaveLength(1);
    expect(teams[0]!.cred.tool).toBe('claude'); // deterministic: first by tool name
    expect(teams[0]!.mine).toEqual(['a-claude', 'a-codex']);
  });

  it('returns one entry per team when the repo has agents on different teams', async () => {
    await saveCredential(t.deps, cred({}));
    await saveCredential(t.deps, cred({ tool: 'codex', agentName: 'b-codex', teamName: 'two' }));
    const teams = await readableTeams(t.deps);
    expect(teams.map((x) => [x.cred.teamName, x.mine])).toEqual([['one', ['a-claude']], ['two', ['b-codex']]]);
  });

  it('with --agent, returns just that credential', async () => {
    await saveCredential(t.deps, cred({}));
    await saveCredential(t.deps, cred({ tool: 'codex', agentName: 'a-codex' }));
    expect((await readableTeams(t.deps, 'codex')).map((x) => x.mine)).toEqual([['a-codex']]);
  });
});
