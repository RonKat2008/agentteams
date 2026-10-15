import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCredentials, resolveCredential, saveCredential, type Credential } from '../src/credentials.js';
import { credentialsPath } from '../src/paths.js';
import { makeTestCli, type TestCli } from './helpers.js';

let t: TestCli;
beforeEach(() => { t = makeTestCli(); });
afterEach(() => t.cleanup());

const cred = (over: Partial<Credential> = {}): Credential => ({
  repoPath: '/work/my-app', tool: 'claude', hubUrl: 'http://127.0.0.1:4747', teamName: 'dev-squad',
  agentName: 'ronit-claude', apiKey: 'at_secret', createdAt: '2026-01-01T00:00:00.000Z', ...over,
});

describe('credentials store', () => {
  it('returns [] when nothing is stored', async () => {
    expect(await loadCredentials(t.deps)).toEqual([]);
  });

  it('writes the file with mode 0600 inside a 0700 dir', async () => {
    await saveCredential(t.deps, cred());
    const file = credentialsPath(t.deps);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('upserts in place by repo path and tool, keeping both tools for one repo', async () => {
    await saveCredential(t.deps, cred());
    await saveCredential(t.deps, cred({ tool: 'codex', agentName: 'ronit-codex', apiKey: 'at_codex' }));
    await saveCredential(t.deps, cred({ apiKey: 'at_rotated' }));
    const all = await loadCredentials(t.deps);
    expect(all.map((c) => [c.tool, c.apiKey])).toEqual([['claude', 'at_rotated'], ['codex', 'at_codex']]);
  });

  it('resolves the deepest repo containing cwd, per tool', async () => {
    await saveCredential(t.deps, cred({ repoPath: '/work', agentName: 'outer' }));
    await saveCredential(t.deps, cred());
    await saveCredential(t.deps, cred({ tool: 'codex', agentName: 'ronit-codex' }));
    expect((await resolveCredential(t.deps, '/work/my-app/src/lib', 'claude'))?.agentName).toBe('ronit-claude');
    expect((await resolveCredential(t.deps, '/work/my-app', 'codex'))?.agentName).toBe('ronit-codex');
    expect((await resolveCredential(t.deps, '/work/other', 'claude'))?.agentName).toBe('outer');
    expect(await resolveCredential(t.deps, '/work/my-app-2', 'codex')).toBeNull();
    expect(await resolveCredential(t.deps, '/elsewhere')).toBeNull();
  });

  it('reports a corrupt file clearly', async () => {
    mkdirSync(dirname(credentialsPath(t.deps)), { recursive: true });
    writeFileSync(credentialsPath(t.deps), '{nope');
    await expect(loadCredentials(t.deps)).rejects.toThrow(/credentials\.json is not valid JSON/);
  });
});
