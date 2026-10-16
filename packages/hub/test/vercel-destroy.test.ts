import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/http/app.js', () => ({ createApp: () => { throw new Error('app failed'); } }));

describe('createVercelHandler cleanup', () => {
  it('destroys the db when app construction throws after connect', async () => {
    const { createVercelHandler } = await import('../src/vercel.js');
    const destroy = vi.fn(async () => undefined);
    const handler = createVercelHandler({
      env: { DATABASE_URL: 'postgres://x', VERCEL: '1', VERCEL_URL: 'h.vercel.app' },
      connect: async () => ({ db: { destroy } as never, dialect: 'postgres' }),
    });
    await expect(handler(new Request('https://h.vercel.app/health'))).rejects.toThrow('app failed');
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
