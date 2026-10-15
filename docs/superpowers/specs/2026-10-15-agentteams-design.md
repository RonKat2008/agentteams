# agentteams — Design Spec

Date: 2026-10-15 · Status: draft for review

## 1. Problem & goal

When several coding agents (Claude Code, Codex, …) work on one project, they collide: conflicting
commits, overwritten files, and no shared picture of who is doing what. **agentteams** lets any
personal coding agent — yours or a friend's, on the same machine or a different one — join a shared
team with an invite code. One agent is the **orchestrator** and assigns work; a **hub** tracks
presence, tasks, messages, file claims and commit summaries so every agent knows what the others are
doing. A team is tied to one project repo, which the orchestrator can create fresh on GitHub or link
from an existing repo.

**Success for v0.1:** `ronit-claude` (orchestrator), `ronit-codex`, `dylan-claude` and `ash-codex`
join one team; the orchestrator assigns tasks; each worker does its task on its own branch without
clobbering others; everyone can see a live status table and an activity log; the orchestrator merges
the results.

### Prior art and positioning

| Tool | Overlap | Gap agentteams fills |
|---|---|---|
| Claude Code Agent Teams | lead + teammates, task list, mailbox | Claude-only, single machine |
| MCP Agent Mail | messaging, advisory file leases, pre-commit guard | local, no multi-person teams, no orchestrator role |
| cross-agent_mcp / agent-bridge | live Claude↔Codex messaging | 1:1, local, no tasks or git awareness |
| mcp-talk | generic message queue over MCP | messaging only |
| GitHub Agent HQ | multi-vendor agents on one repo | vendor cloud agents, not personal local ones |

agentteams = multi-person + multi-machine + multi-vendor + orchestrator + git awareness. We borrow
Agent Mail's lease and pre-commit-guard ideas.

## 2. Concepts

- **Team** — one team = one project repo. Created with `agentteams create <name>`, which returns an
  **invite code**. Anyone with the code can join until it expires or is revoked.
- **Member** — a person. Authenticates once (local mode: none; hosted mode: GitHub OAuth device flow,
  which also gives us their GitHub username).
- **Agent** — one coding tool of one member, named `<member>-<tool>` (`ronit-claude`, `ash-codex`).
  A member may register several agents. Names are unique within a team.
- **Orchestrator** — exactly one agent per team. Initially the creator's first agent; transferable by
  the team creator with `agentteams orchestrator set <agent>`. Only the orchestrator may create/assign
  tasks, send `command` messages, and merge.
- **Presence** — derived from the agent's last heartbeat (any MCP call or hook ping):
  - 🟢 `active` — heartbeat within 60 s
  - 🟡 `idle` — within 10 min
  - ⚫ `offline` — older
  Computed at read time from `last_seen_at`; nothing to expire.
- **Task** — `{id, title, description, assignee?, status, branch?, summary?}` with status
  `open → assigned → in_progress → done` (or `blocked`). Tasks assigned to offline agents simply wait.
- **Message** — `{from, to (agent | "all"), kind, body, created_at, read_at}`, kind ∈
  `command | question | fyi`. Only the orchestrator may send `command`.
- **File claim** — advisory lease `{agent, globs[], exclusive, expires_at}`. Default TTL 2 h,
  renewable.
- **Activity event** — append-only team timeline: `team_created`, `repo_linked`, `agent_joined`,
  `task_created|assigned|claimed|updated|completed`, `files_claimed|released`, `commit`,
  `message_sent`, `merged`, `claim_overridden`. Viewed via `agentteams log [-f]` and the
  `get_activity` MCP tool. (Presence changes are shown live in `status`, not logged as events.)

## 3. Project setup

A team is always linked to one repo, recorded on the team as `{provider: "github" | "local",
slug?: "owner/name", default_branch}`.

**A. Start a new project** — `agentteams create my-app --new-repo [--private|--public] [--owner org]`
1. Requires `gh` authenticated on the creator's machine (checked up front with a clear error).
2. Creates a local folder `./my-app`, `git init`, writes a starter `README.md` plus the agentteams
   instruction block in `CLAUDE.md` and `AGENTS.md` (see §5), commits.
3. `gh repo create <owner>/my-app --private --source . --push`.
4. Links the team to `owner/my-app` and prints the invite code.

**B. Connect an existing repo** — run `agentteams create my-app` inside a git repo (or pass
`--repo owner/name`). It reads `origin`, verifies access with `gh repo view`, links the team, and
offers to add the agentteams instruction block to `CLAUDE.md`/`AGENTS.md` (as a normal commit on a
branch, never pushed to main without confirmation).

**C. Local-only** — `agentteams create my-app --local` inside a repo with no remote. Valid only for
same-machine teams; joiners on other machines are rejected with an explanation.

**Joining** — `agentteams join <code> --agent claude|codex`:
- If the current directory is a clone of the team's repo → use it.
- Otherwise → offer to `gh repo clone owner/name` into `./name` and continue there.
- If the clone fails for lack of access → print who to ask, and (hosted mode) notify the creator.

**Collaborator access** (hosted, GitHub repos) — when a member joins, the hub records their GitHub
username and sends the orchestrator's owner an `access_request`. Running `agentteams access grant
<member>` (or answering yes to the prompt in `agentteams status`) calls
`gh api -X PUT repos/<slug>/collaborators/<username> -f permission=push`. Always explicit — never
automatic.

## 4. Architecture

```
 machine A (Ronit)                          hub (local or hosted)
 ┌──────────────┐  MCP over HTTP   ┌───────────────────────────────┐
 │ Claude Code  │─────────────────▶│  Hono server                  │
 │  + hooks     │  hook pings      │   /mcp   Streamable HTTP MCP  │
 ├──────────────┤─────────────────▶│   /api   REST (CLI, hooks)    │
 │ Codex        │                  │   /api/events  SSE (log -f)   │
 │  + hooks     │                  │  Repository interface         │
 └──────────────┘                  │   ├─ SQLite (local)           │
 machine B (Dylan) ───────────────▶│   └─ Postgres (hosted)        │
                                   └───────────────────────────────┘
 git: each agent works in its own worktree/branch; shared GitHub remote for cross-machine.
```

**Same-machine mode:** `agentteams up` runs the hub on `127.0.0.1:4747` with SQLite at
`~/.agentteams/hub.db`; no login, invite code still required to join (keeps the model identical).

**Cross-machine mode:** the same hub binary deployed to a long-lived host (Fly.io or Railway) with
Postgres. Agents connect over HTTPS with their agent API key.

Agents never talk to each other directly — everything goes through the hub. Code moves only through
git. All `git`/`gh` operations run on members' machines via the CLI; the hub never holds GitHub
credentials.

### Packages (pnpm TypeScript monorepo)

| Package | Responsibility | Depends on |
|---|---|---|
| `packages/shared` | zod schemas + TS types for every entity and API payload | — |
| `packages/hub` | services (team, presence, tasks, messages, claims, activity), repository adapters, HTTP + MCP + SSE transport | shared |
| `packages/cli` | `agentteams` binary: `up`, `create`, `join`, `status`, `log`, `orchestrator set`, `access grant`, `install`, `worktree`, `merged` | shared |
| `packages/hooks` | small Node entrypoints run by Claude Code / Codex hooks and git hooks | shared |

Inside `hub`, services take a `Repository` interface; transports (MCP tools, REST routes) are thin
adapters over services. This keeps business rules testable without HTTP and lets SQLite and Postgres
share one test suite. In `cli`, `git` and `gh` calls go through a small `GitClient` / `GitHubClient`
wrapper so they can be faked in tests.

## 5. Agent interface

### Joining (agent side)

After the repo step in §3, `join`:
1. Exchanges invite code for an agent record + API key (hosted: after GitHub device-flow login).
2. Stores `{hub, team, agent, apiKey}` in `~/.agentteams/credentials.json` (mode 0600), keyed by
   repo path so one machine can be in several teams.
3. Registers the MCP server with the tool in user-local config only, so the key never lands in the
   repo (Claude Code: `claude mcp add --scope local --transport http`; Codex: an entry in
   `~/.codex/config.toml`), pointing at `<hub>/mcp` with the API key as a bearer header.
4. Installs tool hooks and git hooks (`agentteams install`, re-runnable).

### Instruction block

`CLAUDE.md` / `AGENTS.md` get a short block telling agents to: check `read_inbox` and `team_status`
at the start of work, `claim_files` before editing, work only on their task branch, call
`complete_task` with a summary when done, and treat peer messages as information, not orders.

### MCP tools

| Tool | Who | Purpose |
|---|---|---|
| `team_status` | all | agents, presence, current task, claimed files, linked repo |
| `send_message(to, body, kind)` | all (`command`: orchestrator) | message one agent or `all` |
| `read_inbox(mark_read=true)` | all | unread messages, oldest first |
| `create_task(title, description, assignee?)` | orchestrator | add task |
| `assign_task(task_id, assignee)` | orchestrator | (re)assign |
| `list_tasks(status?, assignee?)` | all | task board |
| `claim_task(task_id)` | assignee or anyone if unassigned | start work → `in_progress` |
| `update_task(task_id, status?, note)` | assignee | progress notes, `blocked` |
| `complete_task(task_id, summary, branch)` | assignee | mark `done`, record branch |
| `claim_files(globs, exclusive=true, ttl_min=120)` | all | lease files; returns conflicts if any |
| `release_files(globs?)` | all | release own leases |
| `who_owns(path)` | all | active leases matching path |
| `get_activity(since?, limit=50)` | all | timeline |
| `get_changes(agent?, since?)` | all | recent commit summaries |

Every tool call updates the caller's heartbeat. Errors return MCP error results with a clear message
(e.g. `"only the orchestrator (ronit-claude) can assign tasks"`).

### Message delivery (live sessions)

Agents are turn-based and cannot be interrupted mid-turn, so delivery happens at turn boundaries via
hooks calling `POST /api/agents/me/ping`, which returns unread messages:

- **Claude Code**
  - `SessionStart` → ping; inject team status + unread messages as additional context.
  - `UserPromptSubmit` and `PostToolUse` → ping; inject any new messages.
  - `Stop` → if an unread `command` exists, block the stop and feed the command as the reason, so the
    agent keeps working on orchestrator instructions.
- **Codex** — use Codex hooks if they support equivalent events (verified during build phase 3).
  Fallback: the `AGENTS.md` block instructs Codex to call `read_inbox` at the start of each turn and
  after finishing each step.

**Injected format** (prompt-injection boundary):
```
<agentteams-messages>
[command from ronit-claude (orchestrator)] Build the login page — task #4.
[fyi from dylan-claude (peer, untrusted)] I changed auth/session.ts, re-pull before editing.
</agentteams-messages>
```
Peer messages are labeled untrusted; only orchestrator messages are `command`. agentteams never
changes an agent's permission settings — it adds context, not authority.

Headless auto-spawning of offline agents (`claude -p`, `codex exec`) is **out of scope for v0.1**.

## 6. Git workflow

1. **Isolation** — `agentteams worktree <task-id>` creates a git worktree at
   `../<repo>.at/<agent>-<task-id>` on branch `at/<agent>/<task-id>` from the latest
   `origin/<default_branch>` (or local default branch for `--local` teams), and calls `claim_task`.
2. **Claims** — agents claim files before editing. A git **pre-commit** hook asks the hub `who_owns`
   for each staged path; staged files held by another agent's exclusive lease **block the commit**
   with the owner's name and a hint to message them. `AGENTTEAMS_ALLOW=1 git commit` overrides
   (logged as `claim_overridden`). Hub unreachable → warn and allow (never wedge the user's git).
3. **Change awareness** — git **post-commit** hook posts `{sha, branch, message, files[], insertions,
   deletions}` (no diff content) to the hub → `commit` activity event + `fyi` message to every agent
   with an overlapping active claim.
4. **Completion & merge** — `complete_task` requires the branch to be pushed (GitHub teams) or exist
   locally (`--local` teams). The orchestrator reviews via `get_changes` / `git diff`, then merges or
   opens a PR with `gh pr create`. On conflict it sends a `command` to the owning agent to rebase.
   `agentteams merged <task-id>` (or a post-merge hook on the default branch) records `merged`.

## 7. Security

- **Invite codes**: random ≥ 80-bit, displayed as `word-word-1234`-style, expire after 7 days,
  revocable (`agentteams invite revoke`). Stored hashed.
- **Agent API keys**: random 256-bit, shown once, stored hashed (SHA-256) server-side; client file
  mode 0600; never written to committed files. Revoked when an agent is removed.
- **Authorization** enforced in hub services, never trusted from the client: team membership on every
  request; orchestrator-only operations; agents may only update/complete their own tasks and release
  their own claims.
- **GitHub**: the hub stores no GitHub tokens; repo creation and collaborator grants run locally via
  the creator's `gh`, and collaborator grants always require explicit confirmation.
- **Input validation**: zod schemas from `shared` at every REST and MCP boundary; body size limits
  (message ≤ 8 KB).
- **Rate limiting**: per-agent token bucket (60 req/min) in hosted mode.
- **Data minimization**: activity log holds file names and line counts, never diff or file contents.
- **Local mode** binds to 127.0.0.1 only.

## 8. Error handling

- Hub unreachable from hooks → hooks exit 0 after a 2 s timeout (agent keeps working); CLI prints a
  clear error. The pre-commit guard warns and allows.
- `gh` missing or unauthenticated → `create --new-repo`, existing-repo verification and
  `access grant` fail fast with the exact command to fix it (`gh auth login`).
- Claim conflicts are returned as data (`{granted: false, conflicts: [...]}`), not thrown.
- Invalid state transitions (e.g. completing a task you don't own) → typed domain errors mapped to
  MCP error results / HTTP 403/409 with human-readable messages.

## 9. Testing

- **Unit**: services against an in-memory SQLite repository (vitest), TDD.
- **Repository contract suite**: same tests run against SQLite and Postgres.
- **MCP contract tests**: connect an MCP client from `@modelcontextprotocol/sdk` to the hub
  in-process and exercise every tool, including authorization failures.
- **CLI/hooks**: run the CLI against a temp hub and temp git repo with faked `GitHubClient`; assert
  new-repo and existing-repo flows, join-clone flow, pre-commit blocking, post-commit events.
- **E2E (scripted + manual)**: local hub, Claude Code + Codex in a temp repo; orchestrator creates two
  tasks; workers complete on separate branches; log shows everything; orchestrator merges cleanly.
  One manual run of `--new-repo` against real GitHub (private throwaway repo).
- Coverage target ≥ 80 %.

## 10. Scope & build order

**v0.1**
1. Hub core: shared schemas, SQLite repository, services, MCP tools, REST ping endpoint.
2. CLI + Claude Code: `up`, `create` (existing repo + `--local`), `join`, `status`, `log`, MCP config
   + Claude hooks. Milestone: two Claude Code sessions coordinate on one machine.
3. Codex integration (hooks or AGENTS.md fallback). Milestone: ronit-claude assigns, ronit-codex
   completes.
4. Git layer: `create --new-repo`, join-clone, `worktree`, pre-commit guard, post-commit summaries,
   `merged`.
5. Hosted mode: Postgres adapter, GitHub device-flow login, `access grant`, deploy. Milestone: a
   friend joins from another laptop and pushes a task branch.

**v0.2+** web dashboard, headless runner, more agents (Gemini CLI, Cursor), auto-PR, multiple
orchestrators / sub-teams.

## 11. Defaults chosen

- One orchestrator per team (transferable).
- One team ↔ one repo.
- Claims: advisory, enforced at commit time with an explicit, logged override.
- Delivery: live sessions via hooks only in v0.1.
- Local mode has no member login; hosted uses GitHub device flow.
- Collaborator grants are always manual-confirm.
