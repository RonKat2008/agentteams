import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTeamStore, teamDbPath } from '../src/local/store.js';
import type { ExecResult } from '../src/deps.js';
import { gitDeps, makeRepo, type TempRepo } from './localHelpers.js';

const mode = (p: string) => statSync(p).mode & 0o777;
let r: TempRepo | undefined;
afterEach(() => r?.cleanup());

describe('local store permissions', () => {
  it('tightens a pre-existing 0755 directory and 0644 database file, and the WAL sidecars', async () => {
    r = makeRepo();
    const path = await teamDbPath(gitDeps, r.repo);
    mkdirSync(dirname(path), { recursive: true });
    chmodSync(dirname(path), 0o755);
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    const store = await openTeamStore(gitDeps, r.repo);
    // Force a write so WAL sidecars exist, then reopen-tighten is covered by the open sequence itself.
    expect(mode(dirname(path))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    for (const suffix of ['-wal', '-shm']) expect(mode(path + suffix)).toBe(0o600);
    expect(store.path).toBe(path);
  });

  it('creates a fresh database private from the start', async () => {
    r = makeRepo();
    await openTeamStore(gitDeps, r.repo);
    const path = await teamDbPath(gitDeps, r.repo);
    expect(mode(path)).toBe(0o600);
    expect(mode(dirname(path))).toBe(0o700);
  });
});

describe('teamDbPath', () => {
  it('runs git once per repoPath and resolves a relative git-common-dir itself', async () => {
    let calls = 0;
    const exec = async (_c: string, args: string[]): Promise<ExecResult> => {
      calls++;
      expect(args).toEqual(['rev-parse', '--git-common-dir']);
      return { code: 0, stdout: '.git\n', stderr: '' };
    };
    const p1 = await teamDbPath({ exec }, '/work/app');
    const p2 = await teamDbPath({ exec }, '/work/app');
    expect(p1).toBe('/work/app/.git/agentteams/team.db');
    expect(p2).toBe(p1);
    expect(calls).toBe(1);
  });
});
