# Hub core (Plan 1): deferred follow-ups

These items came up in the per-task and final reviews and were deliberately deferred. Each line names the plan that should pick it up.

## Before Plan 2 (CLI and hooks) ships
- Label peer-written free text that reaches agent context outside the inbox. Message previews, task notes and summaries, and commit subjects in `get_activity` and `get_changes` currently carry no trust label. Also, the first 80 characters of direct messages are visible to the whole team via the activity log.
- Local hub CSRF: any webpage can POST `text/plain` to `/api/teams` and create junk teams. Require `application/json` and allow only `127.0.0.1` and `localhost` as the Host.
- Concurrent `readInbox` is now crash-free but delivers at least once: the same message can reach two parallel pings.
- A 401 from `/mcp` has no `WWW-Authenticate` header. Verify Claude Code doesn't attempt OAuth discovery when it gets one.

## Plan 4 (git layer)
- `globsOverlap` is approximate: exclusive `**/*.ts` and `src/**` are both granted. The pre-commit guard must check each staged path with `whoOwns`, which is exact.
- Dedupe re-posted commits on (team, sha, branch). Amend and hook re-runs currently create duplicates and re-notify.
- `complete_task` doesn't verify that the branch exists or was pushed.

## Plan 5 (hosted)
- Body-size limits on unauthenticated routes. Rate limiting.
- Member identity: creator rights are bound to the creating agent's id (`teams.creator_agent_id`) and can't be transferred. Revisit once members authenticate.
- Agent removal and API-key revocation (spec §7) have no task yet.

## Small cleanups (any time)
- `engines` `>=22` → `>=22.12` (vitest requirement). `@types/better-sqlite3` ^9 vs runtime 13.
- `parsePort` accepts `' 80'`, `0x50` and `1e3`. Tighten it to `/^\d+$/`.
- `dist/bin.js` isn't executable after `tsc`. The bin signal handler hides `close()` errors.
- The claims cleanup delete isn't scoped to the team. Duplicate globs in one request insert two rows.
- Per-request MCP `McpServer` and transport aren't explicitly closed (POST, stateless).
- Test gaps:
  - 100-message inbox page
  - non-Bearer auth scheme
  - 409 and 500 REST paths
  - reassign edge cases (previous assignee == new assignee, previous assignee == actor)
  - no test can reach the migration-failure path
