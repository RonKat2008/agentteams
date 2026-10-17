# Serverless agentteams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task.

**Goal:** Teams work with no operator-run server: same-machine agents share a SQLite file in `.git/`, and people on
different machines replicate an encrypted, signed op log through hidden refs in the team's git remote.

**Architecture:** A `TeamClient` interface replaces direct `HubClient` use. `HttpTeamClient` wraps today's HTTP client;
`LocalTeamClient` calls the hub's service functions in-process on `<git-common-dir>/agentteams/team.db`. Git teams add
op capture, deterministic replay and a background sync engine on top of the local store.

**Tech Stack:** TypeScript, Node 22 (`node:crypto` AES-256-GCM + Ed25519), Kysely + better-sqlite3, git CLI, vitest,
tsup.

**Spec:** `docs/superpowers/specs/2026-10-16-serverless-design.md` (read it first; it is the authority).

## Global Constraints

- Node 22, ESM, no new runtime dependencies (use `node:crypto`, existing `ulid`, `kysely`, `better-sqlite3`).
- MCP tool names, input schemas and descriptions unchanged. Hook output formats unchanged.
- Existing credentials without `transport` keep working as HTTP credentials.
- Hooks must never wait on the network in local/git mode; hook p95 stays < 300 ms.
- Tests never touch the real HOME, never use the network, never call `gh`/`claude`/`cloudflared`; git remotes in tests
  are bare repos in temp dirs.
- Files < 400 lines, functions < 50 lines, immutable style, match existing code style and comment density.
- Every commit message ends with a blank line then exactly:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01P5zkbTve8aPBFWcnUdNQrj`.
- Baseline: `pnpm -r build && pnpm test` → 773 passed, 3 skipped. `mcpProxy.test.ts` "reconnects…" is known-flaky.

## Review Focus

1. Replay determinism: the same set of ops arriving in different orders must yield byte-identical DB contents (ids,
   timestamps, task numbers, activity rows).
2. Worktrees: a task worktree must resolve the same `team.db` as the main checkout (`git rev-parse --git-common-dir`).
3. Forged or corrupted segments (bad signature, bad ciphertext, unknown agent) are rejected without breaking sync.
4. Hooks with an unreachable or slow remote must still return promptly and never lose a local op.
5. Mixed old/new credentials: an HTTP credential next to a local one in the same repo keeps working.

---

## Phase 1 — Local transport

### Task 1: TeamClient interface and HTTP implementation

**Files:** create `packages/cli/src/teamClient.ts`; modify `hubClient.ts` (implements interface), every call site that
does `new HubClient(...)` or `clientFor(...)` (commands/*, hooks.ts, gitHooks.ts, tui/*); tests.

- Define `interface TeamClient` with exactly the methods `HubClient` exposes today (status, activity, ping,
  checkFiles, claimOverride, recordCommit, claimTask, completeTask, getTask, markMerged, setOrchestrator, rotateInvite,
  revokeInvite) using the same shared types.
- `teamClientFor(deps, cred, opts?)` factory: returns the HTTP client for `cred.transport ?? 'http'`. (Local/git
  branches added in Task 2/7.) All call sites use the factory.
- Add optional `transport?: 'http' | 'local' | 'git'` to `Credential` (persisted only when not http).
- Pure refactor: all existing tests pass unchanged except constructor plumbing.

### Task 2: Local store and LocalTeamClient

**Files:** create `packages/cli/src/local/store.ts` (path resolution + open + migrate, cached per process),
`packages/cli/src/local/localClient.ts`; export what is needed from `@agentteams/hub` (services, createContext,
migrateToLatest, openDb/sqlite helper, buildMcpServer) without pulling HTTP-only code into hook startup (lazy import).

- `teamDbPath(deps, repoPath)` = `<git-common-dir>/agentteams/team.db`; dir 0700, file 0600.
- `LocalTeamClient` implements `TeamClient` by authenticating `cred.apiKey` with the `authenticate` service, then
  calling service functions with `createContext(db, {mode: 'local'})`.
- Factory returns it for `transport === 'local'`.
- Tests: every TeamClient method against a temp repo (real `git init`), worktree resolves the same DB, two clients
  (two agents) see each other's messages, concurrent writers from two processes do not error.
- Hook timing test: a local hook round stays fast (no network).

### Task 3: Local create/join, in-process MCP, defaults, TUI

**Files:** `commands/create.ts`, `commands/join.ts`, `commands/mcp*.ts`/`mcpProxy.ts`, `paths.ts`, `tui/*`, README
setup section (brief), tests.

- `create`: if `--hub` is given → today's HTTP flow. Else if the repo has no remote or `--local` → local team: run the
  `createTeam` service against the local store (identity: `--as` or default member), save credential with
  `transport: 'local'`, print invite code. (Repo with a remote → git team in Task 8; until then fall back to local
  with a note.)
- `join <code>` inside a repo that has a local team → `joinTeam` service locally (adds another agent).
- `agentteams mcp` for local credentials serves `buildMcpServer(ctx, actor)` over stdio in-process.
- `agentteams up` stays available (HTTP hub) but is no longer needed for same-machine teams.
- TUI: replace the hub question with "Who will be on this team?" → *Just my agents on this computer* (local) /
  *People on other computers through this repo's remote* (git, disabled until Task 8 with hint) / *A hub server
  (advanced)* → URL. Name question asked for local teams.
- Tests: create→join→status→send/receive via MCP in-process, all offline.

## Phase 2 — Git transport

### Task 4: Crypto, invite codes, HLC, segment codec (pure modules)

**Files:** `packages/cli/src/git/crypto.ts`, `invite.ts`, `hlc.ts`, `segment.ts`; tests.

- `crypto.ts`: `newTeamKey()`, `encrypt(key, plaintext) → Buffer` (AES-256-GCM, 12-byte random nonce, `nonce|tag|ct`),
  `decrypt`, `newAgentKeyPair()` (Ed25519, PEM or raw), `sign`, `verify`.
- `invite.ts`: `encodeInvite({remote, teamId, key}) → 'at1-…'` and `decodeInvite` (base32url, strict validation, clear
  errors; rejects other prefixes).
- `hlc.ts`: hybrid logical clock producing monotonically increasing ISO timestamps even when the wall clock goes back;
  `observe(remoteTs)`.
- `segment.ts`: `encodeSegment(ops[], teamKey, agentKey) → Buffer` (JSON batch → sign → encrypt) and `decodeSegment`
  returning ops or a typed rejection reason.
- Tests: round trips, tamper detection (flip a byte), wrong key, wrong signer, invite edge cases.

### Task 5: Op capture and deterministic replay

**Files:** `packages/cli/src/git/ops.ts` (op type + registry), `replay.ts`; tests.

- `Op = {v:1, id, ts, agent, op, input}`. Registry maps op names to service calls for every state-changing service the
  MCP tools and CLI use (sendMessage, readInbox-with-markRead → `markRead` op, createTask, assignTask, claimTask,
  updateTask, completeTask, markMerged, claimFiles, releaseFiles, recordCommit, recordClaimOverride, setOrchestrator)
  plus special ops `createTeam` (inserts team + creator agent with its public key) and `join` (inserts agent with its
  public key) that bypass invite/API-key logic.
- Replay context: `now()` = op ts; `newId()` = op id, then deterministic successors for additional rows.
- `applyOps(db, ops)`: sort by `(ts, agent, id)`; apply incrementally when all new ops sort after the last applied op,
  else rebuild from scratch (fresh DB + migrate + replay all). Track applied op ids in a table.
- Failed ops (DomainError) are recorded as rejected, not thrown; the author gets a local system message.
- Agent public keys stored in a new table used by segment verification.
- Tests: permutations of the same op set → identical dumps; conflicting claimTask → earliest wins on every replica;
  rebuild path; rejected op recorded.

### Task 6: Git refs layer

**Files:** `packages/cli/src/git/refs.ts`; tests with real git (bare remote in temp dir).

- Write own log: append a segment as a new commit on a local ref `refs/agentteams-local/<team>/agents/<agent>` (tree:
  `ops/<seq>.bin`, `presence.bin`) using plumbing (`hash-object -w`, `mktree`, `commit-tree`, `update-ref`), no working
  tree changes, no index changes.
- `fetchTeam(remote, teamId)`: `git fetch <remote> +refs/agentteams/<team>/*:refs/agentteams-remote/<team>/*`.
- `pushOwn(remote, teamId, agentId)`; meta ref read/write.
- `newSegments(teamId, sinceState)`: list segment blobs not yet applied, per agent, in seq order.
- Tests: two clones exchange segments through a bare remote; nothing appears in `git branch -a` or the working tree;
  pushes are fast-forward.

### Task 7: Sync engine and `agentteams sync`

**Files:** `packages/cli/src/git/sync.ts`, `commands/sync.ts`, hook/MCP integration; tests.

- One round: lock (`.git/agentteams/sync.lock`, stale after 30 s) → fetch → decode/verify → `applyOps` → push own
  pending segment(s) + presence (≤ every 60 s) → unlock. Records `lastFetchAt`.
- `GitTeamClient` (extends local behaviour): every write first appends an op to the pending log and applies it locally,
  then triggers a detached `agentteams sync`; reads trigger a detached sync when `lastFetchAt` > 10 s old.
- Detached spawn helper (no stdio, unref) used by hooks/MCP; never awaited.
- Errors go to `.git/agentteams/sync.log`; the next hook output carries one short warning.
- `status`/`log` print "last synced Xs ago" for git teams.
- Tests: round with unreachable remote returns error without losing ops; lock prevents overlap; presence updates.

### Task 8: Git create/join, invites, TUI

**Files:** `commands/create.ts`, `commands/join.ts`, `commands/invite.ts`, `tui/*`, tests.

- `create` in a repo with a remote (default when no `--hub`/`--local`): new team id + team key + agent key → `createTeam`
  op → meta ref + own log → push → print `at1-…` invite (with "treat like a password").
- `join at1-…`: decode → clone remote unless inside it (`--dir`, `--no-clone` keep working) → fetch → verify meta →
  agent key → `join` op → push → install agent configs.
- `invite` for git teams prints the code again (from the stored team key); rotate/revoke explain repo-access model.
- TUI enables the git option; join flow accepts `at1-` codes.
- Tests: create on clone A, join on clone B, orchestrator command reaches B after one sync round, commit guard sees A's
  claims on B.

### Task 9: Multi-machine integration suite

**Files:** `packages/cli/test/gitTeam.integration.test.ts`.

- Bare remote + three clones with separate `AGENTTEAMS_HOME`s; full scenario: create, two joins, tasks assigned and
  completed, messages, claims and commit guard, one machine offline then reconnecting, tampered segment rejected,
  replicas converge to identical status/activity.

## Phase 3 — Docs and demos (controller)

### Task 10: README + recordings

- Setup sections rewritten around local and git teams; public hub moved under Advanced; recordings re-made with the
  new defaults (no `up`, no `--hub`), including a two-clone git-team demo.
