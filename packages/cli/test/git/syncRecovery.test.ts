import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSqliteDb, sql } from '@agentteams/hub/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitTeamClient } from '../../src/git/client.js';
import { syncRound } from '../../src/git/sync.js';
import { setStoreLockWait } from '../../src/local/store.js';
import type { CliDeps } from '../../src/deps.js';
import { gitServer } from '../../src/mcpProxy.js';
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

describe('the git MCP server', () => {
  it('recovers once the agent reaches the local view, instead of staying unavailable all session', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    expect((await sync(lead)).ok).toBe(true);
    // A joiner whose view has not been synced yet: it is not in its own view.
    const worker = await bootstrap(world, world.clone('b'), 'join', 'bob');
    let triggered = 0;
    const errors: string[] = [];
    const cliDeps = { ...deps, err: (m: string) => errors.push(m) } as unknown as CliDeps;
    const server = await gitServer(cliDeps, worker.cred, { trigger: () => { triggered++; } });
    const [s, c] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const mcp = new Client({ name: 'test', version: '0' });
    await mcp.connect(c);

    const before = await mcp.callTool({ name: 'team_status', arguments: {} });
    expect(before.isError).toBe(true);
    expect(errors.join('\n')).toContain('not in the local team view');
    expect(triggered).toBeGreaterThan(0); // a background sync was started to fill the view

    expect((await sync(worker)).ok).toBe(true);
    const after = await mcp.callTool({ name: 'team_status', arguments: {} });
    expect(after.isError).toBeFalsy();
    expect(JSON.stringify(after.content)).toContain('bob-claude');
    await mcp.close();
  });
});

describe('a failing view', () => {
  it('a round whose apply keeps failing still sends this agent\'s own pending ops', async () => {
    const { lead, worker } = await twoAgents();
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'from lead' });
    await client(worker).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'from worker' });
    expect((await sync(worker)).ok).toBe(true);

    // The lead's view cannot apply anything (a poison op would do the same), round after round.
    const { store } = await view(lead);
    await sql`create trigger fail_apply before insert on messages begin insert into injected_failure values (1); end`
      .execute(store.ctx.db);
    for (let i = 0; i < 2; i++) {
      const r = await sync(lead);
      expect(r.ok).toBe(false);
      expect(r.errors.join('\n')).toMatch(/apply/);
    }
    expect((await sync(lead)).published).toBe(0); // already sent by the first failing round

    expect((await sync(worker)).ok).toBe(true);
    expect(await bodies(worker)).toContain('from lead');
  });
});
