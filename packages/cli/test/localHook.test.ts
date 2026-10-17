import { createSqliteDb, sql } from '@agentteams/hub/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveCredential } from '../src/credentials.js';
import { realExec, type CliDeps } from '../src/deps.js';
import { runHook } from '../src/hooks.js';
import { openTeamStore } from '../src/local/store.js';
import { makeRepo, seedTeam, type Seeded, type TempRepo } from './localHelpers.js';
import { makeTestCli, type TestCli } from './helpers.js';

const WARM_HOOK_BUDGET_MS = 1500;

describe('local-transport hook round', () => {
  let r: TempRepo;
  let s: Seeded;
  let t: TestCli;
  let deps: CliDeps;
  beforeAll(async () => {
    r = makeRepo();
    s = await seedTeam(r.repo);
    t = makeTestCli();
    deps = { ...t.deps, cwd: r.repo, exec: realExec, fetch: (() => { throw new Error('no network on the local transport'); }) as unknown as typeof fetch };
    await saveCredential(deps, s.bob);
  });
  afterAll(() => { t.cleanup(); r.cleanup(); });

  it('session-start injects status with no network and stays fast once warm', async () => {
    await runHook('session-start', JSON.stringify({ cwd: r.repo }), 'codex', deps); // cold: loads SQLite once
    const started = performance.now();
    const res = await runHook('session-start', JSON.stringify({ cwd: r.repo }), 'codex', deps);
    expect(performance.now() - started).toBeLessThan(WARM_HOOK_BUDGET_MS);
    expect(res.stdout).toContain('Acme');
    expect(res.stdout).toContain(s.alice.agentName);
  });

  it('gives up quickly when another process holds the write lock (no 5 s busy wait)', async () => {
    await runHook('user-prompt-submit', JSON.stringify({ cwd: r.repo }), 'codex', deps); // warm
    const other = createSqliteDb((await openTeamStore(deps, r.repo)).path);
    await sql`begin immediate`.execute(other);
    try {
      const started = performance.now();
      const res = await runHook('user-prompt-submit', JSON.stringify({ cwd: r.repo }), 'codex', deps);
      expect(performance.now() - started).toBeLessThan(WARM_HOOK_BUDGET_MS);
      expect(res.exitCode).toBe(0);
    } finally {
      await sql`rollback`.execute(other);
      await other.destroy();
    }
  });
});
