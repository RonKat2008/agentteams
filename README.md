# agentteams

Connect coding agents (Claude Code, Codex, ...) into one team with a shared task board, inbox, file
claims and activity log. One agent is the orchestrator. You keep using the apps you already use
(terminal, IDE extension or desktop app); agentteams configures them for you.

> Status: v0.1 in progress. The hub and the `agentteams` CLI are working. Worktrees, git hooks and
> hosted mode land in later plans. Design: `docs/superpowers/specs/2026-10-15-agentteams-design.md`.

## Install from source

```bash
pnpm install && pnpm build
pnpm --filter @agentteams/cli link --global     # puts `agentteams` on your PATH
# or, without linking:
alias agentteams="node $PWD/packages/cli/dist/bin.js"
```

## Quickstart (one machine)

```bash
# 1. In one terminal: run the local hub (http://127.0.0.1:4747)
agentteams up

# 2. In your repo: create a team. You become its orchestrator.
cd ~/code/my-repo
agentteams create my-team --agent claude        # prints an invite code

# 3. Add a second agent (Codex) with the invite code
agentteams join <invite-code> --agent codex

# 4. Open Claude Code and Codex in the repo.
#    In Codex, run /hooks once and approve the new agentteams hooks.
```

`create` and `join` install everything automatically (MCP server, hooks, instruction block). Run
`agentteams install` to redo that setup, e.g. after updating the CLI. Credentials are keyed by the
repo's absolute path, so after moving a repo run `agentteams join` again (or re-create the
credentials); `install` cannot relink a moved repo.
If you change Node versions (nvm), re-run `agentteams install` — hooks embed the node path.

## What gets installed where

| Tool | Installed |
|---|---|
| Claude Code | Local-scope MCP entry written by `claude mcp add --scope local` (stored in `~/.claude.json`, not in the repo); hooks in `.claude/settings.local.json` (added to `.git/info/exclude`); managed block in `CLAUDE.md` |
| Codex | Managed block in `~/.codex/config.toml` registering a stdio MCP server (`agentteams mcp --tool codex`); entries in `~/.codex/hooks.json`; managed block in `AGENTS.md` |

- `claude mcp add` receives the API key as a command-line argument, so it is briefly visible in `ps` output on a shared machine.
- Codex ignores per-project MCP config, so the stdio proxy resolves the right team for the current
  repo at runtime. Codex asks you to approve new hooks once via `/hooks`.
- Before changing `~/.codex/config.toml` or `~/.codex/hooks.json`, agentteams writes `<file>.bak` with the
  original contents (once; an existing `.bak` is never overwritten).
- API keys live only in `~/.agentteams/credentials.json` (mode 0600) and in Claude Code's own
  `~/.claude.json` entry. They are never written into the repo.

## How messages reach agents

- Messages are delivered at session start, on every prompt, and after every tool call.
- An unread orchestrator command keeps the agent from stopping until it has been read.
- An idle agent cannot be interrupted; it sees its messages on its next turn.

## Command reference

| Command | Purpose |
|---|---|
| `agentteams up [--port <n>]` | Run a local hub (default port 4747 or `$AGENTTEAMS_PORT`) |
| `agentteams create <name>` | Create a team in this repo and install the agent integration |
| `agentteams join <invite-code>` | Join a team and install the agent integration |
| `agentteams install [--agent claude\|codex\|other\|all]` | (Re)configure Claude Code / Codex for this repo |
| `agentteams status` | Show the team and its agents |
| `agentteams log [-f] [--limit <n>]` | Show team activity (default 20 events); `-f` follows |
| `agentteams invite rotate\|revoke` | Rotate or revoke the invite code |
| `agentteams orchestrator <agent-name>` | Make an agent the orchestrator |
| `agentteams worktree <task>` | Claim a task and create its branch and worktree |
| `agentteams done <task> -m <summary>` | Push the task branch and mark the task done |
| `agentteams pr <task>` | Open a GitHub pull request for a finished task |
| `agentteams merged <task> [--pr <url>]` | Record a task as merged (orchestrator only) |

Options:

- `create` and `join`: `--agent <claude|codex|other>` (default `claude`), `--as <member>` (member name),
  `--hub <url>` (default `$AGENTTEAMS_HUB` or the local hub), `--no-install` (skip tool setup).
- `create` only: `--repo <owner/name>` links a GitHub repo; `--local` makes a local-only team. Without
  either, the GitHub `origin` is detected, falling back to a local-only team.
- `create` only: `--new-repo` creates a new GitHub repo with `gh` and links the team to it (`--owner <org>` picks the owner).
- `join` only: clones the team's GitHub repo with `gh` (into `./<repo name>`, or `--dir <path>`); `--no-clone` skips the clone and uses the current directory.
- `done`, `pr`, `merged`: `--agent <tool>` picks the credential; `done` requires `-m, --message`; `merged` takes `--pr <url>`.
- `status`, `log`, `invite`, `orchestrator`: `--agent <tool>` picks which credential to use when the repo
  has more than one (e.g. both Claude and Codex).

`agentteams hook` and `agentteams mcp` are internal entry points used by the installed hooks and the
Codex proxy; you do not run them yourself.

## Git workflow

Each task gets its own branch and worktree, and commits are checked against file claims.

1. `agentteams worktree <task>` claims the task and creates branch `at/<agent>/<task>` in a worktree at
   `<parent of repo>/<repo>.at/<agent>-<task>`. Work and commit there.
2. A pre-commit check asks the hub whether another agent holds an exclusive claim on a file you are
   committing, and blocks the commit if so. Message the owner instead. As a last resort,
   `AGENTTEAMS_ALLOW=1 git commit ...` overrides the check; the override is logged to the team.
   If the hub is unreachable the hooks warn and never block you. A post-commit hook reports commit summaries
   (sha, branch, message, files, line counts; no diffs) to the hub.
3. `agentteams done <task> -m "<summary>"` pushes the branch (GitHub teams) and completes the task. It must be
   run on the task branch, not the default branch.
4. `agentteams pr <task>` opens a pull request with `gh` (GitHub teams only). If one exists, its URL is printed.
5. The orchestrator runs `agentteams merged <task> [--pr <url>]` after merging.

The installed git hooks chain any existing hook (moved to `<hook>.agentteams-prev`). The pre-commit hook blocks
only when the CLI exits 3; any other failure (a crash, a missing CLI) allows the commit and warns on stderr.
Git 2.31 or newer is required.

### Hook managers

If `core.hooksPath` is set (husky and similar), agentteams does not write hooks; add these lines to your
hook manager yourself. They do nothing on machines without `agentteams` installed.

```sh
# pre-commit
if command -v agentteams >/dev/null 2>&1; then
  agentteams git-hook pre-commit; [ $? -ne 3 ] || exit 1
fi
```

```sh
# post-commit
if command -v agentteams >/dev/null 2>&1; then
  agentteams git-hook post-commit || true
fi
```

`create --new-repo` makes a GitHub repo for you, and `join` clones the team repo (skip with `--no-clone`).

## Hosting a hub for friends (Vercel)

The hosted hub runs as one Vercel Node function (Hono via `hono/vercel`) backed by Neon Postgres. The
local hub stays the default; this is only for teammates on other machines.

1. `vercel link` in this repo.
2. Add Neon Postgres from the Vercel Marketplace. It sets `DATABASE_URL`. The function should use the
   pooled (`-pooler`) URL; the migration step prefers `DATABASE_URL_UNPOOLED` when present. The pool is
   capped at 3 connections per instance on Vercel (override with `PG_POOL_MAX`).
3. Allowed hosts: on Vercel no host allowlist is applied unless `AGENTTEAMS_ALLOWED_HOSTS` is set. If you set it
   (comma-separated host names), include every domain, including `<project>.vercel.app`. Self-hosting needs it.
   Builds run migrations, so give Preview its own Neon branch database; a preview without database
   variables skips migration and then fails at runtime.
4. `vercel deploy --prod`. The build command (`vercel.json`) builds the workspace and runs
   `agentteams-hub-migrate`, so the schema is migrated at build time and never on a request.
   A missing `DATABASE_URL` fails a production build; other environments skip migrations.
5. Members: `agentteams create my-app --hub https://<project>.vercel.app`. Friends run
   `agentteams join <code> --hub https://<project>.vercel.app`. The creator runs `agentteams access grant <agent>`.

Layout: `api/index.mjs` (plain ESM, so no TypeScript compile step is needed) re-exports `createVercelHandler()` from `@agentteams/hub/vercel` as the
`GET`/`POST`/... handlers, and `vercel.json` rewrites every path to `/api`. Hosted mode is forced for the
function. `framework` is `null` because this repo is a pnpm workspace whose hub package must be built
first, and an explicit `api/` function plus build command is predictable. (Vercel may also support Hono with
zero configuration; this setup was not checked against that flow or against a live deploy.) `vercel.json`
excludes `better-sqlite3` from the function bundle, which is Postgres-only.

Security notes:

- Use HTTPS only. The CLI sends your GitHub token only to a hub over `https:`.
- GitHub tokens are verified once against GitHub and never stored or logged.
- API keys are stored hashed.
- Rate limits are in-memory token buckets, so on serverless they are per function instance and only
  best-effort (a burst spread over several instances is not counted together). For strict limits add Vercel
  Firewall rate-limit rules in front of the function.
- Client IP trust: on Vercel the hub uses Vercel's own headers, on Fly it uses `fly-client-ip`, and behind any
  other proxy you must set `AGENTTEAMS_TRUSTED_IP_HEADER` to a header your proxy overwrites (for example
  `x-real-ip`), and the hub uses the last comma-separated entry; `x-forwarded-for` is refused unless
  `AGENTTEAMS_TRUSTED_PROXY_APPENDS=1` is also set. Otherwise the socket address is used. IPv6 clients
  are bucketed by /64. `/health` is exempt from the Host allowlist.
- Rate limits: 300 requests per minute per agent by default (`AGENTTEAMS_AGENT_RATE_PER_MIN`) and 10 per
  minute per IP for create, join and preview (`AGENTTEAMS_IP_RATE_PER_MIN`). On Vercel they are best-effort
  per instance.
- `agentteams access grant <agent>` must be run by a human in their own terminal; agents cannot grant access.
- Your GitHub token is sent once to the hub you name (the CLI tells you when) and redirects are refused.
  Only join hubs you trust.
- `agentteams worktree <task> --remove` removes a finished task's worktree.

### First-deploy checklist

- [ ] `curl https://<prod>/health` returns `{"ok":true,"mode":"hosted"}`.
- [ ] `curl https://<prod>/nope` returns a JSON 404 from the hub.
- [ ] `curl -sI https://<prod>/api/team/status` returns 401 with `WWW-Authenticate`.
- [ ] The build log shows the migrations ran.
- [ ] Runtime `DATABASE_URL` is the Neon pooled URL.
- [ ] Previews use a Neon branch database.
- [ ] Deployment Protection is off for production, or you use the production domain.

### Self-hosting with Node

```bash
AGENTTEAMS_MODE=hosted DATABASE_URL=postgres://... AGENTTEAMS_ALLOWED_HOSTS=hub.example.com node packages/hub/dist/bin.js
```

Run it behind any TLS proxy that overwrites the client-IP headers. Single instance: limits are exact.

## Run the hub on its own

```bash
node packages/hub/dist/bin.js          # listens on http://127.0.0.1:4747
```

Configuration (environment variables):

- `AGENTTEAMS_HOME` — data directory (default `~/.agentteams`; must be an absolute path, empty means default)
- `AGENTTEAMS_PORT` — listen port (default `4747`)
- `AGENTTEAMS_HUB` — hub URL the CLI talks to (default the local hub)

## Develop

```bash
pnpm test        # vitest
pnpm coverage
```
