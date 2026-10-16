import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalTeamClient } from '../src/local/localClient.js';
import { teamDbPath } from '../src/local/store.js';
import { gitDeps, makeRepo, type TempRepo } from './localHelpers.js';

const CORE = fileURLToPath(new URL('../../hub/dist/core.js', import.meta.url));
const WRITES = 25;

// Each child replicates openTeamStore's open sequence (plain node cannot load the TS store) on the SAME fresh
// DB: create + WAL + concurrent migrateToLatest, then creates its own team and writes commits like a hook would.
const CHILD = `
const [core, dbPath, name, n] = [await import(process.argv[1]), ...process.argv.slice(2)];
const db = core.createSqliteDb(dbPath);
await core.migrateToLatest(db);
const ctx = core.createContext(db, { mode: 'local' });
const team = await core.createTeam(ctx, { name, member: name, tool: 'claude', repo: { provider: 'local', defaultBranch: 'main' } });
for (let i = 0; i < Number(n); i++) {
  const actor = await core.authenticate(ctx, team.apiKey);
  await core.recordCommit(ctx, actor, { sha: name.charCodeAt(0).toString(16).padStart(2, '0') + String(i).padStart(8, '0'), branch: 'main', message: 'm', files: ['f' + i], insertions: 1, deletions: 0 });
}
process.stdout.write(JSON.stringify({ agentName: team.agentName, apiKey: team.apiKey }));
`;

interface ChildResult { code: number | null; stderr: string; stdout: string }

function runChild(dbPath: string, name: string): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, CORE, dbPath, name, String(WRITES)]);
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.on('close', (code) => resolve({ code, stderr, stdout }));
  });
}

describe.skipIf(!existsSync(CORE))('concurrent writers (needs `pnpm -r build`)', () => {
  let r: TempRepo;
  beforeAll(() => { r = makeRepo(); });
  afterAll(() => r.cleanup());

  it('two processes migrating and writing one fresh team database do not error', async () => {
    const dbPath = await teamDbPath(gitDeps, r.repo); // nothing exists yet: no dir, no file
    mkdirSync(dirname(dbPath), { recursive: true });
    const [a, b] = await Promise.all([runChild(dbPath, 'alpha'), runChild(dbPath, 'beta')]);
    expect(a).toMatchObject({ code: 0, stderr: '' });
    expect(b).toMatchObject({ code: 0, stderr: '' });
    for (const child of [a, b]) {
      const { agentName, apiKey } = JSON.parse(child.stdout) as { agentName: string; apiKey: string };
      const cred = { repoPath: r.repo, tool: 'claude' as const, hubUrl: 'local', teamName: 'x', agentName, apiKey, createdAt: '', transport: 'local' as const };
      const events = await new LocalTeamClient(gitDeps, cred).activity({ limit: 200 });
      expect(events.filter((e) => e.type === 'commit')).toHaveLength(WRITES);
    }
  });
});
