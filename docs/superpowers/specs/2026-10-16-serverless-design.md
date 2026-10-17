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
- `refs/agentteams/<teamId>/agents/<agentId>` — that agent's log. Readers use only the **tip's tree**:
  - `ops/<shard>/<seq>.bin` holds segment `seq` (a batch of ops). `shard` is `floor(seq / 1000)` as 5 digits and
    `seq` is 8 digits, e.g. `ops/00001/00001234.bin`. Sharding keeps every tree small: an append rewrites one shard
    tree of at most 1000 entries, never a tree listing every segment.
  - `presence.bin` is overwritten.
  - Commits exist only to carry trees. The writer makes one commit per change; history depth, parents and commit ids
    are never read, so the writer may squash freely.

A machine never fetches with a glob. Each round it:
1. lists `refs/agentteams/<teamId>` on the remote with `git ls-remote`;
2. keeps only the exact names `meta` and `agents/<ID>`, where ID is a canonical uppercase Crockford ULID (26 chars);
3. fetches the changed ones with explicit refspecs, in one `git fetch --stdin`, into `refs/agentteams-remote/<teamId>/`;
4. deletes fetched refs the remote no longer lists (prune).

Every other name is ignored and warned about once. That covers directory/file conflicts such as `agents/<id>/x` or
a ref named `agents`, and lowercase or case-variant ids. So no ref anyone pushes can break a fetch or clobber
another name on a case-insensitive filesystem. Names that block a valid ref are deleted from the remote with
leased deletes: the owner deletes `agents/<own id>/...`, and the creator deletes `refs/agentteams/<team>`,
`.../agents` and `.../meta/...`.

A machine pushes `<local log commit>:refs/agentteams/<teamId>/agents/<agentId>` with `--force-with-lease` on the
remote tip it last observed, or with "must not exist" when the ref is absent. One leased push covers a normal push,
a restore after vandalism, a deleted ref, and a re-clone whose rebuilt log has different commits.

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
- `agentteams sync` runs one round under a lock file (`.git/agentteams/sync.lock`, owned by a token, with a
  heartbeat; every local ref write is a compare-and-swap):
  1. fetch the team refs;
  2. check our own remote log;
  3. verify and pin the team meta;
  4. ingest the agents' logs by path;
  5. apply or rebuild the view;
  6. publish our pending ops and presence;
  7. push our log.
- **Path-based ingestion.** For each agent, a replica reads `ops/<shard>/<seq>.bin` from the fetched tip's tree for
  seq = lastAcceptedSeq + 1, + 2, ... until a path is missing or the round's budget runs out.
  - Each blob is size-checked (at most 1 MiB) before it is read, then decrypted and verified. The signature binds
    team, agent and seq. The key comes from the agent's pin, or for seq 0 from its bootstrap op, which then pins it.
  - Per agent the replica keeps `nextSeq`, the git blob id (content hash) of every accepted seq, and the last
    accepted presence.
  - A blob that fails verification stops that agent at that seq for that tip, with one security warning. Any later
    tip is read again, so a valid blob at the same path is accepted.
  - When an agent's tip changes, its last accepted seq is looked up again and compared by its **decrypted, signed
    content**: the sha256 of signature | plaintext, which is deterministic because Ed25519 is. Blob and ciphertext
    ids are never compared, because any member holding the team key can re-encrypt a segment.
    - A re-encrypted copy is the same segment and is ignored silently.
    - Different signed content is equivocation; content that does not verify is vandalism. Both are logged and
      ignored, and the accepted copy stays.
  - A deleted ref of an agent we accepted data from is warned about once. Its accepted log is kept.
  - A seq gap is just a missing path: the replica waits.
- **Tree guards.** Before any path lookup, `cat-file --batch-check` sizes are checked:
  - the tip commit: at most 64 KiB;
  - the root tree: at most 4 KiB (it holds only `ops` and `presence.bin`);
  - the `ops` tree: at most 4 MiB (about 130,000 shards);
  - each shard tree: at most 64 KiB.

  An oversized log is skipped with a warning until its tip changes.
- **Budget.** A round reads at most 64 new segments and visits at most 64 changed agents, across all remote agents.
  Each visit reads at most one presence. Agents are served round-robin in passes of 8 segments. The order is the
  stable sorted agent list, rotated by an offset that advances just past the last agent served each round. With B
  agents holding backlogs, every one is served within about B / 8 rounds (B / 64 for visits). Batched blob reads are
  chunked at 16 MiB. Leftover work sets "more pending": the round leaves `sync.pending`, so the coalescing loop
  (up to 3 more rounds per call) or the next detached sync continues it. Logs written in this clone (other agents
  sharing it) are not budgeted. A fully processed tip is cached, so unchanged agents cost nothing.
- **Own log.** Every round compares our remote tip with our local log at the **expected paths only**:
  - our seqs 0..n-1, with one lookup per shard of ours, where a shard whose tree id equals ours is skipped whole, and
    one lookup per seq in a shard that differs;
  - then n, n+1, ... for adoption;
  - then presence.bin.

  Extra shards and files are never listed, so the cost is O(our segments) whatever is pushed. 8000 empty shards
  cost no extra time. Segments are compared by decrypted signed content, so a re-encrypted copy is restored as
  vandalism, never mistaken for our own key signing twice.
  - Our own segments on the remote that we lack are adopted at any depth. They must be contiguous after our last one
    and verify under our own key. This covers a fresh clone with the same credential, which rebuilds its local log
    from them and continues.
  - A newer presence of ours is adopted too.
  - Anything else that differs is vandalism: junk, extra files, or missing or replaced segments that do not verify.
    Our verified local log is pushed back over it with a leased push.
  - A different segment signed with our key means the credential is in use in another clone. It is never pushed over:
    the round fails until a person resolves it.
  - We push only a local log that verifies: every seq 0..n present, each verified under our key.
- **Hooks and MCP** never block on the network. After any state-changing op they spawn `agentteams sync` detached
  (push now). On read paths they spawn a detached sync if the last fetch is older than **10 s**. They always read the
  local view, so new messages show up on the next hook event after the background fetch lands.
- **Presence.** Each agent overwrites its `presence.bin` at most every **60 s** while active.
  - The blob is signed `{ts, counter}` under its own domain prefix.
  - Replicas accept it only if (ts, counter) is newer than the last presence they accepted for that agent, so a
    replayed blob is refused.
  - The writer uses ts = max(now, last.ts) and counter = last.counter + 1, taken from its own log, so a clock moving
    backwards never wedges it.
  - Replicas set `last_seen_at` from it, never in the future. `status` thresholds (active < 60 s, idle < 10 min) gain
    the replication delay; acceptable.
- **Offline:** ops queue in `team.db` (`replica_pending`) and in the local log, and push on the next successful round.
  `status` and `log` show "last synced Xs ago".
- **Failures** (no network, auth error, rejected push) and security refusals are logged to `.git/agentteams/sync.log`
  and surfaced once in the next hook output as a short warning. They never break the agent's turn.

### Defaults and selection

- `create` in a repo with a remote → **git** team. With no remote or `--local` → **local** team. `--hub <url>` or
  `--hub local` → existing HTTP hub behaviour (advanced).
- The TUI's hub question becomes "Who will be on this team?": *Just my agents on this computer* (local), *People on
  other computers via this repo's remote* (git), *A hub server* (advanced, URL).
- The public Vercel hub stops being the default; the README stops recommending it. (Shutting the deployment down is
  the operator's call, outside this work.)

## Security

**Threat model (binding).**
- **Integrity and authenticity** must hold against any member: no forgery, no impersonation, no silent state
  divergence.
- **Availability** against a malicious member with push access is best effort. Such a member can already delete the
  code.
  - Simple vandalism must heal itself cheaply.
  - Nothing a single push does may wedge an agent or the team permanently, or cost unbounded time per round.

- Invite code = team key: anyone holding it and repo access can read and join. Treat it like a password; the CLI says
  so when printing it.
- Encrypted at rest in the remote; plaintext only in the local `team.db` (0600, inside `.git/`, never committed).
- Signed ops prevent impersonation; orchestrator-only rules are enforced on replay on every replica.
- Hub-supplied strings remain untrusted in hook output (existing `oneLine` / peer-message labelling unchanged).
- No secrets in refs other than ciphertext; ref names contain only random ids.
- **Push access is not trust.** Anyone with push access can rewrite any ref. Replicas accept only content that
  verifies by path, so forged or re-created commits change nothing. The owner restores its own ref, and the creator
  restores the meta: from its local copy, or after a re-clone by re-encoding the pinned meta with its key.

**Residual risks** (accepted, documented):
- **TOFU for creator pins.** Invites carry the creator's agent id and key. Every credential stores them: the
  creator's names itself. They are pinned before every round's fetch, so neither a joiner nor a re-cloned creator
  trusts a forged meta. Only a credential without a creator (an old or hand-made invite) trusts the first meta it
  sees. Each agent's own key is still trust-on-first-use from its seq-0 bootstrap.
- **A large push slows fetches.** The fetch downloads every valid team ref, with a 20 s timeout, and the listing is
  capped at 32 MiB.
  - A huge object on a ref that an honest party owns (its own agent ref, the meta) lasts until that owner overwrites
    it.
  - On a ref that no honest party will ever overwrite (the pusher's own agent ref, or a new agent ref), it is
    **permanent**: every member's fetch stays slow or times out until a person deletes the ref.
  - The same goes for a flood of millions of junk refs, which exceeds the listing cap.
  - The tree guards and the round budget bound what is read after the fetch, not what is downloaded.
- **Hostile agents cost latency and storage.** Any member can mint agents (seq-0 bootstraps are TOFU), and their
  verified segments are stored by every replica forever (`accepted/*.jsonl`). Honest latency grows with the number
  of agents holding backlogs: worst case about B / 8 rounds (B / 64 for presence-only changes). That is bounded per
  round, but not in total.
- **Members are attributable but can backdate.** Every op is signed, so it is attributable to its author. Its HLC
  timestamp is chosen by that author, though, so a member can backdate ops to win races such as task claims. (Ops
  dated too far in the future are held back.) Late or backdated arrivals are logged when they force a rebuild.
- **OS-user trust between agents in one clone.** Agents sharing a clone share `.git/agentteams`, the local refs and
  `team.db`. Anyone running as that OS user can edit them, and local logs are read without the round budget. The
  boundary against teammates is the git remote, not the local machine.
- **One credential, one clone at a time.** Running the same agent credential in two clones at once can make them
  sign different segments for the same seq: true equivocation. Replicas keep the first copy and log it. The agent
  that loses stops pushing until a person resolves it, and the ops it wrote meanwhile exist only in that clone's
  local log. Members cannot fake this state: re-encrypted copies are recognised as the same content.
- **Deleted refs and junk names heal in one owner round.** A deleted agent ref is pruned and recreated by its owner.
  Names that block a valid ref are deleted by the owner or the creator. Until then, replicas keep everything they
  accepted.

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
