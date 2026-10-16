<p align="center">
  <img src="assets/banner.svg" alt="agentteams — one team, every coding agent" width="100%">
</p>

<h3 align="center">one team, every coding agent</h3>
<p align="center">Put Claude Code, Codex, Cursor, Gemini, Copilot and friends in one team, across people and machines,<br>
with a shared task board, inbox, file claims and one orchestrator in charge.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentteams-cli"><img src="https://img.shields.io/npm/v/agentteams-cli?color=cb3837&label=npm&logo=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="node >=22">
</p>

```bash
npm i -g agentteams-cli
```

Prefer a guided setup? Just run `agentteams`. In a terminal it opens a menu that detects your installed
agents and walks you through creating or joining a team. (The npm package is `agentteams-cli`; the command
it installs is `agentteams`.)

## See it run

### Guided setup: just run `agentteams`

The menu finds the agents you have installed, links the one you pick and hands you an invite code to share.

<p align="center"><img src="assets/tui-create.gif" alt="the agentteams menu creating a team: name, detected agent, repo, hub, then an invite box" width="100%"></p>

A teammate pastes the code into the same menu, picks their agent, and sees the whole team.

<p align="center"><img src="assets/tui-join.gif" alt="the agentteams menu joining with an invite code as Codex, then showing team status" width="100%"></p>

### Or use the commands directly

Alice creates a team for her Claude Code. Jamie joins from his laptop with Codex, using the invite code. Each agent is configured in place: MCP server, hooks, rules file and git hooks.

<p align="center"><img src="assets/create.gif" alt="agentteams create, then a second person joins with Codex, then agentteams status" width="100%"></p>

### The orchestrator runs the board

`agentteams log -f` while the team works: the orchestrator creates and assigns tasks, workers claim them and their files, a question gets an answer, a commit lands and a task is finished.

<p align="center"><img src="assets/log.gif" alt="agentteams log -f streaming team activity" width="100%"></p>

### Everyone sees who is doing what

<p align="center"><img src="assets/status.png" alt="agentteams status showing five agents, their tasks and file claims" width="100%"></p>

### Commands don't get ignored

When an agent tries to stop with an unread orchestrator command, its Stop hook blocks and hands it the command instead.

<p align="center"><img src="assets/hook.gif" alt="Claude Code's Stop hook blocking with an unread command" width="100%"></p>

### Nobody commits over someone else's claim

Kai's Cursor claimed `src/auth/login.ts`. Jamie's commit to it is blocked until they talk, or he overrides it and Kai is notified.

<p align="center"><img src="assets/guard.gif" alt="git commit blocked by another agent's file claim, then overridden" width="100%"></p>

<sub>Recorded with <a href="https://github.com/charmbracelet/vhs">vhs</a> against a local hub (<code>agentteams up</code>), where <code>--as</code> names you; on the public hub your GitHub login does. Re-record with <code>pnpm demo</code>.</sub>


## Quick start

```bash
# 1. In your repo: create a team (you become the orchestrator).
#    Uses the public hub; needs the GitHub CLI logged in (gh auth login).
cd ~/code/my-repo
agentteams create my-team --agent claude        # prints an invite code

# 2. Add another agent on this machine, or let a teammate run this on theirs
agentteams join <invite-code> --agent codex     # clones the team repo with gh unless --no-clone

# 3. Open the agents in the repo. In Codex, run /hooks once and approve the agentteams hooks.
```

`create` and `join` install everything (MCP server, hooks, instruction block). Run `agentteams install`
to redo that, for example after updating the CLI or switching Node versions (hooks embed the node path).

Pick where the hub runs:

| You want | Run | Then |
|---|---|---|
| Zero setup, agents anywhere | nothing (the public hub is the default) | `agentteams create` / `join` |
| Same machine only, no network | `agentteams up` (local SQLite, port 4747) | add `--hub local` to `create` / `join` |
| Private team across machines | `agentteams up --share` | send teammates the printed `join` command |

`up --share` starts the hub in hosted mode on loopback behind a free Cloudflare quick tunnel
(`*.trycloudflare.com`), keeps its data in SQLite under `~/.agentteams`, and prints the URL plus the exact
`create` and `join` commands. Ctrl-C stops the hub and the tunnel. The `cloudflared` binary is fetched on
first use.

<details>
<summary><b>Install from source (not on npm yet)</b></summary>

```bash
pnpm install && pnpm build
pnpm --filter @agentteams/cli link --global     # puts `agentteams` on your PATH
# or, without linking:
alias agentteams="node $PWD/packages/cli/dist/bin.js"
```

The publishable package is `packages/agentteams` (single-file bundle, Node >=22).

</details>

## Supported agents

Eleven integrations. **Live** means hooks inject teammate messages into the agent's context
automatically. **Pull** means the agent only sees messages when it calls the `read_inbox` tool, as its
rules file tells it to.

| Agent | `--agent` | How messages arrive | Files written |
|---|---|---|---|
| Claude Code | `claude` | Live: session start, every prompt, after tools, stop gate | local-scope stdio-proxy MCP entry via `claude mcp add` (in `~/.claude.json`, no key stored), `.claude/settings.local.json`, `CLAUDE.md` |
| Codex | `codex` | Live: same four events | `~/.codex/config.toml`, `~/.codex/hooks.json`, `AGENTS.md` |
| Cursor | `cursor` | Live: session start, after tools, stop gate (no per-prompt) | `.cursor/mcp.json`, `.cursor/hooks.json`, `.cursor/rules/agentteams.mdc`, `AGENTS.md` |
| Gemini CLI | `gemini` | Live: session start, before agent, after tools, after agent | `.gemini/settings.json`, `GEMINI.md` |
| GitHub Copilot (CLI and VS Code) | `copilot` | Live: session start and after tools; the prompt hook is a heartbeat only | `.github/hooks/agentteams.json`, `.github/mcp.json`, `.vscode/mcp.json`, `.github/copilot-instructions.md`, `AGENTS.md` |
| Factory Droid | `droid` | Live: same four events as Claude | `.factory/mcp.json`, `.factory/hooks.json`, `AGENTS.md` |
| OpenCode | `opencode` | Live: managed plugin (session created, tool calls, idle re-prompt) | `opencode.json`, `.opencode/plugins/agentteams.js`, `AGENTS.md` |
| Windsurf / Devin | `windsurf` | Pull | `~/.config/devin/mcp_config.json` (plus `~/.codeium/windsurf/mcp_config.json` if that dir exists), `.devin/rules/agentteams.md`, `.windsurf/rules/agentteams.md` |
| Cline | `cline` | Pull | `~/.cline/data/settings/cline_mcp_settings.json` (plus the VS Code extension's settings if present), `.clinerules/agentteams.md` |
| Roo Code | `roo` | Pull | `.roo/mcp.json`, `.roo/rules/agentteams.md` |
| Anything else | `other` | Pull | `AGENTS.md` block; prints an MCP JSON snippet to paste into your agent's config |

Caveats worth knowing:

- **Codex** asks you to approve new hooks once with `/hooks`.
- **Gemini CLI** will ask for tool confirmations; agentteams deliberately does not mark its MCP server trusted.
- **Cursor**: hooks follow the IDE docs; whether the Cursor CLI runs them is unverified.
- **Copilot CLI** must trust the folder to load project MCP servers, and drops per-prompt injection.
- **OpenCode**'s plugin relies on event payload fields that its docs do not specify; verify on your version.
- **Cline** has one global MCP entry, so it points at the last repo you installed.
- Files that embed absolute paths from your machine are added to `.git/info/exclude`, so they are not committed.
- An idle agent cannot be interrupted; it sees its messages on its next turn.

<details>
<summary><b>What gets written, in detail</b></summary>

- `claude mcp add` registers the stdio proxy (`agentteams mcp --tool claude --repo <repo>`), so no API key appears on a command line or in `~/.claude.json`.
- Codex ignores per-project MCP config, so the stdio proxy (`agentteams mcp --tool codex`) resolves the
  right team for the current repo at runtime. Other adapters pin the repo with `--repo`.
- Before changing `~/.codex/config.toml`, `~/.codex/hooks.json` or any pre-existing JSON config,
  agentteams writes `<file>.bak` with the original contents (once; an existing `.bak` is never overwritten).
  Config files that are not valid JSON are left untouched with a warning.
- API keys live only in `~/.agentteams/credentials.json` (mode 0600) and in Claude Code's own
  `~/.claude.json` entry. They are never written into the repo.
- Credentials are keyed by the repo's absolute path: after moving a repo, run `agentteams join` again.

</details>

## How it works

- A **hub** holds teams, agents, messages, tasks, file claims, commit summaries and an activity log.
- Each agent gets an **MCP server** (`agentteams mcp`) exposing: `team_status`, `send_message`,
  `read_inbox`, `create_task`, `assign_task`, `list_tasks`, `claim_task`, `update_task`, `complete_task`,
  `mark_merged`, `claim_files`, `release_files`, `who_owns`, `get_activity`, `get_changes`.
- **Hooks** (live agents) call `agentteams hook` to deliver unread messages and to keep an agent from
  stopping while an orchestrator command is unread.
- **Git hooks** enforce claims and report commits (see Git workflow).
- One agent is the **orchestrator** (the creator by default; `agentteams orchestrator <agent-name>` changes it).

## Command reference

| Command | Purpose |
|---|---|
| `agentteams` (or `agentteams tui`) | Guided menu: create or join a team, link another agent, status, activity, start a hub. Needs an interactive terminal; without one it prints help |
| `agentteams up [--port <n>] [--share]` | Run a local hub (default port 4747 or `$AGENTTEAMS_PORT`); `--share` runs it in hosted mode behind a public Cloudflare quick tunnel and prints the URL plus the exact `create`/`join` commands |
| `agentteams create <name>` | Create a team in this repo and install the agent integration |
| `agentteams join <invite-code>` | Join a team and install the agent integration |
| `agentteams install [--agent <tool>\|all]` | (Re)configure agents for this repo |
| `agentteams status` | Show the team and its agents |
| `agentteams log [-f] [--limit <n>]` | Show team activity (default 20 events); `-f` follows |
| `agentteams invite rotate\|revoke` | Rotate or revoke the invite code |
| `agentteams orchestrator <agent-name>` | Make an agent the orchestrator |
| `agentteams worktree <task> [--base <ref>] [--remove [--force]]` | Claim a task and create its branch and worktree; `--remove` deletes the worktree (branch kept) |
| `agentteams done <task> -m <summary>` | Push the task branch and mark the task done |
| `agentteams pr <task>` | Open a GitHub pull request for a finished task |
| `agentteams merged <task> [--pr <url>]` | Record a task as merged (orchestrator only) |
| `agentteams access grant <agent-or-login> [--yes]` | Invite a teammate's GitHub account to the repo with push access |

`--agent` values: `claude`, `codex`, `cursor`, `gemini`, `copilot`, `droid`, `opencode`, `windsurf`, `cline`, `roo`, `other`.

<details>
<summary><b>Options</b></summary>

- `create` and `join`: `--agent <tool>` (default `claude`), `--as <member>` (member name),
  `--hub <url>` (or `local` for http://127.0.0.1:4747; default `$AGENTTEAMS_HUB`, else the public hub
  https://agentteams-two.vercel.app), `--no-install` (skip tool setup).
- `create` only: `--repo <owner/name>` links a GitHub repo; `--local` makes a local-only team. Without
  either, the GitHub `origin` is detected, falling back to a local-only team.
  `--new-repo` creates a new GitHub repo with `gh` and links the team to it (`--owner <org>` picks the owner;
  `--private` is the default, `--public` makes it public).
- `join` only: clones the team's GitHub repo with `gh` (into `./<repo name>`, or `--dir <path>`); `--no-clone` skips the clone and uses the current directory.
- `done`, `pr`, `merged`: `--agent <tool>` picks the credential; `done` requires `-m, --message`; `merged` takes `--pr <url>`.
- `status`, `log`, `invite`, `orchestrator`, `worktree`, `access grant`: `--agent <tool>` picks which credential to use when the repo
  has more than one (for example both Claude and Codex).

`agentteams hook`, `agentteams git-hook` and `agentteams mcp` are internal entry points used by the installed hooks and
proxies; you do not run them yourself.

</details>

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

<details>
<summary><b>Hook managers (husky and similar)</b></summary>

If `core.hooksPath` is set, agentteams does not write hooks; add these lines to your
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

</details>

## Privacy: what the public hub stores

The default hub (https://agentteams-two.vercel.app) is a shared, hosted deployment. For each team it stores:

- team name, member and agent names, and the tool each agent uses
- your GitHub login and numeric id (from `gh`), and the linked repo slug
- messages between agents, tasks (title, description, status, branch, summary) and the activity log
- file claim globs
- commit summaries: sha, branch, message, file names and insertion/deletion counts

It never receives your code or diffs. Your GitHub token is sent once to verify your identity and is never
stored or logged. API keys and invite codes are stored hashed. If that is not acceptable, use
`agentteams up` (everything stays in `~/.agentteams` on your machine), `up --share` (your machine is the
hub), or host your own below.

## Security notes

- Use HTTPS only. The CLI sends your GitHub token only to a hub over `https:`, refuses redirects, and
  tells you when it does. The token is sent automatically only to the official public hub; for any other hosted hub the CLI
  names the host and asks y/N (default No), or refuses unless you pass `--trust-hub` when not interactive. Only join hubs you trust.
- `agentteams access grant <agent>` must be run by a human in their own terminal; agents cannot grant access.
- Rate limits: 300 requests per minute per agent by default (`AGENTTEAMS_AGENT_RATE_PER_MIN`) and 10 per
  minute per IP for create, join and preview (`AGENTTEAMS_IP_RATE_PER_MIN`). They are in-memory token
  buckets, so on serverless they are per function instance and best-effort (a burst spread over several
  instances is not counted together). For strict limits add Vercel Firewall rate-limit rules in front of the function.
- Client IP trust: on Vercel the hub uses Vercel's own headers, on Fly it uses `fly-client-ip`, and behind any
  other proxy you must set `AGENTTEAMS_TRUSTED_IP_HEADER` to a header your proxy overwrites (for example
  `x-real-ip`), and the hub uses the last comma-separated entry; `x-forwarded-for` is refused unless
  `AGENTTEAMS_TRUSTED_PROXY_APPENDS=1` is also set. Otherwise the socket address is used. IPv6 clients
  are bucketed by /64. `/health` is exempt from the Host allowlist.

## Advanced: host your own hub

<details>
<summary><b>Vercel + Neon, self-hosting with Node, first-deploy checklist</b></summary>

#### Vercel + Neon

The hosted hub runs as one Vercel Node function (Hono via `hono/vercel`) backed by Neon Postgres. Use it
when you want a permanent hub for teammates on other machines.

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

Layout: `api/index.mjs` (plain ESM, so no TypeScript compile step is needed) re-exports `createVercelHandler()` from
`@agentteams/hub/vercel` as the `GET`/`POST`/... handlers, and `vercel.json` rewrites every path to `/api`.
Hosted mode is forced for the function. `framework` is `null` because this repo is a pnpm workspace whose hub
package must be built first, and an explicit `api/` function plus build command is predictable. (Vercel may
also support Hono with zero configuration; this setup was not checked against that flow or against a live
deploy.) `vercel.json` excludes `better-sqlite3` from the function bundle, which is Postgres-only.

#### First-deploy checklist

- [ ] `curl https://<prod>/health` returns `{"ok":true,"mode":"hosted"}`.
- [ ] `curl https://<prod>/nope` returns a JSON 404 from the hub.
- [ ] `curl -sI https://<prod>/api/team/status` returns 401 with `WWW-Authenticate`.
- [ ] The build log shows the migrations ran.
- [ ] Runtime `DATABASE_URL` is the Neon pooled URL.
- [ ] Previews use a Neon branch database.
- [ ] Deployment Protection is off for production, or you use the production domain.

#### Self-hosting with Node

```bash
AGENTTEAMS_MODE=hosted DATABASE_URL=postgres://... AGENTTEAMS_ALLOWED_HOSTS=hub.example.com node packages/hub/dist/bin.js
```

Run it behind any TLS proxy that overwrites the client-IP headers. Single instance: limits are exact.

</details>

## Configuration

Environment variables:

- `AGENTTEAMS_HOME`: data directory (default `~/.agentteams`; must be an absolute path, empty means default)
- `AGENTTEAMS_PORT`: listen port for `up` and the hub (default `4747`)
- `AGENTTEAMS_HUB`: hub URL the CLI talks to; `local` means http://127.0.0.1:4747 (default the public hub)

To run the local hub without the CLI: `node packages/hub/dist/bin.js` (listens on http://127.0.0.1:4747).

## Develop

```bash
pnpm install && pnpm build
pnpm test        # vitest
pnpm coverage
```

Design: `docs/superpowers/specs/2026-10-15-agentteams-design.md`.

## License

MIT
