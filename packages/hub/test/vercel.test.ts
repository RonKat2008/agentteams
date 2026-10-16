import { PGlite } from '@electric-sql/pglite';
import { PGliteDialect } from 'kysely-pglite-dialect';
import { Kysely } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/schema.js';
import { migrateToLatest } from '../src/db/migrations.js';
import { loadHubConfig } from '../src/config.js';
import { createVercelHandler } from '../src/vercel.js';

const HOST = 'hub.example.vercel.app';
const req = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  new Request(`https://${HOST}${path}`, { headers: { host: HOST, ...headers }, ...init });

async function pgliteHandle() {
  const db = new Kysely<Database>({ dialect: new PGliteDialect(new PGlite()) });
  await migrateToLatest(db);
  return { db, dialect: 'postgres' as const };
}

describe('createVercelHandler', { timeout: 30_000 }, () => {
  it('serves /health in hosted mode using an injected db', async () => {
    const handler = createVercelHandler({ env: { DATABASE_URL: 'postgres://x', VERCEL: '1', VERCEL_URL: HOST }, connect: pgliteHandle });
    const res = await handler(req('/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: 'hosted' });
  });

  it('creates the db and app once across requests', async () => {
    const connect = vi.fn(pgliteHandle);
    const handler = createVercelHandler({ env: { DATABASE_URL: 'postgres://x', VERCEL: '1', VERCEL_URL: HOST }, connect });
    await handler(req('/health'));
    await handler(req('/health'));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('fails with a clear error when DATABASE_URL is missing', async () => {
    const handler = createVercelHandler({ env: { VERCEL: '1', VERCEL_URL: HOST }, connect: pgliteHandle });
    await expect(handler(req('/health'))).rejects.toThrow(/DATABASE_URL is required/);
  });

  it('forces hosted mode even if AGENTTEAMS_MODE says local', async () => {
    const handler = createVercelHandler({ env: { DATABASE_URL: 'postgres://x', AGENTTEAMS_MODE: 'local', AGENTTEAMS_ALLOWED_HOSTS: HOST }, connect: pgliteHandle });
    expect(await (await handler(req('/health'))).json()).toMatchObject({ mode: 'hosted' });
  });

  it('rejects a Host header outside the derived allow-list', async () => {
    const handler = createVercelHandler({ env: { DATABASE_URL: 'postgres://x', VERCEL: '1', VERCEL_URL: HOST }, connect: pgliteHandle });
    const res = await handler(new Request('https://evil.test/api/anything', { headers: { host: 'evil.test' } }));
    expect(res.status).toBe(403);
  });

  it('rate limits by x-vercel-forwarded-for in hosted mode', async () => {
    const handler = createVercelHandler({ env: { DATABASE_URL: 'postgres://x', VERCEL: '1', VERCEL_URL: HOST }, connect: pgliteHandle });
    const hit = (ip: string) => handler(req('/api/join/preview', { 'x-vercel-forwarded-for': ip, 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ inviteCode: 'aaaa-bbbb-cccc-dddd' }) }));
    for (let i = 0; i < 10; i++) expect((await hit('5.5.5.5')).status).not.toBe(429);
    expect((await hit('5.5.5.5')).status).toBe(429);
    expect((await hit('6.6.6.6')).status).not.toBe(429);
  });
});

describe('loadHubConfig on Vercel', () => {
  const base = { VERCEL: '1', AGENTTEAMS_MODE: 'hosted' };
  it('defaults allowed hosts to the production URL and deployment URL, scheme stripped', () => {
    const c = loadHubConfig({ ...base, VERCEL_PROJECT_PRODUCTION_URL: 'https://app.example.com', VERCEL_URL: 'app-abc.vercel.app' }, '/h');
    expect(c.allowedHosts).toEqual(['app.example.com', 'app-abc.vercel.app']);
  });
  it('filters empty entries', () => {
    expect(loadHubConfig({ ...base, VERCEL_URL: 'a.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: '' }, '/h').allowedHosts).toEqual(['a.vercel.app']);
  });
  it('an explicit AGENTTEAMS_ALLOWED_HOSTS overrides the default', () => {
    expect(loadHubConfig({ ...base, VERCEL_URL: 'a.vercel.app', AGENTTEAMS_ALLOWED_HOSTS: 'mine.dev' }, '/h').allowedHosts).toEqual(['mine.dev']);
  });
  it('still requires hosts when not on Vercel', () => {
    expect(() => loadHubConfig({ AGENTTEAMS_MODE: 'hosted', VERCEL_URL: 'a.vercel.app' }, '/h')).toThrow(/ALLOWED_HOSTS/);
  });
});

describe('createDb', () => {
  afterEach(() => { vi.doUnmock('../src/db/sqlite.js'); vi.resetModules(); });
  it('does not load the sqlite module when given a databaseUrl', async () => {
    const factory = vi.fn(() => ({ createSqliteDb: () => { throw new Error('sqlite loaded'); } }));
    vi.resetModules();
    vi.doMock('../src/db/sqlite.js', factory);
    const { createDb } = await import('../src/db/index.js');
    const handle = await createDb({ databaseUrl: 'postgres://u:p@localhost:1/db' });
    expect(handle.dialect).toBe('postgres');
    expect(factory).not.toHaveBeenCalled();
    await handle.db.destroy();
  });
});

describe('cold start retry', { timeout: 30_000 }, () => {
  it('retries after a failed connect', async () => {
    const connect = vi.fn(pgliteHandle).mockRejectedValueOnce(new Error('boom'));
    const handler = createVercelHandler({ env: { DATABASE_URL: 'postgres://x', VERCEL: '1', VERCEL_URL: HOST }, connect });
    await expect(handler(req('/health'))).rejects.toThrow('boom');
    expect((await handler(req('/health'))).status).toBe(200);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe('loadHubConfig branch url', () => {
  it('includes VERCEL_BRANCH_URL', () => {
    const c = loadHubConfig({ VERCEL: '1', AGENTTEAMS_MODE: 'hosted', VERCEL_URL: 'a.vercel.app', VERCEL_BRANCH_URL: 'b-git-x.vercel.app' }, '/h');
    expect(c.allowedHosts).toEqual(['a.vercel.app', 'b-git-x.vercel.app']);
  });
});
