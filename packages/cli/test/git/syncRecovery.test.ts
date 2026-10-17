import { createSqliteDb, sql } from '@agentteams/hub/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitTeamClient } from '../../src/git/client.js';
import { syncRound } from '../../src/git/sync.js';
import { setStoreLockWait } from '../../src/local/store.js';
import { bootstrap, deps, dump, makeWorld, view, type Agent, type World } from './syncHelpers.js';

let world: World;
beforeEach(() => { world = makeWorld(); });
afterEach(async () => { await world.cleanup(); });

const client = (a: Agent) => new GitTeamClient(deps, a.cred, { trigger: () => undefined });
const sync = (a: Agent) => syncRound(deps, a.repo, a.cred);
const bodies = async (a: Agent) => (await client(a).ping(false)).messages.map((m) => m.body);

async function twoAgents(): Promise<{ lead: Agent; worker: Agent }> {
  const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
  expect((await sync(lead)).ok).toBe(true);
  const worker = await bootstrap(world, world.clone('b'), 'join', 'bob');
  expect((await sync(worker)).ok).toBe(true);
  expect((await sync(lead)).ok).toBe(true);
  return { lead, worker };
}

describe('apply failures', () => {
  it('ops accepted by a round whose apply failed are applied by the next round', async () => {
    const { lead, worker } = await twoAgents();
    await client(worker).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'kept' });
    expect((await sync(worker)).ok).toBe(true);

    // The apply transaction fails after the ops were accepted (as on SQLITE_BUSY or a killed process).
    const { store } = await view(lead);
    await sql`create trigger fail_apply before insert on messages begin insert into injected_failure values (1); end`
      .execute(store.ctx.db);
    const failed = await sync(lead);
    expect(failed.ok).toBe(false);
    expect(failed.ingested).toBeGreaterThan(0);
    await sql`drop trigger fail_apply`.execute(store.ctx.db);

    const recovered = await sync(lead);
    expect(recovered.ok).toBe(true);
    expect(recovered.rebuilt).toBe(true);
    expect(await bodies(lead)).toContain('kept');
    expect(await dump(lead)).toBe(await dump(worker));

    // The marker is cleared: later rounds apply incrementally again.
    await client(worker).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'later' });
    await sync(worker);
    const next = await sync(lead);
    expect(next.rebuilt).toBe(false);
    expect(next.applied).toBeGreaterThan(0);
    expect(await bodies(lead)).toContain('later');
  });
});

describe('a busy database', () => {
  it('reads still answer while a sync holds the write lock: presence is skipped, not waited for', async () => {
    const { lead } = await twoAgents();
    const { store } = await view(lead);
    const other = createSqliteDb(store.path);
    await setStoreLockWait(50);
    await sql`begin immediate`.execute(other);
    try {
      const status = await client(lead).status();
      expect(status.agents.length).toBe(2);
    } finally {
      await sql`rollback`.execute(other);
      await other.destroy();
      await setStoreLockWait(5000);
    }
  });
});
