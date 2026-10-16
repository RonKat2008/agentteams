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

The installed git hooks chain any existing hook (moved to `<hook>.agentteams-prev`). If `core.hooksPath` is
set (husky and similar), agentteams does not write hooks; add these two lines to your hook manager yourself:

```sh
agentteams git-hook pre-commit
agentteams git-hook post-commit
```

`create --new-repo` makes a GitHub repo for you, and `join` clones the team repo (skip with `--no-clone`).

## Teammates on other machines

Hosted mode is planned for a later release. The local hub only accepts local connections (it refuses
non-local `Host` headers), so teammates cannot reach it over the network yet. You can pass `--hub <url>`
to `create`/`join` to point at a different hub, but remote access needs hosted mode.

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
