import { createSqliteDb } from '../src/db/sqlite.js';
import { migrateToLatest } from '../src/db/migrations.js';
import { createContext, type Actor, type HubContext } from '../src/context.js';
import { authenticate, createTeam, joinTeam } from '../src/services/teams.js';

export interface TestEnv {
  ctx: HubContext;
  advance: (ms: number) => void;
  close: () => Promise<void>;
}

export async function makeTestContext(start = '2026-01-01T00:00:00.000Z'): Promise<TestEnv> {
  let t = new Date(start).getTime();
  const db = createSqliteDb(':memory:');
  await migrateToLatest(db);
  const ctx = createContext(db, { now: () => new Date(t) });
  return { ctx, advance: (ms) => { t += ms; }, close: () => db.destroy() };
}

export interface SeededTeam {
  inviteCode: string;
  ronit: Actor; // ronit-claude, team creator + orchestrator
  dylan: Actor; // dylan-claude
  ash: Actor; // ash-codex
  keys: { ronit: string; dylan: string; ash: string };
}

export async function seedTeam(env: TestEnv): Promise<SeededTeam> {
  const created = await createTeam(env.ctx, {
    name: 'dev-squad', member: 'ronit', tool: 'claude',
    repo: { provider: 'github', slug: 'ronit/my-app', defaultBranch: 'main' },
  });
  const d = await joinTeam(env.ctx, { inviteCode: created.inviteCode, member: 'dylan', tool: 'claude' });
  const a = await joinTeam(env.ctx, { inviteCode: created.inviteCode, member: 'ash', tool: 'codex' });
  return {
    inviteCode: created.inviteCode,
    ronit: await authenticate(env.ctx, created.apiKey),
    dylan: await authenticate(env.ctx, d.apiKey),
    ash: await authenticate(env.ctx, a.apiKey),
    keys: { ronit: created.apiKey, dylan: d.apiKey, ash: a.apiKey },
  };
}
