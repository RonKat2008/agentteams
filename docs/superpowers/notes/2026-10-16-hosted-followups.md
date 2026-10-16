# Plan 4 (hosted hub): deferred follow-ups and first-deploy checklist

## Not yet verified
These need a real Vercel and Neon deploy, which waits on the user's go-ahead.
- `vercel build` has never been run, because it needs `vercel link`.
- **Routing:** the rewrite `/(.*)` → `/api` should preserve paths. Check `/health`, `/mcp`, `/api/team/*` and a JSON 404 on `/nope`.
- **Function exports:** Vercel's Node runtime should invoke the named `GET`/`POST` exports in `api/index.mjs`.
- **Bundle:** `excludeFiles` should keep better-sqlite3 out of the function bundle, and pnpm build scripts should succeed on Vercel.
- **Migrations:** `DATABASE_URL_UNPOOLED` or `DATABASE_URL` must be present at build time, so that migrations run.
- **Neon connection strings:** check that `pg` 8 handles their parameters (`sslmode`, `channel_binding`).
- **Cold starts:** Neon waking from suspend may exceed the 2 s hook timeout, in which case the SessionStart hook returns nothing.
- **Claude Code HTTP MCP:** check its behaviour on `WWW-Authenticate: Bearer` when given a bad key; it may attempt OAuth discovery.

## Deferred
- `startHub` cannot take an injected DB, so the hosted e2e test runs on SQLite only. PGlite still covers the services.
- **Rate limits** are in-memory and per instance, so they are best-effort on serverless. Use Vercel Firewall rules for strict limits.
- **MCP proxy retries:** it retries only on `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, a failed initial connect, or a stale-session 404. Everything else returns "may or may not have completed".
- **Fly with raw TCP services:** `fly-client-ip` there would be client-supplied. The documented path is Fly's HTTP handler.
- **Agents in a pseudo-terminal:** an agent harness that runs commands in a PTY would see `isTTY` and could answer the `access grant` prompt itself. Consider reading the answer from `/dev/tty`, together with a check of the parent process.
- **GitHub device flow** would replace the one-time `gh` token verification. It needs a GitHub OAuth app.
- **Pool lifecycle on Vercel:** consider `attachDatabasePool` from `@vercel/functions`. `/health` doesn't touch the DB.
- **Collation:** `orderBy('glob')` sorts differently on Postgres than on SQLite. Cosmetic.
