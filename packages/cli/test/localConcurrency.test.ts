import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalTeamClient } from '../src/local/localClient.js';
import { teamDbPath } from '../src/local/store.js';
import { gitDeps, makeRepo, seedTeam, type Seeded, type TempRepo } from './localHelpers.js';

const CORE = fileURLToPath(new URL('../../hub/dist/core.js', import.meta.url));
const WRITES = 25;

// Each child process opens the same on-disk DB like a separate agent's hook would and writes commits.
const CHILD = `
const [core, dbPath, apiKey, prefix, n] = [await import(process.argv[1]), ...process.argv.slice(2)];
const db = core.createSqliteDb(dbPath);
const ctx = core.createContext(db, { mode: 'local' });
for (let i = 0; i < Number(n); i++) {
  const actor = await core.authenticate(ctx, apiKey);
  await core.recordCommit(ctx, actor, { sha: prefix + String(i).padStart(6, '0'), branch: 'main', message: 'm', files: ['f' + i], insertions: 1, deletions: 0 });
}
`;

function runChild(dbPath: string, apiKey: string, prefix: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, CORE, dbPath, apiKey, prefix, String(WRITES)]);
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe.skipIf(!existsSync(CORE))('concurrent writers (needs `pnpm -r build`)', () => {
  let r: TempRepo;
  let s: Seeded;
  beforeAll(async () => {
    r = makeRepo();
    s = await seedTeam(r.repo);
  });
  afterAll(() => r.cleanup());

  it('two processes writing to one team database do not error', async () => {
    const dbPath = await teamDbPath(gitDeps, r.repo);
    const [a, b] = await Promise.all([runChild(dbPath, s.alice.apiKey, 'aaaaaaa'), runChild(dbPath, s.bob.apiKey, 'bbbbbbb')]);
    expect(a).toEqual({ code: 0, stderr: '' });
    expect(b).toEqual({ code: 0, stderr: '' });
    const events = await new LocalTeamClient(gitDeps, s.alice).activity({ limit: 200 });
    expect(events.filter((e) => e.type === 'commit')).toHaveLength(WRITES * 2);
  });
});
