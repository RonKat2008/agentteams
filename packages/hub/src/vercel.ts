import { handle } from 'hono/vercel';
import { loadHubConfig } from './config.js';
import { createContext } from './context.js';
import { createDb, type DbHandle } from './db/index.js';
import { githubVerifier, type GithubVerifier } from './github.js';
import { createApp } from './http/app.js';
import { redact } from './redact.js';

export interface VercelHandlerOptions {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Tests inject a ready (migrated) database instead of connecting to DATABASE_URL. */
  connect?: (databaseUrl: string) => Promise<DbHandle>;
  verifyGithub?: GithubVerifier;
}

type Fetch = (req: Request) => Response | Promise<Response>;

/**
 * Fetch handler for a Vercel Node function. Hosted mode is forced. The database and app are built on
 * the first request of a function instance and reused after that. Migrations are NOT run here: they
 * run at build time via `agentteams-hub-migrate`. A failed cold start is not cached, so the next
 * request retries.
 */
export function createVercelHandler(opts: VercelHandlerOptions = {}): (req: Request) => Promise<Response> {
  let pending: Promise<Fetch> | undefined;

  async function buildUnredacted(): Promise<Fetch> {
    const env = { ...(opts.env ?? process.env), AGENTTEAMS_MODE: 'hosted' };
    const config = loadHubConfig(env, '/nonexistent');
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required (add Neon Postgres from the Vercel Marketplace)');
    const { db, dialect } = await (opts.connect ?? ((url) => createDb({ databaseUrl: url })))(config.databaseUrl);
    try {
      const ctx = createContext(db, { dialect, mode: 'hosted', verifyGithub: opts.verifyGithub ?? githubVerifier() });
      const app = createApp(ctx, { mode: 'hosted', ipSource: config.ipSource, rateLimits: config.rateLimits, ...(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {}) });
      return handle(app);
    } catch (err) {
      await db.destroy().catch(() => undefined);
      throw err;
    }
  }

  // A malformed DATABASE_URL can end up in a driver's error message; never let it reach the logs.
  const build = () => buildUnredacted().catch((err: unknown) => {
    throw new Error(redact(err instanceof Error ? err.message : String(err)));
  });

  return async (req) => {
    pending ??= build().catch((err) => {
      pending = undefined;
      throw err;
    });
    return (await pending)(req);
  };
}
