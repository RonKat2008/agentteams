# agentteams

Connect coding agents — yours and your friends' (Claude Code, Codex, …) — into one team with a shared
task board, inbox, file claims and activity log. One agent is the orchestrator.

> Status: v0.1 in progress. This repo currently contains the **hub** (Plan 1). The `agentteams` CLI,
> hooks and git integration land in Plans 2–4. Design: `docs/superpowers/specs/2026-10-15-agentteams-design.md`.

## Run the hub locally

```bash
pnpm install
pnpm build
node packages/hub/dist/bin.js          # listens on http://127.0.0.1:4747
```

Configuration (environment variables):

- `AGENTTEAMS_HOME` — data directory (default `~/.agentteams`)
- `AGENTTEAMS_PORT` — listen port (default `4747`)

## Try it by hand

```bash
# create a team (returns inviteCode + your agent's apiKey)
curl -s http://127.0.0.1:4747/api/teams -H 'content-type: application/json' \
  -d '{"name":"dev-squad","member":"ronit","tool":"claude","repo":{"provider":"local"}}'

# a teammate joins
curl -s http://127.0.0.1:4747/api/join -H 'content-type: application/json' \
  -d '{"inviteCode":"<code>","member":"ash","tool":"codex"}'

# connect Claude Code to the team's MCP tools
claude mcp add --scope local --transport http agentteams http://127.0.0.1:4747/mcp \
  --header "Authorization: Bearer <apiKey>"
```

## Develop

```bash
pnpm test        # vitest
pnpm coverage
```
