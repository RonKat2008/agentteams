import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveCredential } from '../src/credentials.js';
import { realExec, type CliDeps } from '../src/deps.js';
import { runHook } from '../src/hooks.js';
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
});
