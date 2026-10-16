# agentteams without a server — design

**Status:** approved direction (user, 2026-10-16): no operator-run server; strangers must be able to install, create a
team, send a code and work together. Same-machine agents talk locally; people on different machines sync through the
team's git remote.

## Goals

1. **Zero infrastructure.** Nobody runs or pays for a hub. The default path needs only the CLI and a git remote the team
   already shares for its code.
2. **Same machine = local and instant.** A person's own agents in one repo coordinate through a file in `.git/`. No
   `agentteams up`, no network, works offline.
3. **Across people = git mailbox.** Team state replicates through hidden refs in the team repo. Teammates can be offline;
   state waits for them. Access control is the repo's own access control.
4. **No GitHub requirement for identity.** Any git remote works (GitHub, GitLab, self-hosted). `gh` remains optional,
   used only by `--new-repo`, `pr` and `access`.
5. **Nothing above the transport changes.** MCP tool names/schemas, hook behaviour, git hooks, CLI commands, the TUI
   and all hub service semantics (roles, orchestrator-only tools, claims, presence) stay as they are.
6. **The HTTP hub stays as an advanced option** (`--hub <url>`, `agentteams up`) for teams that want a server.

## Non-goals

- Real-time chat. Delivery is bounded by the receiver's next hook event anyway; cross-machine adds seconds.
- Invite revocation by key rotation. Repo access is the gate; removing a collaborator from the repo removes them.
- Transferring code. agentteams still never moves code; branches go through the normal remote.

## Measured facts this rests on (2026-10-16)

- GitHub accepts pushes to custom refs (`refs/agentteams/...`); they are not fetched by a normal clone and do not
  appear as branches. Push ≈ 1.2 s, fetch ≈ 0.46 s, delete works.
- Hook startup is ≈ 0.07 s; hooks must stay well under their 2 s budget, so hooks never wait on the network.
- Hub services are Kysely functions over `HubContext {db, dialect, now, newId, mode, verifyGithub?}` and an `Actor`.
  `buildMcpServer(ctx, actor)` has no HTTP dependency. SQLite runs in WAL with busy_timeout 5000, which already
  supports several writer processes on one machine.

## Architecture

```
            MCP tools · hooks · git hooks · CLI commands · TUI
                               │
                         TeamClient (interface; same methods HubClient has today)
               ┌───────────────┼──────────────────────┐
         HttpTeamClient   LocalTeamClient        (git sync engine runs beside LocalTeamClient)
         (today's         in-process services     fetch/push refs/agentteams/<team>/*
          HubClient)      on .git/agentteams/      encrypted, signed per-agent op logs
                          team.db (SQLite)          → replayed into team.db
```

A credential gains `transport: 'http' | 'local' | 'git'` (missing = `http`, so existing credentials keep working).

### Transport 1: local (same machine)

- **Store:** `<git-common-dir>/agentteams/team.db`. The common dir is shared by every worktree of the repo, so task
  worktrees see the same team automatically. Created with mode 0600 inside a 0700 directory. Migrations run on open.
- **LocalTeamClient** opens the DB (cached per process), builds a `HubContext` with `mode: 'local'`, authenticates the
  credential's API key with the existing `authenticate` service to get the `Actor`, and calls the same service
  functions the HTTP routes call. Every `HubClient` method has a local equivalent.
- **MCP:** `agentteams mcp` serves `buildMcpServer(ctx, actor)` directly over stdio for local/git credentials (no
  network, no proxy retry logic).
- **Hooks:** unchanged logic; they read and write the local DB. `last_seen_at` updates stay as today.
- **Create/join:** `create` with no remote (or `--local`) makes a local team and prints a short invite code. `join` in
  the same repo uses it to add another agent (the "link another agent" path). Invite codes keep their hashed storage.
- **Concurrency:** several processes write the same SQLite file; WAL + busy_timeout handles it. `withTx` already exists.

### Transport 2: git (across machines)

Each machine keeps the same `team.db` as a **materialised view** of the team's operation log. The log is the source of
truth and is replicated through the remote.

**Operations.** Every state-changing service call is captured as an op:
`{v: 1, id, ts, agent, op, input, deps?}` where `id` is a ULID minted by the author, `ts` its hybrid-logical-clock
time, `agent` the author's agent id, `op` the service name (`createTask`, `claimTask`, `sendMessage`, `claimFiles`,
`recordCommit`, `markRead`, …) and `input` the validated service input. Reads are never logged. Presence is not an op
(see below).

**Determinism.** Replay calls the real service with a `HubContext` whose `now()` returns the op's `ts` and whose
`newId()` returns ids derived from the op id (`<op id>` then `<op id>+n` for further rows), so every replica produces
identical rows and the ULID ordering `readInbox` relies on is preserved. Total order: `(ts, agent id, op id)`.

**Conflicts.** Ops are applied in total order. If a fetched op sorts before ops already applied locally, the view is
rebuilt: the DB is recreated and the full log replayed (small teams: thousands of ops replay in well under a second).
Service-level rules decide conflicts the same way on every replica, e.g. two agents claiming the same task: the
earlier op wins and the later one fails in replay; its author is told through a local system message ("your claim of
#3 lost to kai-cursor"). Task numbers cannot collide because only the orchestrator creates tasks (single writer). A
replayed op that fails validation is recorded as rejected and skipped, never fatal.

**Refs.** Each agent writes only its own ref, so pushes never conflict:
- `refs/agentteams/<teamId>/meta` — written once by the creator: team id, name, created-at, creator's public key,
  default branch.
- `refs/agentteams/<teamId>/agents/<agentId>` — that agent's log: a commit chain, each commit adding one segment file
  `ops/<seq>.bin` (a batch of ops), plus `presence.bin` (overwritten).

A machine fetches `+refs/agentteams/<teamId>/*:refs/agentteams-remote/<teamId>/*` and pushes
`<local log commit>:refs/agentteams/<teamId>/agents/<agentId>` (always a fast-forward).

**Encryption and signatures.**
- **Team key:** 32 random bytes created at `create`, carried only in the invite code. Every segment and presence file
  is encrypted with AES-256-GCM under the team key (random 96-bit nonce, op batch as plaintext). Public repos leak
  only ref names, sizes and timing.
- **Agent keys:** each agent generates an Ed25519 key pair at create/join, stored next to its credential (0600). Its
  first op is `join` carrying the public key. Every segment is signed; replicas verify the signature against the
  author's registered key and reject anything that fails. So a teammate with repo write access cannot forge another
  agent's ops, and orchestrator-only ops stay enforceable in replay.
- Node's built-in `crypto` provides AES-GCM and Ed25519. No new dependency.

**Invite code (git teams).** One copy-pasteable string:
`at1-<base32url(remote URL)>-<teamId>-<base32(team key)>`, e.g.
`agentteams join at1-...`. `join` decodes it, clones the remote (unless already inside it), fetches the team refs,
verifies the meta ref, generates the agent key, appends a signed `join` op and pushes. Remote access comes from the
user's normal git credentials, so private repos need the lead to grant access (`agentteams access grant` with `gh`, or
the host's UI).

**Sync engine.**
- `agentteams sync` runs one round: fetch team refs → verify + decrypt new segments → apply/rebuild → push own
  unpushed ops and presence. A lock file (`.git/agentteams/sync.lock`) keeps one round at a time.
- Hooks and MCP never block on the network. After any state-changing op they spawn `agentteams sync` detached
  (push now). On read paths they spawn a detached sync if the last fetch is older than **10 s**. They always read the
  local view, so new messages show up on the next hook event after the background fetch lands.
- Presence: each agent overwrites its `presence.bin` at most every **60 s** while active. Replicas set `last_seen_at`
  from it. `status` thresholds (active < 60 s, idle < 10 min) gain the replication delay; acceptable.
- Offline: ops queue in the local log and push on the next successful round; `status`/`log` show "last synced Xs ago".
- Failures (no network, auth error, rejected push) are logged to `.git/agentteams/sync.log` and surfaced once in the
  next hook output as a short warning; they never break the agent's turn.

### Defaults and selection

- `create` in a repo with a remote → **git** team. With no remote or `--local` → **local** team. `--hub <url>` or
  `--hub local` → existing HTTP hub behaviour (advanced).
- The TUI's hub question becomes "Who will be on this team?": *Just my agents on this computer* (local), *People on
  other computers via this repo's remote* (git), *A hub server* (advanced, URL).
- The public Vercel hub stops being the default; the README stops recommending it. (Shutting the deployment down is
  the operator's call, outside this work.)

## Security

- Invite code = team key: anyone holding it and repo access can read and join. Treat it like a password; the CLI says
  so when printing it.
- Encrypted at rest in the remote; plaintext only in the local `team.db` (0600, inside `.git/`, never committed).
- Signed ops prevent impersonation; orchestrator-only rules are enforced on replay on every replica.
- Hub-supplied strings remain untrusted in hook output (existing `oneLine` / peer-message labelling unchanged).
- No secrets in refs other than ciphertext; ref names contain only random ids.

## Testing

- Unit: op capture/replay determinism (same ops in any arrival order → identical DB), conflict rebuild, signature and
  decryption failure paths, invite code round-trip, HLC.
- Integration with real git, no network: a bare repo in a temp dir acts as the remote; two or three "machines" are
  separate clones with separate `AGENTTEAMS_HOME`s. Scenarios: create/join, orchestrator assigns → worker sees command
  after sync, claim conflict, commit guard across machines, offline then reconnect, tampered segment rejected.
- Local transport: two agents in one repo, worktree shares the team, MCP over stdio in-process.
- Existing HTTP hub tests stay green.
- Recordings re-made with the new default (no `up`, no `--as` gymnastics).

## Phases

1. **Local transport**: TeamClient interface, LocalTeamClient, in-process MCP, credential `transport`, create/join
   defaults for repos without a remote, TUI wording. Ships on its own.
2. **Git transport**: op capture, deterministic replay, segment format, crypto, refs, sync engine, invite codes,
   create/join for repos with a remote, TUI.
3. **Docs and demos**: README rewrite of the setup sections, re-recorded GIFs, public hub moved to "Advanced".
