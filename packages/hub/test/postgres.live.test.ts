import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../src/db/index.js';
import { migrateToLatest } from '../src/db/migrations.js';
import { createContext, type HubContext } from '../src/context.js';
import { startHub } from '../src/server.js';
import { claimFiles } from '../src/services/claims.js';
import { authenticate, createTeam, joinTeam } from '../src/services/teams.js';

// Runs only against a real, disposable Postgres: TEST_DATABASE_URL=postgres://... pnpm test:pg-live
const url = process.env.TEST_DATABASE_URL;
const TABLES = ['activity', 'claims', 'commits', 'message_reads', 'messages', 'tasks', 'agents', 'teams', 'kysely_migration', 'kysely_migration_lock'];

async function resetTables(): Promise<void> {
  const { db } = await createDb({ databaseUrl: url });
  try {
    for (const t of TABLES) await sql`DROP TABLE IF EXISTS ${sql.table(t)} CASCADE`.execute(db);
  } finally {
    await db.destroy();
  }
}

describe.skipIf(!url)('live postgres', () => {
  beforeAll(resetTables);
  afterAll(resetTables);

  it('boots, migrates and serves HTTP', async () => {
    const hub = await startHub({ databaseUrl: url, port: 0 });
    try {
      const res = await fetch(`${hub.url}/api/teams`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'live', member: 'ronit', tool: 'claude', repo: { provider: 'github', slug: 'a/b' } }),
      });
      expect(res.status).toBeLessThan(300);
      const created = await res.json() as { apiKey: string };
      const ping = await fetch(`${hub.url}/api/team/ping`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${created.apiKey}` }, body: '{}',
      });
      expect(ping.status).toBe(200);
    } finally {
      await hub.close();
    }
  });

  it('destroy() ends the pool: a later query rejects', async () => {
    const { db } = await createDb({ databaseUrl: url });
    await db.selectFrom('teams').selectAll().execute();
    await db.destroy();
    await expect(db.selectFrom('teams').selectAll().execute()).rejects.toThrow();
  });

  it('grants exactly one of 10 concurrent overlapping exclusive claims', async () => {
    const { db, dialect } = await createDb({ databaseUrl: url });
    try {
      await migrateToLatest(db);
      const ctx: HubContext = createContext(db, { dialect });
      const team = await createTeam(ctx, { name: 'race', member: 'm0', tool: 'claude', repo: { provider: 'github', slug: 'r/r' } });
      const keys = [team.apiKey];
      for (let i = 1; i < 10; i++) keys.push((await joinTeam(ctx, { inviteCode: team.inviteCode, member: `m${i}`, tool: 'claude' })).apiKey);
      const actors = await Promise.all(keys.map((k) => authenticate(ctx, k)));
      const results = await Promise.all(actors.map((a, i) => claimFiles(ctx, a, { globs: [i % 2 ? 'src/auth/**' : 'src/auth/login.ts'] })));
      expect(results.filter((r) => r.granted)).toHaveLength(1);
      expect(await db.selectFrom('claims').selectAll().execute()).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });
});
