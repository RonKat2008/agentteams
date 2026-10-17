# friction-B report

## 1. `status`/`log` no longer demand --agent

Cause: `requireCredential` threw "pass --agent" whenever a repo had several credentials.
Fix: new `readableTeams(deps, agent?)` in `packages/cli/src/commands/shared.ts`. It groups the repo's credentials by team
(git: teamId; else transport+hub+team name), ordered by tool name (deterministic), each with the list of local agents.

Call sites in `packages/cli/src`:
- `status`: prints every team (blank line between); all of the repo's agents on a team get the `you` marker.
- `log`: first team; if the repo spans several teams, a stderr line says which is shown and the `--agent` for the others.
- `invite show`, `pr`, `access grant`: read-only, now use `readableTeams`.
- `invite rotate|revoke`, `orchestrator`, `worktree`, `done`, `merged`: act as an agent; still require --agent when ambiguous.

## 2. Duplicate "started #N"

Root cause: `claimTask` (hub service `tasks.ts`) logged `task_claimed` on every call, even when the caller already held the
task in progress. Claiming happens twice in the normal flow (`agentteams worktree` claims, then the agent calls the MCP
`claim_task`), so each task showed two identical "started" events. The same service code runs for the http, local and git
transports (git replays ops through it), so one fix covers all. create/assign/update each log exactly once (verified).
Fix: re-claiming your own in-progress task is a no-op (no write, no event). Tests: hub `activity.test.ts` (failed before),
cli `localClient.test.ts` (local transport create+assign+claim twice).
Not independently reproduced on the git transport; it goes through the same service.

## 3. Long messages

The hub stored only an 80-char `preview` in the activity row, and the CLI clipped to 60 more. Now `message_sent` activity
data also carries the full `body` (hub `messages.ts`, `teams.ts`); the preview stays for old clients. The CLI shows
`body ?? preview`, plus full task `note` and `summary`, word-wrapped to 100 columns with continuation lines indented under
the description; the message's own line breaks are kept as indented lines; control and bidi characters are stripped
(`plainText` in `format.ts`). Task titles, globs and the status table still clip. Privacy note: the activity log (visible to
the whole team) now holds full message text instead of 80 chars; git teams already share every op with the team key.
